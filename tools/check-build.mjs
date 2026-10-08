// Build check: fresh profile -> hotbar has the builder's kit -> place blocks with real X presses -> the WORLD has them.
// Usage: node tools/check-build.mjs   (private server, real clock)
import fs from 'node:fs';
import { launchBrowser, startPrivateServer } from './lib/browser.mjs';

fs.mkdirSync('shots/gameplay/r2', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = process.env.DEV_URL ? { url: process.env.DEV_URL, stop() {} } : await startPrivateServer();   // DEV_URL=http://127.0.0.1:5173 reuses the running dev server
const { browser, close } = await launchBrowser({ width: 1280, height: 720 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${srv.url}/?view=game&time=11&ui=1&fresh=1&q=low&w=1280&h=720`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready && window.__gameplay', { timeout: 300000 });
  const ev = (fn, a) => page.evaluate(fn, a);
  const inv = () => ev(() => ({ slots: window.__gameplay.store.slots.map((s) => (s ? `${s.item}x${s.n}` : null)), placed: window.__gameplay.store.stats.placed }));
  console.log('start inventory:', JSON.stringify((await inv()).slots));
  // stand on open ground away from the village
  await ev(() => { window.__gw.bridge.command('debug.teleport', { x: 51, z: 20 }); });
  await sleep(1500);
  const slot = await ev(() => window.__gameplay.store.slots.findIndex((x) => x && x.item === 'planks'));
  await page.keyboard.press(slot < 9 ? `Digit${slot + 1}` : 'Digit0');
  await sleep(200);
  const placedBefore = (await inv()).placed;
  const probe = [];
  // 5 wide x 3 high wall, one block per press, aimed at the ground / the previous row (like a player would)
  let ok = 0, tries = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      tries++;
      const aim = await ev(([row, col]) => {
        const b = window.__gw.bridge, p = b.player.pos;
        // a flat floor: aim at the top face of fresh ground cells 2-4 m to the west (what a beginner does first)
        const cx = Math.floor(p.x) - (2 + row), cz = Math.floor(p.z) + (col - 2);
        const g = b.query('world.ground', { x: cx + 0.5, z: cz + 0.5 });
        return [cx + 0.5 - p.x, g.block_y + 0.9 - (p.y + 0.95), cz + 0.5 - p.z];
      }, [row, col]);
      await ev((a) => window.__gameplay.setAim(a), aim);
      await sleep(260);                       // let the aim ray settle on the new cell
      const before = (await inv()).placed;
      await page.keyboard.press('KeyX');
      await sleep(320);                       // longer than the 0.24 s place repeat
      const after = (await inv()).placed;
      if (after > before) ok++;
      else probe.push([row, col, await ev(() => { const t = window.__gameplay.target, p = window.__gw.bridge.player.pos; return `${[...document.querySelectorAll('.gw-toast')].map((x) => x.textContent).join('|').slice(0, 30)} target=${t ? t.name + '@' + t.cell.join(',') + ' n=' + t.normal.join(',') + ' d=' + t.dist.toFixed(1) : 'none'} player=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`; })]);
    }
  }
  await ev(() => window.__gameplay.setAim(null));
  const placed = (await inv()).placed - placedBefore;
  // do the blocks really exist in the world? count planks in the 5x3 area
  const inWorld = await ev(() => { const b = window.__gw.bridge, p = b.player.pos; let n = 0; for (let dx = 2; dx <= 4; dx++) for (let dz = -2; dz <= 2; dz++) { const cx = Math.floor(p.x) - dx, cz = Math.floor(p.z) + dz; const g = b.query('world.ground', { x: cx + 0.5, z: cz + 0.5 }); const blk = b.query('world.block', { x: cx, y: g.block_y, z: cz }); if (blk && blk.name === 'planks') n++; } return n; });
  console.log('planks found in the world:', inWorld);
  const planksLeft = (await inv()).slots;
  await page.screenshot({ path: 'shots/gameplay/r2/building_wall.png' });
  console.log(JSON.stringify({ tries, placedByHud: placed, okPresses: ok, missed: probe, planksLeft, errors: errors.slice(0, 3) }));
} finally { await close(); srv.stop(); }
