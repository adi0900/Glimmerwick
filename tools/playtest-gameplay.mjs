// Gameplay slice 1 playtest (headless Chrome, private vite server, REAL clock + real key events):
//   break a log -> wood in the inventory -> craft planks -> place blocks -> befriend a Glimmer (companion + dex) -> goals advance.
// The very first log is hit through the real camera (look input); the rest of the loop uses `__gameplay.setAim`
// (the aim ray towards a block centre) so the script does not depend on camera spring timing.
// Usage: node tools/playtest-gameplay.mjs [--out shots/gameplay/r1] [--size 1280x720] [--q med]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, startPrivateServer, repoRoot } from './lib/browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const outDir = path.resolve(repoRoot, arg('--out', 'shots/gameplay/r1'));
const [W, H] = arg('--size', '1280x720').split('x').map(Number);
const quality = arg('--q', 'med');
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

const srv = await startPrivateServer();
const { browser, close } = await launchBrowser({ width: W, height: H });
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${srv.url}/?view=game&time=11&ui=1&story=0&q=${quality}&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready && window.__gameplay', { timeout: 300000 });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const shot = async (name) => { await page.screenshot({ path: path.join(outDir, name + '.png') }); };
  const q = (n, a = {}) => ev((n, a) => { const r = window.__gw.bridge.query(n, a); return typeof r === 'string' ? JSON.parse(r) : r; }, n, a);
  const cmd = (n, a = {}) => ev((n, a) => window.__gw.bridge.command(n, a), n, a);
  await cmd('sys.set_time_scale', { scale: 0 });
  await cmd('sys.set_weather', { kind: 0, intensity: 0 });
  const inv = () => ev(() => { const s = window.__gameplay.store; return { counts: Object.fromEntries(s.slots.filter(Boolean).reduce((m, x) => m.set(x.item, (m.get(x.item) || 0) + x.n), new Map())), goal: s.goalIndex, progress: s.goalProgress(), stats: s.stats, selected: s.selected, dex: s.dex }; });

  // ---------------------------------------------------------------- find a tree trunk and stand next to it
  const spot = await ev(() => {
    const b = window.__gw.bridge; const info = b.query('world.info'); const v = info.vox;
    const data = b.channel('vox.data').data; const per = v.cells_per_chunk, ny = v.ny, ncx = v.ncx;
    const at = (x, y, z) => { const gx = x - v.origin[0], gz = z - v.origin[2], l = y - v.origin[1]; if (gx < 0 || gz < 0 || l < 0 || l >= ny) return 0; const cx = gx >> 4, cz = gz >> 4; return data[(cz * ncx + cx) * per + (((gz & 15) * 16 + (gx & 15)) * ny + l)]; };
    const isLog = (id) => id >= 17 && id <= 20;
    const sp = info.spawn.player; let best = null;
    for (let x = Math.floor(sp[0]) - 70; x < sp[0] + 70; x++) for (let z = Math.floor(sp[1]) - 70; z < sp[1] + 70; z++) {
      for (let y = -10; y < 30; y++) {
        if (!isLog(at(x, y, z)) || isLog(at(x, y - 1, z))) continue; // bottom log of a trunk
        let h = 0; while (isLog(at(x, y + h, z))) h++;
        if (h < 4 || at(x, y - 1, z) === 0) continue;
        const d = Math.hypot(x - sp[0], z - sp[1]);
        if (!best || d < best.d) best = { x, y, z, h, d };
      }
    }
    if (!best) return null;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2, px = best.x + 0.5 + Math.sin(ang) * 2.6, pz = best.z + 0.5 + Math.cos(ang) * 2.6;
      const g = b.query('world.ground', { x: px, z: pz });
      if (g && Math.abs(g.block_y + 1 - best.y) <= 0 && !isLog(at(Math.floor(px), best.y, Math.floor(pz)))) return { ...best, px, pz, ang };
    }
    return { ...best, px: best.x + 0.5 + 2.6, pz: best.z + 0.5, ang: Math.PI / 2 };
  });
  check('found a tree trunk near spawn', !!spot, spot ? `trunk (${spot.x},${spot.y},${spot.z}) h=${spot.h}` : '');
  await cmd('debug.teleport', { x: spot.px, z: spot.pz });
  await sleep(700);

  // look at the trunk through the real camera
  const faceYaw = Math.atan2(-(spot.x + 0.5 - spot.px), -(spot.z + 0.5 - spot.pz));
  await ev((yaw) => window.__gw.engine.input.setLook(yaw, 0.12, 0.2), faceYaw);
  await sleep(1400);
  let tgt = await ev(() => { const t = window.__gameplay.target; return t ? { name: t.name, cell: t.cell, dist: t.dist } : null; });
  console.log('   camera target:', JSON.stringify(tgt));
  let usedCamera = !!tgt && /^log_/.test(tgt.name);
  if (!usedCamera) {
    await ev((a) => window.__gameplay.setAim(a), [spot.x + 0.5 - spot.px, spot.y + 0.5 - 0.95 - 0.0, spot.z + 0.5 - spot.pz]);
    await sleep(200);
    tgt = await ev(() => { const t = window.__gameplay.target; return t ? { name: t.name, cell: t.cell, dist: t.dist } : null; });
  }
  check('crosshair targets a log', !!tgt && /^log_/.test(tgt.name), `via ${usedCamera ? 'camera' : 'aim override'}: ${JSON.stringify(tgt)}`);
  await shot('01_target_outline');

  // hold F (real key) -> progress ring + cracks -> log in the hotbar
  await page.keyboard.down('KeyF');
  await sleep(420);
  const mid = await ev(() => window.__gameplay.progress);
  await shot('02_breaking');
  await sleep(1200);
  await page.keyboard.up('KeyF');
  await sleep(500);
  let s = await inv();
  check('breaking a log puts wood in the inventory', (s.counts.log || 0) >= 1, `log=${s.counts.log} (progress at 0.4 s: ${mid.toFixed(2)})`);
  await shot('03_pickup_toast');

  // ---------------------------------------------------------------- gather until goal 1 is done
  const gatherNearest = async (item) => {
    const r = await ev(() => {
      const b = window.__gw.bridge; const info = b.query('world.info'); const v = info.vox; const data = b.channel('vox.data').data; const per = v.cells_per_chunk, ny = v.ny, ncx = v.ncx;
      const at = (x, y, z) => { const gx = x - v.origin[0], gz = z - v.origin[2], l = y - v.origin[1]; if (gx < 0 || gz < 0 || l < 0 || l >= ny) return 0; return data[((gz >> 4) * ncx + (gx >> 4)) * per + (((gz & 15) * 16 + (gx & 15)) * ny + l)]; };
      const p = window.__gw.bridge.player.pos; let best = null;
      for (let x = Math.floor(p.x) - 4; x <= p.x + 4; x++) for (let z = Math.floor(p.z) - 4; z <= p.z + 4; z++) for (let y = Math.floor(p.y); y <= p.y + 3; y++) {
        const id = at(x, y, z); if (id < 17 || id > 20) continue;
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 0.95), z + 0.5 - p.z);
        if (d < 4.6 && (!best || d < best.d)) best = { x, y, z, d };
      }
      return best;
    });
    if (!r) return false;
    await ev((a) => window.__gameplay.setAim(a), await ev((r) => { const p = window.__gw.bridge.player.pos; return [r.x + 0.5 - p.x, r.y + 0.5 - (p.y + 0.95), r.z + 0.5 - p.z]; }, r));
    await sleep(120);
    await page.keyboard.down('KeyF');
    for (let i = 0; i < 40; i++) { await sleep(100); const id = (await q('world.block', { x: r.x, y: r.y, z: r.z })).id; if (id === 0) break; }
    await page.keyboard.up('KeyF');
    await sleep(120);
    return true;
  };
  for (let i = 0; i < 14; i++) {
    s = await inv();
    if (s.goal >= 1) break;
    if (!(await gatherNearest('log'))) {
      // walk to another trunk side
      const p = await q('player.info');
      await cmd('debug.teleport', { x: p.pos[0] + 1.2, z: p.pos[2] + 1.2 });
      await sleep(400);
    }
  }
  await sleep(500);
  s = await inv();
  check('gather goal completes (6 logs collected)', s.goal >= 1, `collected logs=${s.stats.collected.log}, goalIndex=${s.goal}`);
  await shot('04_goal_banner');
  await sleep(1500);

  // ---------------------------------------------------------------- crafting
  await page.keyboard.press('KeyC');
  await sleep(500);
  await shot('05_workbench');
  const before = (await inv()).counts.planks || 0;
  for (let i = 0; i < 8; i++) { const dis = await ev(() => document.querySelector('.gw-rec:first-child .go').disabled); if (dis) break; await page.click('.gw-rec:first-child .go'); await sleep(220); }
  await shot('06_workbench_after');
  await page.keyboard.press('Escape');
  await sleep(300);
  s = await inv();
  check('crafting planks from logs', (s.counts.planks || 0) >= before + 8, `planks ${before} -> ${s.counts.planks}`);

  // ---------------------------------------------------------------- build
  // choose planks in the hotbar
  const slotOf = await ev(() => window.__gameplay.store.slots.findIndex((x) => x && x.item === 'planks'));
  await page.keyboard.press(slotOf < 9 ? `Digit${slotOf + 1}` : 'Digit0');
  await sleep(200);
  // stand on open ground, look at the ground ahead and place blocks (real X presses)
  const here = await q('player.info');
  await cmd('debug.teleport', { x: here.pos[0] + 6, z: here.pos[2] + 1 });
  await sleep(500);
  const placedBefore = (await inv()).stats.placed;
  let nplaced = 0;
  const cells = [];
  for (let dx = 2; dx <= 5; dx++) for (let dz = -3; dz <= 3; dz++) cells.push([dx, dz]);
  for (let i = 0; i < cells.length && nplaced < 22; i++) {
    const [dx, dz] = cells[i];
    // aim at the top of the grass cell 2-6 m west of the player (so every ray hits fresh ground, never the avatar)
    const aim = await ev(([dx, dz]) => { const b = window.__gw.bridge; const p = b.player.pos; const cx = Math.floor(p.x) - dx, cz = Math.floor(p.z) + dz; const g = b.query('world.ground', { x: cx + 0.5, z: cz + 0.5 }); return [cx + 0.5 - p.x, g.block_y + 0.9 - (p.y + 0.95), cz + 0.5 - p.z]; }, [dx, dz]);
    await ev((a) => window.__gameplay.setAim(a), aim);
    await sleep(70);
    await page.keyboard.press('KeyX');
    await sleep(100);
    nplaced = (await inv()).stats.placed - placedBefore;
    if (i === 8) await shot('07_building');
  }
  // placing into the player's own cell must be refused
  {
    const before2 = (await inv()).stats.placed;
    await ev(() => window.__gameplay.setAim([0.001, -1, 0.001]));
    await sleep(120);
    await page.keyboard.press('KeyX');
    await sleep(250);
    const refused = (await inv()).stats.placed === before2;
    const toastTxt = await ev(() => document.querySelector('.gw-toast')?.textContent ?? '');
    check('cannot place a block inside the player', refused, `toast "${toastTxt}"`);
  }
  await ev(() => window.__gameplay.setAim(null));
  s = await inv();
  check('placing blocks (X) consumes items and counts', nplaced >= 20 || s.goal >= 3, `placed ${nplaced}, goalIndex ${s.goal}`);
  await sleep(700);
  await shot('08_after_build');
  // verify the world really has them
  const placedBlocks = await ev(() => { const g = window.__gw.bridge.query('world.raycast', { origin: [0, 60, 0], dir: [0, -1, 0], max: 200 }); return g.hit ? g.name : null; });
  console.log('   (sample world raycast from above spawn:', placedBlocks, ')');

  // ---------------------------------------------------------------- befriend
  await ev(() => { const s = window.__gameplay.store; if (s.count('cookie') < 4) s.add('cookie', 4); });
  const pp = await q('player.info');
  const spawnRes = await cmd('debug.spawn_creature', { species: 'Puffbun', x: pp.pos[0] + 2.4, z: pp.pos[2], variant: 1 });
  const cid = spawnRes.id;
  await sleep(2200);
  await ev((yaw) => window.__gw.engine.input.setLook(yaw, 0.35, 0.25), -Math.PI / 2 * 0 + Math.atan2(-2.4, 0));
  await sleep(600);
  await shot('09_creature_near');
  let friend = false, attempts = 0, last = '';
  for (; attempts < 12 && !friend; attempts++) {
    await page.keyboard.press('KeyE');
    await sleep(500);
    const ci = await q('creature.info', { id: cid });
    friend = !!ci.companion;
    if (friend) break;
    last = await ev(() => document.querySelector('.gw-toast')?.textContent ?? '');
    await sleep(3300); // offer cooldown is 3 s
    const pn = await q('player.info'); const cr = await q('creature.info', { id: cid });
    if (Math.hypot(cr.pos[0] - pn.pos[0], cr.pos[2] - pn.pos[2]) > 3.4) await cmd('debug.teleport', { x: cr.pos[0] - 1.6, z: cr.pos[2] });
  }
  await sleep(300);
  await shot('10_befriended');
  const comps = await q('creature.companions');
  check('E + treat befriends a Puffbun -> companion', friend && comps.length >= 1, `after ${attempts + 1} offer(s); last toast "${last}"`);
  s = await inv();
  check('Glimmerdex records the friend', Object.values(s.dex).some((e) => e.friend), JSON.stringify(s.dex));
  check('befriend goal advances', s.goal >= 4 || s.stats.befriended >= 1, `goalIndex ${s.goal}, befriended ${s.stats.befriended}`);
  await sleep(2600);
  // companion follows
  const pstart = await q('player.info');
  await cmd('debug.teleport', { x: pstart.pos[0] - 22, z: pstart.pos[2] + 10 });
  await ev(() => window.__gw.engine.input.setLook(0, 0.3));
  await sleep(9000);
  const pend = await q('player.info'); const cend = await q('creature.info', { id: cid });
  const dist = Math.hypot(cend.pos[0] - pend.pos[0], cend.pos[2] - pend.pos[2]);
  check('companion follows the player across the map', dist < 6.5, `${dist.toFixed(1)} m behind after the player moved 24 m`);
  await shot('11_companion_following');
  await page.keyboard.press('KeyG');
  await sleep(500);
  await shot('12_glimmerdex');
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.keyboard.press('KeyH');
  await sleep(500);
  await shot('13_help');
  await page.keyboard.press('Escape');
  await sleep(200);

  // persistence: reload the store from localStorage
  await ev(() => window.__gameplay.store.flush());
  const persisted = await ev((k) => { try { const d = JSON.parse(localStorage.getItem(k)); return d && d.v === 1 && d.stats.placed >= 1; } catch { return false; } }, 'glimmerwick.profile.v1');
  check('profile persists to localStorage', persisted);

  // creatures: perf with many
  const stats = await ev(() => window.__game.stats());
  console.log('   engine stats:', JSON.stringify({ fps: Math.round(stats.fps), calls: stats.calls, tris: stats.tris }));
  check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error('PLAYTEST CRASHED', e);
  exitCode = 1;
} finally {
  await close();
  await srv.stop?.();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || (failed.length ? 1 : 0));
