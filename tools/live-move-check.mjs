// Live end-to-end input check: loads the game in headless Chrome (real GPU), holds real key presses and samples the
// sim's player speed / jump apex through the bridge. Usage:  node tools/live-move-check.mjs [url] [--shot FILE]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:5173/?view=game&time=16.5';
const shotIdx = args.indexOf('--shot');
const shot = shotIdx >= 0 ? args[shotIdx + 1] : null;
const stripIdx = args.indexOf('--strip'); // --strip FILE: 8-frame crop of the avatar while sprinting (motion check)
const strip = stripIdx >= 0 ? args[stripIdx + 1] : null;
const { browser, close } = await launchBrowser({ width: 1280, height: 720 });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 120000 });
  await page.evaluate(() => window.__gw.bridge.command('sys.set_time_scale', { scale: 0 }));
  const info = () => page.evaluate(() => { const r = window.__gw.bridge.query('player.info', {}); return typeof r === 'string' ? JSON.parse(r) : r; });
  const hspeed = (p) => Math.hypot(p.vel[0], p.vel[2]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(2500); // let the player settle onto the ground
  const start = await info();
  const out = { start: start.pos.map((v) => +v.toFixed(2)), grounded: start.grounded };

  const sample = async (label, ms, every = 250) => {
    const xs = [];
    for (let t = 0; t < ms; t += every) { await sleep(every); xs.push(+hspeed(await info()).toFixed(2)); }
    out[label] = xs;
  };

  await page.keyboard.down('KeyW');
  await sample('walk_speed_per_250ms', 2000);
  await page.keyboard.up('KeyW');
  await sample('stop_speed_per_100ms', 600, 100);

  await page.keyboard.down('Shift');
  await page.keyboard.down('KeyW');
  await sample('sprint_speed_per_250ms', 2250);
  if (shot) { fs.mkdirSync(path.dirname(shot), { recursive: true }); await page.screenshot({ path: shot }); out.shot = shot; }
  if (strip) {
    const frames = [];
    for (let i = 0; i < 8; i++) {
      frames.push(await page.screenshot({ clip: { x: 480, y: 250, width: 320, height: 240 }, encoding: 'base64' }));
      await sleep(40);
    }
    const sheet = await browser.newPage();
    await sheet.setViewport({ width: 1280, height: 480 });
    const data = await sheet.evaluate(async (fr) => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 480; const g = c.getContext('2d');
      for (let i = 0; i < fr.length; i++) {
        const img = new Image(); img.src = 'data:image/png;base64,' + fr[i]; await img.decode();
        g.drawImage(img, (i % 4) * 320, Math.floor(i / 4) * 240);
      }
      return c.toDataURL('image/png');
    }, frames);
    fs.mkdirSync(path.dirname(strip), { recursive: true });
    fs.writeFileSync(strip, Buffer.from(data.split(',')[1], 'base64'));
    await sheet.close();
    out.strip = strip;
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Shift');
  await sleep(1200);

  const y0 = (await info()).pos[1];
  await page.keyboard.press('Space');
  let apex = 0;
  for (let i = 0; i < 24; i++) { await sleep(40); apex = Math.max(apex, (await info()).pos[1] - y0); }
  out.jump_apex_m = +apex.toFixed(2);

  const end = await info();
  out.end = end.pos.map((v) => +v.toFixed(2));
  out.moved_m = +Math.hypot(end.pos[0] - start.pos[0], end.pos[2] - start.pos[2]).toFixed(1);
  out.errors = errors.slice(0, 5);
  console.log(JSON.stringify(out));
  process.exitCode = errors.length ? 1 : 0;
} finally {
  await close();
}
