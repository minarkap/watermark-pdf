import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import sharp from 'sharp';
import { createHash } from 'crypto';

export async function createWatermarkedPdf({ inputPath, outputPath, watermarkText }) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();

    // 2. Banda de seguridad
    const bandHeight = 40;
    const bandY = height - bandHeight;
    page.drawRectangle({
      x: 0,
      y: bandY,
      width,
      height: bandHeight,
      color: rgb(0.2, 0.2, 0.2),
    });

    const hash = createHash('sha256').update(watermarkText).digest('hex').substring(0, 16);
    const warningText = `🔒 Venta/distribución prohibida. Documento firmado para ${fullName} (${email}). Hash: ${hash}`;
    const threatText = "Cualquier publicación será denunciada inmediatamente.";

    page.drawText(warningText, {
      x: 10,
      y: bandY + bandHeight - 15,
      size: 8,
      color: rgb(0.8, 0.8, 0.8),
    });
    page.drawText(threatText, {
      x: 10,
      y: bandY + bandHeight - 30,
      size: 8,
      color: rgb(0.8, 0.8, 0.8),
    });

    // Watermark central (código anterior)
    const fontSize = Math.max(12, Math.min(18, Math.floor(Math.min(width, height) * 0.02)));
    const font = await pdfDoc.embedFont(PDFDocument.StandardFonts.Helvetica);
    const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);
    const textHeight = font.heightAtSize(fontSize);

    const x = (width - textWidth) / 2;
    const y = (height - textHeight) / 2;

    page.drawText(watermarkText, {
      x,
      y,
      size: fontSize,
      color: rgb(0.5, 0.5, 0.5),
      rotate: degrees(45),
    });
  }

  const updatedPdfBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, updatedPdfBytes);
  return outputPath;
}
