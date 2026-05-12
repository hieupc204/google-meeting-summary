import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svg = readFileSync(resolve(root, 'icons/icon.svg'));

const sizes = [16, 48, 128];
for (const size of sizes) {
  const out = resolve(root, `icons/icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`✓ icons/icon-${size}.png`);
}
console.log('Done.');
