// Clean footage "plates" for the Glimmerwick ad (1920x1080, constant 30 fps, frame-exact, NO captions / sidebar):
// dive -> sprint-jump run (with friends) -> a cottage builds itself (on levelled ground) -> three creature herds -> a whole gang
// of friends on the beach -> golden-hour-to-night lapse -> pull-back.
// Output: showcase/nullmotion/ad/plates/<shot>/00000.jpg ... plus plates.json (shot -> frame count).
// Usage: SHOWCASE_BASE=http://127.0.0.1:5174 node tools/record-ad-plates.mjs [--test] [--only run,gang]
//   --test shoots a few frames per shot into plates/_test (sequential sim, so poses are real).
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './lib/browser.mjs';

const args = process.argv.slice(2);
const TEST = args.includes('--test');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;
const FPS = 30, W = 1920, H = 1080;
const ROOT = path.resolve('showcase/nullmotion/ad/plates');
const BASE = process.env.SHOWCASE_BASE ?? 'http://127.0.0.1:5174';
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

const SHOTS = [
  { id: 'dive', s: 7.1 }, { id: 'run', s: 4.5 }, { id: 'gang', s: 5 }, { id: 'build', s: 6 },
  { id: 'cameo0', s: 3 }, { id: 'cameo1', s: 3 }, { id: 'cameo2', s: 3 },
  { id: 'home', s: 5 }, { id: 'biomes', s: 6.5 },
  { id: 'lapse', s: 5 }, { id: 'outro', s: 4.5 },
].filter((x) => !ONLY || ONLY.includes(x.id));
const TEST_AT = [0.08, 0.3, 0.55, 0.8, 0.97];   // fractions of each shot that --test photographs

const { browser, close } = await launchBrowser({ width: W, height: H });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/?view=game&time=16.3&freeze=1&w=${W}&h=${H}&q=ultra`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 180000 });
  const q = (n, a = {}) => page.evaluate((n, a) => { const r = window.__gw.bridge.query(n, a); return typeof r === 'string' ? JSON.parse(r) : r; }, n, a);
  const cmd = (n, a = {}) => page.evaluate((n, a) => window.__gw.bridge.command(n, a), n, a);
  const setCam = (c) => page.evaluate((c) => { window.__game.setCam(c); }, c);
  const step = (n = 1) => page.evaluate((n) => window.__game.step(n), n);
  const setHour = (h) => page.evaluate((h) => window.__game.setTime(h, true), h);
  await cmd('sys.set_time_scale', { scale: 0 });
  const player = async () => (await q('player.info')).pos;
  const creaturePos = (id) => page.evaluate((id) => { const ch = window.__gw.bridge.channel('creatures'); const d = ch.data, s = ch.stride, n = Math.floor(ch.len / s); for (let i = 0; i < n; i++) if (Math.round(d[i * s]) === id) return [d[i * s + 3], d[i * s + 4], d[i * s + 5]]; return null; }, id);
  const spawn = async (species, x, z, variant = 0) => { const r = await cmd('debug.spawn_creature', { species, x, z, variant, count: 1 }); return r.id ?? (r.ids ?? [])[0]; };

  // The engine ignores the keyboard while the clock is frozen, so the avatar is driven by writing the sim's input block
  // directly (moveY = forward, buttons: 1 jump, 4 sprint, yaw = heading). One call = 2 sim ticks = one 30 fps frame.
  const JUMP = 1, SPRINT = 4;
  const drive = (moveY, buttons, yaw) => page.evaluate(([m, b, y]) => { window.__gw.bridge.setInputParts({ moveY: m, buttons: b, yaw: y, pitch: 0 }); window.__game.step(2); }, [moveY, buttons, yaw]);
  // a straight, wall-free run near (bx, bz) with only gentle height changes; the sim can then run along it unattended
  const findRun = async (bx, bz, len = 26) => {
    const h = async (x, z) => (await q('world.ground', { x, z })).height;
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
    for (let ring = 0; ring <= 45; ring += 3) {
      for (const [ox, oz] of [[0, 0], [ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
        for (const [dx, dz] of dirs) {
          const x = Math.floor(bx + ox) + 0.5, z = Math.floor(bz + oz) + 0.5, hs = [];
          for (let k = 0; k <= len; k += 2) hs.push(await h(x + dx * k, z + dz * k));
          if (hs.some((v) => !Number.isFinite(v) || v < 0.9) || Math.max(...hs) - Math.min(...hs) > 0.9) continue;
          let blocked = false;
          const base = hs.reduce((a, b) => a + b, 0) / hs.length;
          for (let k = 0; k <= len && !blocked; k += 4) for (const lat of [4.6, -4.6]) {   // the camera's ground must be level with the avatar's
            const side = await h(x + dx * k - dz * lat, z + dz * k + dx * lat);
            if (!Number.isFinite(side) || Math.abs(side - base) > 0.8) { blocked = true; break; }
          }
          if (blocked) continue;
          for (const lat of [0, 3.2, -3.2]) {          // the path itself and a 3 m corridor on each side (room for the camera)
            const r = await q('world.sweep', { min: [x - dz * lat - 0.35, Math.max(...hs) + 0.9, z + dx * lat - 0.35], size: [0.7, 1.6, 0.7], delta: [dx * len, 0, dz * len] });
            if (r.hit && (r.hit[0] || r.hit[2])) { blocked = true; break; }
          }
          if (blocked) continue;
          return { x, z, dx, dz, yaw: Math.atan2(-dx, -dz), len };
        }
      }
    }
    throw new Error('no clear run found');
  };
  // camera placed relative to the run's heading: a = 0 behind, +-PI/2 side-on, PI in front
  const camRel = (cp, run, a, d, up, ahead, fov) => ({ pos: [cp[0] + d * (-run.dx * Math.cos(a) + run.dz * Math.sin(a)), cp[1] + up, cp[2] + d * (-run.dz * Math.cos(a) - run.dx * Math.sin(a))], target: [cp[0] + run.dx * ahead, cp[1] + 0.85, cp[2] + run.dz * ahead], fov });
  const alongRun = (run, along, lateral) => [run.x + run.dx * along - run.dz * lateral, run.z + run.dz * along + run.dx * lateral];

  fs.mkdirSync(ROOT, { recursive: true });
  const counts =fs.existsSync(`${ROOT}/plates.json`) ? JSON.parse(fs.readFileSync(`${ROOT}/plates.json`, 'utf8')) : {};
  let dir = '', frame = 0;
  // One rendered frame = 2 game steps (1/60 s each), so the world advances exactly 1/30 s of real game time per frame.
  const advance = () => step(2);
  const snap = async (name) => { await page.screenshot({ path: `${dir}/${name ?? String(frame).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 93 }); frame++; };
  const begin = (s) => { dir = TEST ? `${ROOT}/_test` : `${ROOT}/${s.id}`; if (!TEST) fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); frame = 0; };
  // run `total` frames; in test mode photograph only a few of them but still advance every one
  const frames = async (shot, total, body, ownStep = false) => {
    const tests = new Set(TEST_AT.map((u) => Math.round(u * (total - 1))));
    for (let f = 0; f < total; f++) {
      await body(f, f / (total - 1), f / FPS);
      if (!ownStep) await advance();
      if (!TEST) await snap(); else if (tests.has(f)) { await snap(`${shot.id}_${String(f).padStart(3, '0')}`); }
    }
  };

  // ---- scene prep: levelled house site on the beach ----
  const HX = 44, HZ = 114;
  const ground = async (x, z) => (await q('world.ground', { x, z })).block_y;     // y of the top ground block (the beach is at 0)
  const top = await ground(HX + 3, HZ + 3);
  const G = top + 1;                                                                // floor layer sits directly on the ground at the centre of the site
  const cx = HX + 3.5, cz = HZ + 3.5;
  console.error(`house floor y = ${G} (ground top ${top})`);
  // foundation: every footprint column down to the ground (never floats), plus a sand apron one block wide around it
  const foundation = async () => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const inside = i >= 0 && i <= 6 && j >= 0 && j <= 6, gy = await ground(HX + i, HZ + j);
      for (let y = gy + 1; y < G + (inside ? 0 : 0); y++) await cmd('world.set_block', { x: HX + i, y, z: HZ + j, name: inside ? 'cobble' : 'sand' });
    }
  };
  await cmd('debug.teleport', { x: 58, z: -2 });
  await step(40);
  const P0 = await player();

  const blocks = [];
  const add = (x, y, z, name) => blocks.push([HX + x, G + y, HZ + z, name]);
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) add(i, 0, j, 'planks');
  for (let y = 1; y <= 4; y++) for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
    const edge = i === 0 || i === 6 || j === 0 || j === 6; if (!edge) continue;
    const corner = (i === 0 || i === 6) && (j === 0 || j === 6);
    if (j === 0 && i === 3 && y <= 2) continue;
    let n = y <= 2 ? 'cobble' : 'plaster'; if (corner) n = 'log_oak';
    if (!corner && y >= 2 && y <= 3 && ((i === 3 && j !== 0) || (j === 3 && i !== 3 && (i === 0 || i === 6)))) n = 'glass';
    add(i, y, j, n);
  }
  for (let k = 0; k < 4; k++) for (let i = k; i <= 6 - k; i++) for (let j = k; j <= 6 - k; j++) add(i, 5 + k, j, 'roof_tile');
  add(2, 1, -1, 'lantern'); add(4, 1, -1, 'lantern');
  const placeAll = async () => { for (const [x, y, z, name] of blocks) await cmd('world.set_block', { x, y, z, name }); };
  const habitat = async (name) => (await q('world.info')).habitats?.[name] ?? [];

  for (const shot of SHOTS) {
    const total = Math.round(shot.s * FPS);
    begin(shot);
    const t0 = Date.now();
    if (shot.id === 'dive') {
      await frames(shot, total, async (f, u0) => {
        const u = ease(u0), h = 900 * Math.pow(9 / 900, u), back = 520 * Math.pow(8 / 520, u);
        await setCam({ pos: [P0[0] + 30 * (1 - u), P0[1] + h, P0[2] - back], target: [P0[0], P0[1] + 1 * u, P0[2]], fov: lerp(52, 46, u) });
      });
    } else if (shot.id === 'run') {
      const run = await findRun(58.2, -0.7, 30);                                   // village: a clear straight stretch
      console.error('village run', JSON.stringify(run));
      await cmd('debug.teleport', { x: run.x, z: run.z });
      await page.evaluate(() => { window.__game.setCam('game'); });
      for (let k = 0; k < 40; k++) await drive(0, 0, run.yaw);                    // settle, standing still
      // friends along the path ahead
      for (const [sp, along, lat, v] of [[0, 6, -1.8, 0], [1, 8.5, 1.9, 1], [2, 11, -1.4, 2], [0, 14, 2.4, 1], [1, 17, -2.2, 0], [2, 20, 1.2, 1]]) { const [x, z] = alongRun(run, along, lat); await spawn(sp, x, z, v); }
      let cp = null;
      await frames(shot, total, async (f, u0, rt) => {
        // walk for the first 0.5 s, then sprint; hop at 1.3 s, 2.5 s and 3.5 s (one-frame presses)
        const jump = [1.3, 2.5, 3.5].some((x) => Math.abs(rt - x) < 0.017) ? JUMP : 0;
        const p = await player(); cp = cp ?? p;
        cp = [lerp(cp[0], p[0], 0.3), lerp(cp[1], p[1], 0.3), lerp(cp[2], p[2], 0.3)];
        const u = ease(u0);   // side profile (stride readable) -> settles behind-left so the friends ahead stay in frame
        await setCam(camRel(cp, run, lerp(-1.5, -0.5, u), lerp(3.4, 4.4, u0), lerp(0.9, 1.4, Math.sin(u0 * Math.PI)), lerp(0.8, 3.5, u0), 52));
        await drive(1, (rt >= 0.5 ? SPRINT : 0) | jump, run.yaw);     // camera first, then step, so the frame is rendered from it
      }, true);
    } else if (shot.id === 'build') {
      await cmd('debug.teleport', { x: HX - 6, z: HZ - 4 }); await step(30);
      if (!TEST) await foundation(); else { await foundation(); }
      for (const [sp, dx, dz, v] of [[0, 3, -5, 0], [1, 7, -4, 1], [2, -1, 3, 0]]) await spawn(sp, HX + dx, HZ + dz, v);   // friends gather round the site
      await step(20);
      const perFrame = Math.ceil(blocks.length / (total * 0.82)); let bi = 0;
      await frames(shot, total, async (f, u) => {
        if (TEST) { const upto = Math.floor(blocks.length * Math.min(1, u / 0.82)); while (bi < upto) { const [x, y, z, nm] = blocks[bi++]; await cmd('world.set_block', { x, y, z, name: nm }); } }
        else for (let k = 0; k < perFrame && bi < blocks.length; k++) { const [x, y, z, nm] = blocks[bi++]; await cmd('world.set_block', { x, y, z, name: nm }); }
        const a = -0.9 + u * 2.4;
        await setCam({ pos: [cx + Math.sin(a) * lerp(15, 11, u), G + lerp(6.5, 8.5, u), cz + Math.cos(a) * lerp(15, 11, u)], target: [cx, G + lerp(1.5, 3.2, u), cz], fov: 50 });
      });
      while (bi < blocks.length) { const [x, y, z, nm] = blocks[bi++]; await cmd('world.set_block', { x, y, z, name: nm }); }
    } else if (shot.id.startsWith('cameo')) {
      const sp = Number(shot.id.slice(5));
      const id = await spawn(sp, HX + 2 + sp * 1.6, HZ - 4.5 - (sp % 2), sp);
      const mates = [];
      for (const [dx, dz, v] of [[-2.4, 1.4, (sp + 1) % 3], [2.2, 2.2, (sp + 2) % 3], [0.6, 3.6, sp]]) mates.push(await spawn(sp, HX + 2 + sp * 1.6 + dx, HZ - 4.5 - (sp % 2) + dz, v));
      await step(45);
      await frames(shot, total, async (f, u, t) => {
        const pos = await creaturePos(id);
        if (pos) { const a = 0.4 + t * 0.4 + sp * 2; await setCam({ pos: [pos[0] + Math.sin(a) * 3.6, pos[1] + 1.15, pos[2] + Math.cos(a) * 3.6], target: [pos[0], pos[1] + 0.45, pos[2]], fov: 44 }); }
      });
    } else if (shot.id === 'gang') {
      const sand = await habitat('sand'), far = sand.filter((h) => Math.hypot(h[0] - HX, h[1] - HZ) > 30), s0 = far[0] ?? sand[0] ?? [48, 120];
      let run = null;
      for (const hb of [s0, ...sand]) { try { run = await findRun(hb[0], hb[1], 28); break; } catch { /* try the next beach */ } }   // a clear stretch of beach
      if (!run) throw new Error('no beach run found');
      console.error('beach run', JSON.stringify(run));
      await cmd('debug.teleport', { x: run.x, z: run.z });
      await page.evaluate(() => { window.__game.setCam('game'); });
      for (let k = 0; k < 40; k++) await drive(0, 0, run.yaw);
      // a crowd of friends around the path ahead (along, lateral), mixed species and colour variants
      const ring = [[3.5, -3.2], [4.5, 3.0], [6.5, -1.2], [8, 2.2], [8.5, -4.6], [10, 4.4], [11, -2.4], [13, 0.6], [4.5, -5.4], [6.5, 5.6], [3.2, -0.4], [15, 1.6]];
      for (let k = 0; k < ring.length; k++) { const [x, z] = alongRun(run, ring[k][0], ring[k][1]); await spawn(k % 3, x, z, Math.floor(k / 3) % 3); }
      let cp = null;
      await frames(shot, total, async (f, u0, rt) => {
        // an easy walk through the friends (sprinting would scare them off), with two hops
        const jump = [2.0, 3.5].some((x) => Math.abs(rt - x) < 0.017) ? JUMP : 0;
        const p = await player(); cp = cp ?? p;
        cp = [lerp(cp[0], p[0], 0.25), lerp(cp[1], p[1], 0.25), lerp(cp[2], p[2], 0.25)];
        await setCam(camRel(cp, run, lerp(-1.25, -0.3, ease(u0)), lerp(4.6, 5.4, u0), lerp(1.1, 1.8, u0), lerp(1.5, 4.5, u0), 56));
        await drive(1, jump, run.yaw);
      }, true);
    } else if (shot.id === 'home') {
      // the finished cottage: friends gather in its front yard while the explorer walks up to the door (door is on the -z face)
      const gx = HX + 3.5, gz = HZ - 10;
      await cmd('debug.teleport', { x: gx, z: gz });
      await page.evaluate(() => { window.__game.setCam('game'); });
      for (let k = 0; k < 40; k++) await drive(0, 0, Math.PI);
      for (const [sp, lat, dz, v] of [[0, -3.2, 3.5, 0], [1, 2.8, 4.5, 1], [2, -1.2, 6, 2], [0, 4.2, 6.5, 1], [1, -4.6, 7, 2], [2, 1.2, 7.5, 0], [0, -2.4, 8, 2], [1, 3.4, 8.5, 0]]) await spawn(sp, gx + lat, gz + dz, v);
      await setHour(17.6);
      // fixed three-quarter view of the whole cottage and its yard, easing in slowly
      await frames(shot, total, async (f, u0, rt) => {
        const u = ease(u0);
        await setCam({ pos: [lerp(HX + 12, HX + 9.5, u), lerp(G + 3.6, G + 3.0, u), lerp(HZ - 11, HZ - 9, u)], target: [HX + 3.5, G + 2.0, HZ - 2.5], fov: 54 });
        await drive(rt < 1.9 ? 1 : 0, rt > 2.5 && rt < 2.57 ? JUMP : 0, Math.PI);      // walk up to the door, stop, one happy hop
      }, true);
    } else if (shot.id === 'biomes') {
      // a low flight over different biomes: village -> pond -> meadow -> highland
      const path = [[58, 0], [16, 24], [-8, -40], [-48, -32], [-72, -56]];
      const seg = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1])), L = seg.reduce((a, b) => a + b, 0);
      const at = (s) => { s = Math.max(0, Math.min(L, s)); let i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; } const t = s / seg[i]; return [lerp(path[i][0], path[i + 1][0], t), lerp(path[i][1], path[i + 1][1], t)]; };
      const gh = async (x, z) => { const v = (await q('world.ground', { x: Math.round(x), z: Math.round(z) })).height; return Number.isFinite(v) ? v : 2; };
      await cmd('debug.teleport', { x: 58, z: 0 });
      await setHour(16.6);
      let alt = null;
      await frames(shot, total, async (f, u0) => {
        const s = (u0 * 0.92 + 0.0) * L, p = at(s), a2 = at(s + 26);
        const g0 = await gh(p[0], p[1]), g1 = await gh(a2[0], a2[1]);
        alt = alt === null ? g0 + 13 : lerp(alt, Math.max(g0, g1) + 13, 0.12);
        await setCam({ pos: [p[0], alt, p[1]], target: [a2[0], Math.max(g1, g0) + 1.5, a2[1]], fov: 58 });
      });
    } else if (shot.id === 'lapse') {
      await frames(shot, total, async (f, u0) => {
        const u = ease(u0); await setHour(lerp(16.4, 22.8, u));
        const a = 1.5 + u0 * 2.2;
        await setCam({ pos: [cx + Math.sin(a) * lerp(13, 20, u0), G + lerp(4.5, 10, u0), cz + Math.cos(a) * lerp(13, 20, u0)], target: [cx, G + 3, cz], fov: 50 });
      });
    } else if (shot.id === 'outro') {
      await frames(shot, total, async (f, u0) => {
        const u = ease(u0);
        await setCam({ pos: [cx + 17 + 14 * u, G + 8 + 14 * u, cz + 3 + 10 * u], target: [cx, G + 3, cz], fov: 50 });
      });
    }
    if (!TEST) { counts[shot.id] = frame; fs.writeFileSync(`${ROOT}/plates.json`, JSON.stringify(counts, null, 1)); }
    console.error(`${shot.id}: ${frame} frames in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  if (errors.length) console.error('page errors:', errors.slice(0, 3));
} finally {
  await close();
}
