import express from 'express';
import dotenv from 'dotenv';
import { applyCentralWatermark } from './watermark.js';
import { addSecurityFeatures } from './security.js';
import { sendEmailWithAttachment } from './mailer.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', async (req, res) => {
  try {
    const { fullName, email, purchasedAt } = req.body || {};
    if (!fullName || !email) {
      return res.status(400).json({ error: 'Faltan parámetros: fullName y email son requeridos' });
    }
    const timestamp = purchasedAt || new Date().toISOString();
    const watermarkText = `${fullName} | ${email} | ${timestamp}`;

    const sourcePdfPath = path.join(__dirname, '..', 'analiticas_esenciales.pdf');
    const pdfBytes = await fs.readFile(sourcePdfPath);
    
    // 1. Cargar PDF y aplicar watermark central
    let pdfDoc = await PDFDocument.load(pdfBytes);
    await applyCentralWatermark(pdfDoc, watermarkText);
    
    // 2. Guardar en buffer intermedio y calcular hash
    const watermarkedBytes = await pdfDoc.save();
    const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');

    // 3. Volver a cargar y aplicar banda de seguridad con el hash
    pdfDoc = await PDFDocument.load(watermarkedBytes);
    await addSecurityFeatures(pdfDoc, watermarkText, documentHash);

    // 4. Guardar PDF final
    const tmpDir = path.join(__dirname, '..', 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `analiticas_esenciales_${Date.now()}.pdf`);
    const finalBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, finalBytes);

    // 5. Enviar correo (best-effort)
    try {
      await sendEmailWithAttachment({
        to: email,
        subject: 'Tu PDF con acceso personal',
        text: 'Adjuntamos tu copia personalizada del material.',
        attachmentPath: outputPath,
        attachmentName: 'analiticas_esenciales.pdf',
      });
    } catch (e) {
      console.warn('No se pudo enviar el correo:', e?.message || e);
    }

    res.json({ ok: true, outputPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error procesando el webhook' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

