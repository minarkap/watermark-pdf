import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs/promises';
import sharp from 'sharp';

export async function applyCentralWatermark(pdfDoc, watermarkText) {
  // Log compacto
  console.log("[WM] Inicio");

  const pages = pdfDoc.getPages();
  
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    
    try {
      // Calcular tamaño adaptativo del watermark
      // Para diapositivas (landscape): más pequeño
      // Para páginas verticales: tamaño medio
      const isLandscape = width > height;
      const minDimension = Math.min(width, height);
      
      // Tamaño base del font adaptado al tamaño de página
      // Reducido significativamente para diapositivas
      let baseFontSize;
      if (minDimension < 400) {
        // Página muy pequeña
        baseFontSize = 8;
      } else if (isLandscape) {
        // Diapositivas/presentaciones (landscape)
        baseFontSize = Math.max(10, Math.min(14, Math.floor(minDimension * 0.018)));
      } else {
        // Páginas verticales normales
        baseFontSize = Math.max(12, Math.min(16, Math.floor(minDimension * 0.02)));
      }
      
      // Generar SVG del watermark con tamaño adaptado
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <style>
    .wm { font-family: 'DejaVu Sans', Helvetica, Arial, sans-serif; font-size: ${baseFontSize * 2.5}px; fill: #666666; }
  </style>
  <g transform="translate(600,600) rotate(45) translate(-600,-600)">
    <text x="600" y="600" text-anchor="middle" dominant-baseline="middle" class="wm">${watermarkText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>
  </g>
</svg>`;

      // Renderizar el watermark
      // NO paletizar para preservar correctamente el canal alfa/transparencia
      const pngBuffer = await sharp(Buffer.from(svg))
        .png({ compressionLevel: 6, quality: 90 })
        .toBuffer();
      const wmImage = await pdfDoc.embedPng(pngBuffer);
      
      // Tamaño del watermark ajustado:
      // - Diapositivas: 50% del ancho
      // - Páginas verticales: 55% del ancho
      const targetWidthRatio = isLandscape ? 0.50 : 0.55;
      const targetWidth = width * targetWidthRatio;
      const scale = targetWidth / wmImage.width;
      const drawWidth = wmImage.width * scale;
      const drawHeight = wmImage.height * scale;
      
      // Centrar el watermark
      const centerX = width / 2;
      const centerY = height / 2;
      
      // Dibujar el watermark
      page.drawImage(wmImage, {
        x: centerX - (drawWidth / 2),
        y: centerY - (drawHeight / 2),
        width: drawWidth,
        height: drawHeight,
        opacity: 0.3, // Reducir un poco la opacidad
      });
      
    } catch (err) {
      console.error(`[WM] Error al dibujar watermark en página ${pageIndex + 1}:`, err?.message);
      throw err;
    }
  }
  
  console.log(`[WM] Watermark aplicado en ${pages.length} páginas`);
}
