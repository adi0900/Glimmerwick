#!/usr/bin/env node
// tools/shot.mjs -- deterministic screenshots + perf stats of the web client (real GPU, headless Chrome/Edge).
//
//   node tools/shot.mjs --view _slice --cam wide [--time 16.5 --weather rain --seed 1 --size 1920x1080 --q high]
//                       [--settle 90] [--out FILE] [--filmstrip 8 --interval 120]
//                       [--crop x,y,w,h --zoom 3] [--cam-pos x,y,z --cam-target x,y,z --fov 50]
//                       [--pack <module> --round N]
//   other: --url http://localhost:5173 (default)  --serve (private temp Vite on a free port)  --mock  --hud
//          --browser chrome|edge|<exe>  --bench 90 | --no-bench  --timeout 120  --param "k=v&k2=v2"  --keep-frames
//
// Output: PNG(s) under shots/<view>/r<round>/ (or --out) and ONE JSON line on stdout:
//   {ok, view, cam, out, fps, frameMs, cpuMs, gpuMs, drawCalls, triangles, consoleErrors, pageErrors, ...}
// Exit code: 0 ok - 1 page/console errors (PNG is still written) - 2 infrastructure failure - 3 usage error.
// Human-readable progress goes to stderr. A unique temp user-data-dir is used per run and the browser is always killed.
import fs from 'node:fs';
import path from 'node:path';
import {
  contactSheet,
  cropZoom,
  ensureDir,
  httpOk,
  launchBrowser,
  parseArgs,
  repoRoot,
  startPrivateServer,
} from './lib/browser.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['serve', 'mock', 'hud', 'no-bench', 'keep-frames', 'help', 'quiet', 'verbose'] });

if (args.help || args.h) {
  process.stderr.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(0);
}

const log = (...a) => !args.quiet && process.stderr.write(a.join(' ') + '\n');
const die = (code, msg) => {
  process.stderr.write(`shot: ${msg}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(code);
};

function parseSize(v, dflt = [1920, 1080]) {
  if (!v) return dflt;
  if (Array.isArray(v)) return [Number(v[0]), Number(v[1])];
  const m = /^(\d+)\s*[x,]\s*(\d+)$/.exec(String(v));
  if (!m) die(3, `bad --size "${v}" (expected 1920x1080)`);
  return [Number(m[1]), Number(m[2])];
}

function shotId(s) {
  if (s.id) return String(s.id).replace(/[^\w.-]+/g, '_');
  const parts = [s.cam ?? (s.camPos ? 'free' : 'default')];
  if (s.time !== undefined && s.time !== null) parts.push('t' + String(s.time).replace(':', ''));
  if (s.weather) parts.push(String(s.weather).replace(':', '-'));
  return parts.join('_');
}

function buildUrl(base, s, size) {
  const p = new URLSearchParams();
  p.set('view', s.view);
  if (s.cam) p.set('cam', s.cam);
  if (s.camPos) p.set('camPos', s.camPos);
  if (s.camTarget) p.set('camTarget', s.camTarget);
  if (s.fov) p.set('fov', String(s.fov));
  if (s.time !== undefined && s.time !== null) p.set('time', String(s.time));
  if (s.weather) p.set('weather', String(s.weather));
  if (s.weatherIntensity !== undefined) p.set('wi', String(s.weatherIntensity));
  if (s.seed !== undefined) p.set('seed', String(s.seed));
  if (s.q) p.set('q', s.q);
  if (s.mock) p.set('mock', '1');
  if (s.hud) {
    p.set('hud', '1');
    p.set('stats', '1');
  }
  // stills are frozen for determinism; filmstrips must run live, otherwise they film a stopped world
  // (override either way with --param "freeze=0|1")
  if (!s.filmstrip) p.set('freeze', '1');
  p.set('w', String(size[0]));
  p.set('h', String(size[1]));
  if (s.param) for (const [k, v] of new URLSearchParams(s.param)) p.set(k, v);
  return `${base}/?${p.toString()}`;
}

async function runShot(browser, base, s, outPath) {
  const size = parseSize(s.size);
  const url = buildUrl(base, s, size);
  const timeoutMs = Number(args.timeout ?? 120) * 1000;
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1], deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  const warnings = [];
  let bridgeBanner = '';
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') {
      consoleErrors.push(text);
      log(`  [console.error] ${args.verbose ? text : text.split('\n')[0]}`);
    } else if (t === 'warning') {
      warnings.push(text);
      if (!args.quiet && args.verbose) log(`  [console.warn] ${text.split('\n')[0]}`);
    } else if (/^\[bridge:/.test(text) || /bridge:(mock|wasm)/.test(text)) bridgeBanner = text;
    else if (args.verbose) log(`  [console.${t}] ${text.split('\n')[0]}`);
  });
  page.on('pageerror', (e) => {
    pageErrors.push(String(e?.stack ?? e?.message ?? e));
    log(`  [pageerror] ${String(e?.message ?? e).split('\n')[0]}`);
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(f)) {
      consoleErrors.push(`request failed: ${r.url()} ${f}`);
      log(`  [requestfailed] ${r.url()} ${f}`);
    }
  });
  // The dev server reloads pages when files change (HMR / a concurrent wasm rebuild). Errors that belong to a
  // document that was replaced are stale: forget them when the main frame navigates again.
  let navCount = 0;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    navCount++;
    if (navCount > 1) {
      consoleErrors.length = 0;
      pageErrors.length = 0;
      warnings.length = 0;
      log('  (page reloaded by the dev server - discarding errors from the replaced document)');
    }
  });
  const result = { ok: true, id: shotId(s), view: s.view, cam: s.cam ?? (s.camPos ? 'free' : null), size: `${size[0]}x${size[1]}`, url };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
      await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: timeoutMs, polling: 100 });
    } catch (e) {
      const errs = await page.evaluate(() => (window.__game ? window.__game.errors() : ['__game missing'])).catch(() => []);
      const fatal = await page.evaluate(() => document.getElementById('fatal-msg')?.textContent ?? '').catch(() => '');
      throw new Error(`page never became ready (${e.message}); engine errors: ${JSON.stringify(errs).slice(0, 800)} ${fatal.slice(0, 600)}`);
    }
    const settle = Number(s.settle ?? args.settle ?? 90);
    await page.evaluate((n) => window.__game.settle(n), settle);

    ensureDir(path.dirname(outPath));
    let mainPng;
    if (s.filmstrip) {
      const frames = Math.max(2, Number(s.filmstrip.frames ?? s.filmstrip));
      const interval = Number(s.filmstrip.interval ?? args.interval ?? 120);
      const stepN = Math.max(1, Math.round((interval / 1000) * 60));
      const tiles = [];
      for (let i = 0; i < frames; i++) {
        if (i > 0) await page.evaluate((k) => window.__game.step(k), stepN);
        await page.evaluate(() => window.__game.settle(2));
        const png = await page.screenshot({ type: 'png' });
        tiles.push({ png, label: `#${i}  +${i * interval} ms` });
      }
      const cols = frames <= 4 ? frames : frames <= 6 ? 3 : 4;
      const tileW = Math.min(size[0], Math.floor(2560 / cols) - 8);
      const sheet = await contactSheet(browser, tiles, { cols, tileW });
      const stripPath = outPath.replace(/\.png$/i, '') + '_strip.png';
      fs.writeFileSync(stripPath, sheet);
      mainPng = tiles[0].png;
      if (args['keep-frames']) {
        tiles.forEach((t, i) => fs.writeFileSync(outPath.replace(/\.png$/i, '') + `_f${String(i).padStart(2, '0')}.png`, t.png));
      }
      result.out = stripPath;
      result.frames = frames;
      result.intervalMs = interval;
    } else {
      mainPng = await page.screenshot({ type: 'png' });
      fs.writeFileSync(outPath, mainPng);
      result.out = outPath;
    }

    // crop / zoom (on the first frame for filmstrips)
    const cropSpec = s.crop ?? args.crop;
    const zoom = Number(s.zoom ?? args.zoom ?? (cropSpec ? 3 : 0));
    if (cropSpec || zoom > 1) {
      let [cx, cy, cw, ch] = cropSpec ? String(cropSpec).split(',').map(Number) : [0, 0, 0, 0];
      if (!cropSpec) {
        cw = Math.round(size[0] / zoom);
        ch = Math.round(size[1] / zoom);
        cx = Math.round((size[0] - cw) / 2);
        cy = Math.round((size[1] - ch) / 2);
      }
      if ([cx, cy, cw, ch].some((n) => !Number.isFinite(n)) || cw <= 0 || ch <= 0) throw new Error(`bad --crop "${cropSpec}" (expected x,y,w,h)`);
      const z = zoom > 0 ? zoom : 3;
      const png = await cropZoom(browser, mainPng, { x: cx, y: cy, w: cw, h: ch, zoom: z });
      const cropPath = outPath.replace(/\.png$/i, '') + '_crop.png';
      fs.writeFileSync(cropPath, png);
      result.crop = cropPath;
      result.cropRect = [cx, cy, cw, ch];
      result.zoom = z;
    }

    // stats (rAF-measured, scene frozen but still rendering every frame), then an uncapped benchmark
    const st = await page.evaluate(() => window.__game.stats());
    let bench = null;
    if (!args['no-bench']) bench = await page.evaluate((n) => window.__game.bench(n), Number(args.bench ?? 90));
    const mods = await page.evaluate(() => window.__game.modules());
    const bridge = await page.evaluate(() => window.__game.bridge);
    const engineErrors = await page.evaluate(() => window.__game.errors());
    Object.assign(result, {
      bridge,
      modules: mods,
      fps: round(st.fps, 1),
      frameMs: bench ? round(bench.frameMs, 2) : round(st.ms, 2),
      cpuMs: bench ? round(bench.cpuMs, 2) : round(st.cpuMs, 2),
      gpuMs: bench ? round(bench.gpuMs, 2) : round(st.gpuMs, 2),
      drawCalls: st.calls,
      triangles: st.tris,
      geoms: st.geoms,
      textures: st.textures,
      heapMB: round(st.heapMB, 0),
      pixelRatio: st.pixelRatio,
      consoleErrors: consoleErrors.length,
      pageErrors: pageErrors.length,
      warnings: warnings.length,
      reloads: Math.max(0, navCount - 1),
      engineErrors: engineErrors.length,
    });
    if (bridgeBanner) result.bridgeBanner = bridgeBanner.replace(/%c/g, '').replace(/\s+/g, ' ').slice(0, 120);
    if (consoleErrors.length) result.firstConsoleError = consoleErrors[0].split('\n')[0].slice(0, 300);
    if (pageErrors.length) result.firstPageError = pageErrors[0].split('\n')[0].slice(0, 300);
    if (consoleErrors.length || pageErrors.length) result.ok = false;
  } finally {
    await page.close().catch(() => undefined);
  }
  return result;
}

function round(v, d) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

// ------------------------------------------------------------------------------------------------ main

(async () => {
  let server = null;
  let br = null;
  const watchdog = setTimeout(() => {
    process.stderr.write('shot: global watchdog fired (hung page?) -- killing browser\n');
    br?.close().finally(() => {
      server?.stop();
      process.stdout.write(JSON.stringify({ ok: false, error: 'watchdog timeout' }) + '\n');
      process.exit(2);
    });
  }, Number(args.watchdog ?? 900) * 1000);
  watchdog.unref?.();

  try {
    let base = String(args.url ?? 'http://localhost:5173').replace(/\/+$/, '');
    if (args.serve) {
      log('shot: starting a private Vite server ...');
      server = await startPrivateServer();
      base = server.url;
    } else if (!(await httpOk(base + '/'))) {
      die(2, `dev server not reachable at ${base} -- ask the orchestrator to start it (preview_start web), or pass --serve for a private temporary server`);
    }

    // work list
    const shots = [];
    let outDir = null;
    const common = {
      q: args.q,
      mock: !!args.mock,
      hud: !!args.hud,
      param: args.param,
      settle: args.settle,
    };
    if (args.pack) {
      const m = String(args.pack);
      const file = path.join(repoRoot, 'web', 'src', 'modules', m, 'shots.json');
      if (!fs.existsSync(file)) die(3, `no shots.json for module "${m}" (${file})`);
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) die(3, `${file} must be a JSON array`);
      const round = args.round ?? 0;
      outDir = path.join(repoRoot, 'shots', m, `r${round}`);
      for (const e of list) shots.push({ ...common, view: m, ...e, q: e.q ?? common.q });
    } else {
      const view = String(args.view ?? 'game');
      const [w, h] = parseSize(args.size);
      shots.push({
        ...common,
        view,
        id: args.id,
        cam: args.cam,
        camPos: args['cam-pos'],
        camTarget: args['cam-target'],
        fov: args.fov,
        time: args.time,
        weather: args.weather,
        weatherIntensity: args['weather-intensity'],
        seed: args.seed,
        size: `${w}x${h}`,
        filmstrip: args.filmstrip ? { frames: Number(args.filmstrip), interval: Number(args.interval ?? 120) } : undefined,
      });
      outDir = path.join(repoRoot, 'shots', view, `r${args.round ?? 0}`);
    }
    if (!shots.length) die(3, 'nothing to shoot');

    // a free-camera shot needs both points
    for (const s of shots) if (!!s.camPos !== !!s.camTarget) die(3, '--cam-pos and --cam-target must be given together');

    const first = parseSize(shots[0].size);
    const launched = await launchBrowser({ width: first[0], height: first[1], browser: args.browser });
    br = launched;
    log(`shot: ${launched.executablePath} -> ${base}`);

    const results = [];
    for (const s of shots) {
      const id = shotId(s);
      const out = args.out && shots.length === 1 ? path.resolve(String(args.out)) : path.join(outDir, `${id}.png`);
      log(`shot: ${s.view} / ${id} ...`);
      try {
        results.push(await runShot(launched.browser, base, s, out));
      } catch (e) {
        log(`  FAILED: ${e.message}`);
        results.push({ ok: false, id, view: s.view, error: String(e.message).slice(0, 600) });
      }
    }

    let summary;
    if (args.pack) {
      const okAll = results.every((r) => r.ok);
      const nums = (k) => results.map((r) => r[k]).filter((v) => typeof v === 'number');
      summary = {
        ok: okAll,
        pack: args.pack,
        round: Number(args.round ?? 0),
        count: results.length,
        dir: outDir,
        fps: nums('fps').length ? Math.min(...nums('fps')) : null,
        frameMs: nums('frameMs').length ? Math.max(...nums('frameMs')) : null,
        gpuMs: nums('gpuMs').length ? Math.max(...nums('gpuMs')) : null,
        drawCalls: nums('drawCalls').length ? Math.max(...nums('drawCalls')) : null,
        triangles: nums('triangles').length ? Math.max(...nums('triangles')) : null,
        consoleErrors: nums('consoleErrors').reduce((a, b) => a + b, 0),
        pageErrors: nums('pageErrors').reduce((a, b) => a + b, 0),
        shots: results.map((r) => ({ id: r.id, ok: r.ok, out: r.out, crop: r.crop, fps: r.fps, frameMs: r.frameMs, drawCalls: r.drawCalls, triangles: r.triangles, consoleErrors: r.consoleErrors, pageErrors: r.pageErrors, error: r.error })),
      };
    } else summary = results[0];

    process.stdout.write(JSON.stringify(summary) + '\n');
    await launched.close();
    server?.stop();
    clearTimeout(watchdog);
    process.exit(summary.ok ? 0 : results.some((r) => r.error) ? 2 : 1);
  } catch (e) {
    process.stderr.write(`shot: ${e?.stack ?? e}\n`);
    await br?.close();
    server?.stop();
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 600) }) + '\n');
    process.exit(2);
  }
})();
