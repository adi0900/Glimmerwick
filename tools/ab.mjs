#!/usr/bin/env node
// tools/ab.mjs -- blind A/B comparison of our screenshots against private reference screenshots (docs/QUALITY_BAR.md).
//
//   node tools/ab.mjs make   --ours shots/_slice/r1/wide.png --ref random --id a1 [--tile 960x540] [--fit contain|cover]
//   node tools/ab.mjs reveal --id a1 --pick left|right|close [--scene wide-golden] [--note "why"]
//   node tools/ab.mjs status
//
// make    writes ab/<id>.png (ours vs. a reference, RANDOM left/right, identical tiles, letterboxed to the same size,
//         no labels) and a sealed ab/<id>.key.json. The critic must look ONLY at ab/<id>.png and state a pick.
// reveal  decodes the key, appends the trial to docs/ab_results.json and prints who won. One reveal per id.
// status  prints the running tally from docs/ab_results.json.
//
// --ref random picks a file from reference/*.{png,jpg,jpeg,webp} (README.md ignored; `--seed N` makes it repeatable).
// With no references it logs "no refs" to docs/ab_results.json (rubric-only scoring) and exits with code 3.
// A/B counts as passed when >= 5 trials exist and ours won or was called too-close in more than half of them.
// Image composition uses the headless browser's canvas (no native image dependencies). Exit: 0 ok - 2 failure - 3 no refs / usage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, imageMime, launchBrowser, parseArgs, repoRoot, sideBySide } from './lib/browser.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['force', 'help'] });
const cmd = args._[0];
const abDir = path.join(repoRoot, 'ab');
const refDir = path.join(repoRoot, 'reference');
const resultsFile = path.join(repoRoot, 'docs', 'ab_results.json');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (code, msg, extra = {}) => {
  process.stderr.write(`ab: ${msg}\n`);
  out({ ok: false, error: msg, ...extra });
  process.exit(code);
};

if (args.help || !cmd || !['make', 'reveal', 'status'].includes(cmd)) {
  process.stderr.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(args.help ? 0 : 3);
}

// ----------------------------------------------------------------------------------------------- results file

function loadResults() {
  if (!fs.existsSync(resultsFile)) return { version: 1, trials: [], notes: [], summary: summarize([]) };
  try {
    const r = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    r.trials ??= [];
    r.notes ??= [];
    return r;
  } catch (e) {
    fail(2, `docs/ab_results.json is not valid JSON: ${e.message}`);
  }
}

function summarize(trials, noRefs = false) {
  const oursWon = trials.filter((t) => t.result === 'ours-won').length;
  const refWon = trials.filter((t) => t.result === 'ref-won').length;
  const tooClose = trials.filter((t) => t.result === 'too-close').length;
  const n = trials.length;
  return {
    trials: n,
    oursWon,
    refWon,
    tooClose,
    noRefs,
    // ours must win a majority or be called too-close: needs >= 5 trials
    passed: noRefs && n === 0 ? null : n >= 5 ? oursWon + tooClose > n / 2 : null,
    rule: '>=5 trials and (ours-won + too-close) > half',
  };
}

function saveResults(r) {
  ensureDir(path.dirname(resultsFile));
  r.summary = summarize(r.trials, r.notes.some((n) => n.type === 'no-refs') && r.trials.length === 0);
  fs.writeFileSync(resultsFile, JSON.stringify(r, null, 2) + '\n');
}

// ----------------------------------------------------------------------------------------------- sealing

function keystream(id, len) {
  const out = Buffer.alloc(len);
  let block = crypto.createHash('sha256').update(`gw-ab-seal:${id}`).digest();
  for (let i = 0; i < len; i += 32) {
    block.copy(out, i, 0, Math.min(32, len - i));
    block = crypto.createHash('sha256').update(block).digest();
  }
  return out;
}

function seal(id, obj) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ks = keystream(id, plain.length);
  const sealed = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) sealed[i] = plain[i] ^ ks[i];
  return { sealed: sealed.toString('base64'), check: crypto.createHash('sha256').update(plain).digest('hex').slice(0, 16) };
}

function unseal(id, key) {
  const sealed = Buffer.from(key.sealed, 'base64');
  const ks = keystream(id, sealed.length);
  const plain = Buffer.alloc(sealed.length);
  for (let i = 0; i < sealed.length; i++) plain[i] = sealed[i] ^ ks[i];
  if (crypto.createHash('sha256').update(plain).digest('hex').slice(0, 16) !== key.check) throw new Error('key file is corrupt or was edited');
  return JSON.parse(plain.toString('utf8'));
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// ----------------------------------------------------------------------------------------------- commands

function listRefs() {
  if (!fs.existsSync(refDir)) return [];
  return fs
    .readdirSync(refDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(refDir, f));
}

function seededPick(list, seed) {
  // mulberry32 over the seed (repeatable); crypto random otherwise
  if (seed === undefined) return list[crypto.randomInt(list.length)];
  let s = Number(seed) >>> 0;
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return list[Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * list.length)];
}

async function make() {
  const id = args.id;
  if (!validId(id)) fail(3, '--id is required (letters, digits, - and _)');
  if (!args.ours) fail(3, '--ours FILE is required');
  const oursFile = path.resolve(String(args.ours));
  if (!fs.existsSync(oursFile)) fail(3, `--ours file not found: ${oursFile}`);
  const refArg = String(args.ref ?? 'random');
  let refFile;
  if (refArg === 'random') {
    const refs = listRefs();
    if (!refs.length) {
      const r = loadResults();
      if (!r.notes.some((n) => n.type === 'no-refs')) r.notes.push({ type: 'no-refs', ts: new Date().toISOString(), note: 'reference/ is empty: blind A/B skipped, rubric-only scoring' });
      saveResults(r);
      fail(3, 'no refs: reference/ has no images -- A/B skipped (rubric-only); logged to docs/ab_results.json', { noRefs: true });
    }
    refFile = seededPick(refs, args.seed);
  } else {
    refFile = path.resolve(refArg);
    if (!fs.existsSync(refFile)) fail(3, `--ref file not found: ${refFile}`);
  }

  ensureDir(abDir);
  const imgPath = path.join(abDir, `${id}.png`);
  const keyPath = path.join(abDir, `${id}.key.json`);
  if ((fs.existsSync(imgPath) || fs.existsSync(keyPath)) && !args.force) fail(3, `ab/${id}.* already exists (pick another --id or pass --force)`);

  const oursOnLeft = crypto.randomInt(2) === 0;
  const m = /^(\d+)x(\d+)$/.exec(String(args.tile ?? '960x540'));
  if (!m) fail(3, '--tile must look like 960x540');
  const fit = String(args.fit ?? 'contain');
  if (fit !== 'contain' && fit !== 'cover') fail(3, '--fit must be contain or cover');
  const oursImg = { buffer: fs.readFileSync(oursFile), mime: imageMime(oursFile) };
  const refImg = { buffer: fs.readFileSync(refFile), mime: imageMime(refFile) };

  const launched = await launchBrowser({ width: 1280, height: 720 });
  try {
    const png = await sideBySide(launched.browser, oursOnLeft ? oursImg : refImg, oursOnLeft ? refImg : oursImg, { tileW: Number(m[1]), tileH: Number(m[2]), fit });
    fs.writeFileSync(imgPath, png);
  } finally {
    await launched.close();
  }
  const plain = {
    left: oursOnLeft ? 'ours' : 'ref',
    ours: path.relative(repoRoot, oursFile).replace(/\\/g, '/'),
    ref: path.relative(repoRoot, refFile).replace(/\\/g, '/'),
    fit,
    tile: `${m[1]}x${m[2]}`,
  };
  fs.writeFileSync(keyPath, JSON.stringify({ v: 1, id, created: new Date().toISOString(), ...seal(id, plain) }, null, 2) + '\n');
  // Deliberately NOT printing which side is which, nor the reference's file name.
  out({ ok: true, id, image: path.relative(repoRoot, imgPath).replace(/\\/g, '/'), key: path.relative(repoRoot, keyPath).replace(/\\/g, '/'), sealed: true, next: `look ONLY at ab/${id}.png, then: node tools/ab.mjs reveal --id ${id} --pick left|right|close` });
}

function reveal() {
  const id = args.id;
  if (!validId(id)) fail(3, '--id is required');
  const pick = String(args.pick ?? '');
  if (!['left', 'right', 'close'].includes(pick)) fail(3, '--pick must be left, right or close (too-close)');
  const keyPath = path.join(abDir, `${id}.key.json`);
  if (!fs.existsSync(keyPath)) fail(3, `ab/${id}.key.json not found (run make first)`);
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (key.revealed && !args.force) fail(3, `ab/${id} was already revealed (picked ${key.revealed.pick}); one pick per trial`);
  let plain;
  try {
    plain = unseal(id, key);
  } catch (e) {
    fail(2, e.message);
  }
  const rightIs = plain.left === 'ours' ? 'ref' : 'ours';
  let picked = null;
  let result;
  if (pick === 'close') result = 'too-close';
  else {
    picked = pick === 'left' ? plain.left : rightIs;
    result = picked === 'ours' ? 'ours-won' : 'ref-won';
  }
  const trial = {
    id,
    ts: new Date().toISOString(),
    scene: args.scene ?? null,
    ours: plain.ours,
    ref: plain.ref,
    left: plain.left,
    right: rightIs,
    pick,
    picked,
    result,
    note: args.note ?? null,
  };
  const r = loadResults();
  r.trials = r.trials.filter((t) => t.id !== id);
  r.trials.push(trial);
  saveResults(r);
  key.revealed = { pick, at: trial.ts };
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2) + '\n');
  out({ ok: true, ...trial, summary: r.summary });
}

function status() {
  const r = loadResults();
  out({ ok: true, ...r.summary, notes: r.notes, file: path.relative(repoRoot, resultsFile).replace(/\\/g, '/'), refs: listRefs().length });
}

(async () => {
  try {
    if (cmd === 'make') await make();
    else if (cmd === 'reveal') reveal();
    else status();
    process.exit(0);
  } catch (e) {
    fail(2, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
  }
})();
