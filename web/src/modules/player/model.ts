/**
 * The chibi explorer avatar as a micro-voxel model (same sculptor / material / part-hierarchy as the creatures).
 * Customisable skin / hair / outfit colours via `setColors`. The animation here is the *visual* life layer
 * (walk / run swing, jump / fall / land poses, swim paddle, breathing, blink, hair + backpack springs); the real
 * avatar controller / locomotion FSM belongs to the movement implementer and can call `pose*` or replace `update`.
 */
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { PlayerState } from '../../engine/Bridge';
import type { Ctx } from '../../engine/types';
import { buildModel, composeRig, ModelInstances, newPose, PS, resetPose, type Model } from '../creatures/actors';
import { makeActorMaterial, type ActorMaterial } from '../creatures/material';
import { fxFor } from '../creatures/fx';
import { RigState } from '../creatures/render';
import { AV, AV_BASE, AVATAR, avatarPalette } from '../creatures/species';

export interface AvatarColors {
  skin?: string;
  hair?: string;
  shirt?: string;
  trim?: string;
  pants?: string;
  boots?: string;
  pack?: string;
  pack2?: string;
  eyes?: string;
  glow?: string;
}

const RX = 3,
  RY = 4,
  RZ = 5,
  SXI = 6,
  SYI = 7;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const _root = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);

export class VoxelAvatar {
  readonly group = new Object3D();
  readonly model: Model;
  readonly inst: ModelInstances;
  readonly mat: ActorMaterial;
  private readonly pose: Float32Array;
  private readonly R = new RigState(7);
  private readonly hex: string[];
  private face = 0;
  private t = 0;
  private ph = 0;
  private lean = 0;
  private swimK = 0;
  private vyS = 0;
  /** on-screen voxel count etc. for the report */
  readonly stats: { voxels: number; faces: number; parts: number };

  private wasG = true;
  private vyAir = 0;
  private pg = 0;

  constructor(
    private readonly ctx: Ctx,
    name = 'player',
  ) {
    this.group.name = `${name}.avatar`;
    this.model = buildModel(AVATAR);
    this.hex = [...AV_BASE];
    this.mat = makeActorMaterial(ctx, [avatarPalette(this.hex)], `${name}.avatar`);
    // the player is viewed from behind ~90% of the time (often against the sun): keep the shaded side readable, never a dark slab
    const gw = (this.mat.material.userData as { gw?: { uniforms?: Record<string, { value: unknown }> } }).gw;
    const sh = gw?.uniforms?.uGwShade;
    if (sh) sh.value = 0.82;
    const st = gw?.uniforms?.uGwShadeTint?.value as { set?: (c: string) => void } | undefined;
    st?.set?.('#C2B0EC');
    this.inst = new ModelInstances(this.model, this.mat.material, 1, this.group, ctx.mats, `${name}.avatar`);
    this.pose = newPose(this.model);
    this.stats = { voxels: this.model.baked.voxels, faces: this.model.baked.faces, parts: this.model.n };
  }

  setColors(c: AvatarColors): void {
    const set = (slot: number, v?: string): void => {
      if (v) this.hex[slot] = v;
    };
    set(AV.SKIN, c.skin);
    set(AV.HAIR, c.hair);
    set(AV.SHIRT, c.shirt);
    set(AV.TRIM, c.trim);
    set(AV.PANTS, c.pants);
    set(AV.BOOTS, c.boots);
    set(AV.PACK, c.pack);
    set(AV.PACK2, c.pack2);
    set(AV.IRIS, c.eyes);
    set(AV.GLOW, c.glow);
    this.mat.setPalette(0, avatarPalette(this.hex));
  }

  /** drive from the interpolated `player` channel mirror */
  update(p: PlayerState, dt: number, _sea?: number): void {
    // avatar self-light floor: strong by day (backs sit in shadow against the sun), eased off at night (the actor shader already
    // multiplies emissive by 1 + 4.2 * night)
    const night = Math.max(0, Math.min(1, Number((this.ctx.uniforms.uNight as { value: number }).value) || 0));
    this.mat.fx.value.w = 1 + (0.2 - 1) * night;
    this.group.visible = p.valid;
    if (!p.valid) return;
    this.draw(p.pos.x, p.pos.y, p.pos.z, p.yaw, p.vel.x, p.vel.y, p.vel.z, p.animState, p.animT, p.grounded, p.waterDepth, dt);
  }

  /** lower-level entry used by the lab (no PlayerState needed) */
  draw(x: number, y: number, z: number, yaw: number, vx: number, vy: number, vz: number, state: number, animT: number, grounded: boolean, water: number, dt: number): void {
    this.t += dt;
    const t = this.t;
    const R = this.R;
    const M = this.model;
    const I = M.idx;
    const pose = this.pose;
    resetPose(pose);
    const speed = Math.hypot(vx, vz);
    const swimming = water > 0.5;
    this.swimK += ((swimming ? 1 : 0) - this.swimK) * (1 - Math.exp(-8 * Math.max(dt, 1 / 120)));
    const amp = clamp(speed / 4.3, 0, 1.35);
    if (dt > 0) this.ph += dt * (swimming ? 4 + speed * 1.2 : 3.2 + speed * 1.75);
    const sw = Math.sin(this.ph);
    const body = I.body!,
      head = I.head!,
      hair = I.hair!,
      armR = I.armR!,
      armL = I.armL!,
      legR = I.legR!,
      legL = I.legL!,
      pack = I.pack!;
    const targetLean = swimming ? 0.5 * clamp(speed / 2, 0, 1) : clamp(speed * 0.05, 0, 0.3);
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-9 * Math.max(dt, 1 / 120)));
    let lift = 0;
    let sq = 1 + 0.014 * Math.sin(t * 2.1);
    if (speed > 0.35 && grounded && !swimming) {
      pose[legR * PS + RX] = sw * 0.8 * amp;
      pose[legL * PS + RX] = -sw * 0.8 * amp;
      pose[armR * PS + RX] = -sw * 0.75 * amp;
      pose[armL * PS + RX] = sw * 0.75 * amp;
      pose[body * PS + RY] = sw * 0.12 * amp;
      pose[head * PS + RY] = -sw * 0.09 * amp;
      lift = Math.abs(sw) * 0.07 * amp;
      sq = 1 + 0.03 * Math.cos(this.ph * 2) * amp;
      pose[body * PS + RZ] = sw * 0.06 * amp;
    } else if (swimming) {
      const k = this.swimK;
      pose[legR * PS + RX] = Math.sin(this.ph * 1.6) * 0.5 * k;
      pose[legL * PS + RX] = -Math.sin(this.ph * 1.6) * 0.5 * k;
      pose[armR * PS + RX] = (-1.1 + Math.sin(this.ph) * (speed > 0.4 ? 1.0 : 0.35)) * k;
      pose[armL * PS + RX] = (-1.1 - Math.sin(this.ph) * (speed > 0.4 ? 1.0 : 0.35)) * k;
      pose[armR * PS + RZ] = 0.35 * k;
      pose[armL * PS + RZ] = -0.35 * k;
      lift = 0.02 * Math.sin(t * 2.3);
      sq = 1;
    } else if (!grounded) {
      if (vy > 0) {
        pose[armR * PS + RX] = -2.6;
        pose[armL * PS + RX] = -2.6;
        pose[armR * PS + RZ] = 0.3;
        pose[armL * PS + RZ] = -0.3;
        pose[legR * PS + RX] = 0.5;
        pose[legL * PS + RX] = -0.45;
        sq = 1.06;
      } else {
        pose[armR * PS + RZ] = 0.95;
        pose[armL * PS + RZ] = -0.95;
        pose[armR * PS + RX] = -0.3;
        pose[armL * PS + RX] = -0.3;
        pose[legR * PS + RX] = -0.3;
        pose[legL * PS + RX] = 0.3;
        sq = 1.03;
      }
    } else if (state === 5) {
      const k = clamp(1 - animT / 0.25, 0, 1);
      sq = 1 - 0.22 * k;
      pose[armR * PS + RZ] = 0.4 * k;
      pose[armL * PS + RZ] = -0.4 * k;
    } else {
      pose[armR * PS + RZ] = 0.07 + 0.02 * Math.sin(t * 1.3);
      pose[armL * PS + RZ] = -0.07 - 0.02 * Math.sin(t * 1.3 + 1);
      pose[armR * PS + RX] = 0.03 * Math.sin(t * 1.1);
      pose[head * PS + RY] = 0.22 * Math.sin(t * 0.37) * (1 - clamp(speed, 0, 1));
      pose[head * PS + RX] = 0.03 * Math.sin(t * 0.8);
    }
    pose[body * PS + RX] = this.lean;
    pose[head * PS + RX] = (pose[head * PS + RX] ?? 0) - this.lean * 0.55;
    // hair + backpack springs
    this.vyS += (vy - this.vyS) * (1 - Math.exp(-10 * Math.max(dt, 1 / 120)));
    const hairT = clamp(speed / 5, 0, 1) * 0.55 + clamp(-this.vyS * 0.06, -0.3, 0.5) + 0.04 * Math.sin(t * 1.6);
    pose[hair * PS + RX] = R.sp[0]!.step(hairT, 110, 5, dt);
    pose[hair * PS + RZ] = R.sp[1]!.step(0.05 * Math.sin(t * 1.3) + (speed > 0.4 ? 0.12 * sw : 0), 90, 5, dt);
    pose[pack * PS + RX] = R.sp[2]!.step(-0.03 + this.lean * 0.25 + (grounded ? 0 : clamp(this.vyS * 0.02, -0.2, 0.2)), 130, 7, dt);
    // face
    // authored face frames: 0 open, 1 blink (see voxdata FACE_FRAMES)
    const closed = R.blink(t, dt, false);
    this.face = closed > 0.5 ? 1 : 0;
    // dust: landing puff (scaled by the fall speed) + a pair of puffs per sprint step
    if (dt > 0) {
      const fx = fxFor(this.ctx);
      if (!grounded) this.vyAir = Math.min(this.vyAir, vy);
      else {
        if (!this.wasG && !swimming && this.vyAir < -1.5) fx.puff(x, y, z, 10, 0.11, 1.3);
        this.vyAir = 0;
      }
      this.wasG = grounded;
      const g = Math.floor(this.ph / Math.PI);
      if (g !== this.pg) {
        this.pg = g;
        if (grounded && !swimming && speed > 4.0) fx.puff(x - Math.sin(yaw) * 0.2, y, z - Math.cos(yaw) * 0.2, 3, 0.09, 0.7);
      }
    }
    // root: feet position, yaw, volume-preserving squash
    const sxz = 1 / Math.sqrt(sq);
    _q.setFromAxisAngle(_up, yaw);
    _p.set(x, y + lift, z);
    _s.set(sxz, sq, sxz);
    _root.compose(_p, _q, _s);
    this.inst.begin();
    const i = this.inst.alloc();
    composeRig(M, _root, pose, this.inst, i);
    this.inst.setAttr(i, 0, 0.9 + 0.1 * Math.sin(t * 2.2), this.face);
    this.inst.end();
  }

  dispose(): void {
    this.inst.dispose();
    this.mat.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
