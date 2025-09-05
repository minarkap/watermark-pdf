# PDF Watermark Webhook

Servidor Express que, dado un webhook con datos de compra, marca un PDF con nombre, email y timestamp, y lo envía al correo del cliente usando Gmail API (GCP).

## Requisitos
- Node 18+
- Credenciales de OAuth2 en Google Cloud (Gmail API habilitada)
- Archivo `analiticas_esenciales.pdf` en la raíz del proyecto

## Configuración
1. Copia `.env.example` a `.env` y completa:
```
PORT=3000
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=https://developers.google.com/oauthplayground
GMAIL_REFRESH_TOKEN=
GMAIL_SENDER=
```

2. Obtén `GMAIL_REFRESH_TOKEN` usando el OAuth2 Playground o tu propio flujo para la cuenta remitente (`GMAIL_SENDER`). Permisos mínimos: `https://mail.google.com/`.

## Ejecutar
```bash
npm run dev
```

## Webhook
Endpoint: `POST /webhook`
Body JSON:
```json
{
  "fullName": "Nombre Apellido",
  "email": "cliente@example.com",
  "purchasedAt": "2025-09-03T12:34:56.000Z" // opcional
}
```

## Notas
- El PDF marcado se genera en `tmp/` con nombre único y se adjunta al correo.
- El texto de marca de agua se dibuja en el pie de cada página.
- Ajusta estilo y posición de la marca en `src/watermark.js` si lo necesitas.

## Despliegue con Docker y Railway

### Ejecutar con Docker (localmente)

1.  **Construir la imagen:**
    ```bash
    docker build -t pdf-watermarker .
    ```

2.  **Ejecutar el contenedor:**
    ```bash
    docker run -p 3000:3000 --env-file .env pdf-watermarker
    ```
    El servicio estará disponible en `http://localhost:3000`.

### Despliegue en Railway

1.  **Sube este repositorio a GitHub.**

2.  **Crea un nuevo proyecto en Railway** y vincúlalo a tu repositorio de GitHub.

3.  **Railway detectará el `Dockerfile`** y construirá y desplegará la imagen automáticamente.

4.  **Configura las variables de entorno** en el panel de Railway. Ve a la pestaña "Variables" de tu servicio y añade todas las claves y valores de tu archivo `.env`:
    *   `GMAIL_CLIENT_ID`
    *   `GMAIL_CLIENT_SECRET`
    *   `GMAIL_REDIRECT_URI`
    *   `GMAIL_REFRESH_TOKEN`
    *   `GMAIL_SENDER`

5.  Railway te proporcionará una URL pública donde tu servicio estará disponible. Usa esa URL para configurar tu webhook.
