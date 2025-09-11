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

export async function sendEmailWithAttachments({ to, subject, text, attachments, firstName, downloadLink, names }) {
  console.log(`[MAIL] Envío a ${to} con ${attachments?.length || 0} adj.`);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const encodeHeader = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

  // Caso especial: sin adjuntos (p.ej. enlace de descarga ZIP)
  if (!attachments || attachments.length === 0) {
    const safeFirst = (firstName || '').trim() || 'intergaláctic@';
    const list = Array.isArray(names) ? names : [];
    const bulletsText = list.map(n => `- ${n}`).join('\n');

    const bodyText = (
      text ||
      `¡Hola, ${safeFirst}!\n\n` +
      `Muchísimas gracias por tu confianza :)\n` +
      `¡Ahora empieza tu cambio!\n\n` +
      `Aquí tienes los siguientes descargables PDF:\n\n` +
      `${bulletsText}\n\n` +
      `Puedes descargarlos todos ellos pulsando el siguiente enlace (disponible durante 72 horas):\n${downloadLink}\n\n` +
      `Guárdalos bien en tu móvil, ordenador o imprímelos. Tenlos siempre a mano para que puedas acceder a ellos fácilmente y consigas tus objetivos.\n\n` +
      `¡Son tu mapa único de transformación!\n\n` +
      `Un abrazo intergaláctico 🪐\nPhil.`
    );

    const bulletsHtml = list.map(n => `<li>${n.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</li>`).join('');
    const link = downloadLink || '#';
    const bodyHtml = (
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;white-space:normal;line-height:1.6;font-size:15px;color:#111">` +
        `<p>¡Hola, ${safeFirst}!</p>` +
        `<p>Muchísimas gracias por tu confianza :)<br/>¡Ahora empieza tu cambio!</p>` +
        `<p>Aquí tienes los siguientes descargables PDF:</p>` +
        `<ul style="margin:0 0 16px 20px;">${bulletsHtml}</ul>` +
        `<p>Puedes descargarlos todos ellos pulsando el siguiente botón (disponible durante <strong>72 horas</strong>):</p>` +
        `<p><a href="${link}" style="background:#FFC107;color:#000;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px;display:inline-block">Descargar ahora</a></p>` +
        `<p>Guárdalos bien en tu móvil, ordenador o imprímelos. Tenlos siempre a mano para que puedas acceder a ellos fácilmente y consigas tus objetivos.</p>` +
        `<p>¡Son tu mapa único de transformación!</p>` +
        `<p>Un abrazo intergaláctico 🪐<br/>Phil.</p>` +
      `</div>`
    );

    const boundary = 'alt_' + Date.now();
    const parts = [
      `From: ${encodeHeader('Phil Hugo')} <${GMAIL_SENDER}>`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject || 'Tus descargables personalizados de {$offerKey}')}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary=${boundary}`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      bodyText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      bodyHtml,
      '',
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
    console.log(`[MAIL] OK sin adjuntos id=${result?.data?.id}`);
    return;
  }

  // Enviar un email por adjunto para personalizar asunto/cuerpo
  let idx = 0;
  for (const { path: filePath, name, contentType = 'application/pdf' } of attachments) {
    idx += 1;
    const buf = await fs.readFile(filePath);

    const baseName = (name || 'Descargable').replace(/_\d+\.pdf$/i, '').replace(/\.pdf$/i, '');
    const prettyName = baseName.replace(/_/g, ' ');
    const safeFirst = (firstName || '').trim() || 'intergaláctic@';
    const finalSubject = subject || prettyName;
    const body = text || `¡Hola, ${safeFirst}!\n\nMuchísimas gracias por tu confianza :)\n¡Ahora empieza tu cambio!\n\nAquí tienes tu PDF ${prettyName}.\n\nGuarda bien esta guía en tu móvil, ordenador o imprímela. Tenla siempre a mano para que puedas acceder a ella fácilmente y consigas tus objetivos.\n\n¡Es tu mapa único de transformación!\n\nUn abrazo intergaláctico 🪐\nPhil.`;

    const boundary = 'mixed_' + Date.now() + '_' + idx;
    const altBoundary = 'alt_' + Date.now() + '_' + idx;
    const parts = [
      `From: ${encodeHeader('Phil Hugo')} <${GMAIL_SENDER}>`,
      `To: ${to}`,
      `Subject: ${encodeHeader(finalSubject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      '',
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary=${altBoundary}`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;white-space:normal;line-height:1.5;font-size:14px;color:#111">`
        + `<p>¡Hola, ${safeFirst}!</p>`
        + `<p>Muchísimas gracias por tu confianza :)<br/>¡Ahora empieza tu cambio!</p>`
        + `<p>Aquí tienes tu PDF ${prettyName}.</p>`
        + `<p>Guarda bien esta guía en tu móvil, ordenador o imprímela. Tenla siempre a mano para que puedas acceder a ella fácilmente y consigas tus objetivos.</p>`
        + `<p>¡Es tu mapa único de transformación!</p>`
        + `<p>Un abrazo intergaláctico 🪐<br/>Phil.</p>`
      + `</div>`,
      '',
      `--${altBoundary}--`,
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

export async function sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentName }) {
  return sendEmailWithAttachments({
    to,
    subject,
    text,
    attachments: [{ path: attachmentPath, name: attachmentName }],
  });
}
