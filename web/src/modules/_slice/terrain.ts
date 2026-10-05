/**
 * PLACEHOLDER terrain for the reference slice: one lit mesh from `world.height`, painted by biome/height/slope.
 * The real terrain (chunks, LOD, splat shader, skirts) belongs to the `world` module.
 */
import { BufferAttribute, BufferGeometry, Color, Mesh } from 'three';
import type { HeightField } from '../../engine/HeightField';
import type { Materials } from '../../engine/Materials';

const C = (hex: string) => new Color(hex);
const PAL = {
  sand: C('#F6E2B3'),
  wetSand: C('#D9B98A'),
  seabedShallow: C('#E8CE96'),
  seabedDeep: C('#3F86A6'),
  meadowLight: C('#9BE564'),
  meadowMid: C('#5CC95A'),
  meadowShadow: C('#2E9E6B'),
  dryGrass: C('#D6E063'),
  forest: C('#3E8E5A'),
  highland: C('#8FD65A'),
  cliffWarm: C('#C9A98C'),
  rockLav: C('#B8A9C9'),
  path: C('#D2AE80'),
  mud: C('#A58B5E'),
  clearing: C('#B5D66B'),
  clearingDirt: C('#C9B27C'),
  snow: C('#F4FFFB'),
};

function hash(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number): number {
  return vnoise(x, z) * 0.55 + vnoise(x * 2.3 + 7, z * 2.3 + 3) * 0.3 + vnoise(x * 5.1 + 1, z * 5.1 + 9) * 0.15;
}

const tmp = new Color();

function colorFor(out: Color, biome: number, h: number, slope: number, x: number, z: number, sea: number): void {
  const n = fbm(x * 0.07, z * 0.07);
  const n2 = fbm(x * 0.31 + 20, z * 0.31 - 11);
  const rel = h - sea;
  if (rel < 0) {
    // seabed seen through the water
    out.copy(PAL.seabedShallow).lerp(PAL.seabedDeep, Math.min(1, Math.max(0, -rel / 7)));
    out.lerp(PAL.wetSand, 0.25 * n2);
    return;
  }
  switch (biome) {
    case 2: // sand with wet-sand darkening near the waterline
      out.copy(PAL.sand).lerp(PAL.dryGrass, 0.08 * n2);
      out.lerp(PAL.wetSand, 1 - Math.min(1, rel / 0.55));
      break;
    case 3:
      out.copy(PAL.meadowMid).lerp(PAL.meadowLight, 0.25 + n * 0.75);
      out.lerp(PAL.dryGrass, Math.max(0, n2 - 0.62) * 1.4);
      break;
    case 4:
      out.copy(PAL.forest).lerp(PAL.meadowShadow, n * 0.7);
      break;
    case 5:
      out.copy(PAL.highland).lerp(PAL.dryGrass, 0.2 + n * 0.5);
      break;
    case 6:
      out.copy(PAL.cliffWarm).lerp(PAL.rockLav, 0.3 + n * 0.55);
      break;
    case 7:
      out.copy(PAL.path).lerp(PAL.clearingDirt, n2 * 0.5);
      break;
    case 8:
      out.copy(PAL.mud).lerp(PAL.meadowShadow, n * 0.35);
      break;
    case 9:
      out.copy(PAL.meadowLight).lerp(PAL.dryGrass, 0.2 + n2 * 0.3);
      break;
    case 10:
      out.copy(PAL.clearing).lerp(PAL.clearingDirt, 0.25 + n2 * 0.5);
      break;
    case 11:
      out.copy(PAL.snow);
      break;
    default:
      out.copy(PAL.meadowMid).lerp(PAL.meadowLight, n);
  }
  // steep faces read as rock regardless of biome; AO-ish darkening in crevices
  const rock = Math.min(1, Math.max(0, (slope - 0.55) * 3.2));
  if (rock > 0 && biome !== 2) {
    tmp.copy(PAL.cliffWarm).lerp(PAL.rockLav, 0.25 + n * 0.6);
    out.lerp(tmp, rock);
  }
}

/** one 3x3 (1-2-1) blur pass over the vertex colours: hides the 1 m staircase of biome borders */
function softenColors(col: Float32Array, nx: number, nz: number): void {
  const tmpA = new Float32Array(col.length);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = (iz * nx + ix) * 3;
      const l = (iz * nx + Math.max(ix - 1, 0)) * 3;
      const r = (iz * nx + Math.min(ix + 1, nx - 1)) * 3;
      for (let k = 0; k < 3; k++) tmpA[i + k] = (col[l + k]! + 2 * col[i + k]! + col[r + k]!) * 0.25;
    }
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = (iz * nx + ix) * 3;
      const d = (Math.max(iz - 1, 0) * nx + ix) * 3;
      const u = (Math.min(iz + 1, nz - 1) * nx + ix) * 3;
      for (let k = 0; k < 3; k++) col[i + k] = (tmpA[d + k]! + 2 * tmpA[i + k]! + tmpA[u + k]!) * 0.25;
    }
  }
}

/** WORLD_CONTRACT.md biome class per `world.info.biomes` name (the early sim has only six, in its own order) */
const NAME_CLASS: Record<string, number> = { deep_water: 0, shallow_water: 1, beach: 2, meadow: 3, forest: 4, highland: 5, rock: 6, path: 7, mud: 8, flowers: 9, clearing: 10, snow: 11 };

export function buildTerrain(world: HeightField, mats: Materials): Mesh {
  const info = world.info!;
  const nx = world.nx;
  const nz = world.nz;
  const cell = info.cell;
  const ox = info.origin_x + (world.centered ? cell * 0.5 : 0);
  const oz = info.origin_z + (world.centered ? cell * 0.5 : 0);
  const h = world.data;
  const biomes = world.biomes;
  const names = info.biomes as string[] | undefined;
  const klass = new Uint8Array(256);
  for (let k = 0; k < 256; k++) klass[k] = names && names[k] !== undefined ? (NAME_CLASS[names[k]!] ?? k) : k;
  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new Color();
  const sea = info.sea_level;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const x = ox + ix * cell;
      const z = oz + iz * cell;
      const y = h[i]!;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      const hl = h[iz * nx + Math.max(ix - 1, 0)]!;
      const hr = h[iz * nx + Math.min(ix + 1, nx - 1)]!;
      const hd = h[Math.max(iz - 1, 0) * nx + ix]!;
      const hu = h[Math.min(iz + 1, nz - 1) * nx + ix]!;
      const dx = (hr - hl) / (2 * cell);
      const dz = (hu - hd) / (2 * cell);
      const l = Math.hypot(dx, 1, dz);
      nor[i * 3] = -dx / l;
      nor[i * 3 + 1] = 1 / l;
      nor[i * 3 + 2] = -dz / l;
      colorFor(c, klass[biomes[i] ?? 3]!, y, Math.hypot(dx, dz), x, z, sea);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
  }
  softenColors(col, nx, nz);
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const cc = a + nx;
      const d = cc + 1;
      idx[k++] = a;
      idx[k++] = cc;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = cc;
      idx[k++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mesh = new Mesh(geo, mats.ground({ name: 'slice.terrain' }));
  mesh.name = 'slice.terrain';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
