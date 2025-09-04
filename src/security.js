import { rgb } from 'pdf-lib';
import { createHash } from 'crypto';
import sharp from 'sharp';

export async function addSecurityFeatures(pdfDoc, watermarkText, documentHash) {
  console.log("--- APLICANDO BANDA DE SEGURIDAD Y METADATOS (COMO IMAGEN) ---");
  
  const [fullName, email, timestamp] = watermarkText.split(' | ');
  pdfDoc.setTitle('Analíticas Esenciales');
  pdfDoc.setAuthor('INTERGALACTIC SL');
  pdfDoc.setSubject(`Documento personal para ${fullName} (${email})`);
  pdfDoc.setKeywords(['analiticas', 'esenciales', 'privado', fullName, email]);
  pdfDoc.setProducer('Sistema de Watermarking v1.0');
  pdfDoc.setCreationDate(new Date(timestamp || Date.now()));
  pdfDoc.setModificationDate(new Date());

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const bandHeight = 36;

    const line1 = "Documento encriptado y firmado electrónicamente. Datos guardados y trazados.";
    const line2 = `${fullName} | ${email} | ${documentHash}`;
    const line3 = "La venta, distribución y/o comercialización de este contenido está prohibida y será denunciada.";

    const bandSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bandHeight}">
        <style>
          .bg { fill: rgb(51, 51, 51); }
          .l1 { font-family: Helvetica, Arial, sans-serif; font-size: 9px; font-weight: bold; fill: white; }
          .l2 { font-family: Helvetica, Arial, sans-serif; font-size: 6px; fill: rgb(153, 204, 255); }
          .l3 { font-family: Helvetica, Arial, sans-serif; font-size: 6px; font-style: italic; fill: white; }
        </style>
        <rect width="100%" height="100%" class="bg" />
        <svg x="10" y="${(bandHeight / 2) - 10}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <text x="40" y="12" class="l1">${line1}</text>
        <text x="40" y="22" class="l2">${line2}</text>
        <text x="40" y="30" class="l3">${line3}</text>
      </svg>
    `;

    const dpi = 96; // Bajar la resolución para la prueba
    const bandPngBuffer = await sharp(Buffer.from(bandSvg), { density: dpi }).png().toBuffer();
    const bandImage = await pdfDoc.embedPng(bandPngBuffer);

    page.drawImage(bandImage, {
      x: 0,
      y: height - bandHeight,
      width: width,
      height: bandHeight,
    });
  }
}
