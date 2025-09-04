import { google } from 'googleapis';
import nodemailer from 'nodemailer';
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

export async function sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentName }) {
  console.log(`[MAIL] Preparando envío a ${to}`);
  const accessTokenObj = await oAuth2Client.getAccessToken();
  const accessToken = typeof accessTokenObj === 'string' ? accessTokenObj : accessTokenObj?.token;
  if (!accessToken) {
    console.error('[MAIL] No se pudo obtener accessToken de OAuth2');
  } else {
    console.log('[MAIL] Access token obtenido');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: GMAIL_SENDER,
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_REFRESH_TOKEN,
      accessToken,
    },
  });

  const attachment = await fs.readFile(attachmentPath);
  console.log(`[MAIL] Adjunto leído (${attachment.length} bytes)`);

  console.log('[MAIL] Enviando correo...');
  await transporter.sendMail({
    from: `PDF Delivery <${GMAIL_SENDER}>`,
    to,
    subject,
    text,
    attachments: [
      {
        filename: attachmentName,
        content: attachment,
        contentType: 'application/pdf',
      },
    ],
  });
  console.log('[MAIL] Correo enviado');
}
