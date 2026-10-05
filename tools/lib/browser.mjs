// Shared helpers for tools/shot.mjs and tools/ab.mjs (foundation-web).
//
//  - loads puppeteer-core from web/node_modules (the repo root has no node_modules)
//  - finds Chrome/Edge, launches it headless with real-GPU WebGL2 flags and a UNIQUE temp user-data-dir per run
//    (parallel agents never collide), and guarantees the browser is killed and the temp dir removed on exit
//  - composes images with the browser's own canvas (no native image dependencies): crop/zoom, contact sheets,
//    letterboxed side-by-side comparisons
//  - optionally spawns a private, temporary Vite dev server on a free port (--serve)
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const webDir = path.join(repoRoot, 'web');

const CHROME_CANDIDATES = [
  process.env.GW_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export function findBrowser(pref) {
  if (pref && pref !== 'chrome' && pref !== 'edge') {
    if (fs.existsSync(pref)) return pref;
    throw new Error(`browser not found: ${pref}`);
  }
  let list = CHROME_CANDIDATES.filter(Boolean);
  if (pref === 'edge') list = list.filter((p) => /msedge/i.test(p));
  if (pref === 'chrome') list = list.filter((p) => /chrome/i.test(p));
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('no Chrome/Edge found (set GW_BROWSER to an executable path)');
}

export async function loadPuppeteer() {
  const req = createRequire(path.join(webDir, 'package.json'));
  let resolved;
  try {
    resolved = req.resolve('puppeteer-core');
  } catch {
    throw new Error('puppeteer-core is not installed: run `npm install` in web/');
  }
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}

/** Launch headless Chrome/Edge with GPU WebGL2. Returns {browser, close()}; close() is idempotent. */
export async function launchBrowser({ width = 1920, height = 1080, browser: pref, extraArgs = [] } = {}) {
  const puppeteer = await loadPuppeteer();
  const executablePath = findBrowser(pref);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-shot-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    args: [
      '--enable-gpu',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${width},${height}`,
      ...extraArgs,
    ],
  });
  let closed = false;
  const proc = browser.process();
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      /* ignore */
    }
    try {
      proc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 6; i++) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  const onExit = () => {
    try {
      proc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.once('exit', onExit);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      onExit();
      process.exit(130);
    });
  }
  return { browser, close, executablePath, userDataDir };
}

/** Run `fn(args)` inside a throwaway page of `browser` and return its (JSON-serialisable) result. */
export async function inBrowser(browser, fn, args) {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    return await page.evaluate(fn, args);
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------------------- image helpers

/** Crop (x,y,w,h in source px) and upscale by `zoom` with nearest-neighbour. Returns a PNG Buffer. */
export async function cropZoom(browser, png, { x, y, w, h, zoom }) {
  const b64 = await inBrowser(
    browser,
    async ({ b64, x, y, w, h, zoom }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const sw = Math.min(w, bmp.width - x);
      const sh = Math.min(h, bmp.height - y);
      const c = document.createElement('canvas');
      c.width = Math.round(sw * zoom);
      c.height = Math.round(sh * zoom);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(bmp, x, y, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/png').split(',')[1];
    },
    { b64: png.toString('base64'), x, y, w, h, zoom },
  );
  return Buffer.from(b64, 'base64');
}

/** Contact sheet of equally sized PNG frames. tiles: [{png:Buffer,label:string}] */
export async function contactSheet(browser, tiles, { cols, tileW, label = true } = {}) {
  const b64 = await inBrowser(
    browser,
    async ({ items, cols, tileW, label }) => {
      const bmps = [];
      for (const it of items) {
        const blob = await (await fetch(`data:image/png;base64,${it.b64}`)).blob();
        bmps.push(await createImageBitmap(blob));
      }
      const aspect = bmps[0].height / bmps[0].width;
      const tw = tileW;
      const th = Math.round(tw * aspect);
      const gap = 6;
      const rows = Math.ceil(items.length / cols);
      const c = document.createElement('canvas');
      c.width = cols * tw + (cols + 1) * gap;
      c.height = rows * th + (rows + 1) * gap;
      const g = c.getContext('2d');
      g.fillStyle = '#1d1633';
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      bmps.forEach((b, i) => {
        const cx = gap + (i % cols) * (tw + gap);
        const cy = gap + Math.floor(i / cols) * (th + gap);
        g.drawImage(b, cx, cy, tw, th);
        if (label) {
          g.font = '600 15px system-ui, sans-serif';
          const t = items[i].label;
          const m = g.measureText(t);
          g.fillStyle = 'rgba(20,14,36,.7)';
          g.fillRect(cx + 6, cy + 6, m.width + 12, 22);
          g.fillStyle = '#fff7e8';
          g.fillText(t, cx + 12, cy + 22);
        }
      });
      return c.toDataURL('image/png').split(',')[1];
    },
    { items: tiles.map((t) => ({ b64: t.png.toString('base64'), label: t.label })), cols, tileW, label },
  );
  return Buffer.from(b64, 'base64');
}

// ----------------------------------------------------------------------------------------- dev server

export function httpOk(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Spawn a private Vite dev server on a free port; resolves {url, stop()} once it answers. */
export async function startPrivateServer() {
  const port = await freePort();
  const vite = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, webDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const stop = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  process.once('exit', stop);
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (child.exitCode !== null) throw new Error(`private vite exited early:\n${log}`);
    if (await httpOk(url + '/', 1000)) return { url, stop };
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`private vite did not start in 45 s:\n${log}`);
}

// ----------------------------------------------------------------------------------------- args

/** minimal `--key value` / `--flag` parser. Positional args land in `_`. */
export function parseArgs(argv, { flags = [] } = {}) {
  const out = { _: [] };
  const flagSet = new Set(flags);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const k = a.slice(2);
      if (flagSet.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------------------------------------------------------------------------------- A/B helper

/**
 * Side-by-side comparison image: two images drawn into identical tiles (letterboxed `contain` or centre-cropped
 * `cover`), with a neutral divider. Inputs may be PNG / JPEG / WebP buffers. Returns a PNG Buffer.
 * No labels are drawn: nothing in the output identifies which side is which.
 */
export async function sideBySide(browser, left, right, { tileW = 960, tileH = 540, fit = 'contain', gap = 8 } = {}) {
  const b64 = await inBrowser(
    browser,
    async ({ l, r, tileW, tileH, fit, gap }) => {
      const load = async (o) => {
        const blob = await (await fetch(`data:${o.mime};base64,${o.b64}`)).blob();
        return createImageBitmap(blob);
      };
      const [a, b] = [await load(l), await load(r)];
      const c = document.createElement('canvas');
      c.width = tileW * 2 + gap;
      c.height = tileH;
      const g = c.getContext('2d');
      g.fillStyle = '#202020';
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const draw = (img, x0) => {
        const sx = tileW / img.width;
        const sy = tileH / img.height;
        const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
        const w = img.width * s;
        const h = img.height * s;
        g.save();
        g.beginPath();
        g.rect(x0, 0, tileW, tileH);
        g.clip();
        g.drawImage(img, x0 + (tileW - w) / 2, (tileH - h) / 2, w, h);
        g.restore();
      };
      draw(a, 0);
      draw(b, tileW + gap);
      return c.toDataURL('image/png').split(',')[1];
    },
    {
      l: { b64: left.buffer.toString('base64'), mime: left.mime },
      r: { b64: right.buffer.toString('base64'), mime: right.mime },
      tileW,
      tileH,
      fit,
      gap,
    },
  );
  return Buffer.from(b64, 'base64');
}

export function imageMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}
