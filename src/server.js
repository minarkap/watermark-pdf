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

// Lock para descargas concurrentes en modo inline/worker
const downloadPromises = new Map();

// Cola en Redis (BullMQ)
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '';
let connection = null;
let pdfQueue = null;
let workerActive = false;
if (REDIS_URL) {
  const u = (() => { try { return new URL(REDIS_URL); } catch { return null; } })();
  const needTls = (u && u.protocol === 'rediss:') || process.env.REDIS_FORCE_TLS === 'true';
  connection = { url: REDIS_URL, maxRetriesPerRequest: null, enableReadyCheck: false, ...(needTls ? { tls: { rejectUnauthorized: false } } : {}) };
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
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 30000);
  const maxRetries = Number(process.env.FETCH_RETRIES || 3);
  const baseDelay = Number(process.env.FETCH_RETRY_BASE_MS || 1000);
  const tryFetch = async (u) => {
    console.log('[DL] GET', u);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(u, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PDFWatermark/1.0; +render)' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const ct = resp.headers.get('content-type') || '';
      console.log('[DL] OK', ct, buf.length, 'bytes');
      if (ct.startsWith('application/pdf') || buf.slice(0, 5).toString() === '%PDF-') return buf;
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  const fetchWithRetry = async (u) => {
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxRetries) {
      try {
        const buf = await tryFetch(u);
        if (buf) return buf;
        throw new Error('Contenido no es PDF');
      } catch (e) {
        lastErr = e;
        const isAbort = String(e?.name).includes('AbortError');
        const msg = String(e?.message || '');
        const retryable = isAbort || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(msg);
        attempt += 1;
        if (!retryable || attempt >= maxRetries) break;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`[DL] fallo (${attempt}/${maxRetries}) ${msg}. Reintentando en ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr || new Error('Fallo de descarga');
  };

  // Preferir enlace directo usercontent cuando se puede
  const id = extractDriveIdFromUrl(urlString);
  const usercontentUrl = id ? `https://drive.usercontent.google.com/uc?export=download&id=${id}` : null;

  // Orden: 1) usercontent (si hay id) 2) original share link (fallback)
  if (usercontentUrl) {
    try {
      const buf = await fetchWithRetry(usercontentUrl);
      if (buf) return buf;
    } catch (e) {
      console.warn('[DL] usercontent falló, intentando share link:', e?.message);
    }
  }

  try {
    const buf = await fetchWithRetry(urlString);
    if (buf) return buf;
  } catch (e) {
    console.warn('[DL] share link falló:', e?.message);
  }

  throw new Error('Contenido descargado no parece ser PDF (usa enlaces drive.usercontent o revisa permisos)');
}

dotenv.config();
console.log('Boot OK');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Storage persistente de zips por token (memoria + disco)
const downloadTokens = new Map(); // token -> { path, expiresAt, filename }
const ZIP_TTL_MS = 1000 * 60 * 60 * 48; // 48h
// Usar directorio persistente que sobrevive a redeploys
const PERSISTENT_DIR = process.env.PERSISTENT_STORAGE_PATH || path.join(__dirname, '..', 'persistent');
const TOKENS_STORE = path.join(PERSISTENT_DIR, 'download_tokens.json');

async function saveTokensToDisk() {
  try {
    await fs.mkdir(PERSISTENT_DIR, { recursive: true });
    const serial = [];
    for (const [token, v] of downloadTokens.entries()) {
      serial.push({ token, path: v.path, filename: v.filename, expiresAt: v.expiresAt });
    }
    await fs.writeFile(TOKENS_STORE, JSON.stringify(serial));
  } catch (e) {
    console.warn('[TOKENS] No se pudo guardar:', e?.message);
  }
}

async function loadTokensFromDisk() {
  try {
    await fs.mkdir(PERSISTENT_DIR, { recursive: true });
    const content = await fs.readFile(TOKENS_STORE, 'utf8').catch(() => '[]');
    const arr = JSON.parse(content);
    const now = Date.now();
    for (const entry of arr) {
      try {
        if (!entry?.token || !entry?.path) continue;
        const st = await fs.stat(entry.path).catch(() => null);
        if (!st) continue;
        if (now > (entry.expiresAt || 0)) {
          await fs.rm(entry.path).catch(() => {});
          continue;
        }
        downloadTokens.set(entry.token, { path: entry.path, filename: entry.filename, expiresAt: entry.expiresAt });
      } catch {}
    }
    // Reescribir limpiando expirados/no existentes
    await saveTokensToDisk();
    if (downloadTokens.size > 0) console.log(`[TOKENS] Restaurados ${downloadTokens.size} tokens activos`);
  } catch (e) {
    console.warn('[TOKENS] No se pudo cargar:', e?.message);
  }
}

// Cargar tokens persistidos al arranque
await loadTokensFromDisk();

app.get('/download/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const entry = downloadTokens.get(token);
    if (!entry) return res.status(404).send('Link no válido o expirado');
    if (Date.now() > entry.expiresAt) {
      try { await fs.rm(entry.path).catch(() => {}); } catch {}
      downloadTokens.delete(token);
      await saveTokensToDisk();
      return res.status(410).send('Link expirado');
    }
    return res.download(entry.path, entry.filename || 'descargables.zip');
  } catch {
    res.status(500).send('Error de descarga');
  }
});

// Limpieza periódica de zips expirados
setInterval(async () => {
  const now = Date.now();
  let dirty = false;
  for (const [token, entry] of downloadTokens.entries()) {
    if (now > entry.expiresAt) {
      try { await fs.rm(entry.path).catch(() => {}); } catch {}
      downloadTokens.delete(token);
      dirty = true;
    }
  }
  if (dirty) await saveTokensToDisk();
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

  if (pdfQueue && workerActive) {
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

    const offerKeys = [];
    for (const [key, config] of Object.entries(offerMappings)) {
      if (kajabiOfferTitle && typeof config.match === 'function' && config.match(kajabiOfferTitle)) {
        offerKeys.push(key);
      }
    }

    const outputsMain = [];
    const outputsBonus = [];
    if (offerKeys.length > 0) {
      console.log(`[FLOW] Ofertas detectadas: ${offerKeys.join(', ')}`);
      for (const offerKey of offerKeys) {
        const config = offerMappings[offerKey];
        console.log(`[FLOW] Procesando pack '${offerKey}'...`);
        let filesToProcess = [];

        // Siempre procesar TODOS los archivos de las URLs (tanto locales como remotos)
        const urlsJson = process.env[config.urls_env];
        if (urlsJson) {
          try {
            const list = JSON.parse(urlsJson);
            if (Array.isArray(list) && list.length > 0) {
              filesToProcess = list.map(item => {
                const localPath = path.join(config.dir, item.name);
                // Verificar si el archivo ya está descargado localmente
                try {
                  if (fsSync.existsSync(localPath)) {
                    return {
                      name: item.name,
                      path: localPath,
                      source: 'local'
                    };
                  }
                } catch {}
                // Si no está local, marcar para descarga remota
                return {
                  name: item.name,
                  url: item.url,
                  source: 'remote'
                };
              });
            }
          } catch {
            throw new Error(`${config.urls_env} no es un JSON válido`);
          }
        }

        // Fallback: si no hay URLs configuradas, buscar archivos locales
        if (filesToProcess.length === 0) {
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
        }

        if (filesToProcess.length === 0) {
          console.warn(`[FLOW] No hay PDFs para pack '${offerKey}' (ni locales ni URLs)`);
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
              // Lock para evitar descargas concurrentes del mismo archivo
              const downloadKey = file.url;
              if (downloadPromises.has(downloadKey)) {
                console.log(`[DL] Esperando descarga concurrente de ${file.name}...`);
                bytes = await downloadPromises.get(downloadKey);
              } else {
                const promise = (async () => {
                  const b = await downloadPdfWithDriveSupport(file.url);
                  if (b.slice(0, 5).toString() !== '%PDF-') {
                    throw new Error('Contenido descargado no parece ser PDF (sin cabecera %PDF-)');
                  }
                  await fs.mkdir(config.dir, { recursive: true });
                  const dlPath = path.join(config.dir, file.name);
                  await fs.writeFile(dlPath, b);
                  return fs.readFile(dlPath);
                })();
                downloadPromises.set(downloadKey, promise);
                try {
                  bytes = await promise;
                } finally {
                  downloadPromises.delete(downloadKey); // Limpiar lock
                }
              }
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
            const target = offerKey === 'bonus_ko' ? outputsBonus : outputsMain;
            target.push({ path: sendPath, name: path.basename(sendPath) });
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

    console.log('[FLOW] Enviando email principal...');
    const firstName = fullName ? String(fullName).split(' ')[0] : undefined;
    
    // SIEMPRE crear ZIP para keto_optimizado (correo principal)
    await fs.mkdir(PERSISTENT_DIR, { recursive: true });
    const zipName = `descargables_${Date.now()}.zip`;
    const zipPath = path.join(PERSISTENT_DIR, zipName);
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(zipPath);
      const zip = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(output);
      for (const f of outputsMain) zip.file(f.path, { name: f.name });
      zip.finalize();
    });
    const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
    downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
    await saveTokensToDisk();
    const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
    const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
    await sendEmailWithAttachments({
      to: email,
      subject: `Descargables ${kajabiOfferTitle || ''}`.trim(),
      text: undefined,
      attachments: [],
      firstName: firstName,
      downloadLink: link,
      names: outputsMain.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
    });

    // Enviar BONUS en correo separado si existe - SIEMPRE como ZIP
    if (outputsBonus.length > 0) {
      console.log('[FLOW] Enviando email bonus...');
      await fs.mkdir(PERSISTENT_DIR, { recursive: true });
      const zipName = `bonus_${Date.now()}.zip`;
      const zipPath = path.join(PERSISTENT_DIR, zipName);
      await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(zipPath);
        const zip = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        zip.on('error', reject);
        zip.pipe(output);
        for (const f of outputsBonus) zip.file(f.path, { name: f.name });
        zip.finalize();
      });
      const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
      downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
      await saveTokensToDisk();
      const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
      const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
      await sendEmailWithAttachments({
        to: email,
        subject: `Descargables ${kajabiOfferTitle || ''} - Bonus`.trim(),
        text: undefined,
        attachments: [],
        firstName: firstName,
        downloadLink: link,
        names: outputsBonus.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
      });
    }

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
    const worker = new Worker(
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
      
      const offerKeys = [];
      for (const [key, config] of Object.entries(offerMappings)) {
        if (kajabiOfferTitle && typeof config.match === 'function' && config.match(kajabiOfferTitle)) {
          offerKeys.push(key);
        }
      }

      const outputsMain = [];
      const outputsBonus = [];
      if (offerKeys.length > 0) {
        console.log(`[FLOW] Ofertas detectadas: ${offerKeys.join(', ')}`);
        for (const offerKey of offerKeys) {
          const config = offerMappings[offerKey];
          console.log(`[FLOW] Procesando pack '${offerKey}'...`);
          let filesToProcess = [];

          // Siempre procesar TODOS los archivos de las URLs (tanto locales como remotos)
          const urlsJson = process.env[config.urls_env];
          if (urlsJson) {
            try {
              const list = JSON.parse(urlsJson);
              if (Array.isArray(list) && list.length > 0) {
                filesToProcess = list.map(item => {
                  const localPath = path.join(config.dir, item.name);
                  // Verificar si el archivo ya está descargado localmente
                  try {
                    if (fsSync.existsSync(localPath)) {
                      return {
                        name: item.name,
                        path: localPath,
                        source: 'local'
                      };
                    }
                  } catch {}
                  // Si no está local, marcar para descarga remota
                  return {
                    name: item.name,
                    url: item.url,
                    source: 'remote'
                  };
                });
              }
            } catch {
              throw new Error(`${config.urls_env} no es un JSON válido`);
            }
          }

          // Fallback: si no hay URLs configuradas, buscar archivos locales
          if (filesToProcess.length === 0) {
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
          }
          
          if (filesToProcess.length === 0) {
            console.warn(`[FLOW] No hay PDFs para pack '${offerKey}' (ni locales ni URLs)`);
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
                // Validar PDF y persistir en carpeta
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
              const target = offerKey === 'bonus_ko' ? outputsBonus : outputsMain;
              target.push({ path: sendPath, name: path.basename(sendPath) });
            } catch (fileErr) {
              console.error(`[FLOW] Error procesando ${file.name}:`, fileErr?.message);
              continue;
            }
          }
        }
      }

      if (!(offerKeys.length > 0)) {
        console.log('[FLOW] Oferta no mapeada, no se procesa. Título recibido:', kajabiOfferTitle);
        return;
      }

      console.log('[FLOW] Enviando email...');
      const firstNameLocal = (firstName || (fullName ? String(fullName).split(' ')[0] : undefined));
      
      // SIEMPRE crear ZIP para keto_optimizado (correo principal)
      await fs.mkdir(PERSISTENT_DIR, { recursive: true });
      const zipName = `descargables_${Date.now()}.zip`;
      const zipPath = path.join(PERSISTENT_DIR, zipName);
      await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(zipPath);
        const zip = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        zip.on('error', reject);
        zip.pipe(output);
        for (const f of outputsMain) zip.file(f.path, { name: f.name });
        zip.finalize();
      });
      const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
      downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
      await saveTokensToDisk();
      const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
      const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
      await sendEmailWithAttachments({
        to: email,
        subject: `Descargables ${kajabiOfferTitle || ''}`.trim(),
        text: undefined,
        attachments: [],
        firstName: firstNameLocal,
        downloadLink: link,
        names: outputsMain.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
      });

      // Enviar BONUS en correo separado si existe - SIEMPRE como ZIP
      if (outputsBonus.length > 0) {
        await fs.mkdir(PERSISTENT_DIR, { recursive: true });
        const zipName = `bonus_${Date.now()}.zip`;
        const zipPath = path.join(PERSISTENT_DIR, zipName);
        await new Promise((resolve, reject) => {
          const output = fsSync.createWriteStream(zipPath);
          const zip = archiver('zip', { zlib: { level: 9 } });
          output.on('close', resolve);
          zip.on('error', reject);
          zip.pipe(output);
          for (const f of outputsBonus) zip.file(f.path, { name: f.name });
          zip.finalize();
        });
        const token = createHash('sha256').update(zipName + Math.random()).digest('hex').slice(0, 32);
        downloadTokens.set(token, { path: zipPath, filename: zipName, expiresAt: Date.now() + ZIP_TTL_MS });
        await saveTokensToDisk();
        const publicBase = process.env.PUBLIC_BASE_URL || `https://` + (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '');
        const link = `${publicBase.replace(/\/$/, '')}/download/${token}`;
        await sendEmailWithAttachments({
          to: email,
          subject: `Descargables ${kajabiOfferTitle || ''} - Bonus`.trim(),
          text: undefined,
          attachments: [],
          firstName: firstNameLocal,
          downloadLink: link,
          names: outputsBonus.map(o => o.name.replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '').replace(/_/g, ' ')),
        });
      }

      console.log('[FLOW] Email enviado');
    },
    { connection, concurrency: 1 }
  );
  worker.on('ready', () => { workerActive = true; console.log('[QUEUE] Worker ready'); });
  worker.on('error', (err) => { workerActive = false; console.warn('[QUEUE] Worker error:', err?.message); });
  } catch (e) {
    console.warn('[QUEUE] Worker no iniciado, usando fallback inline:', e?.message);
    workerActive = false;
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
    res.json({ ok: true, queue: queueOk, worker: workerActive });
  } catch {
    res.json({ ok: true, queue: false, worker: false });
  }
});

