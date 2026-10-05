/**
 * MockGame: a stand-in for the wasm `Game` that implements the same raw API and the core channel layouts
 * (ARCHITECTURE.md §4) so the engine, the galleries and every web module run before / without the Rust sim.
 *
 *  - Channels live in a real `WebAssembly.Memory` (fake linear memory + bump allocator) so the Bridge's
 *    typed-array-view code path is byte-for-byte the one used with the real wasm, including `memory.grow`.
 *  - Fixed 60 Hz accumulator (max 5 steps, dt <= 0.1) with double-buffered interpolated channels, like Rust.
 *  - Deterministic: everything derives from `seed`.
 *  - It is NOT the game: terrain/creatures here are simple placeholders. Never ship logic that depends on it.
 *
 * Mock-only debug commands: debug.set_time {hours} · debug.set_weather {kind,intensity} · debug.freeze_time {on}
 * · debug.teleport {x,z} · debug.grow_memory {} (forces the memory.grow path).
 */
import type { ChannelInfo, ChannelKind, RawGame } from './Bridge';
import { Rng, mix32 } from './Rng';

const STEP = 1 / 60;
const MAX_STEPS = 5;
const DAY_SECONDS = 1440; // 24 real minutes per game day (GAME_DESIGN.md)

// ---- mock world constants (a 256 m world, 1 m cells, lattice samples) ----
const N = 257;
const SIZE = 256;
const CELL = 1;
const ORIGIN = -128;
const SEA = 0;
const CREATURE_STRIDE = 16;
const MAX_CREATURES = 64;
const FLORA_STRIDE = 8;
const MAX_FLORA = 4096;

type Slot = { ptr: number; prevPtr: number; len: number; cap: number; stride: number; kind: ChannelKind; version: number };

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = mix32(ix * 374761393 + iz * 668265263 + seed * 2246822519);
  h = mix32(h ^ (h >>> 13));
  return h / 4294967296;
}

function vnoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number, seed: number, oct = 4): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, z * f, seed + i * 17);
    f *= 2.03;
    a *= 0.5;
  }
  return s; // ~[0, 0.94]
}

/** unit vector toward the sun: rises east (+x), peaks to the south (+z), sets west; horizon crossings 05:40 / 18:40 */
function sunDir(hours: number, out: [number, number, number]): void {
  const th = (Math.PI * (hours - 5.67)) / 13;
  const tilt = (30 * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const x = c;
  const y = s * Math.cos(tilt);
  const z = s * Math.sin(tilt);
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

interface Creature {
  id: number;
  species: number;
  variant: number;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  homeX: number;
  homeZ: number;
  radius: number;
  tx: number;
  tz: number;
  wait: number;
  speed: number;
  animT: number;
  state: number; // 0 idle 1 walk 2 notice
  mood: number;
}

export class MockGame implements RawGame {
  readonly memory: WebAssembly.Memory;
  readonly seed: number;

  private bump = 1024;
  private slots = new Map<string, Slot>();
  private acc = 0;
  private _alpha = 0;
  private eventQueue: number[] = [];
  private rng: Rng;

  // time / weather
  private hours = 16.5;
  private day = 0;
  private weatherKind = 0;
  private weatherIntensity = 0;
  private timeScale = 1;
  private windPhase = 0;

  // input
  private input = new Float32Array(16);
  private prevButtons = 0;

  // player
  private px = 0;
  private py = 0;
  private pz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private yaw = 0;
  private grounded = true;
  private animT = 0;
  private tool = 0;

  private heights!: Float32Array; // generator-side copy (not wasm memory)
  private creatures: Creature[] = [];
  private spawn: [number, number] = [0, 0];
  private village: [number, number] = [0, 0];
  private habitats: Record<string, number[][]> = {};
  private floraCount = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(mix32(this.seed ^ 0x6d6f636b));
    // Start small on purpose so allocating the world grids exercises memory.grow() like a real wasm module.
    this.memory = new WebAssembly.Memory({ initial: 8, maximum: 2048 });

    this.alloc('time', 'f32', 11, 11, 1, false);
    this.alloc('player', 'f32', 16, 16, 16, true);
    this.alloc('creatures', 'f32', 0, MAX_CREATURES * CREATURE_STRIDE, CREATURE_STRIDE, true);
    this.alloc('world.height', 'f32', N * N, N * N, 1, false);
    this.alloc('world.biome', 'u8', N * N, N * N, 1, false);
    this.alloc('world.dirty', 'u32', 0, 64, 1, false);
    this.alloc('flora', 'f32', 0, MAX_FLORA * FLORA_STRIDE, FLORA_STRIDE, false);
    this.alloc('props', 'f32', 0, 256 * 12, 12, false);

    this.generateWorld();
    this.spawnCreatures();
    this.px = this.spawn[0];
    this.pz = this.spawn[1];
    this.py = this.groundHeight(this.px, this.pz);
    this.yaw = Math.PI;
    this.writeAll(true);
  }

  // ------------------------------------------------------------------ memory

  private alloc(name: string, kind: ChannelKind, len: number, cap: number, stride: number, interpolated: boolean): void {
    const bytes = kind === 'f32' || kind === 'u32' ? 4 : kind === 'u16' ? 2 : 1;
    const size = Math.max(cap, 1) * bytes;
    const ptr = this.reserve(size, 8);
    const prevPtr = interpolated ? this.reserve(size, 8) : 0;
    this.slots.set(name, { ptr, prevPtr, len, cap, stride, kind, version: 1 });
  }

  private reserve(bytes: number, align: number): number {
    const ptr = (this.bump + (align - 1)) & ~(align - 1);
    const end = ptr + bytes;
    const have = this.memory.buffer.byteLength;
    if (end > have) this.memory.grow(Math.ceil((end - have) / 65536));
    this.bump = end;
    return ptr;
  }

  private view(name: string, which: 'cur' | 'prev' = 'cur'): Float32Array {
    const s = this.slots.get(name)!;
    return new Float32Array(this.memory.buffer, which === 'cur' ? s.ptr : s.prevPtr, s.cap);
  }

  private u8(name: string): Uint8Array {
    const s = this.slots.get(name)!;
    return new Uint8Array(this.memory.buffer, s.ptr, s.cap);
  }

  // ------------------------------------------------------------------ world generation

  private rawHeight(x: number, z: number): number {
    const seed = this.seed;
    // domain warp
    const wx = x + 16 * (fbm(x * 0.012, z * 0.012, seed + 11, 3) - 0.47);
    const wz = z + 16 * (fbm(x * 0.012 + 40, z * 0.012 + 40, seed + 23, 3) - 0.47);
    const r = Math.hypot(wx, wz);
    const mask = 1 - smoothstep(66, 104, r);
    let h = -9 + mask * 12.2; // coast level at mask ~ 0.74 -> 0
    // rolling meadow hills
    h += mask * (fbm(x * 0.03, z * 0.03, seed + 5, 4) - 0.45) * 6.5;
    // north-west highland with terraced cliffs
    const hd = Math.hypot(x + 28, z + 34);
    const hi = 1 - smoothstep(18, 50, hd);
    const hiRaw = hi * (13 + 4 * fbm(x * 0.05, z * 0.05, seed + 31, 3));
    const steps = 3.4;
    const t = hiRaw / steps;
    const f = Math.floor(t);
    const terr = (f + smoothstep(0.84, 1.0, t - f)) * steps;
    h += mask * (hiRaw * 0.25 + terr * 0.75);
    // islets
    const i1 = 1 - smoothstep(4, 11, Math.hypot(x + 98, z - 62));
    const i2 = 1 - smoothstep(4, 10, Math.hypot(x - 96, z + 70));
    h = Math.max(h, -9 + (i1 + i2) * 11.5 * (0.8 + 0.4 * fbm(x * 0.2, z * 0.2, seed + 7, 2)));
    // village clearing (flat)
    const vd = Math.hypot(x - this.village[0], z - this.village[1]);
    h = h + (3.0 - h) * (1 - smoothstep(13, 22, vd)) * mask;
    // pond basin
    const pd = Math.hypot(x - 30, z + 8);
    h -= (1 - smoothstep(6, 15, pd)) * 4.4 * mask;
    return h;
  }

  private generateWorld(): void {
    this.village = [-8, 40];
    const hv = this.view('world.height');
    const bv = this.u8('world.biome');
    this.heights = new Float32Array(N * N);
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const x = ORIGIN + ix * CELL;
        const z = ORIGIN + iz * CELL;
        this.heights[iz * N + ix] = this.rawHeight(x, z);
      }
    }
    hv.set(this.heights);
    const seed = this.seed;
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = ORIGIN + ix * CELL;
        const z = ORIGIN + iz * CELL;
        const h = this.heights[i]!;
        const hx = this.heights[iz * N + Math.min(ix + 1, N - 1)]! - this.heights[iz * N + Math.max(ix - 1, 0)]!;
        const hz = this.heights[Math.min(iz + 1, N - 1) * N + ix]! - this.heights[Math.max(iz - 1, 0) * N + ix]!;
        const slope = Math.hypot(hx, hz) * 0.5;
        const vd = Math.hypot(x - this.village[0], z - this.village[1]);
        const pd = Math.hypot(x - 30, z + 8);
        const forest = fbm(x * 0.045, z * 0.045, seed + 71, 3);
        const flowers = fbm(x * 0.06 + 9, z * 0.06 - 4, seed + 88, 3);
        // winding path from the village to the beach
        const pathX = this.village[0] + 4 + Math.sin((z - this.village[1]) * 0.09) * 6;
        const onPath = z > this.village[1] && Math.abs(x - pathX) < 1.6 && h > 0.6;
        let b = 3;
        if (h < -3) b = 0;
        else if (h < 0) b = 1;
        else if (pd < 19 && h < 1.6 && pd > 8) b = 8;
        else if (h < 1.5) b = 2;
        else if (slope > 0.62 && h > 3) b = 6;
        else if (vd < 15) b = 10;
        else if (onPath) b = 7;
        else if (h > 9) b = 5;
        else if (forest > 0.5 && h > 2.5) b = 4;
        else if (flowers > 0.58) b = 9;
        bv[i] = b;
      }
    }
    this.spawn = [this.village[0] + 2, this.village[1] - 6];
    this.habitats = {
      '3': [[22, 22, 28]],
      '4': [[-50, -8, 24]],
      '2': [[40, 70, 25]],
      '8': [[30, -8, 16]],
    };
    this.placeFlora();
  }

  private biomeAtCell(x: number, z: number): number {
    const ix = Math.round((x - ORIGIN) / CELL);
    const iz = Math.round((z - ORIGIN) / CELL);
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return 0;
    return this.u8('world.biome')[iz * N + ix]!;
  }

  private placeFlora(): void {
    const fv = this.view('flora');
    const rng = new Rng(mix32(this.seed ^ 0xf10a));
    let n = 0;
    const put = (kind: number, x: number, z: number, scale: number, variant: number, state: number) => {
      if (n >= MAX_FLORA) return;
      const o = n * FLORA_STRIDE;
      fv[o] = kind;
      fv[o + 1] = x;
      fv[o + 2] = this.groundHeight(x, z);
      fv[o + 3] = z;
      fv[o + 4] = rng.range(0, Math.PI * 2);
      fv[o + 5] = scale;
      fv[o + 6] = variant;
      fv[o + 7] = state;
      n++;
    };
    const cellSize = 3.2;
    for (let gz = -120; gz < 120; gz += cellSize) {
      for (let gx = -120; gx < 120; gx += cellSize) {
        const x = gx + rng.range(0, cellSize);
        const z = gz + rng.range(0, cellSize);
        const b = this.biomeAtCell(x, z);
        const v = Math.floor(rng.range(0, 256));
        const r = rng.next();
        switch (b) {
          case 4: // forest floor: dense mixed trees, ferns, mushrooms
            if (r < 0.34) put([0, 1, 2, 6, 7][rng.int(5)]!, x, z, rng.range(0.85, 1.35), v, rng.next());
            else if (r < 0.46) put(18, x, z, rng.range(0.8, 1.2), v, 0.5);
            else if (r < 0.52) put(48 + rng.int(3), x, z, rng.range(0.7, 1.1), v, 0.5);
            break;
          case 3: // meadow: sparse trees + bushes
            if (r < 0.022) put(rng.chance(0.5) ? 0 : 3, x, z, rng.range(0.9, 1.3), v, rng.next());
            else if (r < 0.06) put(16, x, z, rng.range(0.8, 1.2), v, 0.5);
            break;
          case 9: // flower meadow
            if (r < 0.7) put(32 + rng.int(8), x, z, rng.range(0.8, 1.2), v, 0.5);
            break;
          case 2: // sand
            if (r < 0.028) put(4, x, z, rng.range(0.9, 1.25), v, rng.next());
            else if (r < 0.06) put(96 + rng.int(4), x, z, 1, v, 0.5);
            break;
          case 5: // highland
            if (r < 0.05) put(rng.chance(0.6) ? 2 : 64, x, z, rng.range(0.9, 1.4), v, 0.5);
            else if (r < 0.1) put(67, x, z, rng.range(0.7, 1.2), v, 0.5);
            break;
          case 8: // pond bank
            if (r < 0.3) put(80 + rng.int(3), x, z, rng.range(0.8, 1.2), v, 0.5);
            else if (r < 0.34) put(5, x, z, rng.range(1, 1.3), v, rng.next());
            break;
          case 6:
            if (r < 0.04) put(64, x, z, rng.range(0.8, 1.5), v, 0.5);
            break;
          default:
            break;
        }
      }
    }
    this.floraCount = n;
    this.slots.get('flora')!.len = n * FLORA_STRIDE;
  }

  private spawnCreatures(): void {
    const rng = new Rng(mix32(this.seed ^ 0xc4ea));
    const defs: { species: number; n: number; cx: number; cz: number; r: number }[] = [
      { species: 0, n: 6, cx: 22, cz: 22, r: 24 },
      { species: 1, n: 4, cx: 30, cz: -8, r: 12 },
      { species: 2, n: 5, cx: -52, cz: -8, r: 22 },
    ];
    let id = 100;
    for (const d of defs) {
      for (let i = 0; i < d.n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const rr = Math.sqrt(rng.next()) * d.r;
        let x = d.cx + Math.cos(a) * rr;
        let z = d.cz + Math.sin(a) * rr;
        for (let t = 0; t < 12 && this.groundHeight(x, z) < 0.2 && d.species !== 1; t++) {
          x = d.cx + rng.range(-d.r, d.r);
          z = d.cz + rng.range(-d.r, d.r);
        }
        this.creatures.push({
          id: id++,
          species: d.species,
          variant: rng.int(3),
          x,
          z,
          yaw: rng.range(-Math.PI, Math.PI),
          scale: d.species === 0 ? 0.9 : d.species === 1 ? 1.0 : 1.1,
          homeX: d.cx,
          homeZ: d.cz,
          radius: d.r,
          tx: x,
          tz: z,
          wait: rng.range(0.2, 3),
          speed: rng.range(0.9, 1.5),
          animT: rng.range(0, 3),
          state: 0,
          mood: 0.5,
        });
      }
    }
  }

  private groundHeight(x: number, z: number): number {
    const fx = Math.min(Math.max((x - ORIGIN) / CELL, 0), N - 1.001);
    const fz = Math.min(Math.max((z - ORIGIN) / CELL, 0), N - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const a = h[iz * N + ix]!;
    const b = h[iz * N + ix + 1]!;
    const c = h[(iz + 1) * N + ix]!;
    const d = h[(iz + 1) * N + ix + 1]!;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  // ------------------------------------------------------------------ raw Game API

  tick(dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.step();
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = Math.min(this.acc, STEP);
    this._alpha = this.acc / STEP;
  }

  alpha(): number {
    return this._alpha;
  }

  set_input(input: Float32Array): void {
    this.input.set(input.subarray(0, 16));
  }

  private step(): void {
    // copy cur -> prev for interpolated channels
    for (const name of ['player', 'creatures']) {
      const s = this.slots.get(name)!;
      this.view(name, 'prev').set(this.view(name, 'cur').subarray(0, s.cap));
    }
    this.stepTime();
    this.stepPlayer();
    this.stepCreatures();
    this.writeAll(false);
  }

  private stepTime(): void {
    if (this.timeScale > 0) {
      this.hours += (STEP * 24 * this.timeScale) / DAY_SECONDS;
      if (this.hours >= 24) {
        this.hours -= 24;
        this.day++;
      }
    }
    this.windPhase += STEP;
  }

  private stepPlayer(): void {
    const inp = this.input;
    const buttons = inp[4]!;
    const pressed = (buttons & ~this.prevButtons) | 0;
    this.prevButtons = buttons | 0;
    const mx = inp[0]!;
    const my = inp[1]!;
    const camYaw = inp[5]!;
    // camera-relative movement: camera looks along (-sin yaw, -cos yaw) in xz; forward = +move_y
    const fx = -Math.sin(camYaw);
    const fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw);
    const rz = -Math.sin(camYaw);
    let dx = fx * my + rx * mx;
    let dz = fz * my + rz * mx;
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    const ground = this.groundHeight(this.px, this.pz);
    const inWater = ground < SEA - 0.45;
    const sprint = (buttons & 4) !== 0;
    const topSpeed = inWater ? 1.7 : sprint ? 5.8 : 3.3;
    const targetVx = dx * topSpeed; // |(dx,dz)| <= 1 keeps analog sticks proportional
    const targetVz = dz * topSpeed;
    const accel = this.grounded || inWater ? 16 : 4;
    const k = 1 - Math.exp(-accel * STEP);
    this.vx += (targetVx - this.vx) * k;
    this.vz += (targetVz - this.vz) * k;
    const speed = Math.hypot(this.vx, this.vz);

    const wasGrounded = this.grounded;
    if ((pressed & 1) !== 0 && this.grounded && !inWater) {
      this.vy = 7.4;
      this.grounded = false;
      this.eventQueue.push(200, 0, 0, this.px, this.py, this.pz, 0);
    }
    this.vy -= 22 * STEP;
    this.px += this.vx * STEP;
    this.pz += this.vz * STEP;
    const lim = SIZE / 2 - 2;
    this.px = Math.min(Math.max(this.px, -lim), lim);
    this.pz = Math.min(Math.max(this.pz, -lim), lim);
    this.py += this.vy * STEP;
    const g = this.groundHeight(this.px, this.pz);
    const floor = Math.max(g, SEA - 0.35);
    if (this.py <= floor) {
      this.py = floor;
      if (!wasGrounded && this.vy < -2) this.eventQueue.push(201, 0, 0, this.px, this.py, this.pz, -this.vy);
      this.vy = 0;
      this.grounded = true;
    } else if (this.py > floor + 0.04) {
      this.grounded = false;
    }
    if (speed > 0.15) {
      const target = Math.atan2(this.vx, this.vz) + 0; // yaw 0 faces +z
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (1 - Math.exp(-14 * STEP));
    }
    this.animT += STEP;
    if ((pressed & 256) !== 0) this.tool = (this.tool + 1) % 5;
    if ((pressed & 512) !== 0) this.tool = (this.tool + 4) % 5;
    this._speed01 = Math.min(1, speed / 5.8);
    this._water = Math.max(0, SEA - g);
  }

  private _speed01 = 0;
  private _water = 0;

  private stepCreatures(): void {
    const px = this.px;
    const pz = this.pz;
    for (const c of this.creatures) {
      c.animT += STEP;
      const dxp = px - c.x;
      const dzp = pz - c.z;
      const dp = Math.hypot(dxp, dzp);
      if (dp < 7 && c.state !== 1) {
        if (c.state !== 2) this.eventQueue.push(300, c.id, 0, c.x, 0, c.z, 0);
        c.state = 2;
        const target = Math.atan2(dxp, dzp);
        let d = target - c.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        c.yaw += d * (1 - Math.exp(-6 * STEP));
        c.mood = Math.min(1, c.mood + STEP * 0.4);
        continue;
      }
      if (c.state === 2) c.state = 0;
      if (c.state === 0) {
        c.wait -= STEP;
        if (c.wait <= 0) {
          const a = this.rng.range(0, Math.PI * 2);
          const r = Math.sqrt(this.rng.next()) * c.radius;
          c.tx = c.homeX + Math.cos(a) * r;
          c.tz = c.homeZ + Math.sin(a) * r;
          const g = this.groundHeight(c.tx, c.tz);
          if (c.species === 1 ? g > 0.6 : g < 0.3) {
            c.wait = 0.5; // reject target on the wrong terrain
          } else {
            c.state = 1;
            c.animT = 0;
          }
        }
      } else {
        const tx = c.tx - c.x;
        const tz = c.tz - c.z;
        const d = Math.hypot(tx, tz);
        if (d < 0.25) {
          c.state = 0;
          c.animT = 0;
          c.wait = this.rng.range(1.2, 5);
        } else {
          const target = Math.atan2(tx, tz);
          let dy = target - c.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          c.yaw += dy * (1 - Math.exp(-8 * STEP));
          c.x += (tx / d) * c.speed * STEP;
          c.z += (tz / d) * c.speed * STEP;
        }
      }
      c.mood += (0.5 - c.mood) * STEP * 0.2;
    }
  }

  private writeAll(initial: boolean): void {
    // time
    const t = this.view('time');
    const sd: [number, number, number] = [0, 1, 0];
    sunDir(this.hours, sd);
    t[0] = this.hours;
    t[1] = this.day;
    t[2] = 1; // summer
    t[3] = 0.3;
    t[4] = this.weatherKind;
    t[5] = this.weatherIntensity;
    const gust = 1 + 0.35 * Math.sin(this.windPhase * 0.7) + 0.2 * Math.sin(this.windPhase * 1.9 + 1.3);
    const windStrength = (0.9 + this.weatherIntensity * (this.weatherKind === 3 ? 2.5 : this.weatherKind === 2 ? 1 : 0)) * gust;
    t[6] = 0.8 * windStrength;
    t[7] = 0.45 * windStrength;
    t[8] = sd[0];
    t[9] = sd[1];
    t[10] = sd[2];
    // player
    const p = this.view('player');
    p[0] = this.px;
    p[1] = this.py;
    p[2] = this.pz;
    p[3] = this.vx;
    p[4] = this.vy;
    p[5] = this.vz;
    p[6] = this.yaw;
    p[7] = this._speed01 > 0.05 ? 1 : 0;
    p[8] = this.animT;
    p[9] = this.grounded ? 1 : 0;
    p[10] = this._water;
    p[11] = this.tool;
    p[12] = this._speed01;
    p[13] = -1;
    // creatures
    const cs = this.view('creatures');
    const n = this.creatures.length;
    for (let i = 0; i < n; i++) {
      const c = this.creatures[i]!;
      const o = i * CREATURE_STRIDE;
      const g = this.groundHeight(c.x, c.z);
      cs[o] = c.id;
      cs[o + 1] = c.species;
      cs[o + 2] = c.variant;
      cs[o + 3] = c.x;
      cs[o + 4] = c.species === 1 ? Math.max(g, SEA - 0.15) : g;
      cs[o + 5] = c.z;
      cs[o + 6] = c.yaw;
      cs[o + 7] = c.scale;
      cs[o + 8] = c.state === 1 ? 1 : 0;
      cs[o + 9] = c.animT;
      cs[o + 10] = c.mood;
      cs[o + 11] = c.state === 2 ? 1 : 0;
      cs[o + 12] = 0;
      cs[o + 13] = c.state === 2 ? 1 : -1;
    }
    this.slots.get('creatures')!.len = n * CREATURE_STRIDE;
    if (initial) {
      const s = this.slots.get('creatures')!;
      this.view('creatures', 'prev').set(this.view('creatures').subarray(0, s.cap));
      this.view('player', 'prev').set(this.view('player'));
    }
  }

  command(name: string, json: string): string {
    let a: any = {};
    try {
      a = json ? JSON.parse(json) : {};
    } catch {
      return JSON.stringify({ error: 'bad json' });
    }
    switch (name) {
      case 'sys.set_time':
      case 'debug.set_time':
        if (a.hours !== undefined) this.hours = ((Number(a.hours) % 24) + 24) % 24;
        if (a.day !== undefined) this.day = Math.max(0, Math.floor(Number(a.day) || 0));
        this.writeAll(false);
        return JSON.stringify({ hours: this.hours, day: this.day });
      case 'sys.set_weather':
      case 'debug.set_weather': {
        const names = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
        const k = typeof a.kind === 'string' ? names.indexOf(a.kind) : Number(a.kind ?? this.weatherKind);
        this.weatherKind = Math.max(0, Math.min(5, Math.floor(Number.isFinite(k) && k >= 0 ? k : 0)));
        this.weatherIntensity = Math.max(0, Math.min(1, Number(a.intensity ?? (this.weatherKind === 0 ? 0 : 0.85))));
        this.writeAll(false);
        return JSON.stringify({ kind: this.weatherKind, name: names[this.weatherKind], intensity: this.weatherIntensity });
      }
      case 'sys.set_time_scale':
        this.timeScale = Math.max(0, Math.min(100, Number(a.scale ?? 1)));
        return JSON.stringify({ scale: this.timeScale });
      case 'debug.freeze_time':
        this.timeScale = a.on === false ? 1 : 0;
        return '{}';
      case 'debug.teleport': {
        this.px = Number(a.x) || 0;
        this.pz = Number(a.z) || 0;
        this.py = this.groundHeight(this.px, this.pz);
        this.vx = this.vy = this.vz = 0;
        this.writeAll(true);
        return '{}';
      }
      case 'debug.grow_memory':
        this.memory.grow(1);
        return '{}';
      case 'player.tool':
        this.tool = Math.max(0, Math.floor(Number(a.id) || 0)) % 5;
        return '{}';
      default:
        return JSON.stringify({ error: `mock: unknown command ${name}` });
    }
  }

  query(name: string, _json: string): string {
    switch (name) {
      case 'world.info': {
        const sy = this.groundHeight(this.spawn[0], this.spawn[1]);
        return JSON.stringify({
          size_x: N,
          size_z: N,
          cell: CELL,
          origin_x: ORIGIN,
          origin_z: ORIGIN,
          sample: 'vertex',
          sea_level: SEA,
          chunk: 32,
          bounds: { min_x: ORIGIN + 4, min_z: ORIGIN + 4, max_x: ORIGIN + N - 5, max_z: ORIGIN + N - 5 },
          spawn: { x: this.spawn[0], y: sy, z: this.spawn[1], player: this.spawn, village: this.village },
          habitats: this.habitats,
          flora_count: this.floraCount,
          mock: true,
        });
      }
      case 'sys.time': {
        const names = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
        const sd: [number, number, number] = [0, 1, 0];
        sunDir(this.hours, sd);
        return JSON.stringify({ hours: this.hours, day: this.day, season: 1, season_name: 'summer', season_t: 0.3, time_scale: this.timeScale, real_seconds_per_day: DAY_SECONDS, weather: { kind: this.weatherKind, name: names[this.weatherKind], intensity: this.weatherIntensity }, sun_dir: sd, wind: [0.8, 0.45] });
      }
      case 'player.info':
        return JSON.stringify({ pos: [this.px, this.py, this.pz], tool: this.tool });
      case 'creature.info':
        return JSON.stringify(
          this.creatures.map((c) => ({ id: c.id, species: ['Puffbun', 'Tidler', 'Sprigfox'][c.species], mood: c.mood })),
        );
      case 'inventory':
        return JSON.stringify({ slots: [] });
      case 'dex':
        return JSON.stringify({ species: [] });
      default:
        return JSON.stringify({ error: `mock: unknown query ${name}` });
    }
  }

  channel_names(): string {
    return JSON.stringify([...this.slots.keys()]);
  }

  channel_info(name: string): string {
    const s = this.slots.get(name);
    if (!s) return JSON.stringify({ error: `unknown channel ${name}` });
    const info: ChannelInfo = {
      ptr: s.ptr,
      prev_ptr: s.prevPtr,
      len: s.len,
      cap: s.cap,
      stride: s.stride,
      kind: s.kind,
      version: s.version,
    };
    return JSON.stringify(info);
  }

  drain_events(): Float32Array {
    const out = new Float32Array(this.eventQueue);
    this.eventQueue.length = 0;
    return out;
  }

  save(): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ mock: 1, seed: this.seed, hours: this.hours, day: this.day, p: [this.px, this.py, this.pz, this.yaw] }),
    );
  }

  load(bytes: Uint8Array): boolean {
    try {
      const d = JSON.parse(new TextDecoder().decode(bytes));
      if (!d || d.mock !== 1) return false;
      this.hours = d.hours;
      this.day = d.day;
      [this.px, this.py, this.pz, this.yaw] = d.p;
      this.writeAll(true);
      return true;
    } catch {
      return false;
    }
  }
}
