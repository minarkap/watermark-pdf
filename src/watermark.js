import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs/promises';
import sharp from 'sharp';

export async function applyCentralWatermark(pdfDoc, watermarkText) {
  console.log("--- APLICANDO WATERMARK CENTRAL ---");

  const pages = pdfDoc.getPages();
  const firstSize = pages[0].getSize();
  const baseFontSize = Math.max(12, Math.min(18, Math.floor(Math.min(firstSize.width, firstSize.height) * 0.02)));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <style>
    .wm { font-family: 'DejaVu Sans', Helvetica, Arial, sans-serif; font-size: ${baseFontSize * 3}px; fill: #666666; }
  </style>
  <g transform="translate(600,600) rotate(45) translate(-600,-600)">
    <text x="600" y="600" text-anchor="middle" dominant-baseline="middle" class="wm">${watermarkText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>
  </g>
</svg>`;

  // Renderizar una sola vez y reutilizar en todas las páginas; paletizar para reducir tamaño
  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ palette: true, compressionLevel: 9, effort: 6 })
    .toBuffer();
  const wmImage = await pdfDoc.embedPng(pngBuffer);

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    try {
      const targetWidth = width * 0.8;
      const scale = targetWidth / wmImage.width;
      const drawWidth = wmImage.width * scale;
      const drawHeight = wmImage.height * scale;
      const centerX = width / 2;
      const centerY = height / 2;
      page.drawImage(wmImage, {
        x: centerX - (drawWidth / 2),
        y: centerY - (drawHeight / 2),
        width: drawWidth,
        height: drawHeight,
        opacity: 0.5,
      });
      console.log(`[WM] Watermark dibujado en página ${pageIndex + 1}`);
    } catch (err) {
      console.error(`[WM] Error al dibujar watermark central en página ${pageIndex + 1}:`, err?.message);
      throw err;
    }
  }
}
