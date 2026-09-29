// Builds all app icons + iOS splash images from the Shine logo.
//   node scripts/make-icons.mjs "C:/Users/Shiva/Downloads/shine png.png"
import sharp from 'sharp';
import fs from 'node:fs';

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/make-icons.mjs <logo.png>'); process.exit(1); }
fs.mkdirSync('public/icons', { recursive: true });
fs.mkdirSync('public/splash', { recursive: true });

// Trim the white margin so the mark fills the frame.
const trimmed = await sharp(src).flatten({ background: '#ffffff' }).trim({ threshold: 12 }).png().toBuffer();
const meta = await sharp(trimmed).metadata();
fs.writeFileSync('public/logo.png', await sharp(trimmed).resize({ width: 512, withoutEnlargement: true }).png().toBuffer());

// Logo centred on a white canvas; `fill` = share of the shorter side the logo may use.
async function canvas(w, h, fill) {
  const box = Math.round(Math.min(w, h) * fill);
  const logo = await sharp(trimmed).resize({ width: box, height: box, fit: 'inside' }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
}

const icons = [
  ['icons/icon-192.png', 192, 0.72], ['icons/icon-512.png', 512, 0.72],
  ['icons/maskable-192.png', 192, 0.52], ['icons/maskable-512.png', 512, 0.52], // maskable: keep inside the safe zone
  ['icons/apple-touch-icon.png', 180, 0.72], ['icons/favicon-32.png', 32, 0.9], ['icons/favicon-16.png', 16, 0.9],
];
for (const [file, size, fill] of icons) fs.writeFileSync(`public/${file}`, await canvas(size, size, fill));

// iOS launch (splash) images: [width, height, device-width, device-height, ratio]
const splashes = [
  [640, 1136, 320, 568, 2], [750, 1334, 375, 667, 2], [1242, 2208, 414, 736, 3], [1125, 2436, 375, 812, 3],
  [828, 1792, 414, 896, 2], [1242, 2688, 414, 896, 3], [1170, 2532, 390, 844, 3], [1284, 2778, 428, 926, 3],
  [1179, 2556, 393, 852, 3], [1290, 2796, 430, 932, 3], [1536, 2048, 768, 1024, 2], [1668, 2224, 834, 1112, 2], [2048, 2732, 1024, 1366, 2],
];
const list = [];
for (const [w, h, dw, dh, r] of splashes) {
  const f = `splash/${w}x${h}.png`;
  fs.writeFileSync(`public/${f}`, await canvas(w, h, 0.42));
  list.push({ url: `/${f}`, media: `(device-width: ${dw}px) and (device-height: ${dh}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)` });
}
fs.writeFileSync('src/lib/splash.json', JSON.stringify(list, null, 2));
console.log(`logo ${meta.width}x${meta.height} -> ${icons.length} icons, ${splashes.length} splash images`);
