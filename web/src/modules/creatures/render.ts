/**
 * Creature runtime: per-species instanced voxel rigs + the basic life layer (breathing, blink, ear / tail / gill springs,
 * hop squash-and-stretch, trot / waddle, look-at-player), driven by the `creatures` channel fields (anim_state, anim_t,
 * mood, emote, flags) or by the lab. Full locomotion FSM comes later from the movement owner.
 */
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { Ctx } from '../../engine/types';
import { buildModel, composeRig, ModelInstances, newPose, PS, resetPose, Spring, type Model } from './actors';
import { makeActorMaterial, type ActorMaterial } from './material';
import { SPECIES_DEFS } from './species';

export interface ActorRow {
  id: number;
  species: number;
  variant: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  state: number;
  at: number;
  mood: number;
  emote: number;
  flags: number;
}

export class RigState {
  seen = 0;
  init = false;
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  fwd = 0;
  side = 0;
  ax = 0;
  az = 0;
  blinkAt = 0;
  blinkT = -1;
  twitchAt = 0;
  phase = 0;
  look = 0;
  lookP = 0;
  aware = 0;
  squint = 0;
  private seed: number;
  readonly sp: Spring[] = Array.from({ length: 10 }, () => new Spring());
  constructor(id: number) {
    this.seed = (id * 2654435761) >>> 0 || 1;
    this.phase = this.rand() * 6.28;
  }
  rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  /** returns eyelid closure 0..1 */
  blink(t: number, dt: number, asleep: boolean): number {
    if (this.blinkAt === 0) this.blinkAt = t + 1.5 + this.rand() * 3.5;
    if (this.blinkT < 0) {
      if (t >= this.blinkAt) this.blinkT = 0;
    } else {
      this.blinkT += dt / 0.17;
      if (this.blinkT >= 1) {
        this.blinkT = -1;
        this.blinkAt = t + (this.rand() < 0.15 ? 0.14 : 2.2 + this.rand() * 4.5);
      }
    }
    const b = this.blinkT < 0 ? 0 : Math.sin(Math.PI * this.blinkT);
    return asleep ? 1 : b;
  }
}

export interface AnimIn {
  t: number;
  dt: number;
  state: number;
  at: number;
  mood: number;
  emote: number;
  flags: number;
  speed: number;
  fwd: number;
  side: number;
  ax: number;
  az: number;
  detail: boolean;
}
export interface AnimOut {
  lift: number;
  sq: number;
  glow: number;
}

const RX = 3,
  RY = 4,
  RZ = 5,
  PY = 1,
  PZ = 2,
  SXI = 6,
  SYI = 7,
  SZI = 8;
const sin = Math.sin,
  cos = Math.cos,
  abs = Math.abs,
  max = Math.max,
  min = Math.min;
const clamp = (v: number, a: number, b: number): number => max(a, min(b, v));

function lid(pose: Float32Array, i: number, closed: number, squint: number): void {
  const k = max(0.1, 1 - 0.9 * max(closed, squint));
  pose[i * PS + SYI] = k;
  pose[i * PS + SXI] = 1 + (1 - k) * 0.12;
}

function glowFor(A: AnimIn, R: RigState): number {
  const m = clamp(A.mood, 0, 1);
  const base = 0.38 + 0.62 * m;
  const pulse = 0.72 + 0.28 * sin(A.t * (1.4 + 2.2 * m) + R.phase);
  let g = base * pulse;
  if (A.state === 4) g = 0.3 + 0.1 * sin(A.t * 0.9 + R.phase);
  if (A.state === 5 || A.state === 6 || A.emote > 0) g = min(1.25, g + 0.35);
  return g;
}

type Animator = (M: Model, pose: Float32Array, A: AnimIn, R: RigState, o: AnimOut) => void;

// ------------------------------------------------------------------------------------------------ Puffbun
const animPuffbun: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
  const moving = A.state === 1 || A.state === 2;
  const sleep = A.state === 4;
  const jumpy = A.state === 5 || A.state === 6 || (A.emote === 2 && A.state === 0);
  let s = 0;
  let H = 0;
  let f = 0;
  if (moving) {
    f = A.state === 2 ? 9.2 : 6.6;
    H = A.state === 2 ? 0.2 : 0.13;
    s = sin(A.at * f);
  } else if (jumpy) {
    f = 6.4;
    H = 0.17;
    s = sin(A.at * f);
  }
  const air = max(0, s);
  const gnd = max(0, -s);
  let sq = 1 + 0.024 * sin(t * 2.2);
  let lift = 0;
  let lean = 0;
  if (moving || jumpy) {
    lift = air * H;
    sq = 1 + 0.17 * air - 0.15 * gnd * gnd;
    lean = moving ? (A.state === 2 ? 0.22 : 0.12) : 0.0;
  } else if (sleep) sq = 0.8 + 0.014 * sin(t * 1.3);
  else if (A.state === 3) sq = 1.07 + 0.012 * sin(t * 9);
  o.lift = lift;
  o.sq = sq;
  o.glow = glowFor(A, R);
  const body = I.body!,
    head = I.head!,
    earR = I.earR!,
    earL = I.earL!,
    tail = I.tail!,
    footR = I.footR!,
    footL = I.footL!,
    eyes = I.eyes!;
  pose[body * PS + RX] = lean + (sleep ? 0.05 : 0);
  pose[body * PS + RZ] = moving ? sin(A.at * f * 0.5) * 0.05 : 0;
  // head: look toward the player, droop when asleep
  pose[head * PS + RX] = (sleep ? 0.5 : A.state === 3 ? -0.18 : 0.02 * sin(t * 1.1)) + R.lookP - (moving ? lean * 0.6 : 0);
  pose[head * PS + RY] = R.look;
  pose[head * PS + RZ] = sleep ? 0.18 : 0.045 * sin(t * 0.7);
  // ears (springs): trail the hop, flick now and then, perk when noticing, flop when asleep
  const vyHop = moving || jumpy ? H * f * cos(A.at * f) * (s > 0 ? 1 : 0) : 0;
  if (A.detail && dt > 0 && t >= R.twitchAt) {
    R.twitchAt = t + 3 + R.rand() * 6;
    (R.rand() < 0.5 ? R.sp[0]! : R.sp[1]!).kick(7 * (R.rand() < 0.5 ? 1 : -1));
  }
  const tp = sleep ? 0.2 : A.state === 3 ? 0.18 : -0.06 - 0.25 * clamp(A.speed / 3, 0, 1) - 0.42 * vyHop;
  const out = sleep ? 0.95 : A.state === 3 ? 0.04 : 0.1 + 0.05 * sin(t * 0.9);
  const e0 = R.sp[0]!.step(tp, 150, 7, dt);
  const e1 = R.sp[1]!.step(tp, 150, 7, dt);
  const r0 = R.sp[2]!.step(out, 120, 6, dt);
  const r1 = R.sp[3]!.step(out, 120, 6, dt);
  pose[earR * PS + RX] = e0;
  pose[earL * PS + RX] = e1;
  pose[earR * PS + RZ] = -r0;
  pose[earL * PS + RZ] = r1;
  // tail wag
  const wag = A.state === 5 || A.state === 6 ? 14 : moving ? 10 : 2.4;
  const wagA = A.state === 5 || A.state === 6 ? 0.55 : moving ? 0.25 : 0.14;
  pose[tail * PS + RY] = sin(t * wag) * wagA;
  pose[tail * PS + RX] = -0.1 - 0.6 * air * 0.3;
  const kick = moving || jumpy ? -0.8 * air + 0.35 * gnd : 0;
  pose[footR * PS + RX] = kick;
  pose[footL * PS + RX] = kick;
  const happy = A.state === 5 || (A.emote === 2 && A.state === 0) ? 0.5 : 0;
  lid(pose, eyes, R.blink(A.t, dt, sleep), happy);
};

// ------------------------------------------------------------------------------------------------ Tidler
const animTidler: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
  const walk = A.state === 1 || A.state === 2;
  const swim = A.state === 7 || (A.flags & 2) !== 0;
  const sleep = A.state === 4;
  const jumpy = A.state === 5 || A.state === 6;
  const body = I.body!,
    head = I.head!,
    eyes = I.eyes!,
    gR = I.gillR!,
    gL = I.gillL!,
    t1 = I.tail1!,
    t2 = I.tail2!;
  let sq = 1 + 0.02 * sin(t * 2.0);
  let lift = 0;
  let ph = 0;
  const legs = [I.legFR!, I.legBL!, I.legFL!, I.legBR!];
  for (const l of legs) pose[l * PS + RX] = 0;
  if (walk && !swim) {
    ph = A.at * (A.state === 2 ? 11 : 7.4);
    const sw = sin(ph);
    pose[body * PS + RZ] = sw * 0.07;
    pose[head * PS + RY] = -sw * 0.1 + R.look;
    pose[legs[0]! * PS + RX] = sw * 0.75;
    pose[legs[1]! * PS + RX] = sw * 0.75;
    pose[legs[2]! * PS + RX] = -sw * 0.75;
    pose[legs[3]! * PS + RX] = -sw * 0.75;
    lift = abs(sw) * 0.012;
    pose[t1 * PS + RY] = sin(ph + 0.6) * 0.35;
    pose[t2 * PS + RY] = R.sp[4]!.step(sin(ph - 0.4) * 0.5, 90, 6, dt);
  } else if (swim) {
    ph = t * 5.2;
    for (const l of legs) pose[l * PS + RX] = 0.9 + 0.25 * sin(ph);
    pose[body * PS + RZ] = sin(ph * 0.5) * 0.05;
    pose[head * PS + RY] = sin(ph - 0.7) * 0.1 + R.look;
    pose[t1 * PS + RY] = sin(ph) * 0.45;
    pose[t2 * PS + RY] = R.sp[4]!.step(sin(ph - 0.9) * 0.6, 90, 6, dt);
    lift = 0.01 * sin(t * 2.2) - 0.03;
  } else if (jumpy) {
    const s = sin(A.at * 6.8);
    lift = max(0, s) * 0.14;
    sq = 1 + 0.17 * max(0, s) - 0.15 * s * s * (s < 0 ? 1 : 0);
    pose[t1 * PS + RY] = sin(t * 13) * 0.55;
    pose[t2 * PS + RY] = R.sp[4]!.step(sin(t * 13 - 0.8) * 0.6, 90, 6, dt);
    pose[head * PS + RY] = R.look;
    pose[body * PS + RZ] = 0;
  } else {
    pose[t1 * PS + RY] = sin(t * 1.5) * 0.2;
    pose[t2 * PS + RY] = R.sp[4]!.step(sin(t * 1.5 - 0.7) * 0.28, 70, 5, dt);
    pose[head * PS + RY] = R.look + 0.05 * sin(t * 0.6);
    pose[body * PS + RZ] = 0;
    if (sleep) sq = 0.84 + 0.014 * sin(t * 1.3);
    if (A.state === 3) sq = 1.06 + 0.01 * sin(t * 9);
  }
  pose[body * PS + RX] = 0;
  pose[head * PS + RX] = (sleep ? 0.35 : A.state === 3 ? -0.15 : 0) + R.lookP + (swim ? -0.15 : 0);
  pose[head * PS + RZ] = sleep ? 0.12 : 0.04 * sin(t * 0.8);
  // gills: flutter + springs; flare when noticing, droop when asleep
  const flare = sleep ? 0.02 : A.state === 3 ? 0.42 : swim ? 0.1 : 0.14 + 0.1 * sin(t * 3.1);
  const g0 = R.sp[0]!.step(flare + (swim ? 0.1 * sin(t * 6) : 0.06 * sin(t * 4.3 + 1)), 130, 5, dt);
  const g1 = R.sp[1]!.step(flare + (swim ? 0.1 * sin(t * 6 + 1) : 0.06 * sin(t * 4.3)), 130, 5, dt);
  pose[gR * PS + RZ] = -g0;
  pose[gL * PS + RZ] = g1;
  pose[gR * PS + RY] = swim ? 0.5 : 0.05 * sin(t * 2.7);
  pose[gL * PS + RY] = swim ? -0.5 : -0.05 * sin(t * 2.7 + 1);
  o.lift = lift;
  o.sq = sq;
  o.glow = glowFor(A, R);
  const happy = A.state === 5 ? 0.5 : 0;
  lid(pose, eyes, R.blink(A.t, dt, sleep), happy);
};

// ------------------------------------------------------------------------------------------------ Sprigfox
const animSprigfox: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
  const walk = A.state === 1 || A.state === 2;
  const run = A.state === 2;
  const sleep = A.state === 4;
  const jumpy = A.state === 5 || A.state === 6;
  const body = I.body!,
    head = I.head!,
    eyes = I.eyes!,
    earR = I.earR!,
    earL = I.earL!,
    sprout = I.sprout!,
    t1 = I.tail1!,
    t2 = I.tail2!;
  const fr = I.legFR!,
    fl = I.legFL!,
    br = I.legBR!,
    bl = I.legBL!;
  let sq = 1 + 0.02 * sin(t * 2.1);
  let lift = 0;
  pose[fr * PS + RX] = pose[fl * PS + RX] = pose[br * PS + RX] = pose[bl * PS + RX] = 0;
  let tailLift = 0;
  if (walk) {
    const ph = A.at * (run ? 12.5 : 8.6);
    const a = run ? 0.9 : 0.55;
    const sw = sin(ph);
    pose[fr * PS + RX] = sw * a;
    pose[bl * PS + RX] = sw * a;
    pose[fl * PS + RX] = -sw * a;
    pose[br * PS + RX] = -sw * a;
    lift = abs(sin(ph)) * (run ? 0.03 : 0.012);
    pose[body * PS + RX] = run ? 0.08 * sin(ph * 2) + 0.05 : 0.025 * sin(ph * 2);
    pose[body * PS + RZ] = sw * 0.03;
    pose[head * PS + RX] = -0.05 + 0.05 * sin(ph * 2 + 1) + R.lookP;
    pose[head * PS + RY] = R.look;
    tailLift = run ? -0.55 : -0.1;
    pose[t1 * PS + RY] = sin(ph * 0.5) * 0.18;
  } else if (jumpy) {
    const s = sin(A.at * 6.6);
    lift = max(0, s) * 0.15;
    sq = 1 + 0.16 * max(0, s) - 0.14 * s * s * (s < 0 ? 1 : 0);
    pose[fr * PS + RX] = pose[fl * PS + RX] = -0.5 * max(0, s);
    pose[br * PS + RX] = pose[bl * PS + RX] = 0.6 * max(0, s);
    pose[body * PS + RX] = -0.1 * max(0, s);
    pose[head * PS + RX] = R.lookP;
    pose[head * PS + RY] = R.look;
    pose[body * PS + RZ] = 0;
    pose[t1 * PS + RY] = sin(t * 12) * 0.5;
    tailLift = -0.25;
  } else {
    pose[body * PS + RX] = sleep ? 0.04 : 0;
    pose[body * PS + RZ] = 0;
    pose[t1 * PS + RY] = sin(t * 1.15) * 0.22;
    pose[head * PS + RX] = (sleep ? 0.42 : A.state === 3 ? -0.16 : 0.02 * sin(t * 0.9)) + R.lookP;
    pose[head * PS + RY] = R.look + (A.state === 0 && R.aware < 0.1 ? 0.28 * sin(t * 0.45) : 0);
    if (A.state === 3) pose[fr * PS + RX] = -0.95;
    if (sleep) {
      sq = 0.76 + 0.015 * sin(t * 1.3);
      pose[fr * PS + RX] = pose[fl * PS + RX] = 0.4;
      pose[br * PS + RX] = pose[bl * PS + RX] = -0.4;
      pose[t1 * PS + RY] = 0.9;
    }
  }
  pose[head * PS + RZ] = sleep ? 0.15 : 0.04 * sin(t * 0.8);
  pose[t1 * PS + RX] = R.sp[4]!.step(tailLift + 0.05 * sin(t * 1.9), 80, 6, dt);
  pose[t2 * PS + RY] = R.sp[5]!.step(pose[t1 * PS + RY]! * 0.9 + 0.1 * sin(t * 2.3), 60, 4.5, dt);
  pose[t2 * PS + RX] = R.sp[6]!.step(tailLift * 0.5, 50, 4, dt);
  // ears
  if (A.detail && dt > 0 && t >= R.twitchAt) {
    R.twitchAt = t + 2 + R.rand() * 5;
    (R.rand() < 0.5 ? R.sp[0]! : R.sp[1]!).kick(9);
  }
  const back = run ? 0.5 : 0;
  const tp = sleep ? 0.35 : A.state === 3 ? -0.2 : 0.02 + back;
  const out = sleep ? 0.6 : A.state === 3 ? 0.05 : 0.08 + 0.04 * sin(t * 0.8);
  pose[earR * PS + RX] = R.sp[0]!.step(tp, 160, 8, dt);
  pose[earL * PS + RX] = R.sp[1]!.step(tp, 160, 8, dt);
  pose[earR * PS + RZ] = -R.sp[2]!.step(out, 120, 6, dt);
  pose[earL * PS + RZ] = R.sp[3]!.step(out, 120, 6, dt);
  const wob = R.sp[7]!.step(0.1 * sin(t * 2.4) + (walk ? 0.12 * sin(t * 9) : 0), 120, 4, dt);
  pose[sprout * PS + RZ] = wob;
  pose[sprout * PS + RX] = -0.1 - lift * 2;
  o.lift = lift;
  o.sq = sq;
  o.glow = glowFor(A, R);
  lid(pose, eyes, R.blink(A.t, dt, sleep), A.state === 5 ? 0.5 : 0);
};

const ANIMATORS: Animator[] = [animPuffbun, animTidler, animSprigfox];

// ------------------------------------------------------------------------------------------------ renderer
const _root = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);

export class CreatureRenderer {
  readonly group = new Object3D();
  readonly models: Model[];
  readonly insts: ModelInstances[];
  readonly mats: ActorMaterial[];
  private readonly poses: Float32Array[];
  private readonly rigs = new Map<number, RigState>();
  private frame = 0;
  private t = 0;
  private dt = 0;
  private target: Vector3 | null = null;
  private cam = new Vector3();
  private readonly out: AnimOut = { lift: 0, sq: 1, glow: 1 };
  private readonly ain: AnimIn = { t: 0, dt: 0, state: 0, at: 0, mood: 0.5, emote: 0, flags: 0, speed: 0, fwd: 0, side: 0, ax: 0, az: 0, detail: true };
  actors = 0;
  /** draw distance (m) beyond which actors are skipped; animation detail (springs / look-at) drops at `detailDist` */
  drawDist = 140;
  detailDist = 45;

  constructor(
    private readonly ctx: Ctx,
    capacity = 160,
  ) {
    this.group.name = 'creatures.actors';
    this.models = SPECIES_DEFS.map((d) => buildModel(d));
    this.mats = this.models.map((m) => makeActorMaterial(ctx, m.def.palettes, `creature.${m.def.name}`));
    this.insts = this.models.map((m, i) => new ModelInstances(m, this.mats[i]!.material, capacity, this.group, ctx.mats, `creature.${m.def.name}`));
    this.poses = this.models.map((m) => newPose(m));
  }

  begin(t: number, dt: number, playerPos: Vector3 | null): void {
    this.t = t;
    this.dt = dt;
    this.target = playerPos;
    this.frame++;
    this.actors = 0;
    this.cam.copy(this.ctx.camera.position);
    for (const i of this.insts) i.begin();
  }

  add(r: ActorRow): void {
    const sp = Math.max(0, Math.min(2, r.species | 0));
    const inst = this.insts[sp]!;
    const dx = r.x - this.cam.x,
      dz = r.z - this.cam.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > this.drawDist * this.drawDist) return;
    const slot = inst.alloc();
    if (slot < 0) return;
    this.actors++;
    let R = this.rigs.get(r.id);
    if (!R) {
      R = new RigState(r.id);
      this.rigs.set(r.id, R);
    }
    R.seen = this.frame;
    const dt = this.dt;
    // velocity estimate (world), then local frame
    if (!R.init || Math.hypot(r.x - R.px, r.z - R.pz) > 6) {
      R.init = true;
      R.vx = R.vz = R.vy = 0;
      R.fwd = R.side = R.ax = R.az = 0;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-10 * dt);
      R.vx += ((r.x - R.px) / dt - R.vx) * k;
      R.vz += ((r.z - R.pz) / dt - R.vz) * k;
      R.vy += ((r.y - R.py) / dt - R.vy) * k;
      const sy = Math.sin(r.yaw),
        cy = Math.cos(r.yaw);
      const side = R.vx * cy - R.vz * sy;
      const fwd = R.vx * sy + R.vz * cy;
      R.ax += ((fwd - R.fwd) / dt - R.ax) * k;
      R.az += ((side - R.side) / dt - R.az) * k;
      R.fwd = fwd;
      R.side = side;
    }
    R.px = r.x;
    R.py = r.y;
    R.pz = r.z;
    // look at the player when aware (flag 4) -- smoothed relative bearing
    let lookT = 0;
    let lookPT = 0;
    let awareT = 0;
    const detail = d2 < this.detailDist * this.detailDist;
    if (this.target && detail && ((r.flags & 4) !== 0 || r.state === 3) && (r.flags & 1) === 0) {
      const ddx = this.target.x - r.x,
        ddz = this.target.z - r.z;
      let rel = Math.atan2(ddx, ddz) - r.yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      lookT = clamp(rel, -0.85, 0.85);
      lookPT = clamp((this.target.y + 1.1 - (r.y + 0.4)) * -0.12, -0.2, 0.15);
      awareT = 1;
    }
    if (dt > 0) {
      const k = 1 - Math.exp(-7 * dt);
      R.look += (lookT - R.look) * k;
      R.lookP += (lookPT - R.lookP) * k;
      R.aware += (awareT - R.aware) * k;
    }
    const A = this.ain;
    A.t = this.t;
    A.dt = dt;
    A.state = r.state;
    A.at = r.at;
    A.mood = r.mood;
    A.emote = r.emote;
    A.flags = r.flags;
    A.speed = Math.hypot(R.vx, R.vz);
    A.fwd = R.fwd;
    A.side = R.side;
    A.ax = R.ax;
    A.az = R.az;
    A.detail = detail;
    const pose = this.poses[sp]!;
    resetPose(pose);
    const O = this.out;
    O.lift = 0;
    O.sq = 1;
    O.glow = 1;
    ANIMATORS[sp]!(this.models[sp]!, pose, A, R, O);
    const sq = O.sq;
    const sxz = 1 / Math.sqrt(sq);
    _q.setFromAxisAngle(_up, r.yaw);
    _p.set(r.x, r.y + O.lift * r.scale, r.z);
    _s.set(r.scale * sxz, r.scale * sq, r.scale * sxz);
    _root.compose(_p, _q, _s);
    composeRig(this.models[sp]!, _root, pose, inst, slot);
    inst.setAttr(slot, Math.max(0, Math.min(2, r.variant | 0)), O.glow);
  }

  end(): void {
    for (const i of this.insts) i.end();
    if ((this.frame & 63) === 0) for (const [id, R] of this.rigs) if (this.frame - R.seen > 120) this.rigs.delete(id);
  }

  dispose(): void {
    for (const i of this.insts) i.dispose();
    for (const m of this.mats) m.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
