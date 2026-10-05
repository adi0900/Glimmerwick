#!/usr/bin/env node
// Smoke test of the built WASM simulation package (web/src/wasm/pkg) without a browser.
//
//   node tools/smoke-wasm.mjs                   600 scripted ticks + contract / determinism / save-load checks
//   node tools/smoke-wasm.mjs --bench           also measure sim step time with 12 and 2000 creatures
//   node tools/smoke-wasm.mjs --expect-digest <hex>   compare the 600-tick fingerprint with the native one
//                                               (cargo test -p bridge print_golden_digest -- --ignored --nocapture)
//   options: --pkg <dir>  --seed <n> (default 42)  --ticks <n> (default 600)
//
// Exit code 0 = everything passed, 1 = at least one check failed (all failures are listed).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(opt('--pkg', path.join(root, 'web', 'src', 'wasm', 'pkg')));
const SEED = Number(opt('--seed', 42));
const TICKS = Number(opt('--ticks', 600));
const DT = 1 / 60;

// ---- tiny check framework ------------------------------------------------------------------------
const failures = [];
let checks = 0;
function check(cond, message) {
  checks++;
  if (!cond) {
    failures.push(message);
    console.log(`  FAIL  ${message}`);
  }
  return !!cond;
}
function section(title) {
  console.log(`\n== ${title}`);
}

// Count console.error output of the wasm module (panic hook, logger).
let wasmErrors = 0;
const originalError = console.error;
console.error = (...a) => {
  wasmErrors++;
  originalError(...a);
};

// ---- load -----------------------------------------------------------------------------------------
section(`loading ${path.relative(root, pkgDir)}`);
const bridge = await import(pathToFileURL(path.join(pkgDir, 'bridge.js')).href);
const wasmBytes = readFileSync(path.join(pkgDir, 'bridge_bg.wasm'));
const t0 = performance.now();
const exports = bridge.initSync({ module: wasmBytes });
const memory = exports.memory;
console.log(`  wasm ${(wasmBytes.length / 1024 / 1024).toFixed(2)} MB, instantiated in ${(performance.now() - t0).toFixed(1)} ms`);
const info = JSON.parse(bridge.build_info());
console.log(`  build_info: ${JSON.stringify(info)}`);
check(info.contract === 1, `contract version is ${info.contract}, expected 1`);

// ---- helpers ---------------------------------------------------------------------------------------
const ARRAY = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };

/** Zero-copy views of a channel. Views must be rebuilt after anything that may grow memory. */
function view(game, name) {
  const i = JSON.parse(game.channel_info(name));
  if (i.error) throw new Error(`channel_info(${name}): ${i.error}`);
  const T = ARRAY[i.kind];
  return {
    info: i,
    cur: new T(memory.buffer, i.ptr, i.len),
    prev: i.prev_ptr ? new T(memory.buffer, i.prev_ptr, i.len) : null,
  };
}

const channelNames = (game) => JSON.parse(game.channel_names());
const q = (game, name, a = '') => JSON.parse(game.query(name, a));
const cmd = (game, name, a = '') => JSON.parse(game.command(name, a));

/** Same scripted input as crates/bridge/tests/contract.rs (kept free of transcendental functions so
 *  the f32 values are bit-identical in Rust and JS). */
function script(n, out) {
  out.fill(0);
  const phase = Math.floor(n / 90) % 6;
  if (phase <= 1 || phase === 3) out[1] = 1;
  else if (phase === 2) {
    out[0] = 1;
    out[1] = 0.6;
  } else if (phase === 4) out[0] = -1;
  let b = 0;
  if (n % 120 === 5) b |= 1; // jump
  if (Math.floor(n / 200) % 2 === 1) b |= 4; // sprint
  if (n % 150 === 20) b |= 256; // tool next
  out[4] = b;
  out[5] = ((n % 400) - 200) * Math.fround(0.006); // camera yaw: exact product, rounded once to f32
}

function run(game, ticks, from = 0) {
  const input = new Float32Array(16);
  for (let n = from; n < from + ticks; n++) {
    script(n, input);
    game.set_input(input);
    game.tick(DT);
  }
}

function snapshot(game) {
  return channelNames(game).map((name) => {
    const v = view(game, name);
    return { name, bytes: Buffer.from(v.cur.buffer.slice(v.cur.byteOffset, v.cur.byteOffset + v.cur.byteLength)) };
  });
}

function sameSnapshots(a, b) {
  return a.length === b.length && a.every((x, i) => x.name === b[i].name && Buffer.compare(x.bytes, b[i].bytes) === 0);
}

const REQUIRED = {
  time: { kind: 'f32', stride: 1, interpolated: false },
  player: { kind: 'f32', stride: 16, interpolated: true },
  creatures: { kind: 'f32', stride: 16, interpolated: true },
  'world.height': { kind: 'f32', stride: 1, interpolated: false },
  'world.biome': { kind: 'u8', stride: 1, interpolated: false },
  'world.dirty': { kind: 'u32', stride: 1, interpolated: false },
  'vox.data': { kind: 'u16', stride: 1, interpolated: false },
  'vox.chunks': { kind: 'u32', stride: 2, interpolated: false },
  'vox.dirty': { kind: 'u32', stride: 1, interpolated: false },
  flora: { kind: 'f32', stride: 8, interpolated: false },
  props: { kind: 'f32', stride: 12, interpolated: false },
};

// ---- 1. contract ---------------------------------------------------------------------------------
section(`new Game(${SEED}) and channel contract`);
const tNew = performance.now();
const game = new bridge.Game(SEED);
console.log(`  world generated + spawned in ${(performance.now() - tNew).toFixed(1)} ms`);
const names = channelNames(game);
for (const [name, want] of Object.entries(REQUIRED)) {
  if (!check(names.includes(name), `channel '${name}' is missing (have ${names.join(', ')})`)) continue;
  const v = view(game, name);
  const i = v.info;
  check(i.kind === want.kind, `${name}: kind ${i.kind}, expected ${want.kind}`);
  check(i.stride === want.stride, `${name}: stride ${i.stride}, expected ${want.stride}`);
  check((i.prev_ptr !== 0) === want.interpolated, `${name}: prev_ptr=${i.prev_ptr} but interpolated should be ${want.interpolated}`);
  check(i.len <= i.cap && i.len % i.stride === 0, `${name}: len ${i.len} / cap ${i.cap} / stride ${i.stride} inconsistent`);
  const size = ARRAY[i.kind].BYTES_PER_ELEMENT;
  check(i.ptr % size === 0 && i.ptr + i.cap * size <= memory.buffer.byteLength, `${name}: ptr ${i.ptr} (cap ${i.cap}) outside wasm memory`);
}
const world = q(game, 'world.info');
check(world.size_x > 0 && world.size_z > 0 && world.sea_level === 0, `world.info unexpected: ${JSON.stringify(world).slice(0, 200)}`);
// size_x / size_z are extents in metres; vertex sampling => n = size / cell + 1 per side
// ("sample": "cell" = voxel world, one sample per block column => n = size / cell)
const vtx = world.sample === 'cell' ? 0 : 1;
const nSamples = (Math.round(world.size_x / world.cell) + vtx) * (Math.round(world.size_z / world.cell) + vtx);
check(view(game, 'world.height').info.len === nSamples, `world.height length ${view(game, 'world.height').info.len} != ${nSamples} (from world.info)`);
check(view(game, 'world.biome').info.len === nSamples, `world.biome length ${view(game, 'world.biome').info.len} != ${nSamples} (from world.info)`);
check(q(game, 'creature.species').length === 3, 'creature.species should list 3 species');
check(view(game, 'creatures').info.len === 12 * 16, 'expected 12 creatures at start');
check(game.channel_info('nope').includes('error'), 'unknown channel should return an error object');
check(game.command('no.such', '').includes('error') && game.query('no.such', '').includes('error'), 'unknown command/query should return error JSON');

// ---- 2. scripted run -----------------------------------------------------------------------------
section(`${TICKS} scripted ticks`);
const startPlayer = q(game, 'player.info');
const tRun = performance.now();
run(game, TICKS);
const runMs = performance.now() - tRun;
const endPlayer = q(game, 'player.info');
const fmt = (a) => a.map((v) => v.toFixed(2)).join(', ');
console.log(`  player start (${fmt(startPlayer.pos)})  ->  end (${fmt(endPlayer.pos)})   grounded=${endPlayer.grounded} swimming=${endPlayer.swimming} tool=${endPlayer.tool}`);
console.log(`  ${TICKS} ticks in ${runMs.toFixed(1)} ms  =  ${(runMs / TICKS).toFixed(3)} ms per 60 Hz step`);
const moved = Math.hypot(endPlayer.pos[0] - startPlayer.pos[0], endPlayer.pos[2] - startPlayer.pos[2]);
check(moved > 3, `player barely moved (${moved.toFixed(2)} m)`);
check(endPlayer.pos.every(Number.isFinite), 'player position is not finite');
const creatures = view(game, 'creatures');
const creatureCount = creatures.cur.length / 16;
console.log(`  creatures: ${creatureCount}   events drained: ${game.drain_events().length / 7}`);
check(creatureCount >= 12, `creature count ${creatureCount} < 12`);
{
  let bad = 0;
  for (const name of channelNames(game)) {
    const v = view(game, name);
    if (v.info.kind === 'f32') for (const x of v.cur) if (!Number.isFinite(x)) bad++;
  }
  check(bad === 0, `${bad} non-finite floats in float channels`);
}
// interpolation buffers hold the previous step
{
  const p = view(game, 'player');
  check(p.prev && p.prev.length === p.cur.length, 'player prev buffer missing');
  const stepLen = Math.hypot(p.cur[0] - p.prev[0], p.cur[2] - p.prev[2]);
  check(stepLen < 0.5, `player moved ${stepLen} m in one step: prev/cur look wrong`);
}
const t = view(game, 'time').cur;
check(Math.abs(t[0] - (8 + TICKS / 3600)) < 0.01, `time channel hours ${t[0]} (expected ${8 + TICKS / 3600})`);
const digest = q(game, 'core.digest');
console.log(`  digest after ${TICKS} ticks (seed ${SEED}): ${digest.digest}   [tick ${digest.tick}]`);
check(digest.tick === TICKS, `tick count ${digest.tick} != ${TICKS}`);
const expect = opt('--expect-digest', null);
if (expect) check(digest.digest === expect, `digest ${digest.digest} differs from the native digest ${expect}`);

// ---- 3. channel table ----------------------------------------------------------------------------
section('channel table');
console.log('  ' + ['name'.padEnd(13), 'kind', 'stride', 'len'.padStart(7), 'cap'.padStart(7), 'ver', 'ptr'.padStart(9), 'prev_ptr'.padStart(9)].join('  '));
for (const name of channelNames(game)) {
  const i = view(game, name).info;
  console.log('  ' + [name.padEnd(13), i.kind.padEnd(4), String(i.stride).padStart(6), String(i.len).padStart(7), String(i.cap).padStart(7), String(i.version).padStart(3), String(i.ptr).padStart(9), String(i.prev_ptr).padStart(9)].join('  '));
}

// ---- 4. determinism inside wasm ---------------------------------------------------------------------
section('determinism (same seed => identical bytes, different seed => different)');
const snapA = snapshot(game);
const game2 = new bridge.Game(SEED);
run(game2, TICKS);
check(sameSnapshots(snapA, snapshot(game2)), 'two runs with the same seed produced different channel bytes');
check(q(game2, 'core.digest').digest === digest.digest, 'digest differs between identical runs');
const game3 = new bridge.Game(SEED + 1);
run(game3, TICKS);
check(!sameSnapshots(snapA, snapshot(game3)), 'different seeds produced identical channels');
console.log(`  same seed identical: ${sameSnapshots(snapA, snapshot(game2))};  different seed differs: ${!sameSnapshots(snapA, snapshot(game3))}`);
game3.free();

// ---- 5. commands, save / load ------------------------------------------------------------------------
section('commands, queries, save / load');
cmd(game, 'sys.set_time', '{"hours":18.5}');
cmd(game, 'sys.set_weather', '{"kind":"rain","intensity":0.6}');
const tp = cmd(game, 'debug.teleport', '{"x":8,"z":-6}');
check(tp.x === 8 && tp.z === -6, `teleport reply ${JSON.stringify(tp)}`);
check(view(game, 'player').cur[0] === 8, 'teleport not visible in the channel immediately');
const spawned = cmd(game, 'debug.spawn_creature', '{"species":"Tidler","count":3}');
check(Array.isArray(spawned.ids) && spawned.ids.length === 3, `spawn reply ${JSON.stringify(spawned)}`);
run(game, 90, TICKS);
const bytes = game.save();
console.log(`  save: ${bytes.length} bytes, header "${Buffer.from(bytes.subarray(0, 4)).toString()}"`);
check(bytes.length > 100 && Buffer.from(bytes.subarray(0, 4)).toString() === 'GLMW', 'save bytes look wrong');
run(game, 120, TICKS + 90);
const afterOriginal = snapshot(game);
const loaded = new bridge.Game(1);
check(loaded.load(bytes) === true, 'load() rejected our own save');
run(loaded, 120, TICKS + 90);
check(sameSnapshots(afterOriginal, snapshot(loaded)), 'loaded game diverged from the original after 120 ticks');
const bad = Uint8Array.from(bytes);
bad[Math.floor(bad.length / 2)] ^= 0x55;
check(loaded.load(bad) === false, 'corrupt save was accepted');
check(loaded.load(new Uint8Array(0)) === false, 'empty save was accepted');
check(q(loaded, 'core.digest').digest === q(game, 'core.digest').digest, 'rejected loads must leave the game unchanged');
console.log(`  load round-trip identical: ${sameSnapshots(afterOriginal, snapshot(loaded))};  corrupt save rejected`);
loaded.free();
game2.free();

// ---- 6. memory growth ---------------------------------------------------------------------------------
section('memory growth invalidates views');
// A view taken before a memory.grow() is detached (length 0); JS must re-create views whenever
// `memory.buffer` is a different object. Force a growth by allocating more worlds.
const staleView = view(game, 'player').cur;
const bufferBefore = memory.buffer;
const sizeBefore = bufferBefore.byteLength;
const extraGames = [];
while (memory.buffer === bufferBefore && extraGames.length < 60) extraGames.push(new bridge.Game(100 + extraGames.length));
const grew = memory.buffer !== bufferBefore;
console.log(`  wasm memory ${(sizeBefore / 1048576).toFixed(1)} MB -> ${(memory.buffer.byteLength / 1048576).toFixed(1)} MB after ${extraGames.length} extra worlds; ArrayBuffer replaced: ${grew}`);
check(grew, 'could not force a memory.grow (test is blind)');
check(bufferBefore.byteLength === 0 && staleView.length === 0, 'views from before memory.grow must be detached - the Bridge wrapper has to rebuild them');
const fresh = view(game, 'player');
check(fresh.cur.length === 16 && Number.isFinite(fresh.cur[0]), 'fresh view after growth is wrong');
for (const g of extraGames) g.free();
// 2000 creatures: spawn, step, read back
const stress = new bridge.Game(7);
cmd(stress, 'debug.spawn_creature', '{"count":1000}');
cmd(stress, 'debug.spawn_creature', '{"count":988}');
run(stress, 30);
const sv = view(stress, 'creatures');
check(sv.cur.length === 2000 * 16 && sv.cur[0] > 0 && Number.isFinite(sv.cur[3]), 'creature channel after bulk spawn is wrong');
stress.free();

// ---- 7. optional benchmark ---------------------------------------------------------------------------------
if (flag('--bench')) {
  section('step-time benchmark (wasm in Node/V8; one tick(1/60) == exactly one 60 Hz step)');
  const stats = (xs) => {
    const s = Float64Array.from(xs).sort();
    const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: s[s.length - 1] };
  };
  const bench = (label, extra) => {
    const g = new bridge.Game(42);
    if (extra) {
      cmd(g, 'debug.spawn_creature', `{"count":${Math.min(extra, 1000)}}`);
      if (extra > 1000) cmd(g, 'debug.spawn_creature', `{"count":${extra - 1000}}`);
    }
    run(g, 180); // warm-up (JIT tier-up)
    const input = new Float32Array(16);
    const samples = [];
    for (let n = 0; n < 900; n++) {
      script(n, input);
      g.set_input(input);
      const s = performance.now();
      g.tick(DT);
      samples.push(performance.now() - s);
      if (n % 60 === 0) g.drain_events();
    }
    const creatures = view(g, 'creatures').cur.length / 16;
    const r = stats(samples);
    console.log(`  ${label.padEnd(18)} ${String(creatures).padStart(5)} creatures: mean ${r.mean.toFixed(3)}  p50 ${r.p50.toFixed(3)}  p95 ${r.p95.toFixed(3)}  p99 ${r.p99.toFixed(3)}  max ${r.max.toFixed(3)} ms`);
    g.free();
    return r;
  };
  const small = bench('12 creatures', 0);
  const big = bench('2000 creatures', 1988);
  check(small.p95 < 3, `p95 step time with 12 creatures is ${small.p95.toFixed(2)} ms (budget 3 ms)`);
  console.log(`  budget: sim step <= 3 ms typical (ARCHITECTURE.md 7); 2000 creatures p50 ${big.p50.toFixed(2)} ms`);
}

// ---- summary ---------------------------------------------------------------------------------------------------
check(wasmErrors === 0, `the wasm module logged ${wasmErrors} console.error message(s)`);
game.free();
section('result');
if (failures.length) {
  console.log(`SMOKE FAIL: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`SMOKE PASS: ${checks} checks`);
