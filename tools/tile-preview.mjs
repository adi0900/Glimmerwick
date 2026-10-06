// Seam check for tileable textures: renders each PNG tiled 2x2 (256 px cells) in a contact sheet.
// Usage: node tools/tile-preview.mjs OUT.png tex1.png tex2.png ...
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';

const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) { console.error('usage: tile-preview.mjs OUT.png a.png b.png ...'); process.exit(3); }
const data = files.map((f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
const { browser, close } = await launchBrowser({ width: 1100, height: 1100 });
try {
  const page = await browser.newPage();
  const url = await page.evaluate(async (imgs) => {
    const cell = 256, reps = 2, size = cell * reps, cols = 2, rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas'); c.width = cols * size; c.height = rows * size;
    const g = c.getContext('2d');
    for (let i = 0; i < imgs.length; i++) {
      const im = new Image(); im.src = imgs[i]; await im.decode();
      for (let y = 0; y < reps; y++) for (let x = 0; x < reps; x++)
        g.drawImage(im, (i % cols) * size + x * cell, Math.floor(i / cols) * size + y * cell, cell, cell);
    }
    return c.toDataURL('image/png');
  }, data);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ok: true, out, textures: files.length }));
} finally { await close(); }
