// Quick camera check: screenshots at pitch +0.35 (default), -0.05 (level) and -0.35 (looking up) on open ground and next to a cottage.
// Usage: node tools/check-camera-pitch.mjs  -> shots/camera/r1/pitch_*.png
import fs from 'node:fs';
import { launchBrowser, startPrivateServer } from './lib/browser.mjs';

fs.mkdirSync('shots/camera/r1', { recursive: true });
const srv = await startPrivateServer();
const { browser, close } = await launchBrowser({ width: 1280, height: 720 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${srv.url}/?view=game&time=16.5&freeze=1&w=1280&h=720&q=med`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 240000 });
  const spots = { meadow: [51, 2.7], cottage: [58.2, -0.7] };
  for (const [name, [x, z]] of Object.entries(spots)) {
    await page.evaluate(([x, z]) => { window.__gw.bridge.command('debug.teleport', { x, z }); window.__game.setCam('game'); window.__game.step(60); }, [x, z]);
    for (const pitch of [0.35, -0.05, -0.35]) {
      await page.evaluate((pitch) => { const i = window.__gw.engine.input; i.setLook(i.yaw, pitch, i.zoom); for (let k = 0; k < 90; k++) window.__game.step(1); }, pitch);
      await page.screenshot({ path: `shots/camera/r1/pitch_${name}_${pitch}.png` });
    }
  }
  console.log('done', errors.length ? errors.slice(0, 2) : 'no page errors');
} finally { await close(); srv.stop(); }
