import { google } from 'googleapis';
import fs from 'fs/promises';

const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN,
  GMAIL_SENDER,
} = process.env;

const oAuth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

export async function sendEmailWithAttachments({ to, subject, text, attachments, firstName }) {
  console.log(`[MAIL] Envío a ${to} con ${attachments.length} adj.`);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const encodeHeader = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

  // Enviar un email por adjunto para personalizar asunto/cuerpo
  let idx = 0;
  for (const { path: filePath, name, contentType = 'application/pdf' } of attachments) {
    idx += 1;
    const buf = await fs.readFile(filePath);

    const baseName = (name || 'Descargable').replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '');
    const prettyName = baseName.replace(/_/g, ' ');
    const safeFirst = (firstName || '').trim() || 'intergaláctic@';
    // Asunto debe ser UNA línea
    const finalSubject = prettyName;
    const body = `¡Hola ${safeFirst}!\n\nMuchísimas gracias por tu confianza :)\n¡Ahora empieza tu cambio!\n\nAquí tienes tu PDF ${prettyName}.\n\nGuarda bien esta guía en tu móvil, ordenador o imprímela. Tenla\nsiempre a mano para que puedas acceder a ella fácilmente y consigas\ntus objetivos. ¡Es tu mapa único de transformación!\n\nUn abrazo intergaláctico 🪐\nPhil.`;

    const boundary = 'mixed_' + Date.now() + '_' + idx;
    const parts = [
      `From: ${encodeHeader('Phil Hugo')} <${GMAIL_SENDER}>`,
      `To: ${to}`,
      `Subject: ${encodeHeader(finalSubject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64'),
      '',
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      buf.toString('base64'),
      `--${boundary}--`,
    ];

    const rawMessage = parts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
    console.log(`[MAIL] OK ${idx}/${attachments.length} id=${result?.data?.id}`);
  }
}

// Compat: wrapper para una sola pieza
export async function sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentName }) {
  return sendEmailWithAttachments({
    to,
    subject,
    text,
    attachments: [{ path: attachmentPath, name: attachmentName }],
  });
}
