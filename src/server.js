import express from 'express';
import dotenv from 'dotenv';
import { applyCentralWatermark } from './watermark.js';
import { addSecurityFeatures } from './security.js';
import { sendEmailWithAttachments } from './mailer.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'crypto';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCb);

// Comprime un PDF si supera cierto umbral (bytes). Devuelve la ruta del archivo a usar finalmente.
async function compressIfTooLarge(inputPath, maxBytes = 20 * 1024 * 1024) {
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

dotenv.config();
console.log('Boot OK');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', async (req, res) => {
  // Soportar payload de Kajabi: puede venir como array de eventos
  const bodyRaw = req.body || {};
  const body = Array.isArray(bodyRaw) ? (bodyRaw[0] || {}) : bodyRaw;
  const kajabiOfferTitle = body?.offer?.title;
  const fullName = body?.member?.name || (body?.member?.first_name && body?.member?.last_name ? `${body.member.first_name} ${body.member.last_name}` : body?.fullName);
  const email = body?.member?.email || body?.email;
  const purchasedAt = body?.payment_transaction?.created_at || body?.purchasedAt;
  if (!fullName || !email) {
    return res.status(400).json({ error: 'Faltan parámetros: fullName y email son requeridos' });
  }

  // Responder inmediatamente
  res.json({ ok: true, message: "Procesando en segundo plano." });

  // --- Ejecutar el resto en segundo plano ---
  try {
    const timestamp = purchasedAt || new Date().toISOString();
    const watermarkText = `${fullName} | ${email} | ${timestamp}`;

    // Si es una oferta de Keto Optimizado, procesar todos los PDFs de la carpeta
    const allowedTitles = new Set([
      'Keto Optimizado',
      'OFERTA CURSO KETO OPTIMIZADO',
      'CURSO KETO OPTIMIZADO (UPSELL KETOFAST)',
      'Test Product'
    ]);
    const isKetoOptimizado = kajabiOfferTitle && allowedTitles.has(kajabiOfferTitle);

    const outputs = [];
    if (isKetoOptimizado) {
      console.log('[FLOW] Oferta Keto Optimizado detectada. Procesando carpeta descargables/keto_optimizado');
      const baseDir = path.join(__dirname, '..', 'descargables', 'keto_optimizado');
      let pdfFiles = [];
      try {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        pdfFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => path.join(baseDir, e.name));
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        console.log('[FLOW] Carpeta no encontrada en imagen. Intentando KETO_OPTIMIZADO_URLS');
      }
      if (pdfFiles.length > 0) {
        console.log(`[FLOW] PDFs locales detectados: ${pdfFiles.length}`);
        for (const pdfPath of pdfFiles) {
          try {
            console.log('[FLOW] Procesando', pdfPath);
            let bytes = await fs.readFile(pdfPath);
            // Intento de saneado con Ghostscript
            try {
              const tmpDir = path.join(__dirname, '..', 'tmp');
              await fs.mkdir(tmpDir, { recursive: true });
              const sanitizedPath = path.join(tmpDir, `sanitized_${Date.now()}.pdf`);
              await exec(`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 -sOutputFile=${sanitizedPath} -f ${pdfPath} | cat`);
              bytes = await fs.readFile(sanitizedPath);
              console.log('[FLOW] PDF saneado con Ghostscript');
            } catch (gsErr) {
              console.log('[FLOW] Ghostscript falló o no era necesario:', gsErr?.message || gsErr);
            }
            let pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
            await applyCentralWatermark(pdfDoc, watermarkText);
            const watermarkedBytes = await pdfDoc.save();
            const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
            pdfDoc = await PDFDocument.load(watermarkedBytes);
            await addSecurityFeatures(pdfDoc, watermarkText, documentHash);
            const finalBytes = await pdfDoc.save();
            const tmpDir = path.join(__dirname, '..', 'tmp');
            await fs.mkdir(tmpDir, { recursive: true });
            const outName = path.basename(pdfPath).replace(/\.pdf$/i, `_${Date.now()}.pdf`);
            const outPath = path.join(tmpDir, outName);
            await fs.writeFile(outPath, finalBytes);
            const sendPath = await compressIfTooLarge(outPath);
            outputs.push({ path: sendPath, name: path.basename(sendPath) });
            console.log('[FLOW] Listo', sendPath);
          } catch (fileErr) {
            console.error('[FLOW] Error procesando', pdfPath, '-', fileErr?.message);
            continue;
          }
        }
      } else {
        const urlsJson = process.env.KETO_OPTIMIZADO_URLS;
        if (!urlsJson) {
          throw new Error('No hay PDFs locales ni KETO_OPTIMIZADO_URLS definido');
        }
        let list;
        try {
          list = JSON.parse(urlsJson);
        } catch {
          throw new Error('KETO_OPTIMIZADO_URLS no es un JSON válido');
        }
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error('KETO_OPTIMIZADO_URLS debe ser un array no vacío');
        }
        console.log(`[FLOW] Descargando ${list.length} PDFs desde KETO_OPTIMIZADO_URLS`);
        for (const item of list) {
          const url = item?.url || item?.URL || item?.link;
          const name = item?.name || (url ? url.split('/').pop() : null);
          if (!url || !name) {
            console.log('[FLOW] Entrada inválida en KETO_OPTIMIZADO_URLS, saltando', item);
            continue;
          }
          console.log('[FLOW] Descargando', url);
          const resp = await fetch(url);
          if (!resp.ok) {
            throw new Error(`Fallo al descargar ${url}: ${resp.status} ${resp.statusText}`);
          }
          const arrayBuffer = await resp.arrayBuffer();
          try {
            let bytes = Buffer.from(arrayBuffer);
            // Intento de saneado con Ghostscript vía archivo temporal
            try {
              const tmpDir = path.join(__dirname, '..', 'tmp');
              await fs.mkdir(tmpDir, { recursive: true });
              const dlPath = path.join(tmpDir, `download_${Date.now()}.pdf`);
              const sanitizedPath = path.join(tmpDir, `sanitized_${Date.now()}.pdf`);
              await fs.writeFile(dlPath, bytes);
              await exec(`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -dCompatibilityLevel=1.6 -sOutputFile=${sanitizedPath} -f ${dlPath} | cat`);
              bytes = await fs.readFile(sanitizedPath);
              console.log('[FLOW] PDF descargado saneado con Ghostscript');
            } catch (gsErr) {
              console.log('[FLOW] Ghostscript falló o no era necesario (descarga):', gsErr?.message || gsErr);
            }
            let pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
            await applyCentralWatermark(pdfDoc, watermarkText);
            const watermarkedBytes = await pdfDoc.save();
            const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
            pdfDoc = await PDFDocument.load(watermarkedBytes);
            await addSecurityFeatures(pdfDoc, watermarkText, documentHash);
            const finalBytes = await pdfDoc.save();
            const tmpDir = path.join(__dirname, '..', 'tmp');
            await fs.mkdir(tmpDir, { recursive: true });
            const outName = name.replace(/\.pdf$/i, `_${Date.now()}.pdf`);
            const outPath = path.join(tmpDir, outName);
            await fs.writeFile(outPath, finalBytes);
            const sendPath = await compressIfTooLarge(outPath);
            outputs.push({ path: sendPath, name: path.basename(sendPath) });
            console.log('[FLOW] Listo', sendPath);
          } catch (urlErr) {
            console.error('[FLOW] Error procesando', url, '-', urlErr?.message);
            continue;
          }
        }
      }
    } else {
      console.log('[FLOW] Oferta no mapeada, no se procesa. Título recibido:', kajabiOfferTitle);
      return;
    }

    console.log('[FLOW] Enviando email con adjuntos...');
    await sendEmailWithAttachments({
      to: email,
      subject: 'Tu material personalizado',
      text: 'Adjuntamos tus descargables personalizados.',
      attachments: outputs,
    });

    console.log('[FLOW] Email enviado');

    console.log(`Proceso completado para ${email}`);

  } catch (err) {
    console.error(`--- ERROR FATAL EN SEGUNDO PLANO PARA ${email} ---`);
    console.error("Mensaje:", err.message);
    console.error("Stack:", err.stack);
    console.error("--- FIN DEL ERROR FATAL ---");
  }
});

const PORT = process.env.PORT || 3000;
console.log('Binding on PORT=', PORT);
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

