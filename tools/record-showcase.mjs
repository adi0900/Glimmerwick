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
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : TEST ? 'showcase/test.mp4' : 'showcase/glimmerwick_showcase_1080p60.mp4');
const ROOT = path.resolve('showcase/frames');
const FPS = 60;
const BASE = 'http://127.0.0.1:5173';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotOpts = { type: 'jpeg', quality: 93 };

// ---- choreography (main pane). t in seconds, relative to the segment start --------------------------------------
const SEGMENTS = [
  { name: 'village', hours: 16.4, seconds: 10, place: 'village', events: [[0.0, 'spawn'], [1.6, 'down', 'KeyW'], [3.4, 'press', 'Space'], [4.4, 'down', 'ShiftLeft'], [6.6, 'press', 'Space'], [7.4, 'up', 'ShiftLeft'], [8.0, 'up', 'KeyW']] },
  { name: 'beach', hours: 17.5, seconds: 9, place: 'sand', events: [[0.0, 'spawn'], [1.2, 'down', 'KeyW'], [4.0, 'press', 'Space'], [7.2, 'up', 'KeyW']] },
  { name: 'sunset', hours: 18.25, seconds: 8, place: 'sand2', events: [[0.0, 'spawn'], [1.0, 'down', 'KeyW'], [5.5, 'up', 'KeyW']] },
  { name: 'night', hours: 22.6, seconds: 8, place: 'village', events: [[0.0, 'spawn'], [1.5, 'down', 'KeyW'], [5.0, 'press', 'Space'], [6.0, 'up', 'KeyW']] },
];
const CARDS = [
  { cam: 'facePuffbun', label: 'PUFFBUN' }, { cam: 'faceTidler', label: 'TIDLER' }, { cam: 'faceSprigfox', label: 'SPRIGFOX' }, { cam: 'faceAvatar', label: 'EXPLORER' },
];
const segs = TEST ? [{ ...SEGMENTS[0], seconds: 4 }] : SEGMENTS;
const totalFrames = segs.reduce((a, s) => a + Math.round(s.seconds * FPS), 0);

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
    // ---------------- main gameplay pane ----------------
    fs.mkdirSync(`${ROOT}/main`, { recursive: true });
    const { page, errors } = await openPage(browser, `${BASE}/?view=game&time=16.4&freeze=1&w=1440&h=1080&q=ultra`, 1440, 1080);
    const q = (name, a = {}) => page.evaluate((n, x) => { const r = window.__gw.bridge.query(n, x); return typeof r === 'string' ? JSON.parse(r) : r; }, name, a);
    const cmd = (name, a = {}) => page.evaluate((n, x) => window.__gw.bridge.command(n, x), name, a);
    await cmd('sys.set_time_scale', { scale: 0 });
    const world = await q('world.info');
    const places = {
      village: world.spawn?.village ?? [world.spawn?.x, world.spawn?.z],
      sand: (world.habitats?.['2'] ?? [])[0] ?? null,
      sand2: (world.habitats?.['2'] ?? [])[1] ?? (world.habitats?.['2'] ?? [])[0] ?? null,
    };
    let frame = 0;
    for (const seg of segs) {
      await page.evaluate((h) => window.__game.setTime(h, true), seg.hours);
      const n = Math.round(seg.seconds * FPS);
      const ev = [...seg.events].sort((a, b) => a[0] - b[0]);
      let ei = 0;
      for (let f = 0; f < n; f++) {
        const t = f / FPS;
        while (ei < ev.length && ev[ei][0] <= t) {
          const [, kind, key] = ev[ei++];
          if (kind === 'spawn') {
            const p = places[seg.place] ?? places.village;
            await cmd('debug.teleport', { x: p[0] - 2, z: p[1] - 6 });
            await page.evaluate(() => window.__game.step(30));
            const me = await q('player.info');
            for (let s = 0; s < 3; s++) await cmd('debug.spawn_creature', { species: s, x: me.pos[0] + 1.5 + s * 1.8, z: me.pos[2] + 5 + (s % 2) * 2.5, count: 1 });
          } else if (kind === 'down') await page.keyboard.down(key);
          else if (kind === 'up') await page.keyboard.up(key);
          else if (kind === 'press') await page.keyboard.press(key);
        }
        await page.evaluate(() => window.__game.step(1));
        await page.screenshot({ path: `${ROOT}/main/${String(frame++).padStart(5, '0')}.jpg`, ...shotOpts });
      }
      for (const k of ['KeyW', 'ShiftLeft']) await page.keyboard.up(k).catch(() => {});
      console.error(`main ${seg.name}: ${frame}/${totalFrames}`);
    }
    if (errors.length) console.error('page errors:', errors.slice(0, 3));
    await page.close();

    // ---------------- sidebar cards (one pass each) ----------------
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
  const cuts = []; let acc = 0; for (const s of segs.slice(0, -1)) { acc += s.seconds; cuts.push(acc); }
  const dip = cuts.map((t) => `fade=t=out:st=${t - 0.25}:d=0.25,fade=t=in:st=${t}:d=0.25`).join(',');
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
