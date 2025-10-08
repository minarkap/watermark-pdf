#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { applyCentralWatermark } from '../src/watermark.js';
import { addSecurityFeatures } from '../src/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`Usage: node bin/watermark-cli.js --in <input.pdf|url> --out <output.pdf> --name <Full Name> --email <user@example.com> [--timestamp <ISO>] [--text <custom>]

Options:
  --in, -i         Ruta a PDF de entrada o URL (http/https, soporta Google Drive share links)
  --out, -o        Ruta de salida (PDF)
  --name, -n       Nombre completo (requerido si no se usa --text)
  --email, -e      Email (requerido si no se usa --text)
  --timestamp, -t  ISO opcional (por defecto: ahora)
  --text           Texto completo del watermark (sobrescribe name/email/timestamp)
  --help, -h       Mostrar ayuda
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--in':
      case '-i': args.in = v; i++; break;
      case '--out':
      case '-o': args.out = v; i++; break;
      case '--name':
      case '-n': args.name = v; i++; break;
      case '--email':
      case '-e': args.email = v; i++; break;
      case '--timestamp':
      case '-t': args.timestamp = v; i++; break;
      case '--text': args.text = v; i++; break;
      case '--help':
      case '-h': args.help = true; break;
      default: args._.push(k); break;
    }
  }
  return args;
}

function extractDriveIdFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.hostname.includes('drive.google.com') || u.hostname.includes('docs.google.com') || u.hostname.includes('googleusercontent.com')) {
      if (u.searchParams.get('id')) return u.searchParams.get('id');
      const m = u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function readInputPdf(input) {
  if (/^https?:\/\//i.test(input)) {
    const id = extractDriveIdFromUrl(input);
    const usercontentUrl = id ? `https://drive.usercontent.google.com/uc?export=download&id=${id}` : null;
    const tryUrl = async (u) => {
      const resp = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (CLI PDF WM)' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!(resp.headers.get('content-type') || '').startsWith('application/pdf') && buf.slice(0, 5).toString() !== '%PDF-') {
        throw new Error('Contenido no parece PDF');
      }
      return buf;
    };
    if (usercontentUrl) {
      try { return await tryUrl(usercontentUrl); } catch {}
    }
    return await tryUrl(input);
  }
  return await fs.readFile(input);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
  if (!args.in || !args.out || (!args.text && (!args.name || !args.email))) {
    printHelp();
    process.exit(1);
  }

  const timestamp = args.timestamp || new Date().toISOString();
  const watermarkText = args.text || `${args.name} | ${args.email} | ${timestamp}`;

  const inputBuf = await readInputPdf(args.in);
  let pdfDoc = await PDFDocument.load(inputBuf, { ignoreEncryption: true });
  await applyCentralWatermark(pdfDoc, watermarkText);
  const watermarkedBytes = await pdfDoc.save();
  const documentHash = createHash('sha256').update(watermarkedBytes).digest('hex');
  pdfDoc = await PDFDocument.load(watermarkedBytes);
  await addSecurityFeatures(pdfDoc, watermarkText, documentHash);
  const finalBytes = await pdfDoc.save();

  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(args.out, finalBytes);
  console.log(`OK -> ${args.out}`);
}

main().catch((e) => {
  console.error('ERROR:', e?.message || e);
  process.exit(1);
});


