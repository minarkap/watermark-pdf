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

export async function sendEmailWithAttachments({ to, subject, text, attachments }) {
  console.log(`[MAIL] Preparando envío a ${to} via Gmail API con ${attachments.length} adjuntos`);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  // Pre-cargar buffers y tamaños
  const loaded = [];
  for (const { path: filePath, name, contentType = 'application/pdf' } of attachments) {
    const buf = await fs.readFile(filePath);
    console.log(`[MAIL] Adjunto leído ${name} (${buf.length} bytes)`);
    loaded.push({ name, contentType, buf });
  }

  // Límite conservador de 17 MiB por mensaje (base64 añade ~33%, total ~22.6 MiB)
  const MAX_BYTES = 17 * 1024 * 1024;
  const groups = [];
  let current = [];
  let acc = 0;
  for (const item of loaded) {
    const estSize = item.buf.length; // tamaño sin base64; base64 añade ~33%
    if (acc > 0 && acc + estSize > MAX_BYTES) {
      groups.push(current);
      current = [];
      acc = 0;
    }
    current.push(item);
    acc += estSize;
  }
  if (current.length) groups.push(current);

  console.log(`[MAIL] Enviando en ${groups.length} mensaje(s)`);

  let idx = 0;
  for (const group of groups) {
    idx += 1;
    const boundary = 'mixed_' + Date.now() + '_' + idx;
    const partHeaders = [
      `From: PDF Delivery <${GMAIL_SENDER}>`,
      `To: ${to}`,
      `Subject: ${subject}${groups.length > 1 ? ` (${idx}/${groups.length})` : ''}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      text,
    ];

    for (const it of group) {
      partHeaders.push(
        '',
        `--${boundary}`,
        `Content-Type: ${it.contentType}; name="${it.name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${it.name}"`,
        '',
        it.buf.toString('base64'),
      );
    }
    partHeaders.push(`--${boundary}--`);

    const rawMessage = partHeaders.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    console.log(`[MAIL] Enviando mensaje ${idx}/${groups.length} via Gmail API...`);
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
    console.log(`[MAIL] Correo enviado (${idx}/${groups.length}), id=${result?.data?.id}`);
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
