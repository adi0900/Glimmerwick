/**
 * Creature / avatar life FX: voxel dust puffs (landing, run steps) and the coloured ground spill under glowing creatures at
 * night. One shared instance per Ctx (`fxFor`), stepped once per frame by the CreatureRenderer. Both are instanced meshes
 * (2 draw calls total); dust is a handful of tiny lit cubes that rise, tumble and shrink away (ART_BIBLE VFX: shrink, never fade).
 */
import { AdditiveBlending, BoxGeometry, CanvasTexture, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, Vector3 } from 'three';
import type { Ctx } from '../../engine/types';

const DUST_CAP = 128;
const SPILL_CAP = 96;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _e = new Vector3(0, 1, 0);

export class Fx {
  readonly group = new Object3D();
  disposed = false;
  private readonly dust: InstancedMesh;
  private readonly spill: InstancedMesh;
  private readonly x = new Float32Array(DUST_CAP);
  private readonly y = new Float32Array(DUST_CAP);
  private readonly z = new Float32Array(DUST_CAP);
  private readonly vx = new Float32Array(DUST_CAP);
  private readonly vy = new Float32Array(DUST_CAP);
  private readonly vz = new Float32Array(DUST_CAP);
  private readonly age = new Float32Array(DUST_CAP);
  private readonly life = new Float32Array(DUST_CAP);
  private readonly size = new Float32Array(DUST_CAP);
  private readonly rot = new Float32Array(DUST_CAP);
  private n = 0;
  private ns = 0;
  private seed = 12345;

  constructor(private readonly ctx: Ctx) {
    this.group.name = 'creatures.fx';
    const mat = ctx.mats.toon({ cls: 'clay', color: '#F4EAD2', paint: 0, wobble: 0, edge: 0, rim: 0.15, shade: 0.35, bands: 3, softness: 0.3, weather: false, cloudShadow: false, name: 'fx.dust' });
    this.dust = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, DUST_CAP);
    this.dust.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dust.count = 0;
    this.dust.frustumCulled = false;
    this.dust.name = 'fx.dust';
    ctx.mats.prepare(this.dust);
    this.group.add(this.dust);

    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    const tex = new CanvasTexture(cv);
    const pg = new PlaneGeometry(1, 1);
    pg.rotateX(-Math.PI / 2);
    const sm = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.spill = new InstancedMesh(pg, sm, SPILL_CAP);
    this.spill.instanceMatrix.setUsage(DynamicDrawUsage);
    this.spill.setColorAt(0, _c.set('#000000'));
    this.spill.count = 0;
    this.spill.frustumCulled = false;
    this.spill.renderOrder = 3;
    this.spill.name = 'fx.spill';
    this.group.add(this.spill);
    ctx.scene.add(this.group);
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** a ring of dust voxels kicked out from (x,y,z); size in metres (cube edge), `kick` = outward m/s */
  puff(x: number, y: number, z: number, count: number, size: number, kick: number, bx = 0, bz = 0): void {
    for (let i = 0; i < count && this.n < DUST_CAP; i++) {
      const k = this.n++;
      const a = this.rnd() * Math.PI * 2;
      const sp = kick * (0.5 + this.rnd() * 0.7);
      this.x[k] = x + Math.cos(a) * size * 1.2;
      this.y[k] = y + size * 0.6;
      this.z[k] = z + Math.sin(a) * size * 1.2;
      this.vx[k] = Math.cos(a) * sp + bx;
      this.vz[k] = Math.sin(a) * sp + bz;
      this.vy[k] = 0.35 + this.rnd() * 0.55;
      this.age[k] = 0;
      this.life[k] = 0.38 + this.rnd() * 0.22;
      this.size[k] = size * (0.7 + this.rnd() * 0.6);
      this.rot[k] = this.rnd() * 6.28;
    }
  }

  begin(): void {
    this.ns = 0;
  }

  /** coloured light pool on the ground (additive); rgb is linear, already scaled by intensity */
  spillAdd(x: number, y: number, z: number, diameter: number, r: number, g: number, b: number): void {
    if (this.ns >= SPILL_CAP) return;
    _p.set(x, y + 0.03, z);
    _s.set(diameter, 1, diameter);
    _m.compose(_p, _q.identity(), _s);
    this.spill.setMatrixAt(this.ns, _m);
    this.spill.setColorAt(this.ns, _c.setRGB(r, g, b));
    this.ns++;
  }

  end(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) continue;
      if (w !== i) {
        this.x[w] = this.x[i]!;
        this.y[w] = this.y[i]!;
        this.z[w] = this.z[i]!;
        this.vx[w] = this.vx[i]!;
        this.vy[w] = this.vy[i]!;
        this.vz[w] = this.vz[i]!;
        this.age[w] = this.age[i]!;
        this.life[w] = this.life[i]!;
        this.size[w] = this.size[i]!;
        this.rot[w] = this.rot[i]!;
      }
      w++;
    }
    this.n = w;
    for (let i = 0; i < w; i++) {
      const u = this.age[i]! / this.life[i]!;
      const damp = Math.exp(-3 * dt);
      this.vx[i]! *= damp;
      this.vz[i]! *= damp;
      this.vy[i]! = this.vy[i]! * damp - 0.9 * dt;
      this.x[i]! += this.vx[i]! * dt;
      this.y[i]! += this.vy[i]! * dt;
      this.z[i]! += this.vz[i]! * dt;
      // grow fast then shrink away (never a fade)
      const sc = this.size[i]! * Math.min(1, u * 8) * (1 - u * u);
      _p.set(this.x[i]!, this.y[i]!, this.z[i]!);
      _q.setFromAxisAngle(_e, this.rot[i]! + u * 2);
      _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      this.dust.setMatrixAt(i, _m);
    }
    this.dust.count = w;
    this.dust.visible = w > 0;
    this.dust.instanceMatrix.needsUpdate = true;
    this.spill.count = this.ns;
    this.spill.visible = this.ns > 0;
    this.spill.instanceMatrix.needsUpdate = true;
    if (this.spill.instanceColor) this.spill.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.dust.geometry.dispose();
    this.spill.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}

const cache = new WeakMap<object, Fx>();
export function fxFor(ctx: Ctx): Fx {
  let f = cache.get(ctx);
  if (!f || f.disposed) {
    f = new Fx(ctx);
    cache.set(ctx, f);
  }
  return f;
}
