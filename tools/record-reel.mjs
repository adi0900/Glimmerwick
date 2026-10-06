// Viral vertical reel (1080x1920, constant 60 fps, frame-exact): dive -> sprint-jump run -> a cottage builds itself block by
// block -> creature cameos -> day-to-night time-lapse -> title. Output name is versioned (never overwrites older videos).
// Usage: node tools/record-reel.mjs [--test] [--skip-frames] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchBrowser } from './lib/browser.mjs';

const args = process.argv.slice(2);
const TEST = args.includes('--test');
const FPS = 60, W = 1080, H = 1920;
const ROOT = path.resolve('showcase/reel_frames');
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = path.resolve(`showcase/${TEST ? '_tests/test_' : ''}glimmerwick_reel_vertical_1080x1920_60fps_${stamp}.mp4`);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const BASE = process.env.SHOWCASE_BASE ?? 'http://127.0.0.1:5173';
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

// shot list: name, seconds. (title overlays are burned in by ffmpeg with the same timing)
const SHOTS = [
  { id: 'dive', s: 6.5 }, { id: 'run', s: 12 }, { id: 'build', s: 15 }, { id: 'cameo', s: 12 }, { id: 'lapse', s: 12 }, { id: 'outro', s: 5 },
].map((x) => (TEST ? { ...x, s: Math.min(x.s, 1.5) } : x));   // ~62.5 s: slow, clear beats
const total = SHOTS.reduce((a, x) => a + Math.round(x.s * FPS), 0);

async function capture() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
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
    const cam = (c) => page.evaluate((c) => { window.__game.setCam(c); window.__game.step(1); }, c);
    const step = (n = 1) => page.evaluate((n) => window.__game.step(n), n);
    const setHour = (h) => page.evaluate((h) => window.__game.setTime(h, true), h);
    await cmd('sys.set_time_scale', { scale: 0 });
    const player = async () => (await q('player.info')).pos;
    let frame = 0;
    const snap = async () => { await page.screenshot({ path: `${ROOT}/${String(frame++).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 93 }); };

    // ---- scene prep: house site on the meadow, player start ----
    const HX = 44, HZ = 114;                       // house origin (7x7) on open beach sand (habitat 'sand' ~ (48,120))
    const groundY = async (x, z) => { for (let y = 40; y > 0; y--) { const b = await q('world.block', { x, y, z }); const id = b.id ?? b; if (id && id !== 16 && !(id >= 21 && id <= 30)) return y; } return 4; };
    const gy = await groundY(HX + 3, HZ + 3);
    const G = gy;                                   // y of the floor layer (replaces the grass top)
    await cmd('debug.teleport', { x: 58, z: -2 });
    await step(40);
    const P0 = await player();

    // ---- 1. dive ----
    for (let f = 0; f < Math.round(SHOTS[0].s * FPS); f++) {
      const u = ease(f / (Math.round(SHOTS[0].s * FPS) - 1));
      const h = 900 * Math.pow(9 / 900, u), back = 520 * Math.pow(8 / 520, u);
      await cam({ pos: [P0[0] + 30 * (1 - u), P0[1] + h, P0[2] - back], target: [P0[0], P0[1] + 1 * u, P0[2]], fov: lerp(70, 58, u) });
      await snap();
    }

    // ---- 2. sprint-jump run with a swooping tracking camera (player runs +z from the meadow edge) ----
    await cmd('debug.teleport', { x: 51, z: -14 });                // clear village path: ~40 m of open ground along +z
    await step(40);
    await page.keyboard.down('KeyW');                              // walk first, sprint-jump in the middle, walk out
    let cp = null; const runN = Math.round(SHOTS[1].s * FPS);
    for (let f = 0; f < runN; f++) {
      const rt = f / FPS;
      if (Math.abs(rt - 4.0) < 0.009) await page.keyboard.down('ShiftLeft');
      if (Math.abs(rt - 9.0) < 0.009) await page.keyboard.up('ShiftLeft');
      if ([5.2, 6.7, 8.0].some((x) => Math.abs(rt - x) < 0.009)) await page.keyboard.press('Space');
      const p = await player();
      cp = cp ?? p;
      cp = [lerp(cp[0], p[0], 0.18), lerp(cp[1], p[1], 0.18), lerp(cp[2], p[2], 0.18)];
      const u = f / (runN - 1), a = lerp(-1.3, 1.1, ease(u));     // camera swings from the side to behind and low in front
      const d = lerp(7.5, 5.2, Math.sin(u * Math.PI));
      await cam({ pos: [cp[0] + Math.sin(a) * d, cp[1] + lerp(1.6, 2.6, Math.sin(u * Math.PI)), cp[2] - Math.cos(a) * d], target: [cp[0], cp[1] + 1.0, cp[2] + 1.8], fov: lerp(78, 66, ease(u)) });
      await snap();
    }
    await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');

    // ---- 3. the cottage builds itself ----
    await cmd('debug.teleport', { x: HX - 6, z: HZ - 4 }); await step(30);
    const blocks = [];
    const add = (x, y, z, name) => blocks.push([HX + x, G + y, HZ + z, name]);
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) add(i, 0, j, 'planks');               // floor
    for (let y = 1; y <= 4; y++) for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const edge = i === 0 || i === 6 || j === 0 || j === 6; if (!edge) continue;
      const corner = (i === 0 || i === 6) && (j === 0 || j === 6);
      if (j === 0 && i === 3 && y <= 2) continue;                                                 // door
      let n = y <= 2 ? 'cobble' : 'plaster'; if (corner) n = 'log_oak';
      if (!corner && y >= 2 && y <= 3 && ((i === 3 && j !== 0) || (j === 3 && i !== 3 && (i === 0 || i === 6)))) n = 'glass';
      add(i, y, j, n);
    }
    for (let k = 0; k < 4; k++) for (let i = k; i <= 6 - k; i++) for (let j = k; j <= 6 - k; j++) add(i, 5 + k, j, 'roof_tile');
    add(2, 1, -1, 'lantern'); add(4, 1, -1, 'lantern');
    const buildN = Math.round(SHOTS[2].s * FPS), every = Math.max(1, Math.floor((buildN * 0.82) / blocks.length));   // one block every ~3 frames
    let bi = 0; const cx = HX + 3.5, cz = HZ + 3.5;
    for (let f = 0; f < buildN; f++) {
      if (f % every === 0 && bi < blocks.length) { const [x, y, z, n] = blocks[bi++]; await cmd('world.set_block', { x, y, z, name: n }); }
      const u = f / (buildN - 1), a = -0.9 + u * 2.4;
      await cam({ pos: [cx + Math.sin(a) * lerp(15, 11, u), G + lerp(7, 9, u), cz + Math.cos(a) * lerp(15, 11, u)], target: [cx, G + lerp(1.5, 3.2, u), cz], fov: 62 });
      await snap();
    }
    while (bi < blocks.length) { const [x, y, z, n] = blocks[bi++]; await cmd('world.set_block', { x, y, z, name: n }); }

    // ---- 4. creature cameos (whip cuts) ----
    const ids = [];
    for (let s = 0; s < 3; s++) { const r = await cmd('debug.spawn_creature', { species: s, x: HX + 2 + s * 1.6, z: HZ - 4.5 - (s % 2), count: 1 }); ids.push(r.id ?? (r.ids ?? [])[0]); }
    await step(45);
    const cn = Math.round(SHOTS[3].s * FPS);
    for (let f = 0; f < cn; f++) {
      const w = Math.min(2, Math.floor((f / cn) * 3)), t = f / FPS;
      const pos = await page.evaluate((id) => { const ch = window.__gw.bridge.channel('creatures'); const d = ch.data, s = ch.stride, n = Math.floor(ch.len / s); for (let i = 0; i < n; i++) if (Math.round(d[i * s]) === id) return [d[i * s + 3], d[i * s + 4], d[i * s + 5]]; return null; }, ids[w]);
      if (pos) { const a = 0.4 + t * 0.4 + w * 2; await cam({ pos: [pos[0] + Math.sin(a) * 2.6, pos[1] + 0.95, pos[2] + Math.cos(a) * 2.6], target: [pos[0], pos[1] + 0.4, pos[2]], fov: 52 }); } else await step(1);
      await snap();
    }

    // ---- 5. time-lapse around the finished cottage ----
    const ln = Math.round(SHOTS[4].s * FPS);
    for (let f = 0; f < ln; f++) {
      const u = f / (ln - 1);
      await setHour(lerp(16.4, 22.8, ease(u)));
      const a = 1.5 + u * 2.2;
      await cam({ pos: [cx + Math.sin(a) * lerp(13, 20, u), G + lerp(4.5, 10, u), cz + Math.cos(a) * lerp(13, 20, u)], target: [cx, G + 3, cz], fov: 64 });
      await snap();
    }

    // ---- 6. outro pull-back ----
    const on = Math.round(SHOTS[5].s * FPS);
    for (let f = 0; f < on; f++) {
      const u = ease(f / (on - 1));
      await cam({ pos: [cx + 17 + 14 * u, G + 8 + 14 * u, cz + 3 + 10 * u], target: [cx, G + 3, cz], fov: 64 });
      await snap();
    }
    if (errors.length) console.error('page errors:', errors.slice(0, 3));
  } finally {
    await close();
  }
  console.error(`captured ${total} frames`);
}

function encode() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const font = 'C\\:/Windows/Fonts/arialbd.ttf';
  const sec = (i) => SHOTS.slice(0, i).reduce((a, x) => a + Math.round(x.s * FPS) / FPS, 0);
  const T = SHOTS.map((_, i) => [sec(i), sec(i + 1)]);
  const txt = (text, a, b, size, y) => `drawtext=fontfile='${font}':text='${text}':fontcolor=0xfff7e8:fontsize=${size}:x=(w-text_w)/2:y=${y}:borderw=6:bordercolor=0x4a3b52:enable='between(t,${a.toFixed(2)},${(b - 0.15).toFixed(2)})'`;
  const cuts = T.slice(1).map(([a]) => `eq=brightness='-max(0,1-abs(t-${a.toFixed(3)})/0.12)':eval=frame`).join(',');
  const vf = [
    cuts,
    txt('ONE ISLAND. ALL BLOCKS.', T[0][0] + 0.2, T[0][1], 78, 'h*0.16'),
    txt('SPRINT. JUMP. EXPLORE.', T[1][0] + 0.2, T[1][1], 74, 'h*0.16'),
    txt('BUILD ANYTHING', T[2][0] + 0.2, T[2][1], 92, 'h*0.16'),
    txt('MEET YOUR CREATURES', T[3][0] + 0.2, T[3][1], 74, 'h*0.16'),
    txt('LIVE IN IT', T[4][0] + 0.2, T[4][1], 96, 'h*0.16'),
    txt('GLIMMERWICK', T[5][0] + 0.1, T[5][1], 120, 'h*0.40'),
    txt('early prototype  -  original game', T[5][0] + 0.1, T[5][1], 40, 'h*0.40+150'),
    'fade=t=in:st=0:d=0.3', `fade=t=out:st=${(total / FPS - 0.5).toFixed(2)}:d=0.5`, 'format=yuv420p',
  ].filter(Boolean).join(',');
  const r = spawnSync(FFMPEG, ['-y', '-framerate', String(FPS), '-i', `${ROOT}/%05d.jpg`, '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.slice(-1500)); process.exit(1); }
  const probe = spawnSync(FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'default=nw=1', OUT], { encoding: 'utf8' });
  console.log(JSON.stringify({ ok: true, out: OUT, frames: total, probe: (probe.stdout || '').trim().replace(/\r?\n/g, ' ') }));
}

if (!args.includes('--skip-frames')) await capture();
encode();
if (!args.includes('--keep') && !TEST) fs.rmSync(ROOT, { recursive: true, force: true });
