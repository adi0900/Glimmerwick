/**
 * Voxel sculptor + baker for the micro-voxel creatures and the player avatar.
 *
 * A model is a sparse grid of cells (integer x/y/z, +z = forward, +y = up, symmetric about x = 0) where every cell
 * belongs to one named *part* (body, head, ear, ...). Primitives (ellipsoid / capsule / taper / leaf / box) voxelise
 * with cell-centre tests, so mirrored shapes come out exactly symmetric. Colour rules are palette *slots* + a shade
 * multiplier + an emissive amount (the palette itself lives in the material, so variants are a uniform swap).
 * `bake()` emits one quad per visible voxel face (hidden faces inside a part are dropped, faces between different parts
 * are kept so animated parts never open holes) with per-vertex ambient occlusion computed over the whole model,
 * one BufferGeometry per part, positioned relative to the part pivot so animation = transforms + springs.
 */
import { BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';

export type V3 = [number, number, number];

/** palette slot, shade multiplier (default 1), emissive: 0..1 pulses with the creature's mood, negative = constant. */
export interface Paint {
  s: number;
  h?: number;
  e?: number;
}
export interface PaintCtx {
  /** cell centre */
  x: number;
  y: number;
  z: number;
  /** approximate outward normal */
  nx: number;
  ny: number;
  nz: number;
  /** 0 centre .. 1 surface */
  r: number;
  /** 0..1 along the primitive axis (capsule / taper / leaf) */
  t: number;
  /** local normalised coordinates (ellipsoid: d / radius) */
  lx: number;
  ly: number;
  lz: number;
}
export type PaintSpec = number | Paint | ((c: PaintCtx) => number | Paint | null | undefined);
export interface Vox {
  /** decal-moved cell (eyes): attached to the surface behind it, so prune() keeps it */
  d?: boolean;
  part: number;
  s: number;
  h: number;
  e: number;
}

export const P = (s: number, h = 1, e = 0): Paint => ({ s, h, e });

const OFF = 400;
const SPAN = 800;
const K = (x: number, y: number, z: number): number => ((x + OFF) * SPAN + (y + OFF)) * SPAN + (z + OFF);

export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function resolve(p: PaintSpec, c: PaintCtx): Paint | null {
  const v = typeof p === 'function' ? p(c) : p;
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? { s: v } : v;
}

type M3 = [number, number, number, number, number, number, number, number, number];
/** Rz(c) * Ry(b) * Rx(a) */
function rotM(e: V3): M3 {
  const [a, b, c] = e;
  const ca = Math.cos(a),
    sa = Math.sin(a),
    cb = Math.cos(b),
    sb = Math.sin(b),
    cc = Math.cos(c),
    sc = Math.sin(c);
  return [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa, sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa, -sb, cb * sa, cb * ca];
}
const mulT = (R: M3, x: number, y: number, z: number): V3 => [R[0] * x + R[3] * y + R[6] * z, R[1] * x + R[4] * y + R[7] * z, R[2] * x + R[5] * y + R[8] * z];
const mul = (R: M3, x: number, y: number, z: number): V3 => [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
const norm3 = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

export interface TaperOpts {
  /** thickness factor along the thin axis (1 = round) */
  flat?: number;
  /** the thin direction (world), default +z */
  thin?: V3;
  /** custom radius profile r(t) (replaces ra..rb) */
  profile?: (t: number) => number;
  erase?: boolean;
}

export interface DecalOpts {
  on: string;
  /** move the hit voxel into this part (e.g. eyes); default: recolour in place */
  into?: string;
  /** top-left cell of the pattern in the plane facing `dir` */
  x: number;
  y: number;
  dir?: '+z' | '-z' | '+x' | '-x' | '+y';
  rows: string[];
  legend: Record<string, PaintSpec | null>;
}

const DIRS: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** face table: normal, tangent (u), bitangent (v) with T x B = N -- identical to the voxel world's shader table */
const FACE_T: V3[] = [
  [0, 0, -1],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
];
const FACE_B: V3[] = [
  [0, 1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
  [0, 1, 0],
];

export class Sculpt {
  readonly vox = new Map<number, Vox>();
  private readonly pi = new Map<string, number>();
  constructor(readonly names: string[]) {
    names.forEach((n, i) => this.pi.set(n, i));
  }

  idx(part: string): number {
    const i = this.pi.get(part);
    if (i === undefined) throw new Error(`sculpt: unknown part "${part}"`);
    return i;
  }

  get(x: number, y: number, z: number): Vox | undefined {
    return this.vox.get(K(x, y, z));
  }

  /** place one cell (integer coordinates) */
  put(part: string, x: number, y: number, z: number, paint: PaintSpec): void {
    const c: PaintCtx = { x: x + 0.5, y: y + 0.5, z: z + 0.5, nx: 0, ny: 1, nz: 0, r: 0, t: 0, lx: 0, ly: 0, lz: 0 };
    const p = resolve(paint, c);
    if (p) this.vox.set(K(x, y, z), { part: this.idx(part), s: p.s, h: p.h ?? 1, e: p.e ?? 0 });
  }

  private fill(part: string, lo: V3, hi: V3, test: (x: number, y: number, z: number) => PaintCtx | null, paint: PaintSpec, erase: boolean): void {
    const pi = erase ? -1 : this.idx(part);
    for (let x = Math.floor(lo[0]); x <= Math.ceil(hi[0]); x++)
      for (let y = Math.floor(lo[1]); y <= Math.ceil(hi[1]); y++)
        for (let z = Math.floor(lo[2]); z <= Math.ceil(hi[2]); z++) {
          const c = test(x + 0.5, y + 0.5, z + 0.5);
          if (!c) continue;
          if (erase) {
            this.vox.delete(K(x, y, z));
            continue;
          }
          const p = resolve(paint, c);
          if (p) this.vox.set(K(x, y, z), { part: pi, s: p.s, h: p.h ?? 1, e: p.e ?? 0 });
        }
  }

  /** (super)ellipsoid; `n` > 2 squares it off, `rot` tilts it (radians, Rz*Ry*Rx) */
  ellipsoid(part: string, c: V3, r: V3, paint: PaintSpec, o: { n?: number; rot?: V3; erase?: boolean } = {}): void {
    const n = o.n ?? 2;
    const R = o.rot ? rotM(o.rot) : null;
    const m = Math.max(r[0], r[1], r[2]) + 1;
    const lo: V3 = R ? [c[0] - m, c[1] - m, c[2] - m] : [c[0] - r[0] - 1, c[1] - r[1] - 1, c[2] - r[2] - 1];
    const hi: V3 = R ? [c[0] + m, c[1] + m, c[2] + m] : [c[0] + r[0] + 1, c[1] + r[1] + 1, c[2] + r[2] + 1];
    this.fill(
      part,
      lo,
      hi,
      (x, y, z) => {
        let dx = x - c[0],
          dy = y - c[1],
          dz = z - c[2];
        if (R) [dx, dy, dz] = mulT(R, dx, dy, dz);
        const a = dx / r[0],
          b = dy / r[1],
          d = dz / r[2];
        const q = n === 2 ? a * a + b * b + d * d : Math.abs(a) ** n + Math.abs(b) ** n + Math.abs(d) ** n;
        if (q > 1) return null;
        let g = norm3(dx / (r[0] * r[0]), dy / (r[1] * r[1]), dz / (r[2] * r[2]));
        if (R) g = mul(R, g[0], g[1], g[2]);
        return { x, y, z, nx: g[0], ny: g[1], nz: g[2], r: q ** (1 / n), t: 0, lx: a, ly: b, lz: d };
      },
      paint,
      !!o.erase,
    );
  }

  /** round-ended tapered tube from a to b */
  capsule(part: string, a: V3, b: V3, ra: number, rb: number, paint: PaintSpec, o: { erase?: boolean } = {}): void {
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-6;
    const m = Math.max(ra, rb) + 1;
    this.fill(
      part,
      [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.min(a[2], b[2]) - m],
      [Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, Math.max(a[2], b[2]) + m],
      (x, y, z) => {
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / L2));
        const dx = x - (a[0] + ab[0] * t),
          dy = y - (a[1] + ab[1] * t),
          dz = z - (a[2] + ab[2] * t);
        const rr = ra + (rb - ra) * t;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rr * rr) return null;
        const g = d2 > 1e-6 ? norm3(dx, dy, dz) : norm3(ab[0], ab[1], ab[2]);
        return { x, y, z, nx: g[0], ny: g[1], nz: g[2], r: Math.sqrt(d2) / rr, t, lx: dx / rr, ly: dy / rr, lz: dz / rr };
      },
      paint,
      !!o.erase,
    );
  }

  /** flat-ended taper with an elliptical section (ears, leaves, fins); `profile` replaces the linear radius */
  taper(part: string, a: V3, b: V3, ra: number, rb: number, paint: PaintSpec, o: TaperOpts = {}): void {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1e-6;
    const u = norm3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const f = o.thin ?? [0, 0, 1];
    const fu = f[0] * u[0] + f[1] * u[1] + f[2] * u[2];
    let e2 = norm3(f[0] - fu * u[0], f[1] - fu * u[1], f[2] - fu * u[2]);
    if (Math.abs(fu) > 0.999) e2 = norm3(1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2]);
    const e1: V3 = [u[1] * e2[2] - u[2] * e2[1], u[2] * e2[0] - u[0] * e2[2], u[0] * e2[1] - u[1] * e2[0]];
    const k = o.flat ?? 1;
    const rf = o.profile ?? ((t: number) => ra + (rb - ra) * t);
    let mr = 0;
    for (let i = 0; i <= 12; i++) mr = Math.max(mr, rf(i / 12));
    const m = mr + 1;
    this.fill(
      part,
      [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.min(a[2], b[2]) - m],
      [Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, Math.max(a[2], b[2]) + m],
      (x, y, z) => {
        const dx = x - a[0],
          dy = y - a[1],
          dz = z - a[2];
        const al = dx * u[0] + dy * u[1] + dz * u[2];
        const t = al / L;
        if (t < 0 || t > 1) return null;
        const r0 = rf(t);
        if (r0 <= 0.05) return null;
        // never thinner than one voxel in-plane / out-of-plane, so pointed tips stay connected
        const r = Math.max(r0, 0.8);
        const th = Math.max(r * k, 0.62);
        const qx = dx - u[0] * al,
          qy = dy - u[1] * al,
          qz = dz - u[2] * al;
        const q1 = qx * e1[0] + qy * e1[1] + qz * e1[2];
        const q2 = qx * e2[0] + qy * e2[1] + qz * e2[2];
        const v = (q1 / r) ** 2 + (q2 / th) ** 2;
        if (v > 1) return null;
        const g = norm3(e1[0] * (q1 / (r * r)) + e2[0] * (q2 / (th * th)), e1[1] * (q1 / (r * r)) + e2[1] * (q2 / (th * th)), e1[2] * (q1 / (r * r)) + e2[2] * (q2 / (th * th)));
        return { x, y, z, nx: g[0], ny: g[1], nz: g[2], r: Math.sqrt(v), t, lx: q1 / r, ly: q2 / th, lz: t * 2 - 1 };
      },
      paint,
      !!o.erase,
    );
  }

  /** leaf / petal: widest ~40 % along the axis, pointed at both ends */
  leaf(part: string, a: V3, b: V3, width: number, thin: V3, paint: PaintSpec, flat = 0.4): void {
    this.taper(part, a, b, width, width, paint, { flat, thin, profile: (t) => width * Math.sin(Math.PI * t ** 0.7) });
  }

  box(part: string, c: V3, s: V3, paint: PaintSpec, o: { round?: number; erase?: boolean } = {}): void {
    const hx = s[0] / 2,
      hy = s[1] / 2,
      hz = s[2] / 2;
    const rr = o.round ?? 0;
    this.fill(
      part,
      [c[0] - hx - 1, c[1] - hy - 1, c[2] - hz - 1],
      [c[0] + hx + 1, c[1] + hy + 1, c[2] + hz + 1],
      (x, y, z) => {
        const dx = Math.abs(x - c[0]),
          dy = Math.abs(y - c[1]),
          dz = Math.abs(z - c[2]);
        if (dx > hx || dy > hy || dz > hz) return null;
        if (rr > 0) {
          const qx = Math.max(dx - (hx - rr), 0),
            qy = Math.max(dy - (hy - rr), 0),
            qz = Math.max(dz - (hz - rr), 0);
          if (qx * qx + qy * qy + qz * qz > rr * rr) return null;
        }
        const ax = dx / hx,
          ay = dy / hy,
          az = dz / hz;
        let nx = 0,
          ny = 0,
          nz = 0;
        if (ax >= ay && ax >= az) nx = Math.sign(x - c[0]);
        else if (ay >= az) ny = Math.sign(y - c[1]);
        else nz = Math.sign(z - c[2]);
        return { x, y, z, nx, ny, nz, r: Math.max(ax, ay, az), t: 0, lx: (x - c[0]) / hx, ly: (y - c[1]) / hy, lz: (z - c[2]) / hz };
      },
      paint,
      !!o.erase,
    );
  }

  bounds(): { min: V3; max: V3 } {
    const min: V3 = [1e9, 1e9, 1e9];
    const max: V3 = [-1e9, -1e9, -1e9];
    for (const k of this.vox.keys()) {
      const z = (k % SPAN) - OFF;
      const y = (Math.floor(k / SPAN) % SPAN) - OFF;
      const x = Math.floor(k / (SPAN * SPAN)) - OFF;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
    return { min, max };
  }

  /**
   * Stamp a character pattern onto the surface of part `on` seen from `dir` (rows top->bottom, columns left->right as
   * seen by a viewer outside). The first voxel of `on` along the ray is recoloured; with `into` it also changes part
   * (so eyes blink independently while the head keeps its surface layer underneath).
   */
  decal(o: DecalOpts): void {
    const on = this.idx(o.on);
    const into = o.into !== undefined ? this.idx(o.into) : on;
    const dir = o.dir ?? '+z';
    const B = this.bounds();
    for (let r = 0; r < o.rows.length; r++) {
      const row = o.rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const spec = o.legend[row[c]!];
        if (spec === undefined || spec === null) continue;
        let hit = -1;
        let hx = 0,
          hy = 0,
          hz = 0;
        const test = (x: number, y: number, z: number): boolean => {
          const v = this.vox.get(K(x, y, z));
          if (v && v.part === on) {
            hit = K(x, y, z);
            hx = x;
            hy = y;
            hz = z;
            return true;
          }
          return false;
        };
        if (dir === '+z') {
          for (let z = B.max[2]; z >= B.min[2]; z--) if (test(o.x + c, o.y - r, z)) break;
        } else if (dir === '-z') {
          for (let z = B.min[2]; z <= B.max[2]; z++) if (test(o.x - c, o.y - r, z)) break;
        } else if (dir === '+x') {
          for (let x = B.max[0]; x >= B.min[0]; x--) if (test(x, o.y - r, o.x - c)) break;
        } else if (dir === '-x') {
          for (let x = B.min[0]; x <= B.max[0]; x++) if (test(x, o.y - r, o.x + c)) break;
        } else {
          for (let y = B.max[1]; y >= B.min[1]; y--) if (test(o.x + c, y, o.y - r)) break;
        }
        if (hit < 0) continue;
        const p = resolve(spec, { x: hx + 0.5, y: hy + 0.5, z: hz + 0.5, nx: 0, ny: 0, nz: 1, r: 1, t: 0, lx: 0, ly: 0, lz: 0 });
        if (p) this.vox.set(hit, { part: into, s: p.s, h: p.h ?? 1, e: p.e ?? 0, d: o.into !== undefined });
      }
    }
  }

  /** recolour surface voxels (those with an empty 6-neighbour); `fn` gets the cell, a coarse normal and the voxel */
  recolor(parts: string[] | null, fn: (c: { x: number; y: number; z: number; nx: number; ny: number; nz: number; v: Vox }) => Paint | number | null | undefined): void {
    const only = parts ? new Set(parts.map((p) => this.idx(p))) : null;
    const ups: [number, Vox][] = [];
    for (const [k, v] of this.vox) {
      if (only && !only.has(v.part)) continue;
      const z = (k % SPAN) - OFF;
      const y = (Math.floor(k / SPAN) % SPAN) - OFF;
      const x = Math.floor(k / (SPAN * SPAN)) - OFF;
      let nx = 0,
        ny = 0,
        nz = 0;
      for (const d of DIRS) if (!this.vox.has(K(x + d[0], y + d[1], z + d[2]))) {
        nx += d[0];
        ny += d[1];
        nz += d[2];
      }
      if (nx === 0 && ny === 0 && nz === 0) {
        // interior or perfectly enclosed
        let open = false;
        for (const d of DIRS) if (!this.vox.has(K(x + d[0], y + d[1], z + d[2]))) open = true;
        if (!open) continue;
      }
      const n = norm3(nx, ny, nz);
      const res = fn({ x: x + 0.5, y: y + 0.5, z: z + 0.5, nx: n[0], ny: n[1], nz: n[2], v });
      if (res === null || res === undefined) continue;
      const p: Paint = typeof res === 'number' ? { s: res } : res;
      ups.push([k, { part: v.part, s: p.s, h: p.h ?? 1, e: p.e ?? 0 }]);
    }
    for (const [k, v] of ups) this.vox.set(k, v);
  }

  /** recolour the top-most voxel of part in column (x,z) */
  topCell(part: string, x: number, z: number, paint: PaintSpec): void {
    const pi = this.idx(part);
    const B = this.bounds();
    for (let y = B.max[1]; y >= B.min[1]; y--) {
      const v = this.vox.get(K(x, y, z));
      if (v && v.part === pi) {
        const p = resolve(paint, { x: x + 0.5, y: y + 0.5, z: z + 0.5, nx: 0, ny: 1, nz: 0, r: 1, t: 0, lx: 0, ly: 0, lz: 0 });
        if (p) this.vox.set(K(x, y, z), { part: pi, s: p.s, h: p.h ?? 1, e: p.e ?? 0 });
        return;
      }
    }
  }

  /** drop single floating cells (no 6-neighbour of the same part) left by thin primitives */
  prune(): void {
    for (const [k, v] of [...this.vox]) {
      const z = (k % SPAN) - OFF;
      const y = (Math.floor(k / SPAN) % SPAN) - OFF;
      const x = Math.floor(k / (SPAN * SPAN)) - OFF;
      let n = 0,
        m = 0;
      for (const d of DIRS) {
        const w = this.vox.get(K(x + d[0], y + d[1], z + d[2]));
        if (w) {
          m++;
          if (w.part === v.part) n++;
        }
      }
      if (n === 0 && !(v.d && m > 0)) this.vox.delete(k);
    }
  }
}

export interface BakedPart {
  name: string;
  geo: BufferGeometry;
  voxels: number;
  faces: number;
}
export interface BakedModel {
  parts: BakedPart[];
  voxels: number;
  faces: number;
  min: V3;
  max: V3;
}

/** one quad per visible voxel face; geometry is in metres relative to each part's pivot (voxel units * vs) */
export function bake(sc: Sculpt, pivots: V3[], vs: number): BakedModel {
  const n = sc.names.length;
  const acc = Array.from({ length: n }, () => ({ pos: [] as number[], nor: [] as number[], uv: [] as number[], vox: [] as number[], face: [] as number[], idx: [] as number[], voxels: 0, faces: 0 }));
  const solid = (x: number, y: number, z: number): number => (sc.vox.has(K(x, y, z)) ? 1 : 0);
  const B = sc.bounds();
  for (const [k, v] of sc.vox) {
    const z = (k % SPAN) - OFF;
    const y = (Math.floor(k / SPAN) % SPAN) - OFF;
    const x = Math.floor(k / (SPAN * SPAN)) - OFF;
    const a = acc[v.part]!;
    const pv = pivots[v.part]!;
    a.voxels++;
    for (let f = 0; f < 6; f++) {
      const N = DIRS[f]!;
      const nb = sc.vox.get(K(x + N[0], y + N[1], z + N[2]));
      if (nb && nb.part === v.part) continue;
      const T = FACE_T[f]!;
      const Bv = FACE_B[f]!;
      const cx = x + 0.5 + N[0] * 0.5,
        cy = y + 0.5 + N[1] * 0.5,
        cz = z + 0.5 + N[2] * 0.5;
      const ao: number[] = [];
      const base = a.pos.length / 3;
      for (let c = 0; c < 4; c++) {
        const u = c === 1 || c === 2 ? 1 : 0;
        const w = c >= 2 ? 1 : 0;
        const su = u ? 1 : -1,
          sv = w ? 1 : -1;
        const px = cx + (u - 0.5) * T[0] + (w - 0.5) * Bv[0];
        const py = cy + (u - 0.5) * T[1] + (w - 0.5) * Bv[1];
        const pz = cz + (u - 0.5) * T[2] + (w - 0.5) * Bv[2];
        const bx = x + N[0],
          by = y + N[1],
          bz = z + N[2];
        const s1 = solid(bx + su * T[0], by + su * T[1], bz + su * T[2]);
        const s2 = solid(bx + sv * Bv[0], by + sv * Bv[1], bz + sv * Bv[2]);
        const s3 = solid(bx + su * T[0] + sv * Bv[0], by + su * T[1] + sv * Bv[1], bz + su * T[2] + sv * Bv[2]);
        const av = s1 && s2 ? 0 : 3 - (s1 + s2 + s3);
        ao.push(av / 3);
        a.pos.push((px - pv[0]) * vs, (py - pv[1]) * vs, (pz - pv[2]) * vs);
        a.nor.push(N[0], N[1], N[2]);
        a.uv.push(u, w);
        a.vox.push(v.s, v.h, av / 3, v.e);
        a.face.push(f);
      }
      if (ao[0]! + ao[2]! > ao[1]! + ao[3]!) a.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else a.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      a.faces++;
    }
  }
  const parts: BakedPart[] = [];
  let voxels = 0,
    faces = 0;
  for (let i = 0; i < n; i++) {
    const a = acc[i]!;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(a.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(a.nor, 3));
    geo.setAttribute('aUv', new Float32BufferAttribute(a.uv, 2));
    geo.setAttribute('aVox', new Float32BufferAttribute(a.vox, 4));
    geo.setAttribute('aFace', new Float32BufferAttribute(a.face, 1));
    geo.setIndex(a.pos.length / 3 > 65535 ? new Uint32BufferAttribute(a.idx, 1) : new Uint16BufferAttribute(a.idx, 1));
    geo.computeBoundingSphere();
    parts.push({ name: sc.names[i]!, geo, voxels: a.voxels, faces: a.faces });
    voxels += a.voxels;
    faces += a.faces;
  }
  return { parts, voxels, faces, min: B.min, max: B.max };
}
