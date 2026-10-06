/**
 * Rigged voxel models: sculpt -> bake (one geometry per part) -> instanced per-part meshes with a part hierarchy.
 * Animation is `pose` arrays (per part: offset xyz, euler xyz, scale xyz) composed parent-first into instance matrices.
 */
import { DynamicDrawUsage, Euler, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3, type Material, type Object3D } from 'three';
import type { Materials } from '../../engine/Materials';
import { bake, Sculpt, type BakedModel, type V3 } from './sculpt';

export interface PartDef {
  name: string;
  parent: string | null;
  /** pivot in voxel units (model space); rotation / scale animate about it */
  pivot: V3;
}
export interface ModelDef {
  name: string;
  /** metres per voxel */
  vs: number;
  parts: PartDef[];
  /** palettes[variant][slot] = '#rrggbb' */
  palettes: string[][];
  build(s: Sculpt): void;
}
export interface Model {
  def: ModelDef;
  baked: BakedModel;
  vs: number;
  n: number;
  parent: Int16Array;
  /** rest offset of each part relative to its parent pivot (metres) */
  rest: Float32Array;
  idx: Record<string, number>;
  /** model height / length in metres at scale 1 */
  height: number;
  length: number;
}

export function buildModel(def: ModelDef): Model {
  const sc = new Sculpt(def.parts.map((p) => p.name));
  def.build(sc);
  sc.prune();
  const baked = bake(
    sc,
    def.parts.map((p) => p.pivot),
    def.vs,
  );
  const n = def.parts.length;
  const idx: Record<string, number> = {};
  def.parts.forEach((p, i) => (idx[p.name] = i));
  const parent = new Int16Array(n);
  const rest = new Float32Array(n * 3);
  def.parts.forEach((p, i) => {
    const pi = p.parent === null ? -1 : idx[p.parent]!;
    if (pi >= i) throw new Error(`model ${def.name}: part ${p.name} must come after its parent`);
    parent[i] = pi;
    const pp: V3 = pi < 0 ? [0, 0, 0] : def.parts[pi]!.pivot;
    for (let k = 0; k < 3; k++) rest[i * 3 + k] = (p.pivot[k]! - pp[k]!) * def.vs;
  });
  return { def, baked, vs: def.vs, n, parent, rest, idx, height: (baked.max[1] + 1) * def.vs, length: (baked.max[2] - baked.min[2] + 1) * def.vs };
}

export const PS = 9;
/** a pose = per part [px py pz rx ry rz sx sy sz] */
export function newPose(model: Model): Float32Array {
  const p = new Float32Array(model.n * PS);
  resetPose(p);
  return p;
}
export function resetPose(p: Float32Array): void {
  for (let i = 0; i < p.length; i += PS) {
    p[i] = p[i + 1] = p[i + 2] = p[i + 3] = p[i + 4] = p[i + 5] = 0;
    p[i + 6] = p[i + 7] = p[i + 8] = 1;
  }
}

/** per-part instanced meshes for one model (one draw per part, instances = actors) */
export class ModelInstances {
  readonly meshes: InstancedMesh[] = [];
  readonly world: Matrix4[];
  count = 0;
  private readonly av: Float32Array[] = [];
  private readonly ag: Float32Array[] = [];
  private readonly attrs: InstancedBufferAttribute[] = [];

  constructor(
    readonly model: Model,
    material: Material,
    readonly capacity: number,
    parent: Object3D,
    mats: Materials,
    name: string,
  ) {
    this.world = Array.from({ length: model.n }, () => new Matrix4());
    for (const bp of model.baked.parts) {
      const geo = bp.geo;
      const a1 = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      const a2 = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      a1.setUsage(DynamicDrawUsage);
      a2.setUsage(DynamicDrawUsage);
      geo.setAttribute('aInstVar', a1);
      geo.setAttribute('aInstGlow', a2);
      this.av.push(a1.array as Float32Array);
      this.ag.push(a2.array as Float32Array);
      this.attrs.push(a1, a2);
      const im = new InstancedMesh(geo, material, capacity);
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.count = 0;
      im.visible = false;
      im.frustumCulled = false;
      im.name = `${name}.${bp.name}`;
      mats.prepare(im);
      parent.add(im);
      this.meshes.push(im);
    }
  }

  begin(): void {
    this.count = 0;
  }
  alloc(): number {
    return this.count < this.capacity ? this.count++ : -1;
  }
  setAttr(i: number, variant: number, glow: number): void {
    for (let p = 0; p < this.av.length; p++) {
      this.av[p]![i] = variant;
      this.ag[p]![i] = glow;
    }
  }
  end(): void {
    for (const im of this.meshes) {
      im.count = this.count;
      im.visible = this.count > 0;
      im.instanceMatrix.needsUpdate = true;
    }
    for (const a of this.attrs) a.needsUpdate = true;
  }
  dispose(): void {
    for (const im of this.meshes) {
      im.parent?.remove(im);
      im.geometry.dispose();
      im.dispose();
    }
  }
}

const _e = new Euler();
const _q = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();

/** compose root * (rest + pose) down the hierarchy into instance `i` of every part */
export function composeRig(model: Model, root: Matrix4, pose: Float32Array, inst: ModelInstances, i: number): void {
  const W = inst.world;
  for (let p = 0; p < model.n; p++) {
    const o = p * PS;
    _e.set(pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, 'YXZ');
    _q.setFromEuler(_e);
    _v.set(model.rest[p * 3]! + pose[o]!, model.rest[p * 3 + 1]! + pose[o + 1]!, model.rest[p * 3 + 2]! + pose[o + 2]!);
    _s.set(pose[o + 6]!, pose[o + 7]!, pose[o + 8]!);
    _m.compose(_v, _q, _s);
    const par = model.parent[p]!;
    const w = W[p]!;
    w.multiplyMatrices(par < 0 ? root : W[par]!, _m);
    w.toArray(inst.meshes[p]!.instanceMatrix.array as Float32Array, i * 16);
  }
}

export class Spring {
  x = 0;
  v = 0;
  step(target: number, k: number, c: number, dt: number): number {
    const n = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  kick(v: number): void {
    this.v += v;
  }
}
