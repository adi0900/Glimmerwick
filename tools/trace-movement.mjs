#!/usr/bin/env node
// Movement trace: measures the player controller on the real wasm sim (flat voxel ground, scripted input) and a
// numeric model of the follow camera, so "stiff" can be argued with numbers and before/after can be compared with
// the spec's sanity numbers (docs/specs/MOVEMENT_SPEC.md section 7).
//
//   node tools/trace-movement.mjs [--label before|after] [--cam old|rig] [--pkg dir] [--seed n] [--json out.json]
//
// --cam old : replica of the pre-phase-1 follow camera (_slice/index.ts followCamera: lerp 9/s position, 14/s look target,
//             look-ahead 0.22 s of the stepwise sim velocity)
// --cam rig : numeric model of web/src/modules/camera/rig.ts (critically damped focus spring + velocity low-pass);
//             the constants below must mirror RIG_DEFAULTS there.
// Camera numbers are computed from the real interpolated player channel (prev/cur/alpha) at 144 Hz and 60 Hz frames.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(opt('--pkg', path.join(root, 'web', 'src', 'wasm', 'pkg')));
const SEED = Number(opt('--seed', 42));
const LABEL = opt('--label', 'run');
const CAM = opt('--cam', LABEL === 'after' ? 'rig' : 'old');
const DT = 1 / 60;
const SPEC = { walk: 4.317, sprint: 5.612, bunnyAvg: 7.127, apex: 1.2522, air: 0.6, sjDist: 3.629, stopSprint: 0.333 };
const RIG = { omegaXZ: 10, omegaY: 6, lookAhead: 0.1, velTau: 0.12, head: 0.95 }; // mirror of rig.ts RIG_DEFAULTS

const bridge = await import(pathToFileURL(path.join(pkgDir, 'bridge.js')).href);
const { memory } = bridge.initSync({ module: readFileSync(path.join(pkgDir, 'bridge_bg.wasm')) });
const game = new bridge.Game(SEED);
const q = (n, a = {}) => JSON.parse(game.query(n, JSON.stringify(a)));
const cmd = (n, a = {}) => JSON.parse(game.command(n, JSON.stringify(a)));

function prec() {
  const i = JSON.parse(game.channel_info('player'));
  return { cur: new Float32Array(memory.buffer, i.ptr, i.len), prev: new Float32Array(memory.buffer, i.prev_ptr, i.len) };
}
const inp = new Float32Array(16);
function setIn(fwd, strafe, btn, yaw) {
  inp.fill(0);
  inp[0] = strafe;
  inp[1] = fwd;
  inp[4] = btn;
  inp[5] = yaw;
  inp[6] = 0.38;
  inp[7] = 0.4;
  game.set_input(inp);
}
const JUMP = 1;
const SPRINT = 4;

// ---- find a straight, flat, obstacle-free run near the spawn ------------------------------------------------------
const info = q('world.info');
const sp = Array.isArray(info.spawn?.player) ? info.spawn.player : [info.spawn?.x ?? 0, info.spawn?.z ?? 0];
const groundH = (x, z) => q('world.ground', { x, z }).height;
function runOk(x, z, dx, dz, len) {
  const h0 = groundH(x, z);
  if (!Number.isFinite(h0)) return null;
  for (let k = 1; k <= len; k++) if (Math.abs(groundH(x + dx * k, z + dz * k) - h0) > 0.01) return null;
  const r = q('world.sweep', { min: [x - 0.3, h0 + 0.01, z - 0.3], size: [0.6, 1.8, 0.6], delta: [dx * len, 0, dz * len] });
  if (!r.hit || r.hit[0] || r.hit[2]) return null;
  return h0;
}
let run = null;
for (const len of [22, 18, 14]) {
  for (let ring = 0; ring <= 24 && !run; ring += 2) {
    for (const [ox, oz] of [[0, 0], [ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
      const x = Math.floor(sp[0] + ox) + 0.5;
      const z = Math.floor(sp[1] + oz) + 0.5;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h = runOk(x, z, dx, dz, len);
        if (h !== null) {
          run = { x, z, dx, dz, len, h, yaw: Math.atan2(-dx, -dz) };
          break;
        }
      }
      if (run) break;
    }
  }
  if (run) break;
}
if (!run) {
  console.error('no flat run found near the spawn');
  process.exit(2);
}
function settle(n = 40) {
  for (let k = 0; k < n; k++) {
    setIn(0, 0, 0, run.yaw);
    game.tick(DT);
  }
}
function place() {
  cmd('debug.teleport', { x: run.x, z: run.z });
  settle();
}

// ---- scenario runner (60 Hz steps) ---------------------------------------------------------------------------------
function trace(ticks, frame) {
  const c0 = prec().cur;
  let px = c0[0];
  let pz = c0[2];
  const y0 = c0[1];
  const rows = [];
  for (let n = 0; n < ticks; n++) {
    const [f, s, b] = frame(n);
    setIn(f, s, b, run.yaw);
    game.tick(DT);
    const c = prec().cur;
    const along = (c[0] - px) * run.dx + (c[2] - pz) * run.dz;
    rows.push({ n, x: c[0], y: c[1] - y0, z: c[2], sp: Math.abs(along) / DT, g: c[9], px, pz });
    px = c[0];
    pz = c[2];
  }
  return rows;
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) * (v - m))));
};
const reach = (rows, frac, steady) => {
  const r = rows.find((w) => w.sp >= frac * steady);
  return r ? (r.n + 1) * DT : NaN;
};
const R = {};

function accel(name, btn, ticks = 110) {
  place();
  const rows = trace(ticks, () => [1, 0, btn]);
  const steady = mean(rows.slice(-30).map((r) => r.sp));
  R[name] = { steady, v100ms: rows[5].sp, v200ms: rows[11].sp, t50: reach(rows, 0.5, steady), t90: reach(rows, 0.9, steady), t99: reach(rows, 0.99, steady) };
  return steady;
}
const walk = accel('walk', 0);
const sprint = accel('sprint', SPRINT);

function stop(name, btn) {
  place();
  const rows = trace(150, (n) => (n < 100 ? [1, 0, btn] : [0, 0, 0]));
  const steady = mean(rows.slice(80, 100).map((r) => r.sp));
  const rel = rows.slice(100);
  let dist = 0;
  let tStop = NaN;
  let t10 = NaN;
  for (const r of rel) {
    dist += r.sp * DT;
    if (Number.isNaN(t10) && r.sp <= 0.1 * steady) t10 = (r.n - 99) * DT;
    if (r.sp < 0.05) {
      tStop = (r.n - 99) * DT;
      dist -= r.sp * DT;
      break;
    }
  }
  R[name] = { steady, t10, tStop, dist };
}
stop('stopWalk', 0);
stop('stopSprint', SPRINT);

function hop(name, pre, btn) {
  place();
  const rows = trace(pre + 90, (n) => (n === pre ? [pre ? 1 : 0, 0, btn | JUMP] : [pre ? 1 : 0, 0, btn]));
  const after = rows.slice(pre);
  const k0 = after.findIndex((r) => r.y > 0.02);
  let k1 = -1;
  let apex = 0;
  for (let k = Math.max(k0, 0); k < after.length; k++) {
    apex = Math.max(apex, after[k].y);
    if (k > k0 + 3 && after[k].y <= 0.02) {
      k1 = k;
      break;
    }
  }
  const a = after[Math.max(k0, 0)];
  const b = after[k1 >= 0 ? k1 : after.length - 1];
  R[name] = { apex, air: (k1 - k0 + 1) * DT, dist: Math.abs((b.x - a.px) * run.dx + (b.z - a.pz) * run.dz) };
}
hop('jumpStanding', 0, 0);
hop('jumpSprint', 90, SPRINT);

place();
{
  const rows = trace(220, (n) => [1, 0, SPRINT | (n % 2 === 0 ? JUMP : 0)]);
  const w = rows.slice(-120);
  R.bunny = { avg: (Math.abs((w[w.length - 1].x - w[0].px) * run.dx + (w[w.length - 1].z - w[0].pz) * run.dz)) / (w.length * DT), maxY: Math.max(...rows.map((r) => r.y)) };
}

// ---- camera model --------------------------------------------------------------------------------------------------
function camSim(mode, fps, seconds) {
  place();
  const dtf = 1 / fps;
  const pitch = 0.38;
  const cp = Math.cos(pitch);
  const dist = 4.3 + 0.4 * 5.4;
  const dir = [Math.sin(run.yaw) * cp, Math.sin(pitch), Math.cos(run.yaw) * cp];
  const rd = [-Math.sin(run.yaw), 0, -Math.cos(run.yaw)];
  const dot = (a, b) => a[0] * b[0] + a[2] * b[2];
  let cam = null;
  let look = null;
  let focus = null;
  const fv = [0, 0, 0];
  const vs = [0, 0];
  const rows = [];
  for (let f = 0; f < fps * seconds; f++) {
    setIn(1, 0, 0, run.yaw);
    game.tick(dtf);
    const a = game.alpha();
    const { cur, prev } = prec();
    const p = [0, 1, 2].map((i) => prev[i] + (cur[i] - prev[i]) * a);
    if (mode === 'old') {
      const t = [p[0] + cur[3] * 0.22, p[1] + 0.95, p[2] + cur[5] * 0.22];
      const d = [t[0] + dir[0] * dist, t[1] + dir[1] * dist, t[2] + dir[2] * dist];
      if (!cam) {
        cam = d.slice();
        look = t.slice();
      } else {
        const k = 1 - Math.exp(-9 * Math.max(dtf, 1 / 240));
        const kl = 1 - Math.exp(-14 * Math.max(dtf, 1 / 240));
        for (let i = 0; i < 3; i++) {
          cam[i] += (d[i] - cam[i]) * k;
          look[i] += (t[i] - look[i]) * kl;
        }
      }
      focus = look;
    } else {
      const kv = 1 - Math.exp(-dtf / RIG.velTau);
      vs[0] += (cur[3] - vs[0]) * kv;
      vs[1] += (cur[5] - vs[1]) * kv;
      const t = [p[0] + vs[0] * RIG.lookAhead, p[1] + RIG.head, p[2] + vs[1] * RIG.lookAhead];
      if (!focus) focus = t.slice();
      const om = [RIG.omegaXZ, RIG.omegaY, RIG.omegaXZ];
      for (let i = 0; i < 3; i++) {
        const x = focus[i] - t[i];
        const e = Math.exp(-om[i] * dtf);
        const tmp = (fv[i] + om[i] * x) * dtf;
        fv[i] = (fv[i] - om[i] * tmp) * e;
        focus[i] = t[i] + (x + tmp) * e;
      }
      cam = [focus[0] + dir[0] * dist, focus[1] + dir[1] * dist, focus[2] + dir[2] * dist];
    }
    rows.push({ cam: cam.slice(), head: [p[0], p[1] + 0.95, p[2]], focus: focus.slice() });
  }
  const dc = rows.slice(1).map((r, i) => dot([r.cam[0] - rows[i].cam[0], 0, r.cam[2] - rows[i].cam[2]], rd));
  const win = dc.slice(-fps);
  const mu = mean(win);
  const steadyV = mu * fps;
  const t90 = dc.findIndex((v) => v * fps >= 0.9 * steadyV);
  const lag = mean(rows.slice(-fps).map((r) => dot([r.head[0] - r.focus[0], 0, r.head[2] - r.focus[2]], rd)));
  let maxStep = 0;
  for (let i = 1; i < win.length; i++) maxStep = Math.max(maxStep, Math.abs(win[i] - win[i - 1]));
  return { steadyV, t90: (t90 + 1) / fps, lagM: lag, jitterPct: (100 * std(win)) / Math.abs(mu), maxFrameStepPct: (100 * maxStep) / Math.abs(mu) };
}
R.cam144 = camSim(CAM, 144, 3);
R.cam60 = camSim(CAM, 60, 3);

// ---- report ---------------------------------------------------------------------------------------------------------
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const L = [];
L.push(`## trace "${LABEL}" (camera model: ${CAM}; run: ${run.len} m flat at (${run.x}, ${run.z}) dir (${run.dx}, ${run.dz}); seed ${SEED})`);
L.push('| metric | measured | spec |');
L.push('|---|---|---|');
L.push(`| walk steady speed (m/s) | ${f(R.walk.steady)} | ${SPEC.walk} |`);
L.push(`| walk: v at 0.1 s / 0.2 s (m/s) | ${f(R.walk.v100ms, 2)} / ${f(R.walk.v200ms, 2)} | 3.4 / 4.0 (TV-03 per-tick) |`);
L.push(`| walk: time to 50 / 90 / 99 % (s) | ${f(R.walk.t50, 2)} / ${f(R.walk.t90, 2)} / ${f(R.walk.t99, 2)} | ~0.05 / 0.20 / 0.35 |`);
L.push(`| sprint steady speed (m/s) | ${f(R.sprint.steady)} | ${SPEC.sprint} |`);
L.push(`| sprint: time to 50 / 90 / 99 % (s) | ${f(R.sprint.t50, 2)} / ${f(R.sprint.t90, 2)} / ${f(R.sprint.t99, 2)} | ~0.05 / 0.20 / 0.35 |`);
L.push(`| stop from walk: time to 10 % / full stop (s), distance (m) | ${f(R.stopWalk.t10, 2)} / ${f(R.stopWalk.tStop, 2)}, ${f(R.stopWalk.dist)} | - |`);
L.push(`| stop from sprint: time to 10 % / full stop (s), distance (m) | ${f(R.stopSprint.t10, 2)} / ${f(R.stopSprint.tStop, 2)}, ${f(R.stopSprint.dist)} | 0.333 m in 7 ticks |`);
L.push(`| standing jump: apex (m) / airtime (s) | ${f(R.jumpStanding.apex)} / ${f(R.jumpStanding.air, 2)} | ${SPEC.apex} / ${SPEC.air} |`);
L.push(`| sprint-jump from steady sprint: distance (m) / airtime (s) | ${f(R.jumpSprint.dist)} / ${f(R.jumpSprint.air, 2)} | ${SPEC.sjDist} / ${SPEC.air} |`);
L.push(`| bunny hop (sprint + jump pressed every other step): average speed (m/s) | ${f(R.bunny.avg)} | ${SPEC.bunnyAvg} |`);
for (const k of ['cam144', 'cam60']) {
  const c = R[k];
  L.push(`| camera ${k === 'cam144' ? '144' : '60'} Hz, walking: steady speed / time to 90 % (s) / focus lag behind head (m) | ${f(c.steadyV, 2)} / ${f(c.t90, 2)} / ${f(c.lagM, 2)} | - |`);
  L.push(`| camera ${k === 'cam144' ? '144' : '60'} Hz: per-frame step jitter, std/mean (%) / worst frame-to-frame change (% of mean step) | ${f(c.jitterPct, 2)} / ${f(c.maxFrameStepPct, 2)} | 0 |`);
}
console.log(L.join('\n'));
const out = opt('--json', null);
if (out) writeFileSync(out, JSON.stringify({ label: LABEL, cam: CAM, run, R }, null, 2));
game.free();
