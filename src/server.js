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
console.log('Boot OK');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', async (req, res) => {
  const { fullName, email, purchasedAt } = req.body || {};
  if (!fullName || !email) {
    return res.status(400).json({ error: 'Faltan parámetros: fullName y email son requeridos' });
  }

  // Responder inmediatamente
  res.json({ ok: true, message: "Procesando en segundo plano." });

  // --- Ejecutar el resto en segundo plano ---
  try {
    const timestamp = purchasedAt || new Date().toISOString();
    const watermarkText = `${fullName} | ${email} | ${timestamp}`;

    // Intentar leer KO_ebook.pdf de disco; si no existe en el contenedor, descargar desde BASE_PDF_URL
    const configuredPath = process.env.BASE_PDF_PATH || path.join(__dirname, '..', 'KO_ebook.pdf');
    let pdfBytes;
    try {
      console.log('[FLOW] Intentando leer PDF base de', configuredPath);
      pdfBytes = await fs.readFile(configuredPath);
    } catch (readErr) {
      if (readErr?.code === 'ENOENT' && process.env.BASE_PDF_URL) {
        console.log('[FLOW] PDF base no encontrado. Descargando desde BASE_PDF_URL');
        const resp = await fetch(process.env.BASE_PDF_URL);
        if (!resp.ok) {
          throw new Error(`No se pudo descargar BASE_PDF_URL: ${resp.status} ${resp.statusText}`);
        }
        const arrayBuffer = await resp.arrayBuffer();
        pdfBytes = Buffer.from(arrayBuffer);
        console.log('[FLOW] PDF base descargado en memoria');
      } else {
        throw readErr;
      }
    }
    
    // 1. Cargar PDF y aplicar watermark central
    console.log('[FLOW] Cargando PDF base');
    let pdfDoc = await PDFDocument.load(pdfBytes);
    console.log('[FLOW] PDF cargado, aplicando watermark central');
    await applyCentralWatermark(pdfDoc, watermarkText);
    
    // 2. Guardar en buffer intermedio y calcular hash
    console.log('[FLOW] Guardando PDF con watermark central (intermedio)');
    const watermarkedBytes = await pdfDoc.save();
    const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
    console.log('[FLOW] Hash calculado:', documentHash.slice(0, 16) + '...');

    // 3. Volver a cargar y aplicar banda de seguridad con el hash
    console.log('[FLOW] Reabriendo PDF intermedio para aplicar banda de seguridad');
    pdfDoc = await PDFDocument.load(watermarkedBytes);
    await addSecurityFeatures(pdfDoc, watermarkText, documentHash);

    // 4. Guardar PDF final
    const tmpDir = path.join(__dirname, '..', 'tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `KO_ebook_${Date.now()}.pdf`);
    console.log('[FLOW] Guardando PDF final a', outputPath);
    const finalBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, finalBytes);
    console.log('[FLOW] PDF final escrito en disco');

    // 5. Enviar correo (best-effort)
    console.log('[FLOW] Enviando email con adjunto...');
    await sendEmailWithAttachment({
      to: email,
      subject: 'Tu PDF con acceso personal',
      text: 'Adjuntamos tu copia personalizada del material.',
      attachmentPath: outputPath,
      attachmentName: 'KO_ebook.pdf',
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

