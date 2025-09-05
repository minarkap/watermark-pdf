# PDF Watermark Webhook

Servidor Express que procesa webhooks de compra, personaliza PDFs (marca de agua central y banda de seguridad superior con metadatos y hash), y envía el resultado por email vía Gmail API.

## Funcionalidades
- Marca de agua central no seleccionable (render SVG→PNG con Sharp).
- Banda de seguridad como imagen (SVG→PNG) con icono, mensajes y hash del documento.
- Metadatos PDF (título, autor, palabras clave, fechas).
- Soporte de payload Kajabi (incluye arrays de eventos).
- Procesamiento por oferta: para títulos mapeados se procesan todos los PDFs de `descargables/keto_optimizado` en lote.
- Normalización de PDFs problemáticos (Ghostscript y copia de páginas con pdf-lib).
- Cola en memoria: las solicitudes se encolan y se procesan de forma secuencial.
- Compresión automática: si un PDF final > 17 MiB, se recomprime (/ebook) antes de enviar.
- Particionado de envíos: divide adjuntos en varios correos si el total excede ~17 MiB por mensaje.

## Requisitos
- Node 18+ (para desarrollo local)
- Cuenta de Google Cloud con Gmail API habilitada (OAuth2)
- Docker (recomendado para producción). La imagen instala fontconfig, DejaVu y Ghostscript.

## Configuración
1) Copia `.env.example` a `.env` y completa:
```
# Puerto local (producción usa PORT inyectado por la plataforma)
PORT=3000

# Gmail API OAuth2
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=https://developers.google.com/oauthplayground
GMAIL_REFRESH_TOKEN=
GMAIL_SENDER=

# Opcionales (según flujo)
# BASE_PDF_PATH=/usr/src/app/KO_ebook.pdf
# BASE_PDF_URL=https://.../KO_ebook.pdf
# KETO_OPTIMIZADO_URLS=[{"name":"Keto_Optimizado_Baja_kcal_2024.pdf","url":"https://.../Keto_Optimizado_Baja_kcal_2024.pdf"}]
```
2) El `GMAIL_REFRESH_TOKEN` debe emitirse para `GMAIL_SENDER` con el scope `https://mail.google.com/`.

## Ejecutar (desarrollo)
```bash
npm install
npm start
# o npm run dev
```

Salud:
```bash
curl -s http://localhost:3000/health
```

## Webhook
- Endpoint: `POST /webhook`
- Cuerpo (soporta dos formas):
  - Directo:
```json
{
  "fullName": "Nombre Apellido",
  "email": "cliente@example.com",
  "purchasedAt": "2025-09-03T12:34:56.000Z"
}
```
  - Kajabi (array) ejemplo:
```json
[
  {
    "offer": { "title": "Keto Optimizado" },
    "member": { "email": "cliente@example.com", "name": "Nombre Apellido" },
    "payment_transaction": { "created_at": "2025-09-04T18:55:39.864Z" },
    "event": "payment.succeeded"
  }
]
```

### Mapeo de ofertas
Se procesan todos los PDFs de `descargables/keto_optimizado` cuando `offer.title` es exactamente uno de:
- `Keto Optimizado`
- `OFERTA CURSO KETO OPTIMIZADO`
- `CURSO KETO OPTIMIZADO (UPSELL KETOFAST)`
- `Test Product`

Para cambiar estos títulos, edita `allowedTitles` en `src/server.js`.

## Notas de envío por email
- Límite por mensaje ~25 MiB en Gmail (incluye base64). El servicio usa ~17 MiB de umbral por mensaje para ir seguro y dividir en varios correos si hace falta.
- Cada PDF individual se recomprime automáticamente si supera 17 MiB (perfil `/ebook`).
- Los asuntos incluyen sufijo `(i/N)` cuando un lote requiere varios correos.

## Despliegue con Docker y Railway

### Local con Docker
```bash
docker build -t pdf-watermarker .
docker run -p 8080:8080 --env-file .env -e PORT=8080 pdf-watermarker
```
Salud: `http://localhost:8080/health`

### Railway
1. Conecta este repo desde GitHub.
2. Railway construirá usando el `Dockerfile`.
3. Variables en Railway:
   - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER`.
   - No definas `PORT` (Railway la inyecta). El servicio ya hace bind a `process.env.PORT`.
   - Opcionales: `KETO_OPTIMIZADO_URLS`, `BASE_PDF_URL`/`BASE_PDF_PATH` si usas flujos alternativos.
4. Prueba:
```bash
curl -s https://<tu-app>.up.railway.app/health
```

## Estructura relevante
- `descargables/keto_optimizado/` → PDFs base de la oferta mapeada.
- `src/watermark.js` → watermark central (SVG→PNG) y posicionamiento.
- `src/security.js` → banda superior (SVG→PNG), metadatos y hash.
- `src/mailer.js` → envío vía Gmail API, particionado por tamaño.
- `src/server.js` → endpoint, cola, normalización (Ghostscript + pdf-lib), orquestación.

## Problemas comunes
- 502 en Railway: asegúrate de no fijar `PORT`; el contenedor debe escuchar en el puerto inyectado.
- Emails no llegan: seguramente por tamaño. Revisa logs; el servicio divide en varios correos y comprime si es necesario.
- PDFs con refs inválidas/emoji: el pipeline usa DejaVu y sanitiza con Ghostscript; además reescribe páginas con pdf-lib.
