/**
 * `voxel` -- the voxel world renderer (order 40): meshes `vox.data` (chunked block ids published by sim_world) into
 * 32 x 32 column regions (opaque + water), paints the procedural tile atlas, runs the edit pipeline (a dirty chunk
 * version -> remesh of only its region), the ripple API and the gallery debug tool (click = break, right-click = place,
 * 1-9 = block; `?voxdemo=1` scripts an edit filmstrip). Replaces the smooth `world` module.
 */
import { Box3, BufferAttribute, BufferGeometry, DataTexture, Group, Mesh, NearestFilter, RGBAFormat, Sphere, SRGBColorSpace, UnsignedByteType, Vector3, type Vector4 } from 'three';
import type { Ctx, GalleryCam } from '../../engine/types';
import { defineModule } from '../../engine/types';
import { lookState } from '../../engine/Lighting';
import { buildAtlas } from './atlas';
import { makeBlockMaterial, makeWaterMaterial, type BlockMaterial, type WaterMaterial } from './materials';
import { createFx, type VoxFx } from './fx';
import { Mesher, REGION, type SolidMesh, type VoxInfo, type WaterMesh } from './mesher';

interface BlockDef {
  id: number;
  name: string;
  solid: boolean;
  opaque: boolean;
  liquid: boolean;
  foliage: boolean;
  glow: boolean;
  plant: boolean;
  night_glow?: boolean;
  tex: [string, string, string];
}

interface Region {
  rx: number;
  rz: number;
  solid: Mesh | null;
  water: Mesh | null;
  ver: number[];
}

interface State {
  root: Group;
  info: VoxInfo;
  mesher: Mesher;
  regions: Region[];
  rw: number;
  rh: number;
  block: BlockMaterial;
  water: WaterMaterial;
  ring: Mesh;
  blocks: BlockDef[];
  dataVer: number;
  rippleNext: number;
  stats: { regions: number; tris: number; lastRemeshMs: number; lastEditMs: number; buildMs: number; edits: number };
  sel: number;
  pendingEditAt: number;
  demo: { ops: (() => void)[]; next: number } | null;
}

let S: State | null = null;
const focusDir = new Vector3();
const PALETTE = ['planks', 'cobble', 'plaster', 'roof_tile', 'lantern', 'sand', 'stone', 'glowcap', 'log_oak'];

function chunkIds(s: State, r: Region): number[] {
  const n = s.info.ncx;
  return [r.rz * 2 * n + r.rx * 2, r.rz * 2 * n + r.rx * 2 + 1, (r.rz * 2 + 1) * n + r.rx * 2, (r.rz * 2 + 1) * n + r.rx * 2 + 1];
}

function solidGeometry(m: SolidMesh, ny: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new BufferAttribute(m.nrm, 3, true));
  g.setAttribute('aTF', new BufferAttribute(m.tf, 1));
  g.setAttribute('aLight', new BufferAttribute(m.light, 4, true));
  g.setAttribute('aSway', new BufferAttribute(m.sway, 1, true));
  g.setIndex(new BufferAttribute(m.idx, 1));
  g.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(REGION, ny, REGION));
  g.boundingSphere = new Sphere(new Vector3(REGION / 2, ny / 2, REGION / 2), Math.hypot(REGION / 2, ny / 2, REGION / 2));
  return g;
}

function waterGeometry(m: WaterMesh, ny: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.pos, 3));
  g.setAttribute('aWater', new BufferAttribute(m.aw, 2));
  g.setIndex(new BufferAttribute(m.idx, 1));
  g.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(REGION, ny, REGION));
  g.boundingSphere = new Sphere(new Vector3(REGION / 2, ny / 2, REGION / 2), Math.hypot(REGION / 2, ny / 2, REGION / 2));
  return g;
}

function dropMesh(s: State, mesh: Mesh | null): void {
  if (!mesh) return;
  s.root.remove(mesh);
  mesh.geometry.dispose();
}

/** (re)meshes one region; returns the time in ms */
function remesh(ctx: Ctx, s: State, r: Region): number {
  const t0 = performance.now();
  const blocks = ctx.game.channel<Uint16Array>('vox.data').data;
  const chunks = ctx.game.channel<Uint32Array>('vox.chunks').data;
  const { solid, water } = s.mesher.meshRegion(blocks, chunks, r.rx, r.rz);
  dropMesh(s, r.solid);
  dropMesh(s, r.water);
  r.solid = r.water = null;
  const i = s.info;
  const px = i.originX + r.rx * REGION;
  const pz = i.originZ + r.rz * REGION;
  if (solid) {
    const m = new Mesh(solidGeometry(solid, i.ny), s.block.material);
    m.position.set(px, i.originY, pz);
    m.name = `vox.r${r.rx}_${r.rz}`;
    ctx.mats.prepare(m);
    s.root.add(m);
    r.solid = m;
  }
  if (water) {
    const m = new Mesh(waterGeometry(water, i.ny), s.water.material);
    m.position.set(px, i.originY, pz);
    m.name = `vox.w${r.rx}_${r.rz}`;
    m.renderOrder = 5;
    m.castShadow = false;
    m.receiveShadow = false;
    s.root.add(m);
    r.water = m;
  }
  r.ver = chunkIds(s, r).map((c) => chunks[c * 2]!);
  return performance.now() - t0;
}

function countTris(s: State): number {
  let t = 0;
  for (const r of s.regions) {
    t += (r.solid?.geometry.index?.count ?? 0) / 3;
    t += (r.water?.geometry.index?.count ?? 0) / 3;
  }
  return t;
}

function buildSeaRing(s: State, ctx: Ctx): Mesh {
  // endless ocean: a 3 x 3 grid (centre = the voxel world) out to 6 km; the water depth continues the world's own sea
  // (12 m at its border) and deepens away from it, so there is no visible edge; the haze (gwFog) melts it into the sky
  const i = s.info;
  const B = 6000;
  const xs = [i.originX - B, i.originX, i.originX + i.nx, i.originX + i.nx + B];
  const zs = [i.originZ - B, i.originZ, i.originZ + i.nz, i.originZ + i.nz + B];
  const y = -0.12;
  const pos = new Float32Array(16 * 3);
  const aw = new Float32Array(16 * 2);
  for (let j = 0; j < 4; j++) {
    for (let k = 0; k < 4; k++) {
      const v = j * 4 + k;
      pos.set([xs[k]!, y, zs[j]!], v * 3);
      const out = Math.max(0, i.originX - xs[k]!, xs[k]! - (i.originX + i.nx), i.originZ - zs[j]!, zs[j]! - (i.originZ + i.nz));
      aw.set([12 + 4 * Math.min(out / 300, 1), 0], v * 2);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 3; k++) {
      if (j === 1 && k === 1) continue;
      const c0 = (j + 1) * 4 + k;
      const c1 = (j + 1) * 4 + k + 1;
      const c2 = j * 4 + k + 1;
      const c3 = j * 4 + k;
      idx.push(c0, c1, c2, c0, c2, c3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aWater', new BufferAttribute(aw, 2));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  const m = new Mesh(g, s.water.material);
  m.frustumCulled = false;
  m.renderOrder = 4;
  m.name = 'vox.sea';
  void ctx;
  return m;
}

function buildAll(ctx: Ctx, s: State): void {
  const t0 = performance.now();
  for (const r of s.regions) remesh(ctx, s, r);
  s.stats.buildMs = performance.now() - t0;
  s.stats.tris = countTris(s);
}

// ------------------------------------------------------------------------------------------------- edit tool

// ------------------------------------------------------------------------------------------------- water reflections

interface RefState {
  data: Uint8Array;
  tex: DataTexture;
  rgb: Uint8Array;
  waterId: number;
}
let REF: RefState | null = null;

/** top-block colour + height per column (352 x 288 texels): the water shader marches reflected rays over it */
function initRef(ctx: Ctx, s: State, blocks: { id: number; color: number[] }[], waterId: number): void {
  const rgb = new Uint8Array(256 * 3);
  for (const b of blocks) rgb.set(b.color.slice(0, 3), b.id * 3);
  const data = new Uint8Array(s.info.nx * s.info.nz * 4);
  const tex = new DataTexture(data, s.info.nx, s.info.nz, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.name = 'voxel.reflect';
  REF = { data, tex, rgb, waterId };
  const u = s.water.material.uniforms;
  u.uRefTex!.value = tex;
  (u.uRefInfo!.value as Vector4).set(s.info.originX, s.info.originZ, s.info.nx, s.info.nz);
  u.uRefSea!.value = s.info.seaY;
  updateRef(ctx, s);
}

function updateRef(ctx: Ctx, s: State): void {
  if (!REF) return;
  const { nx, nz, ny, ncx, chunk, seaY } = s.info;
  const cells = chunk * chunk * ny;
  const blocks = ctx.game.channel<Uint16Array>('vox.data').data;
  const chunks = ctx.game.channel<Uint32Array>('vox.chunks').data;
  const { data, rgb, waterId } = REF;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const ci = (z >> 4) * ncx + (x >> 4);
      const base = ci * cells + (((z & 15) << 4) + (x & 15)) * ny;
      let y = Math.min(ny - 1, chunks[ci * 2 + 1]!);
      while (y > 0) {
        const b = blocks[base + y]!;
        if (b !== 0 && b !== waterId) break;
        y--;
      }
      const b = blocks[base + y]!;
      const o = (z * nx + x) * 4;
      if (y + 1 - seaY < 1) {
        data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0; // sea floor / waterline: never occludes
      } else {
        data[o] = rgb[b * 3]!;
        data[o + 1] = rgb[b * 3 + 1]!;
        data[o + 2] = rgb[b * 3 + 2]!;
        data[o + 3] = Math.min(255, (y + 1) * 4);
      }
    }
  }
  REF.tex.needsUpdate = true;
}

function blockId(s: State, name: string): number {
  return s.blocks.find((b) => b.name === name)?.id ?? 0;
}

function rayFromPointer(ctx: Ctx, cx: number, cy: number): { origin: number[]; dir: number[] } {
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const ndc = new Vector3(((cx - rect.left) / rect.width) * 2 - 1, -(((cy - rect.top) / rect.height) * 2 - 1), 0.5).unproject(ctx.camera);
  const o = ctx.camera.position;
  const d = ndc.sub(o).normalize();
  return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
}

function editAt(ctx: Ctx, s: State, cx: number, cy: number, mode: 'break' | 'place'): void {
  const ray = rayFromPointer(ctx, cx, cy);
  const hit = ctx.game.query('world.raycast', { ...ray, max: 200 });
  if (!hit?.hit) return;
  const [x, y, z] = hit.pos as number[];
  const t0 = performance.now();
  if (mode === 'break') ctx.game.command('world.break_block', { x, y, z }, true);
  else {
    const n = hit.normal as number[];
    ctx.game.command('world.place_block', { x: x! + n[0]!, y: y! + n[1]!, z: z! + n[2]!, name: PALETTE[s.sel] }, true);
  }
  s.stats.edits++;
  s.pendingEditAt = t0;
}

function setupEditTool(ctx: Ctx, s: State): void {
  const el = ctx.renderer.domElement;
  let down: { x: number; y: number; t: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  el.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const dt = performance.now() - down.t;
    down = null;
    if (moved > 5 || dt > 450) return;
    editAt(ctx, s, e.clientX, e.clientY, e.button === 2 ? 'place' : 'break');
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= '9') s.sel = Number(e.key) - 1;
  });
}

/** `?voxdemo=1`: every `__game.step()` (the filmstrip tool calls it between frames) digs / builds a few more blocks */
function setupDemo(ctx: Ctx, s: State): void {
  const info = ctx.game.world.info as any;
  const sp = (info.spawn?.player ?? [0, 0]) as number[];
  const x0 = Math.floor(sp[0]!) + 4;
  const z0 = Math.floor(sp[1]!) + 2;
  const g = ctx.game.query('world.ground', { x: x0 + 1.5, z: z0 + 1.5 });
  const gy = (g?.block_y ?? 4) as number;
  const ops: (() => void)[] = [];
  const cmd = (name: string, a: object): (() => void) => () => void ctx.game.command(name, a, true);
  for (let dy = 0; dy < 3; dy++) for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) ops.push(cmd('world.break_block', { x: x0 + dx, y: gy - dy, z: z0 + dz }));
  ops.push(cmd('world.place_block', { x: x0 + 1, y: gy - 2, z: z0 + 1, name: 'lantern' }));
  for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) ops.push(cmd('world.place_block', { x: x0 + dx!, y: gy - 1, z: z0 + dz!, name: 'glowcap' }));
  s.demo = { ops, next: 0 };
  const w = window as unknown as { __game?: { step: (n: number) => unknown } };
  const patch = (): boolean => {
    if (!w.__game || (w.__game.step as { __voxPatched?: boolean }).__voxPatched) return !!w.__game;
    const orig = w.__game.step.bind(w.__game);
    const patched = (n: number): unknown => {
      for (let k = 0; k < 6 && s.demo && s.demo.next < s.demo.ops.length; k++) s.demo.ops[s.demo.next++]!();
      return orig(n);
    };
    (patched as { __voxPatched?: boolean }).__voxPatched = true;
    w.__game.step = patched;
    return true;
  };
  if (!patch()) {
    const t = setInterval(() => {
      if (patch()) clearInterval(t);
    }, 50);
  }
}

// ------------------------------------------------------------------------------------------------- gallery cams

function deriveCams(ctx: Ctx): Record<string, GalleryCam> {
  const world = ctx.game.world;
  const info = world.info as any;
  if (!info) return {};
  const sea = 0;
  const gy = (x: number, z: number): number => Math.max(world.sample(x, z), sea);
  const cx = info.origin_x + info.nx / 2;
  const cz = info.origin_z + info.nz / 2;
  const norm = (x: number, z: number): [number, number] => {
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  };
  const spawn: [number, number] = info.spawn?.player ?? [cx, cz];
  const village: [number, number] = info.spawn?.village ?? spawn;
  const pond = info.water?.pond as { x: number; z: number; level: number } | undefined;
  const streams = (info.water?.streams ?? []) as { pts: number[][] }[];
  const hl = (info.highland ?? [cx - 66, cz - 56, 70]) as number[];
  const cams: Record<string, GalleryCam> = {};
  cams.overview = { pos: [cx - 55, 72, cz + 196], target: [cx + 6, 22, cz - 4], fov: 50 };
  cams.top = { pos: [cx, 330, cz + 1], target: [cx, 0, cz], fov: 42 };
  const out = streams[1]?.pts;
  if (out?.length) {
    const m = out[out.length - 1]!;
    cams.shore = { pos: [m[0]! + 22, 1.9, m[1]! + 36], target: [m[0]! - 6, 1.4, m[1]! - 10], fov: 50 };
  }
  const f = norm(-0.92, 0.38);
  cams.cliff = { pos: [hl[0]! + f[0] * 100, 8, hl[1]! + f[1] * 100], target: [hl[0]! + f[0] * 36, 9, hl[1]! + f[1] * 36], fov: 52 };
  cams.cliff2 = { pos: [hl[0]! + f[0] * 66, gy(hl[0]! + f[0] * 66, hl[1]! + f[1] * 66) + 3.4, hl[1]! + f[1] * 66], target: [hl[0]! + f[0] * 36, gy(hl[0]! + f[0] * 36, hl[1]! + f[1] * 36) + 4, hl[1]! + f[1] * 36], fov: 50 };
  const pdir = pond ? norm(pond.x - spawn[0], pond.z - spawn[1]) : norm(-1, 0);
  const mpx = spawn[0] - pdir[0] * 3.5 - pdir[1] * 1.5;
  const mpz = spawn[1] - pdir[1] * 3.5 + pdir[0] * 1.5;
  cams.meadow = { pos: [mpx, gy(mpx, mpz) + 1.7, mpz], target: [spawn[0] + pdir[0] * 9, gy(spawn[0] + pdir[0] * 9, spawn[1] + pdir[1] * 9) + 0.9, spawn[1] + pdir[1] * 9], fov: 52 };
  cams.lawn = { pos: [spawn[0] + 2.4, gy(spawn[0], spawn[1]) + 2.3, spawn[1] + 3.4], target: [spawn[0] - 2.5, gy(spawn[0], spawn[1]) + 0.2, spawn[1] - 2], fov: 42 };
  if (pond) cams.pond = { pos: [pond.x - 30, pond.level + 5.5, pond.z + 24], target: [pond.x + 2, pond.level - 0.4, pond.z - 2], fov: 50 };
  if (streams[1]?.pts.length) {
    const p = streams[1].pts;
    const i = Math.floor(p.length * 0.45);
    const a = p[Math.max(i - 3, 0)]!;
    const b = p[Math.min(i + 6, p.length - 1)]!;
    const d = norm(b[0]! - a[0]!, b[1]! - a[1]!);
    const c = p[i]!;
    cams.stream = { pos: [c[0]! - d[0] * 9 - d[1] * 2.5, c[3]! + 3.4, c[1]! - d[1] * 9 + d[0] * 2.5], target: [c[0]! + d[0] * 9, c[3]! + 0.1, c[1]! + d[1] * 9], fov: 52 };
  }
  cams.sunset = { pos: [cx + 40, 2.3, info.origin_z + info.nz - 7], target: [cx - 110, 3.5, cz + 40], fov: 54 };
  cams.night = { pos: [village[0] + 14, gy(village[0] + 14, village[1] + 18) + 3.2, village[1] + 18], target: [village[0], gy(village[0], village[1]) + 1.5, village[1]], fov: 50 };
  (globalThis as any).__gwCams = cams;
  (globalThis as any).__gwVillage = [village[0], village[1]];
  cams.seabed = { pos: [cx + 0.55 * 176, 7, cz + 0.62 * 176], target: [cx + 0.4 * 176, -2.5, cz + 0.38 * 176], fov: 52 };
  cams.village = { pos: [village[0] + 26, gy(village[0] + 26, village[1] + 30) + 12, village[1] + 30], target: [village[0], gy(village[0], village[1]) + 1.5, village[1]], fov: 50 };
  const fh = info.habitats?.forest_floor?.[0] as number[] | undefined;
  if (fh) cams.forest = { pos: [fh[0]! + 5, gy(fh[0]! + 5, fh[1]! + 9) + 2.2, fh[1]! + 9], target: [fh[0]! - 3, gy(fh[0]! - 3, fh[1]! - 4) + 1.6, fh[1]! - 4], fov: 54 };
  const cave = info.vox?.caves?.[0] as number[] | undefined;
  if (cave) {
    const [x, fy, z, dx, dz] = cave as [number, number, number, number, number];
    cams.cave = { pos: [x + dx * 8, fy + 2.8, z + dz * 8], target: [x - dx * 2, fy + 1.4, z - dz * 2], fov: 56 };
  } else cams.cave = cams.cliff2;
  const cot = info.vox?.cottages?.[0] as number[] | undefined;
  if (cot) {
    const [x, z, , by] = cot as [number, number, number, number];
    cams.closeup = { pos: [x + 5.2, by + 2.6, z + 6.4], target: [x + 2.2, by + 1.1, z + 2.4], fov: 38 };
  } else cams.closeup = cams.meadow;
  const dx0 = Math.floor(spawn[0]) + 4;
  const dz0 = Math.floor(spawn[1]) + 2;
  cams.edit = { pos: [dx0 + 1.5 - 3.2, gy(dx0 + 1.5, dz0 + 1.5) + 4.2, dz0 + 1.5 + 5.6], target: [dx0 + 1.5, gy(dx0 + 1.5, dz0 + 1.5) - 0.8, dz0 + 1.5], fov: 46 };
  return cams;
}

let fx: VoxFx | null = null;

const mod = defineModule({
  name: 'voxel',
  order: 40,

  init(ctx) {
    if (!ctx.game.has('vox.data')) {
      console.warn('[voxel] the sim publishes no voxel world (mock game?) -- nothing to render');
      return;
    }
    const t0 = performance.now();
    const winfo = ctx.game.query('world.info') as any;
    const v = winfo.vox;
    const info: VoxInfo = { nx: v.nx, ny: v.ny, nz: v.nz, chunk: v.chunk, ncx: v.ncx, ncz: v.ncz, seaY: v.sea_y, originX: v.origin[0], originY: v.origin[1], originZ: v.origin[2] };
    const blocks = (ctx.game.query('world.blocks') as { blocks: BlockDef[] }).blocks;
    const names: string[] = [];
    for (const b of blocks) for (const n of b.tex) if (n && !names.includes(n)) names.push(n);
    const atlas = buildAtlas(names, Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()));
    const flags = new Uint8Array(256);
    const tiles = new Uint16Array(256 * 3);
    const tileVar = new Uint8Array(256 * 3);
    for (const b of blocks) {
      flags[b.id] = (b.solid ? 1 : 0) | (b.opaque ? 2 : 0) | (b.liquid ? 4 : 0) | (b.foliage ? 8 : 0) | (b.glow ? 16 : 0) | (b.plant ? 32 : 0) | (b.night_glow ? 64 : 0);
      b.tex.forEach((n, k) => {
        tiles[b.id * 3 + k] = n ? atlas.index.get(n) ?? 0 : 0;
        tileVar[b.id * 3 + k] = n ? atlas.variants.get(n) ?? 1 : 1;
      });
    }
    const waterId = blocks.find((b) => b.liquid)?.id ?? 16;
    const root = new Group();
    root.name = 'voxel.root';
    ctx.scene.add(root);
    const colors = new Uint8Array(256 * 3);
    for (const b of blocks as any[]) if (b.color) colors.set(b.color, b.id * 3);
    fx = createFx(root, info, flags, colors);
    const block = makeBlockMaterial(ctx, atlas.texture, -0.12);
    const water = makeWaterMaterial(ctx);
    const rw = info.ncx / 2;
    const rh = info.ncz / 2;
    const regions: Region[] = [];
    for (let rz = 0; rz < rh; rz++) for (let rx = 0; rx < rw; rx++) regions.push({ rx, rz, solid: null, water: null, ver: [] });
    S = {
      root,
      info,
      mesher: new Mesher(info, flags, tiles, tileVar, waterId),
      regions,
      rw,
      rh,
      block,
      water,
      ring: null as unknown as Mesh,
      blocks,
      dataVer: ctx.game.channel('vox.data').ver,
      rippleNext: 0,
      stats: { regions: regions.length, tris: 0, lastRemeshMs: 0, lastEditMs: 0, buildMs: 0, edits: 0 },
      sel: 0,
      pendingEditAt: 0,
      demo: null,
    };
    S.ring = buildSeaRing(S, ctx);
    root.add(S.ring);
    buildAll(ctx, S);
    initRef(ctx, S, blocks as unknown as { id: number; color: number[] }[], waterId);
    ctx.uniforms.uWorldSize.value.set(info.nx, info.nz, info.originX, info.originZ);
    const s = S;
    const api = {
      addRipple(x: number, z: number, strength = 0.6): void {
        const r = s.water.ripples[s.rippleNext++ % 8]!;
        r.set(x, z, ctx.uniforms.uTime.value as number, strength);
      },
      raycast: (origin: number[], dir: number[], max = 64) => ctx.game.query('world.raycast', { origin, dir, max }),
      blockAt: (x: number, y: number, z: number) => ctx.game.query('world.block', { x, y, z }),
      breakBlock: (x: number, y: number, z: number) => ctx.game.command('world.break_block', { x, y, z }),
      placeBlock: (x: number, y: number, z: number, name: string) => ctx.game.command('world.place_block', { x, y, z, name }),
      get stats() {
        return s.stats;
      },
    };
    ctx.api.world = api;
    (ctx as unknown as { world: typeof api }).world = api;
    (window as unknown as { __voxel: unknown }).__voxel = api;
    ctx.debug.line('voxel', () => `regions ${s.stats.regions} · tris ${(s.stats.tris / 1000).toFixed(0)}k · build ${s.stats.buildMs.toFixed(0)} ms · remesh ${s.stats.lastRemeshMs.toFixed(1)} ms · edit→mesh ${s.stats.lastEditMs.toFixed(1)} ms · edits ${s.stats.edits}`);
    console.info(`[voxel] ${info.nx}x${info.nz}x${info.ny}: ${regions.length} regions, ${(s.stats.tris / 1000).toFixed(0)}k tris, atlas ${names.length} tiles, built in ${s.stats.buildMs.toFixed(0)} ms (init ${(performance.now() - t0).toFixed(0)} ms)`);
    const params = new URLSearchParams(location.search);
    if (ctx.view.view === 'voxel') setupEditTool(ctx, s);
    if (params.get('voxdemo')) setupDemo(ctx, s);
  },

  update(ctx, dt) {
    const s = S;
    if (!s) return;
    fx?.update(ctx, dt);
    s.block.vox.w = ctx.uniforms.uTime.value as number;
    {
      // DOF focus = distance to what the camera looks at (exact voxel hit, not the flat-ground guess); Lighting.follow reads it
      const o = ctx.camera.position;
      const d = ctx.camera.getWorldDirection(focusDir);
      const hit = ctx.game.query('world.raycast', { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z], max: 600, liquids: true });
      lookState.hint = hit?.hit ? (hit.dist as number) : 0;
    }
    const dv = ctx.game.channel('vox.data').ver;
    const chunks = ctx.game.channel<Uint32Array>('vox.chunks').data;
    let budget = 6;
    if (dv !== s.dataVer) {
      s.dataVer = dv; // republished (load): everything is stale
      for (const r of s.regions) r.ver = [];
    }
    let worst = 0;
    for (const r of s.regions) {
      if (budget <= 0) break;
      const ids = chunkIds(s, r);
      let stale = r.ver.length === 0;
      for (let k = 0; k < 4 && !stale; k++) if (chunks[ids[k]! * 2] !== r.ver[k]) stale = true;
      if (!stale) continue;
      worst = Math.max(worst, remesh(ctx, s, r));
      budget--;
    }
    if (worst > 0) {
      updateRef(ctx, s);
      s.stats.lastRemeshMs = worst;
      s.stats.tris = countTris(s);
      if (s.pendingEditAt > 0) {
        s.stats.lastEditMs = performance.now() - s.pendingEditAt;
        s.pendingEditAt = 0;
      }
    }
  },

  gallery: {
    cams: {
      overview: { pos: [-40, 108, 226], target: [16, 2, 4], fov: 44 },
      top: { pos: [16, 330, 9], target: [16, 0, 8], fov: 42 },
    } as Record<string, GalleryCam>,
    setup(ctx) {
      Object.assign(mod.gallery!.cams, deriveCams(ctx));
    },
  },

  dispose() {
    fx?.dispose();
    fx = null;
    if (!S) return;
    for (const r of S.regions) {
      dropMesh(S, r.solid);
      dropMesh(S, r.water);
    }
    S.ring.geometry.dispose();
    S.root.parent?.remove(S.root);
    S = null;
  },
});

export default mod;
