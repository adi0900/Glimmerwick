// Live check that the sim's creatures render in the game view: finds the creature nearest the player, teleports the
// player 3.5 m behind it (default camera looks toward +z) and screenshots. Usage: node tools/live-creature-check.mjs [FILE]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';

const outFile = process.argv[2] ?? 'shots/_orch/live_creature.png';
const { browser, close } = await launchBrowser({ width: 1280, height: 720 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173/?view=game&time=16.5', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 120000 });
  await page.evaluate(() => window.__gw.bridge.command('sys.set_time_scale', { scale: 0 }));
  await new Promise((r) => setTimeout(r, 1500));
  const info = await page.evaluate(() => {
    const b = window.__gw.bridge;
    const q = (n) => { const r = b.query(n, {}); return typeof r === 'string' ? JSON.parse(r) : r; };
    const p = q('player.info');
    const ch = b.channel('creatures');
    const d = ch.data, stride = ch.stride, n = Math.floor(ch.len / stride);
    let best = null;
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      const x = d[o + 3], y = d[o + 4], z = d[o + 5], dist = Math.hypot(x - p.pos[0], z - p.pos[2]);
      if (!best || dist < best.dist) best = { x, y, z, dist, species: d[o + 1], id: d[o] };
    }
    return { player: p.pos, count: n, best };
  });
  if (!info.best) { console.log(JSON.stringify({ ok: false, why: 'no creatures in channel', info })); process.exitCode = 1; }
  else {
    // photo camera aimed at the nearest creature (bypasses the follow camera)
    await page.evaluate((b) => window.__game.setCam({ pos: [b.x + 2.2, b.y + 1.6, b.z - 3.2], target: [b.x, b.y + 0.35, b.z], fov: 42 }), info.best);
    await new Promise((r) => setTimeout(r, 2500)); // animation settle
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile });
    console.log(JSON.stringify({ ok: true, creatures: info.count, nearest: { species: info.best.species, dist: +info.best.dist.toFixed(1) }, shot: outFile, errors: errors.slice(0, 3) }));
    process.exitCode = errors.length ? 1 : 0;
  }
} finally {
  await close();
}
