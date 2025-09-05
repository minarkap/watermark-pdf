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

  const boundary = 'mixed_' + Date.now();
  const messageParts = [
    `From: PDF Delivery <${GMAIL_SENDER}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
  ];

  for (const { path: filePath, name, contentType = 'application/pdf' } of attachments) {
    const fileBuf = await fs.readFile(filePath);
    console.log(`[MAIL] Adjunto leído ${name} (${fileBuf.length} bytes)`);
    messageParts.push(
      '',
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      fileBuf.toString('base64'),
    );
  }

  messageParts.push(`--${boundary}--`);

  const rawMessage = messageParts.join('\r\n');
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  console.log('[MAIL] Enviando mensaje via Gmail API...');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });
  console.log('[MAIL] Correo enviado via Gmail API');
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
