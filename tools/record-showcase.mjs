// Frame-exact showcase recorder: freezes the game clock, advances exactly 1/60 s per frame, screenshots every frame,
// then composes (gameplay 1440x1080 | sidebar of 4 model turntables 480x1080) with ffmpeg at constant 60 fps.
// Usage: node tools/record-showcase.mjs [--test] [--out showcase/x.mp4] [--keep] [--skip-frames]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchBrowser } from './lib/browser.mjs';

const args = process.argv.slice(2);
const TEST = args.includes('--test');
const outIdx = args.indexOf('--out');
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : TEST ? `showcase/_tests/test_${stamp}.mp4` : `showcase/glimmerwick_showcase_1080p60_v2_${stamp}.mp4`);
const ROOT = path.resolve('showcase/frames');
const FPS = 60;
const BASE = process.env.SHOWCASE_BASE ?? 'http://127.0.0.1:5173';   // point at a frozen snapshot server so edits can't reload the page
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const shotOpts = { type: 'jpeg', quality: 93 };

// ---- choreography. cam: 'intro' (zoom from outside the map), 'orbit' (showreel on one character), 'follow' (gameplay) ----
// events: [t, 'spawn'|'down'|'up'|'press', key]; 'spawn' teleports to `place`, spawns creatures, restores the follow camera.
const SEGMENTS = [
  { name: 'intro', cam: 'intro', hours: 16.2, seconds: 11, place: 'village', events: [[0, 'spawn']] },
  { name: 'reel_explorer', cam: 'orbit', who: 'player', radius: 3.3, seconds: 5, hours: 16.9, place: 'sand', respawn: true, events: [[0, 'spawn']] },
  { name: 'reel_puffbun', cam: 'orbit', who: 0, radius: 2.5, seconds: 5, hours: 16.4, events: [] },
  { name: 'reel_tidler', cam: 'orbit', who: 1, radius: 2.7, seconds: 5, hours: 16.4, events: [] },
  { name: 'reel_sprigfox', cam: 'orbit', who: 2, radius: 3.1, seconds: 5, hours: 16.4, events: [] },
  { name: 'village', cam: 'follow', hours: 16.6, seconds: 14, place: 'village', events: [[0, 'spawn'], [1.8, 'down', 'KeyW'], [4.0, 'press', 'Space'], [5.2, 'down', 'ShiftLeft'], [8.4, 'press', 'Space'], [9.6, 'up', 'ShiftLeft'], [11.0, 'up', 'KeyW']] },
  { name: 'beach', cam: 'follow', hours: 17.5, seconds: 14, place: 'sand', events: [[0, 'spawn'], [1.2, 'down', 'KeyW'], [5.0, 'press', 'Space'], [10.5, 'up', 'KeyW']] },
  { name: 'sunset', cam: 'follow', hours: 18.2, seconds: 12, place: 'sand2', events: [[0, 'spawn'], [1.0, 'down', 'KeyW'], [8.0, 'up', 'KeyW']] },
  { name: 'night', cam: 'follow', hours: 22.6, seconds: 14, place: 'village', events: [[0, 'spawn'], [1.5, 'down', 'KeyW'], [6.0, 'press', 'Space'], [9.0, 'up', 'KeyW']] },
];
const CARDS = [
  { cam: 'facePuffbun', label: 'PUFFBUN' }, { cam: 'faceTidler', label: 'TIDLER' }, { cam: 'faceSprigfox', label: 'SPRIGFOX' }, { cam: 'faceAvatar', label: 'EXPLORER' },
];
const segs = TEST ? [SEGMENTS[0], SEGMENTS[2]].map((s) => ({ ...s, seconds: 3 })) : SEGMENTS;
const totalFrames = segs.reduce((a, s) => a + Math.round(s.seconds * FPS), 0);
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

async function openPage(browser, url, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 180000 });
  return { page, errors };
}

async function capture() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const { browser, close } = await launchBrowser({ width: 1440, height: 1080 });
  try {
    fs.mkdirSync(`${ROOT}/main`, { recursive: true });
    const { page, errors } = await openPage(browser, `${BASE}/?view=game&time=16.2&freeze=1&w=1440&h=1080&q=ultra`, 1440, 1080);
    const q = (name, a = {}) => page.evaluate((n, x) => { const r = window.__gw.bridge.query(n, x); return typeof r === 'string' ? JSON.parse(r) : r; }, name, a);
    const cmd = (name, a = {}) => page.evaluate((n, x) => window.__gw.bridge.command(n, x), name, a);
    await cmd('sys.set_time_scale', { scale: 0 });
    const world = await q('world.info');
    const sand = world.habitats?.sand ?? [];      // habitats are keyed by NAME ('sand', 'shallows', ...), not by biome id
    const places = { village: world.spawn?.village ?? [world.spawn?.x, world.spawn?.z], sand: sand[0] ?? null, sand2: sand[1] ?? sand[0] ?? null };
    let frame = 0, spawned = [], P = [0, 5, 0];
    for (const seg of segs) {
      await page.evaluate((h) => window.__game.setTime(h, true), seg.hours);
      const n = Math.round(seg.seconds * FPS);
      const ev = [...seg.events].sort((a, b) => a[0] - b[0]);
      let ei = 0;
      for (let f = 0; f < n; f++) {
        const t = f / FPS, u = f / (n - 1);
        while (ei < ev.length && ev[ei][0] <= t) {
          const [, kind, key] = ev[ei++];
          if (kind === 'spawn') {
            const p = places[seg.place] ?? places.village;
            await cmd('debug.teleport', { x: p[0] - 2, z: p[1] - 6 });
            await page.evaluate(() => { window.__game.setCam('game'); window.__game.step(40); });
            const me = await q('player.info');
            P = me.pos;
            if (!spawned.length || seg.respawn || seg.name === 'intro') {
              spawned = [];
              for (let s = 0; s < 3; s++) {
                const r = await cmd('debug.spawn_creature', { species: s, x: P[0] + 2.2 + s * 2.0, z: P[2] + 4.5 + (s % 2) * 2.5, count: 1 });
                spawned.push(r.id ?? (r.ids ?? [])[0]);
              }
            }
          } else if (kind === 'down') await page.keyboard.down(key);
          else if (kind === 'up') await page.keyboard.up(key);
          else if (kind === 'press') await page.keyboard.press(key);
        }
        if (seg.cam === 'intro') {
          // zoom in from far outside the map to behind the character: exponential distance + eased angle
          const e = ease(u), dist = 700 * Math.pow(7.5 / 700, e), h = 360 * Math.pow(2.6 / 360, e);
          const yaw = -0.35 + e * 0.35;
          const pos = [P[0] + Math.sin(yaw) * dist, P[1] + h, P[2] - Math.cos(yaw) * dist];
          const tgt = [P[0], P[1] + 0.2 + 0.9 * e, P[2]];
          await page.evaluate((c) => { window.__game.setCam(c); window.__game.step(1); }, { pos, target: tgt, fov: 52 - 10 * e });
        } else if (seg.cam === 'orbit') {
          await page.evaluate((who, id, radius, tt) => {
            let tp;
            if (who === 'player') { const r = window.__gw.bridge.query('player.info', {}); tp = (typeof r === 'string' ? JSON.parse(r) : r).pos; }
            else { const ch = window.__gw.bridge.channel('creatures'); const d = ch.data, s = ch.stride, n = Math.floor(ch.len / s); tp = null; for (let i = 0; i < n; i++) if (Math.round(d[i * s]) === id) tp = [d[i * s + 3], d[i * s + 4], d[i * s + 5]]; }
            if (!tp) { window.__game.step(1); return; }
            const a = 0.7 + tt * 0.55, hy = who === 'player' ? 0.75 : 0.35;
            window.__game.setCam({ pos: [tp[0] + Math.sin(a) * radius, tp[1] + 1.15 + 0.15 * Math.sin(tt * 2), tp[2] + Math.cos(a) * radius], target: [tp[0], tp[1] + hy, tp[2]], fov: 38 });
            window.__game.step(1);
          }, seg.who === 'player' ? 'player' : 'c', seg.who === 'player' ? 0 : spawned[seg.who], seg.radius, t);
        } else {
          await page.evaluate(() => window.__game.step(1));
        }
        await page.screenshot({ path: `${ROOT}/main/${String(frame++).padStart(5, '0')}.jpg`, ...shotOpts });
      }
      for (const k of ['KeyW', 'ShiftLeft']) await page.keyboard.up(k).catch(() => {});
      console.error(`main ${seg.name}: ${frame}/${totalFrames}`);
    }
    if (errors.length) console.error('page errors:', errors.slice(0, 3));
    await page.close();

    for (const c of CARDS) {
      const dir = `${ROOT}/card_${c.cam}`;
      fs.mkdirSync(dir, { recursive: true });
      const { page: cp } = await openPage(browser, `${BASE}/?view=creatures&set=sheet&spin=0.7&cam=${c.cam}&time=16.5&freeze=1&w=480&h=270`, 480, 270);
      for (let f = 0; f < totalFrames; f++) {
        await cp.evaluate(() => window.__game.step(1));
        await cp.screenshot({ path: `${dir}/${String(f).padStart(5, '0')}.jpg`, ...shotOpts });
      }
      console.error(`card ${c.cam}: ${totalFrames} frames`);
      await cp.close();
    }
  } finally {
    await close();
  }
}

function encode() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const font = 'C\\:/Windows/Fonts/arialbd.ttf';
  const inputs = ['main', ...CARDS.map((c) => `card_${c.cam}`)].flatMap((d) => ['-framerate', String(FPS), '-i', `${ROOT}/${d}/%05d.jpg`]);
  // short dip-to-black at every cut except between showreel segments' neighbours of the same kind
  const cuts = []; let acc = 0; for (const s of segs.slice(0, -1)) { acc += s.seconds; cuts.push(acc); }
  // dip-to-black around each cut (a plain fade-in would hold black from t=0, so use a per-frame brightness ramp)
  const dip = cuts.map((t) => `eq=brightness='-max(0,1-abs(t-${t.toFixed(3)})/0.2)':eval=frame`).join(',');
  const total = totalFrames / FPS;
  const cards = CARDS.map((c, i) => `[${i + 1}:v]scale=480:270,drawbox=x=0:y=0:w=480:h=270:color=0x4a3b52@1:t=4,drawtext=fontfile='${font}':text='${c.label}':fontcolor=0xfff7e8:fontsize=26:x=16:y=h-40:shadowcolor=0x000000@0.6:shadowx=2:shadowy=2[c${i}]`);
  const filter = [
    `[0:v]scale=1440:1080${dip ? ',' + dip : ''}[m]`,
    ...cards,
    `[c0][c1][c2][c3]vstack=inputs=4[side]`,
    `[m][side]hstack=inputs=2[row]`,
    `[row]drawbox=x=0:y=ih-44:w=iw:h=44:color=0x4a3b52@0.82:t=fill,drawtext=fontfile='${font}':text='GLIMMERWICK  -  early prototype  -  original IP':fontcolor=0xfff7e8:fontsize=24:x=20:y=h-34,fade=t=in:st=0:d=0.8,fade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2,format=yuv420p[v]`,
  ].join(';');
  const r = spawnSync(FFMPEG, ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.slice(-1500)); process.exit(1); }
  const probe = spawnSync(FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'default=nw=1', OUT], { encoding: 'utf8' });
  console.log(JSON.stringify({ ok: true, out: OUT, frames: totalFrames, seconds: total, probe: (probe.stdout || '').trim().replace(/\r?\n/g, ' ') }));
}

if (!args.includes('--skip-frames')) await capture();
encode();
if (!args.includes('--keep') && !TEST) fs.rmSync(ROOT, { recursive: true, force: true });
