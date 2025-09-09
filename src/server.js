import express from 'express';
import dotenv from 'dotenv';
import { applyCentralWatermark } from './watermark.js';
import { addSecurityFeatures } from './security.js';
import { sendEmailWithAttachments } from './mailer.js';
import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'crypto';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { Queue, Worker } from 'bullmq';
import Ajv from 'ajv';
import archiver from 'archiver';
const exec = promisify(execCb);

// Cola en Redis (BullMQ)
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '';
let connection = null;
let pdfQueue = null;
if (REDIS_URL) {
  connection = { url: REDIS_URL, maxRetriesPerRequest: null, enableReadyCheck: false };
  try {
    pdfQueue = new Queue('pdf-jobs', { connection });
  } catch (e) {
    console.warn('[QUEUE] No se pudo inicializar Redis/BullMQ, usando fallback inline:', e?.message);
    pdfQueue = null;
    connection = null;
  }
}

// Comprime un PDF si supera cierto umbral (bytes). Devuelve la ruta del archivo a usar finalmente.
async function compressIfTooLarge(inputPath, maxBytes = 17 * 1024 * 1024) {
  try {
    const stat = await fs.stat(inputPath);
    if (stat.size <= maxBytes) return inputPath;
    console.log(`[FLOW] Compresión: ${inputPath} pesa ${(stat.size / (1024*1024)).toFixed(1)} MiB, recomprimiendo...`);
    const outPath = inputPath.replace(/\.pdf$/i, '.compressed.pdf');
    // Perfil /ebook mantiene buena calidad visual a tamaño razonable
    await exec(`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 -dPDFSETTINGS=/ebook -dDetectDuplicateImages=true -dCompressFonts=true -dDownsampleColorImages=true -dColorImageResolution=144 -dDownsampleGrayImages=true -dGrayImageResolution=144 -dDownsampleMonoImages=true -dMonoImageResolution=144 -sOutputFile=${outPath} -f ${inputPath} | cat`);
    const outStat = await fs.stat(outPath);
    console.log(`[FLOW] Compresión lista: ${(outStat.size / (1024*1024)).toFixed(1)} MiB`);
    // Si no mejora, usa el original
    if (outStat.size >= stat.size) {
      await fs.rm(outPath).catch(() => {});
      return inputPath;
    }
    return outPath;
  } catch (e) {
    console.log('[FLOW] Compresión omitida por error:', e?.message || e);
    return inputPath;
  }
}

// Normaliza bytes de PDF copiando todas las páginas a un nuevo documento
const normalizeCache = new Map(); // hash(bytes)->bytes normalizados
async function normalizeWithPdfLib(bytes) {
  try {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (normalizeCache.has(hash)) return normalizeCache.get(hash);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const indices = src.getPages().map((_, idx) => idx);
    const copied = await out.copyPages(src, indices);
    for (const p of copied) out.addPage(p);
    const normalized = await out.save();
    normalizeCache.set(hash, normalized);
    return normalized;
  } catch (e) {
    return bytes;
  }
}

// Descarga con soporte para Google Drive (convierte a drive.usercontent si hace falta)
function extractDriveIdFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (
      u.hostname.includes('drive.google.com') ||
      u.hostname.includes('docs.google.com') ||
      u.hostname.includes('googleusercontent.com')
    ) {
      if (u.searchParams.get('id')) return u.searchParams.get('id');
      const m = u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function downloadPdfWithDriveSupport(urlString) {
  const tryFetch = async (u, timeoutMs = 20000) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(u, { redirect: 'follow', signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const ct = resp.headers.get('content-type') || '';
      if (ct.startsWith('application/pdf') || buf.slice(0, 5).toString() === '%PDF-') return buf;
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  // Reintentos con backoff
  const attempts = [0, 750, 2000];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) await sleep(attempts[i]);
    try {
      let buf = await tryFetch(urlString);
      if (buf) return buf;
      const id = extractDriveIdFromUrl(urlString);
      if (id) {
        const alt = `https://drive.usercontent.google.com/uc?export=download&id=${id}`;
        buf = await tryFetch(alt);
        if (buf) return buf;
      }
      lastErr = new Error('Respuesta no PDF');
    } catch (e) {
      lastErr = e;
      // Reintentar ante abortos o resets
      if (String(e?.code).includes('ECONNRESET') || e?.name === 'AbortError') {
        continue;
      }
    }
  }
  throw new Error('Contenido descargado no parece ser PDF (puede requerir confirmación). Usa enlaces directos de drive.usercontent. Último error: ' + (lastErr?.message || lastErr));
}

dotenv.config();
console.log('Boot OK');

// Manejo global de ECONNRESET/AbortError para evitar ruido
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ECONNRESET' || err.name === 'AbortError')) {
    console.warn('[NET] Ignorado uncaughtException:', err.code || err.name);
    return;
  }
  console.error('[FATAL] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  if (err && (err.code === 'ECONNRESET' || err.name === 'AbortError')) {
    console.warn('[NET] Ignorado unhandledRejection:', err.code || err.name);
    return;
  }
  console.error('[FATAL] unhandledRejection', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Storage temporal de zips por token (memoria + disco)
const downloadTokens = new Map(); // token -> { path, expiresAt, filename }
const ZIP_TTL_MS = 1000 * 60 * 60 * 48; // 48h

// Utilidad: sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/download/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const entry = downloadTokens.get(token);
    if (!entry) return res.status(404).send('Link no válido o expirado');
    if (Date.now() > entry.expiresAt) {
      try { await fs.rm(entry.path).catch(() => {}); } catch {}
      downloadTokens.delete(token);
      return res.status(410).send('Link expirado');
    }
    return res.download(entry.path, entry.filename || 'descargables.zip', (err) => {
      if (!err) return;
      // Ignorar abortos del cliente
      if (err.code === 'ECONNRESET') return;
      try { res.status(500).end('Error de descarga'); } catch {}
    });
  } catch {
    res.status(500).send('Error de descarga');
  }
});

// Limpieza periódica de zips expirados
setInterval(async () => {
  const now = Date.now();
  for (const [token, entry] of downloadTokens.entries()) {
    if (now > entry.expiresAt) {
      try { await fs.rm(entry.path).catch(() => {}); } catch {}
      downloadTokens.delete(token);
    }
  }
}, 60 * 60 * 1000); // cada hora

// Validación de esquema del webhook (básico)
const ajv = new Ajv({ removeAdditional: true, allErrors: true });
const directSchema = {
  type: 'object',
  properties: {
    fullName: { type: 'string', minLength: 1 },
    email: { type: 'string', minLength: 3 },
    purchasedAt: { type: 'string' }
  },
  required: ['fullName', 'email'],
};
const kajabiSchema = {
  type: 'object',
  properties: {
    offer: {
      type: 'object',
      properties: { title: { type: 'string' } },
    },
    member: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        name: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
      },
    },
    payment_transaction: {
      type: 'object',
      properties: { created_at: { type: 'string' } },
    },
  },
};
const validateDirect = ajv.compile(directSchema);
const validateKajabi = ajv.compile(kajabiSchema);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', async (req, res) => {
  // Soportar payload de Kajabi: puede venir como array de eventos
  const bodyRaw = req.body || {};
  const body = Array.isArray(bodyRaw) ? (bodyRaw[0] || {}) : bodyRaw;
  if (Array.isArray(bodyRaw)) {
    if (!validateKajabi(body)) return res.status(400).json({ error: 'Payload Kajabi inválido' });
  } else {
    if (!validateDirect(bodyRaw) && !validateKajabi(bodyRaw)) {
      return res.status(400).json({ error: 'Payload inválido' });
    }
  }
  const kajabiOfferTitle = body?.offer?.title;
  const fullName = body?.member?.name || (body?.member?.first_name && body?.member?.last_name ? `${body.member.first_name} ${body.member.last_name}` : body?.fullName);
  const email = body?.member?.email || body?.email;
  const purchasedAt = body?.payment_transaction?.created_at || body?.purchasedAt;
    if (!fullName || !email) {
      return res.status(400).json({ error: 'Faltan parámetros: fullName y email son requeridos' });
    }

  const firstName = req.body?.member?.first_name || (fullName ? String(fullName).split(' ')[0] : undefined);

  // Responder inmediatamente
  res.json({ ok: true, message: "Procesando en segundo plano." });

  // --- Encolar el trabajo en segundo plano (BullMQ en Redis o fallback inline) ---
  const jobPayload = { fullName, email, purchasedAt, kajabiOfferTitle, firstName };

  if (pdfQueue) {
    const jobId = `${email}:${purchasedAt || ''}:${kajabiOfferTitle || ''}`;
    await pdfQueue.add('process', jobPayload, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: true,
      removeOnFail: { count: 10 },
    });
    return; // devolvemos respuesta arriba; el worker procesará
  }

  // Fallback sin Redis
  const job = async () => {
    try {
    const timestamp = purchasedAt || new Date().toISOString();
    const watermarkText = `${fullName} | ${email} | ${timestamp}`;

    // Normalizador para comparar sin acentos y sin sensibilidad a mayúsculas
    const normalizeTitle = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const titleNorm = normalizeTitle(kajabiOfferTitle || '');

    // Mapeo de títulos a carpetas y URLs (igual que en el worker)
    const offerMappings = {
      keto_optimizado: {
        match: (t) => normalizeTitle(t).includes('keto optimizado'),
        urls_env: 'KETO_OPTIMIZADO_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'keto_optimizado'),
      },
      bonus_ko: {
        match: (t) => normalizeTitle(t).includes('keto optimizado'),
        urls_env: 'BONUS_KO_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'bonus_ko'),
      },
      keto_fast: {
        match: (t) => {
          const n = normalizeTitle(t);
          return n.includes('keto fast') || n.includes('keto-fast');
        },
        urls_env: 'KETO_FAST_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'keto_fast'),
      },
      ldl_colesterol: {
        match: (t) => normalizeTitle(t).includes('colesterol'),
        urls_env: 'LDL_COLESTEROL_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'ldl_colesterol'),
      },
      control_apetito: {
        match: (t) => {
          const n = normalizeTitle(t);
          return n.includes('ebook') && n.includes('control absoluto del apetito');
        },
        urls_env: 'CONTROL_APETITO_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'control_apetito'),
      },
      analiticas_esenciales: {
        match: (t) => {
          const n = normalizeTitle(t);
          return n.includes('analiticas esenciales');
        },
        urls_env: 'ANALITICAS_ESENCIALES_URLS',
        dir: path.join(__dirname, '..', 'descargables', 'analiticas_esenciales'),
      },
    };

    // Permitir múltiples packs por título
    const matchedConfigs = Object.entries(offerMappings)
      .filter(([_, cfg]) => kajabiOfferTitle && typeof cfg.match === 'function' && cfg.match(kajabiOfferTitle))
      .map(([key, cfg]) => ({ key, ...cfg }));

    const outputs = [];
    if (matchedConfigs.length > 0) {
      for (const config of matchedConfigs) {
        console.log(`[FLOW] Oferta '${config.key}' detectada. Procesando...`);
        let filesToProcess = [];

        try {
          const entries = await fs.readdir(config.dir, { withFileTypes: true });
          const pdfFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => ({
            name: e.name,
            path: path.join(config.dir, e.name),
            source: 'local'
          }));
          if (pdfFiles.length > 0) filesToProcess = pdfFiles;
        } catch (e) {
          if (e?.code !== 'ENOENT') throw e;
        }

        if (filesToProcess.length === 0) {
          const urlsJson = process.env[config.urls_env];
          if (urlsJson) {
            try {
              const list = JSON.parse(urlsJson);
              if (Array.isArray(list) && list.length > 0) {
                filesToProcess = list.map(item => ({
                  name: item.name,
                  url: item.url,
                  source: 'remote'
                }));
              }
            } catch {
              throw new Error(`${config.urls_env} no es un JSON válido`);
            }
          }
        }

        if (filesToProcess.length === 0) {
          console.warn(`No se encontraron PDFs para '${config.key}'`);
          continue;
        }

        console.log(`[FLOW] Procesando ${filesToProcess.length} PDFs...`);
        for (const file of filesToProcess) {
          try {
            console.log(`[FLOW] - ${file.name} (${file.source})`);
            let bytes;
            if (file.source === 'local') {
              bytes = await fs.readFile(file.path);
            } else {
              bytes = await downloadPdfWithDriveSupport(file.url);
              if (bytes.slice(0, 5).toString() !== '%PDF-') {
                throw new Error('Contenido descargado no parece ser PDF (sin cabecera %PDF-)');
              }
              await fs.mkdir(config.dir, { recursive: true });
              const dlPath = path.join(config.dir, file.name);
              await fs.writeFile(dlPath, bytes);
              // Leer desde disco a partir de aquí para unificar flujo
              bytes = await fs.readFile(dlPath);
            }
            
            if (process.env.ENABLE_GS !== 'false') {
              try {
                const tmpDir = path.join(__dirname, '..', 'tmp');
                await fs.mkdir(tmpDir, { recursive: true });
                const inPath = path.join(tmpDir, `in_${Date.now()}.pdf`);
                const outPath = path.join(tmpDir, `gs_out_${Date.now()}.pdf`);
                await fs.writeFile(inPath, bytes);
                await exec(`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 -sOutputFile=${outPath} -f ${inPath} | cat`);
                bytes = await fs.readFile(outPath);
              } catch {}
            }
            if (process.env.ENABLE_QPDF !== 'false') {
              try {
                const tmpDir = path.join(__dirname, '..', 'tmp');
                const inPath = path.join(tmpDir, `in_${Date.now()}.pdf`);
                const outPath = path.join(tmpDir, `qpdf_out_${Date.now()}.pdf`);
                await fs.writeFile(inPath, bytes);
                await exec(`qpdf --linearize --stream-data=preserve --recompress-flate --object-streams=preserve --qdf ${inPath} ${outPath} | cat`);
                bytes = await fs.readFile(outPath);
              } catch {}
            }
            bytes = await normalizeWithPdfLib(bytes);
            let pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
            await applyCentralWatermark(pdfDoc, watermarkText);
            const watermarkedBytes = await pdfDoc.save();
            const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
            pdfDoc = await PDFDocument.load(watermarkedBytes);
            await addSecurityFeatures(pdfDoc, watermarkText, documentHash);
            const finalBytes = await pdfDoc.save();
            const tmpDir = path.join(__dirname, '..', 'tmp');
            await fs.mkdir(tmpDir, { recursive: true });
            const outName = file.name.replace(/\.pdf$/i, `_${Date.now()}.pdf`);
            const outPath = path.join(tmpDir, outName);
            await fs.writeFile(outPath, finalBytes);
            const sendPath = await compressIfTooLarge(outPath);
            outputs.push({ path: sendPath, name: path.basename(sendPath) });
          } catch (fileErr) {
            console.error(`[FLOW] Error procesando ${file.name}:`, fileErr?.message);
            continue;
          }
        }
      }
    } else {
      console.log('[FLOW] Oferta no mapeada, no se procesa. Título recibido:', kajabiOfferTitle);
      return;
    }

    console.log('[FLOW] Enviando email...');
    const firstName = fullName ? String(fullName).split(' ')[0] : undefined;
    // Siempre enviar enlace ZIP 48h con listado de nombres
    const tmpDir = path.join(__dirname, '..', 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const zipName = `descargables_${Date.now()}.zip`;
    const zipPath = path.join(tmpDir, zipName);
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(zipPath);
      const zip = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(output);
      for (const f of outputs) zip.file(f.path, { name: f.name });
      zip.finalize();
    });
    const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
    downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
    const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
    const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
    await sendEmailWithAttachments({
      to: email,
      subject: 'Tus descargables personalizados',
      text: undefined,
      attachments: [],
      firstName,
      downloadLink: link,
      names: outputs.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
    });

    console.log('[FLOW] Email enviado');

    console.log(`Proceso completado para ${email}`);

  } catch (err) {
      console.error(`--- ERROR FATAL EN SEGUNDO PLANO PARA ${email} ---`);
      console.error("Mensaje:", err.message);
      console.error("Stack:", err.stack);
      console.error("--- FIN DEL ERROR FATAL ---");
    }
  };
  await job();
});

// Worker (si hay Redis) – procesa en el mismo contenedor
if (pdfQueue && connection) {
  try {
    // eslint-disable-next-line no-new
    new Worker(
      'pdf-jobs',
      async (job) => {
      const { fullName, email, purchasedAt, kajabiOfferTitle, firstName } = job.data || {};
      const timestamp = purchasedAt || new Date().toISOString();
      const watermarkText = `${fullName} | ${email} | ${timestamp}`;

      // Reutilizamos la misma lógica del fallback ejecutando el "job" inline
      // Copiamos el cuerpo de la función bajo el try { ... } para no duplicar más estructura
      // Nota: mantenemos logs compactos

      // Normalizador para comparar sin acentos y sin sensibilidad a mayúsculas
      const normalizeTitle = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // Mapeo de títulos a carpetas y URLs
      const offerMappings = {
        keto_optimizado: {
          match: (t) => normalizeTitle(t).includes('keto optimizado'),
          urls_env: 'KETO_OPTIMIZADO_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'keto_optimizado'),
        },
        bonus_ko: {
          match: (t) => normalizeTitle(t).includes('keto optimizado'),
          urls_env: 'BONUS_KO_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'bonus_ko'),
        },
        keto_fast: {
          match: (t) => {
            const n = normalizeTitle(t);
            return n.includes('keto fast') || n.includes('keto-fast');
          },
          urls_env: 'KETO_FAST_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'keto_fast'),
        },
        ldl_colesterol: {
          match: (t) => normalizeTitle(t).includes('colesterol'),
          urls_env: 'LDL_COLESTEROL_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'ldl_colesterol'),
        },
        control_apetito: {
          match: (t) => {
            const n = normalizeTitle(t);
            return n.includes('ebook') && n.includes('control absoluto del apetito');
          },
          urls_env: 'CONTROL_APETITO_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'control_apetito'),
        },
        analiticas_esenciales: {
          match: (t) => {
            const n = normalizeTitle(t);
            return n.includes('analiticas esenciales');
          },
          urls_env: 'ANALITICAS_ESENCIALES_URLS',
          dir: path.join(__dirname, '..', 'descargables', 'analiticas_esenciales'),
        }
      };

      const matchedConfigs = Object.entries(offerMappings)
        .filter(([_, cfg]) => kajabiOfferTitle && typeof cfg.match === 'function' && cfg.match(kajabiOfferTitle))
        .map(([key, cfg]) => ({ key, ...cfg }));

      const outputs = [];
      if (matchedConfigs.length) {
        for (const config of matchedConfigs) {
          console.log(`[FLOW] Oferta '${config.key}' detectada. Procesando...`);
          let filesToProcess = [];

          try {
            const entries = await fs.readdir(config.dir, { withFileTypes: true });
            const pdfFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => ({
              name: e.name,
              path: path.join(config.dir, e.name),
              source: 'local'
            }));
            if (pdfFiles.length > 0) filesToProcess = pdfFiles;
          } catch (e) {
            if (e?.code !== 'ENOENT') throw e;
          }

          if (filesToProcess.length === 0) {
            const urlsJson = process.env[config.urls_env];
            if (urlsJson) {
              try {
                const list = JSON.parse(urlsJson);
                if (Array.isArray(list) && list.length > 0) {
                  filesToProcess = list.map(item => ({
                    name: item.name,
                    url: item.url,
                    source: 'remote'
                  }));
                }
              } catch {
                throw new Error(`${config.urls_env} no es un JSON válido`);
              }
            }
          }
          
          if (!filesToProcess.length) {
            console.warn(`No se encontraron PDFs para '${config.key}'`);
            continue;
          }

          console.log(`[FLOW] Procesando ${filesToProcess.length} PDFs...`);
          for (const file of filesToProcess) {
            try {
              console.log(`[FLOW] - ${file.name} (${file.source})`);
              let bytes;
              if (file.source === 'local') {
                bytes = await fs.readFile(file.path);
              } else {
                bytes = await downloadPdfWithDriveSupport(file.url);
                if (bytes.slice(0, 5).toString() !== '%PDF-') {
                  throw new Error('Contenido descargado no parece ser PDF (sin cabecera %PDF-)');
                }
                await fs.mkdir(config.dir, { recursive: true });
                const dlPath = path.join(config.dir, file.name);
                await fs.writeFile(dlPath, bytes);
                // Leer desde disco a partir de aquí para unificar flujo
                bytes = await fs.readFile(dlPath);
              }
              
              // Saneado y normalización
              if (process.env.ENABLE_GS !== 'false') {
                try {
                  const tmpDir = path.join(__dirname, '..', 'tmp');
                  await fs.mkdir(tmpDir, { recursive: true });
                  const inPath = path.join(tmpDir, `in_${Date.now()}.pdf`);
                  const outPath = path.join(tmpDir, `gs_out_${Date.now()}.pdf`);
                  await fs.writeFile(inPath, bytes);
                  await exec(`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 -sOutputFile=${outPath} -f ${inPath} | cat`);
                  bytes = await fs.readFile(outPath);
                } catch {}
              }
              if (process.env.ENABLE_QPDF !== 'false') {
                try {
                  const tmpDir = path.join(__dirname, '..', 'tmp');
                  const inPath = path.join(tmpDir, `in_${Date.now()}.pdf`);
                  const outPath = path.join(tmpDir, `qpdf_out_${Date.now()}.pdf`);
                  await fs.writeFile(inPath, bytes);
                  await exec(`qpdf --linearize --stream-data=preserve --recompress-flate --object-streams=preserve --qdf ${inPath} ${outPath} | cat`);
                  bytes = await fs.readFile(outPath);
                } catch {}
              }
              bytes = await normalizeWithPdfLib(bytes);

              // Watermarking
              let pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
              await applyCentralWatermark(pdfDoc, watermarkText);
              const watermarkedBytes = await pdfDoc.save();
              const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
              pdfDoc = await PDFDocument.load(watermarkedBytes);
              await addSecurityFeatures(pdfDoc, watermarkText, documentHash);
              const finalBytes = await pdfDoc.save();
              
              // Guardado y compresión
              const tmpDir = path.join(__dirname, '..', 'tmp');
              await fs.mkdir(tmpDir, { recursive: true });
              const outName = file.name.replace(/\.pdf$/i, `_${Date.now()}.pdf`);
              const outPath = path.join(tmpDir, outName);
              await fs.writeFile(outPath, finalBytes);
              const sendPath = await compressIfTooLarge(outPath);
              outputs.push({ path: sendPath, name: path.basename(sendPath) });
            } catch (fileErr) {
              console.error(`[FLOW] Error procesando ${file.name}:`, fileErr?.message);
              continue;
            }
          }
        }
      } else {
        console.log('[FLOW] Oferta no mapeada, no se procesa. Título recibido:', kajabiOfferTitle);
        return;
      }

      console.log('[FLOW] Enviando email...');
      const firstNameLocal = (firstName || (fullName ? String(fullName).split(' ')[0] : undefined));
      // Siempre enviar enlace ZIP 48h con listado de nombres
      const tmpDir = path.join(__dirname, '..', 'tmp');
      await fs.mkdir(tmpDir, { recursive: true });
      const zipName = `descargables_${Date.now()}.zip`;
      const zipPath = path.join(tmpDir, zipName);
      await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(zipPath);
        const zip = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        zip.on('error', reject);
        zip.pipe(output);
        for (const f of outputs) zip.file(f.path, { name: f.name });
        zip.finalize();
      });
      const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
      downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
      const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
      const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
      await sendEmailWithAttachments({
        to: email,
        subject: 'Tus descargables personalizados',
        text: undefined,
        attachments: [],
        firstName: firstNameLocal,
        downloadLink: link,
        names: outputs.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
      });
      console.log('[FLOW] Email enviado');
    },
    { connection, concurrency: 1 }
  );
  } catch (e) {
    console.warn('[QUEUE] Worker no iniciado, usando fallback inline:', e?.message);
  }
}

const PORT = process.env.PORT || 3000;
console.log('Binding on PORT=', PORT);
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Endpoint de health extendido (cola)
app.get('/healthz', async (_req, res) => {
  try {
    const queueOk = !!pdfQueue;
    res.json({ ok: true, queue: queueOk });
  } catch {
    res.json({ ok: true, queue: false });
  }
});

