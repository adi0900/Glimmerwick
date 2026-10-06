/**
 * Creature runtime: per-species instanced voxel rigs + the locomotion / life layer.
 *
 * Locomotion layer (see docs/specs/MOVEMENT_TRACE_NOTES.md, creature section):
 *  - speed / yaw-rate come from the sim (`creatures` channel cols 14 / 15; the sim already limits acceleration and turn
 *    rate) and are low-passed here; gait phase advances with DISTANCE travelled (stride-matched, feet do not moonwalk),
 *    amplitude follows the smoothed speed fraction, so limbs settle when the creature stops;
 *  - hopping (Puffbun walks by hopping; every species hops when playing) has a real cycle: anticipation crouch -> launch
 *    stretch -> air -> landing squash -> spring-driven overshoot, and always finishes the hop it started;
 *  - every pose difference (sleep / notice / swim / hop / move) is a smoothed weight, nothing is switched on a frame;
 *  - body leans into acceleration and banks into turns (springs), head leads turns and looks at the player with a
 *    limited angle, ears / tails / gills follow through (springs) from vertical hop velocity, acceleration and yaw rate.
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
  /** m/s from the sim (channel col 14); negative = unknown, estimate from positions */
  speed?: number;
  /** rad/s from the sim (channel col 15) */
  yawRate?: number;
}

/** per-species locomotion constants (metres at world scale; `run` / `walk` match crates/sim_creatures species table) */
export const LOCO = [
  { walk: 0.9, run: 3.0, accel: 3.5, strideWalk: 0.5, strideRun: 1.0, hopStride: 0.42, legAmpWalk: 0.55, legAmpRun: 0.95 },
  { walk: 0.8, run: 2.4, accel: 3.0, strideWalk: 0.36, strideRun: 0.7, hopStride: 0.5, legAmpWalk: 0.7, legAmpRun: 0.95 },
  { walk: 1.2, run: 4.2, accel: 6.0, strideWalk: 0.42, strideRun: 1.0, hopStride: 0.55, legAmpWalk: 0.55, legAmpRun: 0.95 },
] as const;

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
  // --- locomotion layer
  vyaw = 0;
  pyaw = 0;
  spd = 0;
  lastSpd = 0;
  acc = 0;
  yr = 0;
  moveW = 0;
  runW = 0;
  gph = 0;
  hop = 0;
  hopRate = 0;
  hopW = 0;
  playW = 0;
  wSleep = 0;
  wNotice = 0;
  wSwim = 0;
  tailPh = 0;
  swPh = 0;
  lastLift = 0;
  vLift = 0;
  glanceNext = 0;
  glanceUntil = 0;
  private seed: number;
  readonly sp: Spring[] = Array.from({ length: 14 }, () => new Spring());
  constructor(id: number) {
    this.seed = (id * 2654435761) >>> 0 || 1;
    this.phase = this.rand() * 6.28;
    this.sp[8]!.x = 1; // squash spring rests at 1
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
  // --- locomotion layer (all smoothed; weights 0..1)
  s01: number;
  moveW: number;
  runW: number;
  gph: number;
  hop: number;
  hopW: number;
  playW: number;
  wSleep: number;
  wNotice: number;
  wSwim: number;
  lean: number;
  bank: number;
  lead: number;
  yr: number;
  acc: number;
  vLift: number;
  sp: number;
}
export interface AnimOut {
  lift: number;
  sq: number;
  glow: number;
}

const RX = 3,
  RY = 4,
  RZ = 5,
  SXI = 6,
  SYI = 7;
const sin = Math.sin,
  cos = Math.cos,
  abs = Math.abs,
  max = Math.max,
  min = Math.min;
const clamp = (v: number, a: number, b: number): number => max(a, min(b, v));
const mix = (a: number, b: number, w: number): number => a + (b - a) * w;
const sstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;
const wrapPi = (a: number): number => Math.atan2(sin(a), cos(a));

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
  g = mix(g, 0.3 + 0.1 * sin(A.t * 0.9 + R.phase), A.wSleep);
  if (A.state === 5 || A.state === 6 || A.emote > 0) g = min(1.25, g + 0.35);
  return g;
}

/**
 * One hop cycle (f = fractional cycle): anticipation crouch 0-0.2, launch stretch 0.2-0.3, parabola 0.3-0.8,
 * landing squash 0.8-0.9, recovery 0.9-1. `sq` is a TARGET: a spring turns it into overshoot.
 */
const _hop = { lift: 0, sq: 1, air: 0, crouch: 0 };
function hopShape(u: number, H: number): typeof _hop {
  const f = u - Math.floor(u);
  let lift = 0;
  let sq = 1;
  if (f < 0.2) sq = 1 - 0.2 * sstep(0, 1, f / 0.2);
  else if (f < 0.3) sq = 0.8 + 0.4 * ((f - 0.2) / 0.1);
  else if (f < 0.8) {
    const x = (f - 0.3) / 0.5;
    lift = H * 4 * x * (1 - x);
    sq = 1.2 - 0.14 * x;
  } else if (f < 0.9) sq = 1.06 - 0.28 * ((f - 0.8) / 0.1);
  else sq = 0.78 + 0.22 * sstep(0, 1, (f - 0.9) / 0.1);
  _hop.lift = lift;
  _hop.sq = sq;
  _hop.air = H > 1e-5 ? lift / H : 0;
  _hop.crouch = clamp((1 - sq) / 0.22, 0, 1);
  return _hop;
}

type Animator = (M: Model, pose: Float32Array, A: AnimIn, R: RigState, o: AnimOut) => void;

/** squash spring (overshoot) + shared body channels */
function bodyChannels(pose: Float32Array, body: number, head: number, A: AnimIn, R: RigState, sqT: number): number {
  const sq = R.sp[8]!.step(sqT, 520, 24, A.dt);
  pose[body * PS + RX] = A.lean + A.wSleep * 0.05;
  pose[body * PS + RZ] = A.bank;
  pose[head * PS + RX] = -A.lean * 0.6 + R.lookP;
  pose[head * PS + RY] = R.look + A.lead;
  return sq;
}

// ------------------------------------------------------------------------------------------------ Puffbun
const animPuffbun: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
  const H = mix(0.075 + 0.125 * A.runW, 0.17, A.playW) * A.hopW;
  const h = hopShape(A.hop, H);
  const body = I.body!,
    head = I.head!,
    earR = I.earR!,
    earL = I.earL!,
    tail = I.tail!,
    footR = I.footR!,
    footL = I.footL!,
    eyes = I.eyes!;
  let sqT = mix(1 + 0.024 * sin(t * 2.2), h.sq, A.hopW);
  sqT = mix(sqT, 0.8 + 0.014 * sin(t * 1.3), A.wSleep);
  sqT = mix(sqT, 1.07 + 0.012 * sin(t * 9), A.wNotice);
  o.sq = bodyChannels(pose, body, head, A, R, sqT);
  o.lift = h.lift;
  o.glow = glowFor(A, R);
  pose[body * PS + RZ] += 0.04 * sin(A.hop * TAU) * A.hopW;
  pose[head * PS + RX] += mix(0.02 * sin(t * 1.1), 0.5, A.wSleep) + A.wNotice * -0.18 + 0.12 * h.crouch * A.hopW;
  pose[head * PS + RZ] = mix(0.045 * sin(t * 0.7), 0.18, A.wSleep);
  // ears: follow-through from vertical hop velocity, speed and acceleration; flick now and then; perk when noticing; flop asleep
  if (A.detail && dt > 0 && t >= R.twitchAt) {
    R.twitchAt = t + 3 + R.rand() * 6;
    (R.rand() < 0.5 ? R.sp[0]! : R.sp[1]!).kick(7 * (R.rand() < 0.5 ? 1 : -1));
  }
  let tp = -0.06 - 0.25 * clamp(A.speed / 3, 0, 1) - 0.3 * A.vLift - 0.02 * A.acc;
  tp = mix(tp, 0.2, A.wSleep);
  tp = mix(tp, 0.18, A.wNotice);
  const out = mix(0.1 + 0.05 * sin(t * 0.9), 0.95, A.wSleep) * (1 - A.wNotice) + 0.04 * A.wNotice;
  pose[earR * PS + RX] = R.sp[0]!.step(tp, 150, 7, dt);
  pose[earL * PS + RX] = R.sp[1]!.step(tp, 150, 7, dt);
  pose[earR * PS + RZ] = -R.sp[2]!.step(out, 120, 6, dt);
  pose[earL * PS + RZ] = R.sp[3]!.step(out, 120, 6, dt);
  // tail: wag phase is integrated (frequency changes never pop), swings against turns
  const wagA = mix(0.14, 0.3, A.moveW);
  pose[tail * PS + RY] = R.sp[4]!.step(sin(R.tailPh) * wagA * (1 + A.playW) - A.yr * 0.06, 90, 7, dt);
  pose[tail * PS + RX] = -0.1 - 0.2 * h.air * A.hopW + 0.05 * A.acc;
  const kick = (-0.8 * h.air + 0.35 * h.crouch) * A.hopW;
  pose[footR * PS + RX] = kick;
  pose[footL * PS + RX] = kick;
  lid(pose, eyes, R.blink(A.t, dt, A.wSleep > 0.5), R.squint);
};

// ------------------------------------------------------------------------------------------------ Tidler
const animTidler: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
  const body = I.body!,
    head = I.head!,
    eyes = I.eyes!,
    gR = I.gillR!,
    gL = I.gillL!,
    t1 = I.tail1!,
    t2 = I.tail2!;
  const legs = [I.legFR!, I.legBL!, I.legFL!, I.legBR!];
  const walkW = A.moveW * (1 - A.wSwim) * (1 - A.hopW);
  const H = 0.19 * A.hopW;
  const h = hopShape(A.hop, H);
  const sw = sin(A.gph);
  const amp = mix(LOCO[1].legAmpWalk, LOCO[1].legAmpRun, A.runW) * walkW;
  const swim = A.wSwim;
  const swimLeg = 0.9 + 0.25 * sin(R.swPh);
  const tuck = -0.5 * h.air * A.hopW;
  const l = (sign: number): number => mix(sign * sw * amp + tuck, swimLeg, swim);
  pose[legs[0]! * PS + RX] = l(1);
  pose[legs[1]! * PS + RX] = l(1);
  pose[legs[2]! * PS + RX] = l(-1);
  pose[legs[3]! * PS + RX] = l(-1);
  let sqT = mix(1 + 0.02 * sin(t * 2.0), h.sq, A.hopW);
  sqT = mix(sqT, 0.84 + 0.014 * sin(t * 1.3), A.wSleep);
  sqT = mix(sqT, 1.06 + 0.01 * sin(t * 9), A.wNotice);
  o.sq = bodyChannels(pose, body, head, A, R, sqT);
  o.lift = abs(cos(A.gph)) * 0.012 * walkW + h.lift + (0.01 * sin(t * 2.2) - 0.03) * swim;
  o.glow = glowFor(A, R);
  pose[body * PS + RZ] += sw * 0.07 * walkW + sin(R.swPh * 0.5) * 0.05 * swim;
  pose[head * PS + RX] += (A.wSleep * 0.35 - 0.15 * A.wNotice) - 0.15 * swim;
  pose[head * PS + RY] += -sw * 0.1 * walkW + sin(R.swPh - 0.7) * 0.1 * swim + 0.05 * sin(t * 0.6) * (1 - A.moveW);
  pose[head * PS + RZ] = mix(0.04 * sin(t * 0.8), 0.12, A.wSleep);
  // tail: integrated phase; the tip lags through a spring and counter-swings against turns
  const tA = mix(0.2, 0.35, walkW) + 0.1 * swim + 0.3 * A.hopW;
  pose[t1 * PS + RY] = sin(R.tailPh) * tA - A.yr * 0.05;
  pose[t2 * PS + RY] = R.sp[4]!.step(sin(R.tailPh - 0.8) * tA * 1.3 - A.yr * 0.09, 90, 6, dt);
  // gills: flutter + springs; flare when noticing, droop when asleep
  const flare = mix(0.14 + 0.1 * sin(t * 3.1) + 0.12 * swim, 0.02, A.wSleep) * (1 - A.wNotice) + 0.42 * A.wNotice;
  const g0 = R.sp[0]!.step(flare + (swim > 0.5 ? 0.1 * sin(t * 6) : 0.06 * sin(t * 4.3 + 1)), 130, 5, dt);
  const g1 = R.sp[1]!.step(flare + (swim > 0.5 ? 0.1 * sin(t * 6 + 1) : 0.06 * sin(t * 4.3)), 130, 5, dt);
  pose[gR * PS + RZ] = -g0;
  pose[gL * PS + RZ] = g1;
  pose[gR * PS + RY] = swim * 0.5 + (1 - swim) * 0.05 * sin(t * 2.7);
  pose[gL * PS + RY] = -swim * 0.5 - (1 - swim) * 0.05 * sin(t * 2.7 + 1);
  lid(pose, eyes, R.blink(A.t, dt, A.wSleep > 0.5), R.squint);
};

// ------------------------------------------------------------------------------------------------ Sprigfox
const animSprigfox: Animator = (M, pose, A, R, o) => {
  const I = M.idx;
  const t = A.t + R.phase;
  const dt = A.dt;
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
  const walkW = A.moveW * (1 - A.hopW);
  const H = 0.15 * A.hopW;
  const h = hopShape(A.hop, H);
  const sw = sin(A.gph);
  const a = mix(LOCO[2].legAmpWalk, LOCO[2].legAmpRun, A.runW) * walkW;
  // trot (diagonal pairs); the run gait adds a bound (front pair leads the rear pair)
  const bound = 0.35 * A.runW;
  const swF = sin(A.gph + bound),
    swB = sin(A.gph - bound);
  const air = h.air * A.hopW;
  const slp = A.wSleep;
  const notice = A.wNotice;
  pose[fr * PS + RX] = mix(swF * a - 0.5 * air, 0.4, slp) + notice * -0.95 * (1 - slp);
  pose[fl * PS + RX] = mix(-swF * a - 0.5 * air, 0.4, slp);
  pose[br * PS + RX] = mix(-swB * a + 0.6 * air, -0.4, slp);
  pose[bl * PS + RX] = mix(swB * a + 0.6 * air, -0.4, slp);
  let sqT = mix(1 + 0.02 * sin(t * 2.1), h.sq, A.hopW);
  sqT = mix(sqT, 0.76 + 0.015 * sin(t * 1.3), slp);
  o.sq = bodyChannels(pose, body, head, A, R, sqT);
  o.lift = abs(cos(A.gph)) * mix(0.012, 0.03, A.runW) * walkW + h.lift;
  o.glow = glowFor(A, R);
  pose[body * PS + RX] += (mix(0.025, 0.08, A.runW) * sin(A.gph * 2) + 0.05 * A.runW) * walkW - 0.1 * air;
  pose[body * PS + RZ] += sw * 0.03 * walkW;
  pose[head * PS + RX] += -0.05 * walkW + 0.05 * sin(A.gph * 2 + 1) * walkW + (slp * 0.42 - notice * 0.16) + 0.02 * sin(t * 0.9) * (1 - A.moveW);
  pose[head * PS + RY] += (A.state === 0 && R.aware < 0.1 ? 0.28 * sin(t * 0.45) : 0) * (1 - A.moveW) * (1 - slp);
  pose[head * PS + RZ] = mix(0.04 * sin(t * 0.8), 0.15, slp);
  // tail: lift with speed, swing against turns, follow-through through a 2-spring chain
  const tailLift = mix(mix(0, -0.1, A.moveW) + A.runW * -0.45 + (A.hopW > 0.01 ? -0.25 * A.hopW : 0), 0, slp) - 0.04 * A.acc;
  pose[t1 * PS + RX] = R.sp[4]!.step(tailLift + 0.05 * sin(t * 1.9), 80, 6, dt);
  const ty = mix(sin(R.tailPh) * (0.22 + 0.2 * A.hopW) , 0.9, slp) - A.yr * 0.07;
  pose[t1 * PS + RY] = ty;
  pose[t2 * PS + RY] = R.sp[5]!.step(ty * 0.9 + 0.1 * sin(t * 2.3), 60, 4.5, dt);
  pose[t2 * PS + RX] = R.sp[6]!.step(tailLift * 0.5, 50, 4, dt);
  // ears
  if (A.detail && dt > 0 && t >= R.twitchAt) {
    R.twitchAt = t + 2 + R.rand() * 5;
    (R.rand() < 0.5 ? R.sp[0]! : R.sp[1]!).kick(9);
  }
  let tp = 0.02 + 0.5 * A.runW * A.moveW - 0.25 * A.vLift - 0.02 * A.acc;
  tp = mix(tp, 0.35, slp);
  tp = mix(tp, -0.2, notice);
  const out = mix(0.08 + 0.04 * sin(t * 0.8), 0.6, slp) * (1 - notice) + 0.05 * notice;
  pose[earR * PS + RX] = R.sp[0]!.step(tp, 160, 8, dt);
  pose[earL * PS + RX] = R.sp[1]!.step(tp, 160, 8, dt);
  pose[earR * PS + RZ] = -R.sp[2]!.step(out, 120, 6, dt);
  pose[earL * PS + RZ] = R.sp[3]!.step(out, 120, 6, dt);
  const wob = R.sp[7]!.step(0.1 * sin(t * 2.4) + A.moveW * 0.12 * sin(t * 9), 120, 4, dt);
  pose[sprout * PS + RZ] = wob;
  pose[sprout * PS + RX] = -0.1 - o.lift * 2;
  lid(pose, eyes, R.blink(A.t, dt, slp > 0.5), R.squint);
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
  private readonly ain: AnimIn = {
    t: 0, dt: 0, state: 0, at: 0, mood: 0.5, emote: 0, flags: 0, speed: 0, fwd: 0, side: 0, ax: 0, az: 0, detail: true,
    s01: 0, moveW: 0, runW: 0, gph: 0, hop: 0, hopW: 0, playW: 0, wSleep: 0, wNotice: 0, wSwim: 0, lean: 0, bank: 0, lead: 0, yr: 0, acc: 0, vLift: 0, sp: 0,
  };
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

  /** advances the per-creature locomotion state (all smoothing is dt based; dt = 0 freezes everything) */
  private locomote(R: RigState, r: ActorRow, sp: number, detail: boolean): AnimIn {
    const dt = this.dt;
    const L = LOCO[sp]!;
    const snap = !R.init;
    const A = this.ain;
    // --- kinematics: velocity estimate from positions (fallback), speed / yaw-rate from the sim when given
    if (snap || Math.hypot(r.x - R.px, r.z - R.pz) > 6) {
      R.vx = R.vz = R.vy = 0;
      R.fwd = R.side = R.ax = R.az = 0;
      R.vyaw = r.yaw;
      R.spd = r.speed !== undefined && r.speed >= 0 ? r.speed : 0;
      R.lastSpd = R.spd;
      R.acc = 0;
      R.yr = 0;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-10 * dt);
      R.vx += ((r.x - R.px) / dt - R.vx) * k;
      R.vz += ((r.z - R.pz) / dt - R.vz) * k;
      R.vy += ((r.y - R.py) / dt - R.vy) * k;
      const sy = sin(r.yaw),
        cy = cos(r.yaw);
      const side = R.vx * cy - R.vz * sy;
      const fwd = R.vx * sy + R.vz * cy;
      R.ax += ((fwd - R.fwd) / dt - R.ax) * k;
      R.az += ((side - R.side) / dt - R.az) * k;
      R.fwd = fwd;
      R.side = side;
    }
    const known = r.speed !== undefined && r.speed >= 0;
    if (dt > 0) {
      // visual yaw: shortest arc, fast (the sim already rate-limits the heading; this only hides lab / network snaps)
      const dy = wrapPi(r.yaw - R.vyaw);
      R.vyaw = wrapPi(R.vyaw + dy * (1 - Math.exp(-40 * dt)));
      const rawSpd = known ? r.speed! : Math.hypot(R.vx, R.vz);
      const rawYr = r.yawRate !== undefined && known ? r.yawRate : wrapPi(r.yaw - R.pyaw) / dt;
      R.spd += (rawSpd - R.spd) * (1 - Math.exp(-14 * dt));
      R.yr += (clamp(rawYr, -9, 9) - R.yr) * (1 - Math.exp(-12 * dt));
      R.acc += (clamp((R.spd - R.lastSpd) / dt, -12, 12) - R.acc) * (1 - Math.exp(-10 * dt));
    }
    R.lastSpd = R.spd;
    R.pyaw = r.yaw;
    R.px = r.x;
    R.py = r.y;
    R.pz = r.z;
    // --- discrete wants -> smoothed weights (never switched on a frame)
    const sleepT = r.state === 4 || (r.flags & 1) !== 0 ? 1 : 0;
    const noticeT = r.state === 3 ? 1 : 0;
    const swimT = (r.flags & 2) !== 0 ? 1 : 0;
    const playT = r.state === 5 || r.state === 6 || (r.emote === 2 && r.state === 0) ? 1 : 0;
    const s01 = R.spd / L.run;
    const moveT = sleepT ? 0 : sstep(0.03, 0.16, s01);
    const runT = sstep(0.5, 0.72, s01);
    const kw = (rate: number): number => (snap ? 1 : 1 - Math.exp(-rate * dt));
    R.wSleep += (sleepT - R.wSleep) * kw(2.5);
    R.wNotice += (noticeT - R.wNotice) * kw(12);
    R.wSwim += (swimT - R.wSwim) * kw(6);
    R.playW += (playT - R.playW) * kw(8);
    R.moveW += (moveT - R.moveW) * kw(10);
    R.runW += (runT - R.runW) * kw(8);
    R.squint += ((playT && r.state === 5 ? 0.5 : 0) - R.squint) * kw(12);
    // --- gait phase from DISTANCE (stride matched): cycles/s = speed / stride
    const stride = mix(L.strideWalk, L.strideRun, R.runW);
    R.gph = (R.gph + (R.spd / stride) * TAU * dt) % (TAU * 64);
    // --- hop cycle: Puffbun walks by hopping; every species hops when playing. A started hop is always finished.
    const hopper = sp === 0 && R.moveW > 0.05;
    let rate = 0;
    if (hopper) rate = clamp(R.spd / L.hopStride, 0.8, 3.2);
    if (playT && !sleepT) rate = max(rate, clamp(R.spd / L.hopStride, 1.5, 2.4));
    R.hopRate += (rate - R.hopRate) * kw(8);
    if (rate > 0.05) R.hop += R.hopRate * dt;
    else {
      const f = R.hop - Math.floor(R.hop);
      if (f > 1e-3) R.hop = min(R.hop + 2.4 * dt, Math.floor(R.hop) + 1);
      if (R.hop - Math.floor(R.hop) < 1e-3 && R.hop > 1e6) R.hop = 0;
    }
    if (R.hop > 1e5) R.hop -= 1e5;
    const hopOn = rate > 0.05 || R.hop - Math.floor(R.hop) > 1e-3;
    R.hopW += ((hopOn ? 1 : 0) - R.hopW) * kw(15);
    // --- integrated phases (frequency changes never pop)
    const tf = mix(mix(1.5, 5.5, R.moveW), 12, R.playW);
    R.tailPh += tf * dt;
    R.swPh += 5.2 * dt;
    // --- lean into acceleration, bank into turns, head leads turns (springs)
    const leanT = 0.09 * min(1, s01) + clamp(R.acc / L.accel, -1, 1) * 0.1 * (R.moveW > 0.02 ? 1 : 0.5) + (r.state === 2 ? 0 : 0);
    const lean = R.sp[9]!.step(sleepT ? 0 : leanT, 110, 13, dt);
    const bank = R.sp[10]!.step(-clamp(R.yr * (0.15 + 0.7 * min(1, s01)) * 0.09, -0.22, 0.22), 110, 12, dt);
    const lead = R.sp[12]!.step(clamp(R.yr * 0.11, -0.4, 0.4) * (1 - R.wSleep), 120, 13, dt);
    A.lean = lean;
    A.bank = bank;
    A.lead = lead;
    // --- vertical hop velocity for ear follow-through (normalised, smoothed)
    A.vLift = R.vLift;
    A.s01 = s01;
    A.moveW = R.moveW;
    A.runW = R.runW;
    A.gph = R.gph;
    A.hop = R.hop;
    A.hopW = R.hopW;
    A.playW = R.playW;
    A.wSleep = R.wSleep;
    A.wNotice = R.wNotice;
    A.wSwim = R.wSwim;
    A.yr = R.yr;
    A.acc = R.acc;
    A.sp = R.spd;
    A.detail = detail;
    return A;
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
    const detail = d2 < this.detailDist * this.detailDist;
    const A = this.locomote(R, r, sp, detail);
    R.init = true;
    // look: at the player while aware (flag 4 / notice) or on a random glance when the player is close; the head turns
    // at most ~50 deg relative to the body and not at all for a player behind it (the body turns instead)
    let lookT = 0;
    let lookPT = 0;
    let awareT = 0;
    if (this.target && detail && (r.flags & 1) === 0 && r.state !== 4) {
      const ddx = this.target.x - r.x,
        ddz = this.target.z - r.z;
      const near = ddx * ddx + ddz * ddz < 8 * 8;
      if (near && dt > 0 && this.t >= R.glanceNext) {
        R.glanceUntil = this.t + 0.8 + R.rand() * 0.7;
        R.glanceNext = this.t + 1.5 + R.rand() * 1.5 + 0.7;
      }
      const glance = near && this.t < R.glanceUntil && A.moveW < 0.5;
      if ((r.flags & 4) !== 0 || r.state === 3 || glance) {
        let rel = wrapPi(Math.atan2(ddx, ddz) - R.vyaw);
        const behind = 1 - sstep(1.9, 2.6, abs(rel));
        rel = clamp(rel, -0.85, 0.85) * behind;
        lookT = rel;
        lookPT = clamp((this.target.y + 1.1 - (r.y + 0.4)) * -0.12, -0.2, 0.15) * behind;
        awareT = 1;
      }
    }
    if (dt > 0 || !R.init) {
      const k = dt > 0 ? 1 - Math.exp(-7 * dt) : 1;
      R.look += (lookT - R.look) * k;
      R.lookP += (lookPT - R.lookP) * k;
      R.aware += (awareT - R.aware) * k;
    }
    A.t = this.t;
    A.dt = dt;
    A.state = r.state;
    A.at = r.at;
    A.mood = r.mood;
    A.emote = r.emote;
    A.flags = r.flags;
    A.speed = R.spd;
    A.fwd = R.fwd;
    A.side = R.side;
    A.ax = R.ax;
    A.az = R.az;
    const pose = this.poses[sp]!;
    resetPose(pose);
    const O = this.out;
    O.lift = 0;
    O.sq = 1;
    O.glow = 1;
    ANIMATORS[sp]!(this.models[sp]!, pose, A, R, O);
    // vertical velocity of the hop (m/s, normalised) for next frame's ear follow-through
    if (dt > 0) R.vLift += (clamp((O.lift - R.lastLift) / dt / 1.6, -1.5, 1.5) - R.vLift) * (1 - Math.exp(-18 * dt));
    R.lastLift = O.lift;
    const sq = max(0.3, O.sq);
    const sxz = 1 / Math.sqrt(sq);
    _q.setFromAxisAngle(_up, R.vyaw);
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
