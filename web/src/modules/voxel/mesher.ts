/**
 * Voxel mesher (JS, culled faces; documented choice: the sim publishes block ids, meshing is done here so edits remesh
 * only the touched regions and the GPU layout can evolve without touching wasm).
 *
 * A *region* is 2 x 2 chunks = 32 x 32 columns x all layers. For each region the mesher copies the block columns (+ a
 * 1-column border from the neighbours, clamped at the world edge) into a padded array and emits
 *   - opaque faces with per-vertex AO (4-neighbour rule + quad flip) and a cheap skylight (column sky height),
 *   - water top / waterfall faces with per-vertex depth + shore foam.
 * Vertex format (solid): position f32x3 (region-local), normal i8x3, aTF u16 (tile * 8 + face), aLight u8x4 (ao, sky,
 * glow, -), aSway u8 (leaf wind weight). The corner (u, v) of a quad comes from `gl_VertexID & 3` in the shader.
 */
export interface VoxInfo {
  nx: number;
  ny: number;
  nz: number;
  chunk: number;
  ncx: number;
  ncz: number;
  seaY: number;
  /** world coords of layer 0 / column 0 min corner */
  originX: number;
  originY: number;
  originZ: number;
}

export const FL = { SOLID: 1, OPAQUE: 2, LIQUID: 4, FOLIAGE: 8, GLOW: 16, PLANT: 32 } as const;
export const REGION = 32;
const R = REGION;
const P = R + 2;
const WATER_DROP = 0.12;

export interface SolidMesh {
  vcount: number;
  pos: Float32Array;
  nrm: Int8Array;
  tf: Uint16Array;
  light: Uint8Array;
  sway: Uint8Array;
  idx: Uint32Array;
}

export interface WaterMesh {
  vcount: number;
  pos: Float32Array;
  aw: Float32Array;
  idx: Uint32Array;
}

// face tables: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z
const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FT = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FB = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
const FBASE = [[1, 0, 1], [0, 0, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1], [1, 0, 0]];
const CU = [0, 1, 1, 0];
const CV = [0, 0, 1, 1];

export class Mesher {
  private readonly col: Uint16Array;
  private readonly light: Uint8Array;
  private readonly wtop: Int16Array;
  private readonly wdep: Uint8Array;
  private readonly opq = new Uint8Array(65536);
  private readonly dN = new Int32Array(6);
  private readonly dT = new Int32Array(6);
  private readonly dB = new Int32Array(6);
  // growable scratch
  private cap = 1 << 16;
  private pos = new Float32Array(this.cap * 3);
  private nrm = new Int8Array(this.cap * 3);
  private tf = new Uint16Array(this.cap);
  private lt = new Uint8Array(this.cap * 4);
  private sw = new Uint8Array(this.cap);
  private idx = new Uint32Array((this.cap / 4) * 6);
  private nv = 0;
  private ni = 0;
  private wcap = 1 << 14;
  private wpos = new Float32Array(this.wcap * 3);
  private waw = new Float32Array(this.wcap * 2);
  private widx = new Uint32Array((this.wcap / 4) * 6);
  private wnv = 0;
  private wni = 0;

  constructor(
    readonly info: VoxInfo,
    private readonly flags: Uint8Array,
    /** [block * 3 + (0 top | 1 side | 2 bottom)] -> atlas layer */
    private readonly tiles: Uint16Array,
    private readonly waterId: number,
  ) {
    const ny = info.ny;
    this.col = new Uint16Array(P * P * ny);
    this.light = new Uint8Array(P * P * ny);
    this.wtop = new Int16Array(P * P);
    this.wdep = new Uint8Array(P * P);
    for (let i = 0; i < flags.length; i++) this.opq[i] = flags[i]! & FL.OPAQUE ? 1 : 0;
    for (let f = 0; f < 6; f++) {
      const d = (v: number[]): number => v[0]! * ny + v[2]! * P * ny + v[1]!;
      this.dN[f] = d(FN[f]!);
      this.dT[f] = d(FT[f]!);
      this.dB[f] = d(FB[f]!);
    }
  }

  private growSolid(): void {
    this.cap *= 2;
    const g = <T extends Float32Array | Int8Array | Uint16Array | Uint8Array | Uint32Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, this.cap * 3);
    this.nrm = g(this.nrm, this.cap * 3);
    this.tf = g(this.tf, this.cap);
    this.lt = g(this.lt, this.cap * 4);
    this.sw = g(this.sw, this.cap);
    this.idx = g(this.idx, (this.cap / 4) * 6);
  }

  private growWater(): void {
    this.wcap *= 2;
    const g = <T extends Float32Array | Uint32Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.wpos = g(this.wpos, this.wcap * 3);
    this.waw = g(this.waw, this.wcap * 2);
    this.widx = g(this.widx, (this.wcap / 4) * 6);
  }

  /** Meshes region `(rx, rz)`; returns null meshes where nothing is visible. */
  meshRegion(blocks: Uint16Array, chunks: Uint32Array, rx: number, rz: number): { solid: SolidMesh | null; water: WaterMesh | null } {
    const { info, flags, tiles, opq, col, light, wtop, wdep, dN, dT, dB } = this;
    const ny = info.ny;
    const cells = info.chunk * info.chunk * ny;
    const x0 = rx * R;
    const z0 = rz * R;
    this.nv = this.ni = this.wnv = this.wni = 0;

    // ---- gather the padded columns + sky height + water columns
    for (let pz = 0; pz < P; pz++) {
      const gz = Math.min(Math.max(z0 + pz - 1, 0), info.nz - 1);
      for (let px = 0; px < P; px++) {
        const gx = Math.min(Math.max(x0 + px - 1, 0), info.nx - 1);
        const off = ((gz >> 4) * info.ncx + (gx >> 4)) * cells + (((gz & 15) << 4) + (gx & 15)) * ny;
        const base = (pz * P + px) * ny;
        col.set(blocks.subarray(off, off + ny), base);
        let h = ny;
        while (h > 0 && !opq[col[base + h - 1]!]) h--;
        for (let y = 0; y < ny; y++) light[base + y] = y >= h ? 255 : Math.max(96, 255 - (h - y) * 22);
        let wt = -1;
        let dep = 0;
        for (let y = ny - 2; y > 0; y--) {
          if (col[base + y] === this.waterId) {
            wt = y;
            while (y >= 0 && col[base + y] === this.waterId) {
              dep++;
              y--;
            }
            break;
          }
        }
        wtop[pz * P + px] = wt;
        wdep[pz * P + px] = Math.min(dep, 255);
      }
    }
    let maxY = 1;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) maxY = Math.max(maxY, chunks[((rz * 2 + j) * info.ncx + rx * 2 + i) * 2 + 1]!);
    maxY = Math.min(maxY + 1, ny - 1);

    for (let pz = 1; pz <= R; pz++) {
      for (let px = 1; px <= R; px++) {
        const base = (pz * P + px) * ny;
        const cx = px - 1;
        const cz = pz - 1;
        for (let y = 0; y < maxY; y++) {
          const b = col[base + y]!;
          if (b === 0) continue;
          const fl = flags[b]!;
          if (fl & FL.OPAQUE) {
            const sway = fl & FL.FOLIAGE ? 255 : 0;
            const glow = fl & FL.GLOW ? 255 : 0;
            for (let f = 0; f < 6; f++) {
              if (f === 3 && y === 0) continue;
              const front = base + y + dN[f]!;
              if (opq[col[front]!]) continue;
              this.solidQuad(f, cx, y, cz, front, tiles[b * 3 + (f === 2 ? 0 : f === 3 ? 2 : 1)]!, sway, glow);
            }
          } else if (fl & FL.LIQUID) {
            const above = col[base + y + 1]!;
            if (above !== b && !opq[above]) this.waterTop(cx, y, cz);
            for (let f of [0, 1, 4, 5]) {
              if (col[base + y + dN[f]!] === 0) this.waterSide(f, cx, y, cz, above === b ? 1 : 1 - WATER_DROP);
            }
          }
        }
      }
    }

    let solid: SolidMesh | null = null;
    if (this.ni > 0) {
      solid = {
        vcount: this.nv,
        pos: this.pos.slice(0, this.nv * 3),
        nrm: this.nrm.slice(0, this.nv * 3),
        tf: this.tf.slice(0, this.nv),
        light: this.lt.slice(0, this.nv * 4),
        sway: this.sw.slice(0, this.nv),
        idx: this.idx.slice(0, this.ni),
      };
    }
    let water: WaterMesh | null = null;
    if (this.wni > 0) water = { vcount: this.wnv, pos: this.wpos.slice(0, this.wnv * 3), aw: this.waw.slice(0, this.wnv * 2), idx: this.widx.slice(0, this.wni) };
    return { solid, water };
  }

  private solidQuad(f: number, cx: number, y: number, cz: number, front: number, tile: number, sway: number, glow: number): void {
    if (this.nv + 4 > this.cap) this.growSolid();
    const { col, light, opq, dT, dB } = this;
    const N = FN[f]!;
    const T = FT[f]!;
    const B = FB[f]!;
    const bs = FBASE[f]!;
    const fx = cx + bs[0]!;
    const fy = y + bs[1]!;
    const fz = cz + bs[2]!;
    const ao = [0, 0, 0, 0];
    const v0 = this.nv;
    for (let c = 0; c < 4; c++) {
      const u = CU[c]!;
      const v = CV[c]!;
      const sT = u ? dT[f]! : -dT[f]!;
      const sB = v ? dB[f]! : -dB[f]!;
      const i1 = front + sT;
      const i2 = front + sB;
      const i3 = front + sT + sB;
      const o1 = opq[col[i1]!]!;
      const o2 = opq[col[i2]!]!;
      const o3 = opq[col[i3]!]!;
      const a = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
      ao[c] = a;
      let ls = light[front]!;
      let ln = 1;
      if (!o1) {
        ls += light[i1]!;
        ln++;
      }
      if (!o2) {
        ls += light[i2]!;
        ln++;
      }
      if (!o3) {
        ls += light[i3]!;
        ln++;
      }
      const i = v0 + c;
      this.pos[i * 3] = fx + u * T[0]! + v * B[0]!;
      this.pos[i * 3 + 1] = fy + u * T[1]! + v * B[1]!;
      this.pos[i * 3 + 2] = fz + u * T[2]! + v * B[2]!;
      this.nrm[i * 3] = N[0]! * 127;
      this.nrm[i * 3 + 1] = N[1]! * 127;
      this.nrm[i * 3 + 2] = N[2]! * 127;
      this.tf[i] = tile * 8 + f;
      this.lt[i * 4] = (a * 255) / 3;
      this.lt[i * 4 + 1] = ls / ln;
      this.lt[i * 4 + 2] = glow;
      this.lt[i * 4 + 3] = 255;
      this.sw[i] = sway;
    }
    const flip = ao[0]! + ao[2]! > ao[1]! + ao[3]!;
    const k = this.ni;
    if (!flip) {
      this.idx[k] = v0;
      this.idx[k + 1] = v0 + 1;
      this.idx[k + 2] = v0 + 2;
      this.idx[k + 3] = v0;
      this.idx[k + 4] = v0 + 2;
      this.idx[k + 5] = v0 + 3;
    } else {
      this.idx[k] = v0 + 1;
      this.idx[k + 1] = v0 + 2;
      this.idx[k + 2] = v0 + 3;
      this.idx[k + 3] = v0 + 1;
      this.idx[k + 4] = v0 + 3;
      this.idx[k + 5] = v0;
    }
    this.ni += 6;
    this.nv += 4;
  }

  private waterVert(i: number, x: number, y: number, z: number, depth: number, foam: number): void {
    this.wpos[i * 3] = x;
    this.wpos[i * 3 + 1] = y;
    this.wpos[i * 3 + 2] = z;
    this.waw[i * 2] = depth;
    this.waw[i * 2 + 1] = foam;
  }

  private waterIdx(): void {
    const v0 = this.wnv;
    const k = this.wni;
    const w = this.widx;
    w[k] = v0;
    w[k + 1] = v0 + 1;
    w[k + 2] = v0 + 2;
    w[k + 3] = v0;
    w[k + 4] = v0 + 2;
    w[k + 5] = v0 + 3;
    this.wni += 6;
    this.wnv += 4;
  }

  private waterTop(cx: number, y: number, cz: number): void {
    if (this.wnv + 4 > this.wcap) this.growWater();
    const { wtop, wdep } = this;
    for (let c = 0; c < 4; c++) {
      const u = CU[c]!;
      const v = CV[c]!;
      const X = cx + u;
      const Z = cz + 1 - v;
      const a = Z * P + X;
      const dep = (wdep[a]! + wdep[a + 1]! + wdep[a + P]! + wdep[a + P + 1]!) / 4;
      const wet = (wtop[a]! >= 0 ? 1 : 0) + (wtop[a + 1]! >= 0 ? 1 : 0) + (wtop[a + P]! >= 0 ? 1 : 0) + (wtop[a + P + 1]! >= 0 ? 1 : 0);
      this.waterVert(this.wnv + c, X, y + 1 - WATER_DROP, Z, dep, 1 - wet / 4);
    }
    this.waterIdx();
  }

  private waterSide(f: number, cx: number, y: number, cz: number, h: number): void {
    if (this.wnv + 4 > this.wcap) this.growWater();
    const T = FT[f]!;
    const B = FB[f]!;
    const bs = FBASE[f]!;
    for (let c = 0; c < 4; c++) {
      const u = CU[c]!;
      const v = CV[c]!;
      this.waterVert(this.wnv + c, cx + bs[0]! + u * T[0]!, y + v * h, cz + bs[2]! + u * T[2]!, 0.3 + (1 - v) * 0.3, 0.7);
    }
    void B;
    this.waterIdx();
  }
}
