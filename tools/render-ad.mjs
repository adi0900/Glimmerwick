// Renders a composer page in showcase/nullmotion/ad/ deterministically (GSAP timeline + plate frames) to JPEG frames at 30 fps.
// Usage: node tools/render-ad.mjs [--page trailer.html] [--dur 57] --stills 1.0,3.5,8.4   -> ad/stills/still_<t>.jpg
//        node tools/render-ad.mjs [--page trailer.html] [--dur 57]                          -> ad/frames/00000.jpg ...
// (defaults: ad.html, 55 s). The plate frame counts are read from ad/plates/plates.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const stillsIdx = args.indexOf('--stills');
const FPS = 30, DUR = Number(opt('--dur', 55)), W = 1920, H = 1080;
const PAGE = opt('--page', 'ad.html');
const AD = path.resolve('showcase/nullmotion/ad');
const counts = JSON.parse(fs.readFileSync(path.join(AD, 'plates', 'plates.json'), 'utf8'));
const { browser, close } = await launchBrowser({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text()); });
  await page.goto(pathToFileURL(path.join(AD, PAGE)).href, { waitUntil: 'networkidle2' });
  await page.evaluate((c) => Object.assign(window.COUNTS || {}, c), counts);
  console.error('fonts ok:', await page.evaluate(() => window.READY));
  const shot = async (f, file) => { await page.evaluate((f) => window.renderFrame(f), f); await page.screenshot({ path: file, type: 'jpeg', quality: 95 }); };
  if (stillsIdx >= 0) {
    const dir = path.join(AD, 'stills'); fs.mkdirSync(dir, { recursive: true });
    // stills are rendered in time order so GSAP's lazily-recorded tween start values match a real sequential render
    const times = args[stillsIdx + 1].split(',').map(Number).sort((a, b) => a - b);
    let f = 0;
    for (const t of times) {
      const target = Math.round(t * FPS);
      for (; f < target; f += Math.max(1, Math.ceil((target - f) / 6))) await page.evaluate((f) => window.renderFrame(f), f);
      await shot(target, path.join(dir, `still_${t}.jpg`)); f = target + 1;
    }
  } else {
    const dir = path.join(AD, 'frames'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const total = Math.round(DUR * FPS), t0 = Date.now();
    for (let f = 0; f < total; f++) {
      await shot(f, path.join(dir, `${String(f).padStart(5, '0')}.jpg`));
      if (f % 150 === 0) console.error(`frame ${f}/${total}  ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    console.error('rendered', total);
  }
} finally { await close(); }
