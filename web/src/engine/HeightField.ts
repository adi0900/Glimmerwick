/**
 * Terrain helper over the `world.height` (f32 grid) / `world.biome` (u8 grid) channels and `query("world.info")`.
 * Same code path for the wasm sim and for MockGame. Row-major: index = iz * nx + ix.
 * Returns neutral values (0 / false) until the world exists, so modules can call it unconditionally.
 */
import { Vector3 } from 'three';
import type { Bridge } from './Bridge';

export interface WorldInfo {
  size_x: number;
  size_z: number;
  cell: number;
  origin_x: number;
  origin_z: number;
  sea_level: number;
  chunk: number;
  spawn?: { player?: [number, number]; village?: [number, number] };
  habitats?: Record<string, number[][]>;
  [k: string]: any;
}

export class HeightField {
  private _info: WorldInfo | null = null;
  private _infoVer = -1;
  /** grid dimensions (vertices per side) */
  nx = 0;
  nz = 0;
  /** true when samples sit at cell centres (origin + (i + 0.5) * cell) rather than on lattice corners */
  centered = false;

  constructor(private readonly bridge: Bridge) {}

  /** true once `world.height` + `world.info` are available */
  get ready(): boolean {
    return this.info !== null && this.bridge.has('world.height') && this.bridge.channel('world.height').len > 0;
  }

  /** cached `world.info` (refetched when the height channel's version bumps) */
  get info(): WorldInfo | null {
    if (!this.bridge.has('world.height')) return null;
    const v = this.bridge.channel('world.height').ver;
    if (this._info === null || v !== this._infoVer) {
      const info = this.bridge.query('world.info') as WorldInfo | null;
      this._info = info && typeof info === 'object' && !(info as any).error ? info : null;
      this._infoVer = v;
      if (this._info) this.layout();
    }
    return this._info;
  }

  get version(): number {
    return this.bridge.has('world.height') ? this.bridge.channel('world.height').ver : 0;
  }

  get seaLevel(): number {
    return this.info?.sea_level ?? 0;
  }

  get cell(): number {
    return this.info?.cell ?? 1;
  }

  get originX(): number {
    return this.info?.origin_x ?? 0;
  }

  get originZ(): number {
    return this.info?.origin_z ?? 0;
  }

  /** metres spanned by the samples along x (vertex sampling: (nx - 1) * cell) */
  get extentX(): number {
    return this.info ? (this.nx - (this.centered ? 0 : 1)) * this.cell : 0;
  }

  /** metres spanned by the samples along z */
  get extentZ(): number {
    return this.info ? (this.nz - (this.centered ? 0 : 1)) * this.cell : 0;
  }

  /** live height array (re-read every frame; may be replaced when memory grows) */
  get data(): Float32Array {
    return this.bridge.channel('world.height').data;
  }

  /** live biome array (u8) */
  get biomes(): Uint8Array {
    return this.bridge.channel<Uint8Array>('world.biome').data;
  }

  private layout(): void {
    const i = this._info!;
    const len = this.bridge.channel('world.height').len;
    const cell = i.cell || 1;
    const sx = Math.round(i.size_x);
    const sz = Math.round(i.size_z);
    const a = Math.round(i.size_x / cell);
    const b = Math.round(i.size_z / cell);
    // `world.info.sample`: "vertex" (default) = samples on the lattice origin + i*cell; "cell" = at cell centres
    const sample = String(i.sample ?? 'vertex');
    this.centered = sample === 'cell' || sample === 'center' || sample === 'centre';
    if (sx * sz === len) {
      // size_x/size_z are sample counts (docs/BRIDGE_API.md: heights[z * size_x + x])
      this.nx = sx;
      this.nz = sz;
    } else if (a * b === len) {
      this.nx = a;
      this.nz = b;
    } else if ((a + 1) * (b + 1) === len) {
      this.nx = a + 1;
      this.nz = b + 1;
    } else {
      this.nx = this.nz = Math.round(Math.sqrt(len));
    }
  }

  /** bilinear terrain height (m) at world x,z, clamped to the grid edge */
  sample(x: number, z: number): number {
    const info = this.info;
    if (!info) return 0;
    const h = this.data;
    const cell = info.cell || 1;
    const off = this.centered ? 0.5 : 0;
    let fx = (x - info.origin_x) / cell - off;
    let fz = (z - info.origin_z) / cell - off;
    const mx = this.nx - 1;
    const mz = this.nz - 1;
    fx = fx < 0 ? 0 : fx > mx ? mx : fx;
    fz = fz < 0 ? 0 : fz > mz ? mz : fz;
    const ix = Math.min(Math.floor(fx), Math.max(mx - 1, 0));
    const iz = Math.min(Math.floor(fz), Math.max(mz - 1, 0));
    const tx = fx - ix;
    const tz = fz - iz;
    const i00 = iz * this.nx + ix;
    const h00 = h[i00]!;
    const h10 = h[i00 + (ix < mx ? 1 : 0)]!;
    const h01 = h[i00 + (iz < mz ? this.nx : 0)]!;
    const h11 = h[i00 + (ix < mx ? 1 : 0) + (iz < mz ? this.nx : 0)]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** terrain normal (unit) via central differences */
  normal(x: number, z: number, out = new Vector3()): Vector3 {
    const e = Math.max(this.cell, 0.25);
    const dx = this.sample(x + e, z) - this.sample(x - e, z);
    const dz = this.sample(x, z + e) - this.sample(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** nearest biome id at world x,z (0 when unknown) */
  biomeAt(x: number, z: number): number {
    const info = this.info;
    if (!info || !this.bridge.has('world.biome')) return 0;
    const b = this.biomes;
    const cell = info.cell || 1;
    const off = this.centered ? 0.5 : 0;
    const ix = Math.round((x - info.origin_x) / cell - off);
    const iz = Math.round((z - info.origin_z) / cell - off);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return 0;
    return b[iz * this.nx + ix] ?? 0;
  }

  /** metres of water above the terrain at x,z (0 on land) */
  waterDepthAt(x: number, z: number): number {
    return Math.max(0, this.seaLevel - this.sample(x, z));
  }
}
