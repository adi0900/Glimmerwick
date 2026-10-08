/**
 * Villager actors: a `VoxelAvatar` each (different palette), a voxel hat, a wander / face-the-player routine on the
 * real ground height, and a bouncy "!" bubble (DOM, projected) when they have something for you.
 */
import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, type Scene } from 'three';
import type { Ctx } from '../../engine/types';
import { VoxelAvatar } from '../player/model';
import type { NpcDef } from './engine';

const U = 0.05;
/** head-top height of the avatar rig (m) */
export const HEAD_TOP = 1.16;

function shade(hex: string, k: number): Color {
  const c = new Color(hex);
  return c.multiplyScalar(k);
}

/** voxel hats from a few stacked boxes (flat-shaded, tone-stepped like the avatar) */
function buildHat(kind: NpcDef['hat']['kind'], color: string, band: string): { group: Group; mats: Array<{ m: MeshBasicMaterial; base: Color }> } {
  const group = new Group();
  const mats: Array<{ m: MeshBasicMaterial; base: Color }> = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string, k = 1): void => {
    const base = shade(hex, k);
    const m = new MeshBasicMaterial({ color: base.clone() });
    mats.push({ m, base });
    const mesh = new Mesh(new BoxGeometry(w, h, d), m);
    mesh.position.set(x, y + h / 2, z);
    group.add(mesh);
  };
  switch (kind) {
    case 'tophat':
      box(0.56, U, 0.56, 0, 0, 0, color, 0.82); // brim
      box(0.38, 0.34, 0.38, 0, U, 0, color, 1); // crown
      box(0.4, 0.09, 0.4, 0, U, 0, band, 1); // band
      box(0.32, U * 0.6, 0.32, 0, U + 0.34, 0, color, 1.18); // top highlight
      break;
    case 'cap': // builder's hard hat
      box(0.52, 0.06, 0.52, 0, 0, 0, color, 0.85);
      box(0.46, 0.14, 0.46, 0, 0.06, 0, color, 1);
      box(0.32, 0.08, 0.32, 0, 0.2, 0, color, 1.12);
      box(0.1, 0.1, 0.5, 0, 0.1, 0, band, 1); // ridge stripe
      box(0.4, 0.03, 0.2, 0, 0, 0.34, color, 0.8); // visor
      break;
    case 'bucket':
      box(0.62, 0.04, 0.62, 0, 0, 0, color, 0.85);
      box(0.44, 0.2, 0.44, 0, 0.04, 0, color, 1);
      box(0.46, 0.06, 0.46, 0, 0.04, 0, band, 1);
      box(0.36, 0.05, 0.36, 0, 0.24, 0, color, 1.1);
      break;
    case 'sunhat':
      box(0.8, 0.035, 0.8, 0, 0, 0, color, 0.9);
      box(0.56, 0.04, 0.56, 0, 0.03, 0, color, 0.96);
      box(0.4, 0.16, 0.4, 0, 0.07, 0, color, 1.05);
      box(0.42, 0.06, 0.42, 0, 0.07, 0, band, 1);
      box(0.1, 0.1, 0.1, 0.17, 0.12, 0.2, '#FF8FB1', 1.05); // flower
      box(0.05, 0.05, 0.05, 0.17, 0.2, 0.2, '#FFE27A', 1.1);
      break;
  }
  return { group, mats };
}

export interface GroundFn {
  (x: number, z: number): { h: number; ok: boolean };
}

export class Npc {
  readonly def: NpcDef;
  readonly av: VoxelAvatar;
  private readonly hat: Group;
  private readonly hatMats: Array<{ m: MeshBasicMaterial; base: Color }>;
  readonly bang: HTMLElement;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  private home = { x: 0, z: 0 };
  private tx = 0;
  private tz = 0;
  private walking = false;
  private wait = 1;
  private t = Math.random() * 10;
  private groundT = 0;
  private targetY = 0;
  private vx = 0;
  private vz = 0;
  present = false;
  /** world position to walk to instead of wandering (festival), null = wander */
  gather: { x: number; z: number } | null = null;
  /** excited bounce amount 0-1 (a quest is waiting) */
  excited = false;
  /** set while a dialogue is open with this villager */
  talking = false;

  constructor(
    ctx: Ctx,
    def: NpcDef,
    scene: Scene,
    hudRoot: HTMLElement,
  ) {
    this.def = def;
    this.av = new VoxelAvatar(ctx, `npc.${def.id}`);
    this.av.setColors(def.look);
    this.av.group.visible = false;
    scene.add(this.av.group);
    const h = buildHat(def.hat.kind, def.hat.color, def.hat.band);
    this.hat = h.group;
    this.hatMats = h.mats;
    this.hat.visible = false;
    scene.add(this.hat);
    this.bang = document.createElement('div');
    this.bang.className = 'gw-bang';
    this.bang.textContent = '!';
    this.bang.style.display = 'none';
    hudRoot.append(this.bang);
  }

  setHome(x: number, z: number, h: number): void {
    this.home = { x, z };
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.y = this.targetY = h;
  }

  /** move without changing home (arrivals spawn at the village edge and walk home) */
  placeAt(x: number, z: number, h: number): void {
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.y = this.targetY = h;
  }

  get homePos(): { x: number; z: number } {
    return this.home;
  }

  /** teleport next to home and show */
  spawn(): void {
    this.present = true;
    this.av.group.visible = true;
    this.hat.visible = true;
  }

  hide(): void {
    this.present = false;
    this.av.group.visible = false;
    this.hat.visible = false;
    this.bang.style.display = 'none';
  }

  update(ctx: Ctx, dt: number, px: number, pz: number, ground: GroundFn): void {
    if (!this.present) return;
    this.t += dt;
    const dxp = px - this.x;
    const dzp = pz - this.z;
    const dp = Math.hypot(dxp, dzp);
    // --- decide where to be
    const near = dp < 4.6;
    if (this.talking || (near && !this.gather)) {
      this.walking = false;
      this.wait = Math.max(this.wait, 0.5);
    }
    if (this.gather) {
      const gx = this.gather.x - this.x;
      const gz = this.gather.z - this.z;
      if (Math.hypot(gx, gz) > 0.6) {
        this.tx = this.gather.x;
        this.tz = this.gather.z;
        this.walking = true;
      } else this.walking = false;
    } else if (!this.walking && !near && !this.talking) {
      this.wait -= dt;
      if (this.wait <= 0) {
        // pick a nearby spot at the same height (never up a wall / into a pond)
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 0.8 + Math.random() * this.def.wander;
          const cx = this.home.x + Math.cos(a) * r;
          const cz = this.home.z + Math.sin(a) * r;
          const g = ground(cx, cz);
          if (g.ok && Math.abs(g.h - this.targetY) < 0.9) {
            this.tx = cx;
            this.tz = cz;
            this.walking = true;
            break;
          }
        }
        this.wait = 2 + Math.random() * 5;
      }
    }
    // --- move
    let speed = 0;
    if (this.walking) {
      const mx = this.tx - this.x;
      const mz = this.tz - this.z;
      const d = Math.hypot(mx, mz);
      speed = this.gather ? 1.7 : 1.05;
      if (d < 0.12) this.walking = false;
      else {
        const step = Math.min(d, speed * dt);
        const nx = this.x + (mx / d) * step;
        const nz = this.z + (mz / d) * step;
        const g = ground(nx, nz);
        if (g.ok && Math.abs(g.h - this.targetY) < 1.1) {
          this.x = nx;
          this.z = nz;
          this.vx = (mx / d) * speed;
          this.vz = (mz / d) * speed;
          const want = Math.atan2(mx, mz);
          this.yaw += wrap(want - this.yaw) * Math.min(1, dt * 9);
        } else {
          this.walking = false;
          speed = 0;
        }
      }
    }
    if (!this.walking) {
      this.vx *= 0.5;
      this.vz *= 0.5;
      speed = 0;
      if (near || this.talking) {
        const want = Math.atan2(dxp, dzp);
        this.yaw += wrap(want - this.yaw) * Math.min(1, dt * 6);
      } else if (Math.sin(this.t * 0.27 + this.def.id.length) > 0.97) {
        this.yaw += 0.4 * dt; // a lazy look around
      }
    }
    // --- ground height (5 Hz query, smoothed)
    this.groundT -= dt;
    if (this.groundT <= 0) {
      this.groundT = 0.2;
      const g = ground(this.x, this.z);
      if (g.ok) this.targetY = g.h;
    }
    this.y += (this.targetY - this.y) * Math.min(1, dt * 10);
    // --- draw
    const hop = this.excited && !this.talking ? Math.max(0, Math.sin(this.t * 4.2)) * 0.1 : 0;
    this.av.draw(this.x, this.y + hop, this.z, this.yaw, this.vx, 0, this.vz, 0, 0, true, 0, dt);
    this.hat.position.set(this.x, this.y + hop + HEAD_TOP - 0.04, this.z);
    this.hat.rotation.y = this.yaw;
    const night = ctx.uniforms.uNight.value as number;
    const k = 1 - 0.5 * night;
    for (const { m, base } of this.hatMats) m.color.copy(base).multiplyScalar(k);
    void speed;
  }

  dispose(): void {
    this.av.dispose();
    this.hat.parent?.remove(this.hat);
    this.bang.remove();
  }
}

const wrap = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
