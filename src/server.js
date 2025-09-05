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
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const pdfFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => path.join(baseDir, e.name));
      console.log(`[FLOW] PDFs detectados: ${pdfFiles.length}`);
      for (const pdfPath of pdfFiles) {
        console.log('[FLOW] Procesando', pdfPath);
        const bytes = await fs.readFile(pdfPath);
        let pdfDoc = await PDFDocument.load(bytes);
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
        outputs.push({ path: outPath, name: outName });
        console.log('[FLOW] Listo', outPath);
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

