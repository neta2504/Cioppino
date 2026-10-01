#!/usr/bin/env node
// One-off script: re-encodes oversized PNGs in frontend/public/ to sensible
// dimensions for their actual render size. Originals are backed up next to
// the file with a `.orig` suffix the first time the script runs.
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'frontend', 'public');

// width = max dimension the asset is rendered at, doubled for retina.
const targets = [
  { file: 'icon.png',                    width: 256 },
  { file: 'sea-animals-2.png',           width: 480 },
  { file: 'ocean/cioppino-icon.png',     width: 256 },
  { file: 'ocean/nav-bottom.png',        width: 480 },
  { file: 'ocean/main-bottom.png',       width: 800 },
];

function fmtKb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

for (const t of targets) {
  const abs = path.join(PUBLIC, t.file);
  if (!existsSync(abs)) { console.log(`[skip] ${t.file} not found`); continue; }
  const backup = abs + '.orig';
  if (!existsSync(backup)) await fs.copyFile(abs, backup);
  const src = await fs.readFile(backup);
  const before = src.length;
  const out = await sharp(src)
    .resize({ width: t.width, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 85 })
    .toBuffer();
  await fs.writeFile(abs, out);
  console.log(`[ok]   ${t.file.padEnd(34)} ${fmtKb(before).padStart(10)} -> ${fmtKb(out.length).padStart(10)}  (${Math.round((1 - out.length / before) * 100)}% smaller)`);
}

console.log('\nDone. Originals preserved with .orig suffix.');
