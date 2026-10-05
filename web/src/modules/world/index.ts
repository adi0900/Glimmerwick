/**
 * `world` -- island terrain, water and horizon (order 40).
 *
 * Reads `world.height` / `world.biome` / `world.info` through `ctx.game.world`, builds the chunked LOD terrain
 * (painterly splat shader), the sea / pond / stream water and the far-island horizon, and publishes
 * `ctx.api.world = { addRipple(x, z, strength), ... }` (also mirrored on `ctx.world`).
 * Gallery cams are derived from the real layout in `world.info` (village, pond, streams, highland, islets...).
 */
import { Group, type Vector3 } from 'three';
import type { Ctx, GalleryCam, Vec3 } from '../../engine/types';
import { defineModule } from '../../engine/types';
import { buildHorizon } from './horizon';
import { buildTextures, makeTerrainMaterial, readGrid, TerrainSystem, type TerrainGrid, type TerrainTextures } from './terrain';
import { buildWater, type WaterSystem } from './water';

interface State {
  root: Group;
  grid: TerrainGrid | null;
  tex: TerrainTextures | null;
  terrain: TerrainSystem | null;
  water: WaterSystem | null;
  horizon: { group: Group; dispose(): void } | null;
  ver: number;
  /** ripples requested before the water exists */
  pending: [number, number, number][];
}

let S: State | null = null;

function disposeBuilt(s: State): void {
  s.terrain?.dispose();
  s.water?.dispose();
  s.horizon?.dispose();
  s.tex?.dispose();
  s.terrain = null;
  s.water = null;
  s.horizon = null;
  s.tex = null;
}

function build(ctx: Ctx, s: State): boolean {
  const world = ctx.game.world;
  const grid = readGrid(world);
  if (!grid) return false;
  disposeBuilt(s);
  const t0 = performance.now();
  s.grid = grid;
  s.tex = buildTextures(grid);
  const tm = makeTerrainMaterial(ctx, grid, s.tex);
  s.terrain = new TerrainSystem(grid, tm.material, ctx.quality);
  s.root.add(s.terrain.group);
  const info = world.info!;
  s.water = buildWater(ctx, grid, s.tex, info.water as never);
  s.root.add(s.water.group);
  for (const [x, z, k] of s.pending) s.water.addRipple(x, z, k);
  s.pending.length = 0;
  s.horizon = buildHorizon(ctx, (info.seed as number) | 0, Math.max(world.extentX, world.extentZ) / 2);
  s.root.add(s.horizon.group);
  ctx.uniforms.uWorldSize.value.set(world.extentX, world.extentZ, info.origin_x, info.origin_z);
  s.terrain.update(ctx.camera.position as Vector3, true);
  s.ver = world.version;
  // eslint-disable-next-line no-console
  console.info(`[world] built ${grid.nx}x${grid.nz} @ ${grid.cell} m: ${s.terrain.stats.chunks} chunks, textures ${s.tex.tw}x${s.tex.th}, ${(performance.now() - t0).toFixed(0)} ms`);
  return true;
}

// ------------------------------------------------------------------------------------------------- gallery cams

function deriveCams(ctx: Ctx): Record<string, GalleryCam> {
  const world = ctx.game.world;
  const info = world.info as any;
  if (!info) return {};
  const sea = info.sea_level ?? 0;
  const gy = (x: number, z: number): number => Math.max(world.sample(x, z), sea);
  const ox = info.origin_x as number;
  const oz = info.origin_z as number;
  const half = Math.max(world.extentX, world.extentZ) / 2;
  const cx = ox + world.extentX / 2;
  const cz = oz + world.extentZ / 2;
  const cams: Record<string, GalleryCam> = {};
  const norm = (x: number, z: number): [number, number] => {
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  };
  const spawn: [number, number] = Array.isArray(info.spawn?.player) ? info.spawn.player : [cx, cz];
  const village: [number, number] = Array.isArray(info.spawn?.village) ? info.spawn.village : spawn;
  const pond = info.water?.pond as { x: number; z: number; rx: number; rz: number; level: number } | undefined;
  const streams = (info.water?.streams ?? []) as { pts: number[][] }[];
  const hl = (info.highland ?? [cx - 66, cz - 56, 70]) as number[];
  const islets = (info.islets ?? []) as number[][];

  cams.overview = { pos: [cx - 0.3 * half, 0.33 * half, cz + 0.88 * half], target: [cx + 0.03 * half, 3, cz - 0.02 * half], fov: 46 };
  cams.top = { pos: [cx, half * 2.15, cz + 1], target: [cx, 0, cz], fov: 45 };

  // south-west cove: low over the water looking at the stream mouth, cliffs behind
  const out = streams[1]?.pts;
  if (out && out.length) {
    const m = out[out.length - 1]!;
    cams.shore = { pos: [m[0]! + 24, sea + 1.6, m[1]! + 44], target: [m[0]! - 6, sea + 1.6, m[1]! - 10], fov: 50 };
  }

  // highland cliffs: from the sea off the terraced flank (facing matches sim_world::worldgen)
  const f = norm(-0.92, 0.38);
  cams.cliff = { pos: [hl[0]! + f[0] * 118, sea + 9, hl[1]! + f[1] * 118], target: [hl[0]! + f[0] * 30, sea + 9, hl[1]! + f[1] * 30], fov: 52 };
  cams.cliff2 = { pos: [hl[0]! + f[0] * 88, gy(hl[0]! + f[0] * 88, hl[1]! + f[1] * 88) + 3.2, hl[1]! + f[1] * 88], target: [hl[0]! + f[0] * 40, gy(hl[0]! + f[0] * 40, hl[1]! + f[1] * 40) + 4, hl[1]! + f[1] * 40], fov: 50 };

  // meadow: ground-level view from the spawn towards the pond
  const pdir = pond ? norm(pond.x - spawn[0], pond.z - spawn[1]) : norm(-1, 0);
  const mpx = spawn[0] - pdir[0] * 3.5 - pdir[1] * 1.5;
  const mpz = spawn[1] - pdir[1] * 3.5 + pdir[0] * 1.5;
  cams.meadow = { pos: [mpx, gy(mpx, mpz) + 1.25, mpz], target: [spawn[0] + pdir[0] * 9, gy(spawn[0] + pdir[0] * 9, spawn[1] + pdir[1] * 9) + 0.7, spawn[1] + pdir[1] * 9], fov: 48 };

  // east beach: the end of the village -> east path
  const east = (info.paths?.[1] ?? null) as number[][] | null;
  if (east && east.length) {
    const e = east[east.length - 1]!;
    cams.beach = { pos: [e[0]! + 5, gy(e[0]! + 5, e[1]! + 5) + 0.95, e[1]! + 5], target: [e[0]! + 15, sea + 0.25, e[1]! - 3], fov: 50 };
  }
  if (pond) {
    cams.pond = { pos: [pond.x - 31, pond.level + 3.1, pond.z + 24], target: [pond.x + 2, pond.level - 0.2, pond.z - 2], fov: 48 };
  }
  if (streams[1]?.pts.length) {
    const p = streams[1].pts;
    const i = Math.floor(p.length * 0.45);
    const a = p[Math.max(i - 3, 0)]!;
    const b = p[Math.min(i + 6, p.length - 1)]!;
    const d = norm(b[0]! - a[0]!, b[1]! - a[1]!);
    const c = p[i]!;
    cams.stream = { pos: [c[0]! - d[0] * 9 - d[1] * 2.5, c[3]! + 2.1, c[1]! - d[1] * 9 + d[0] * 2.5], target: [c[0]! + d[0] * 9, c[3]! + 0.1, c[1]! + d[1] * 9], fov: 50 };
  }
  cams.sunset = { pos: [cx + 70, sea + 2.4, cz + 0.62 * half], target: [cx - 0.55 * half, sea + 3, cz + 0.28 * half], fov: 52 };
  cams.night = { pos: [cx + 0.3 * half, sea + 2.4, cz + 0.58 * half], target: [cx, 5, cz + 0.02 * half], fov: 50 };
  cams.seabed = { pos: [cx + 0.55 * half, sea + 6, cz + 0.62 * half], target: [cx + 0.4 * half, sea - 2.5, cz + 0.38 * half], fov: 52 };
  if (islets[0]) {
    const i0 = islets[0]!;
    const east0 = (info.paths?.[1] ?? [[cx + 100, cz]]) as number[][];
    const e = east0[east0.length - 1]!;
    cams.islet = { pos: [e[0]! + 18, sea + 2.3, e[1]! + 3], target: [i0[0]!, sea + 3.5, i0[1]!], fov: 46 };
  }
  cams.village = { pos: [village[0] + 26, gy(village[0] + 26, village[1] + 30) + 8, village[1] + 30], target: [village[0], gy(village[0], village[1]) + 1.2, village[1]], fov: 50 };
  const fh = info.habitats?.forest_floor?.[0] as number[] | undefined;
  if (fh) {
    cams.forest = { pos: [fh[0]! + 5, gy(fh[0]! + 5, fh[1]! + 9) + 1.5, fh[1]! + 9], target: [fh[0]! - 3, gy(fh[0]! - 3, fh[1]! - 4) + 1.1, fh[1]! - 4], fov: 52 };
  }
  return cams;
}

const mod = defineModule({
  name: 'world',
  order: 40,

  init(ctx) {
    const root = new Group();
    root.name = 'world.root';
    ctx.scene.add(root);
    S = { root, grid: null, tex: null, terrain: null, water: null, horizon: null, ver: -1, pending: [] };
    const api = {
      /** drop a ripple ring on the water at (x, z); strength ~0.2 (wade) .. 1 (splash) */
      addRipple(x: number, z: number, strength = 0.6): void {
        if (S?.water) S.water.addRipple(x, z, strength);
        else S?.pending.push([x, z, strength]);
      },
      get grid(): TerrainGrid | null {
        return S?.grid ?? null;
      },
    };
    ctx.api.world = api;
    (ctx as unknown as { world: typeof api }).world = api;
    build(ctx, S);
    ctx.debug.line('world', () => (S?.terrain ? `chunks ${S.terrain.stats.chunks} · tris ${(S.terrain.stats.tris / 1000).toFixed(0)}k · built ${S.terrain.stats.built} · world v${S.ver}` : 'no world'));
  },

  update(ctx) {
    const s = S;
    if (!s) return;
    const world = ctx.game.world;
    if (!s.terrain || world.version !== s.ver) {
      if (world.ready && (world.version !== s.ver || !s.terrain)) build(ctx, s);
    }
    s.terrain?.update(ctx.camera.position as Vector3, ctx.clock.frame < 16);
    s.water?.update();
  },

  gallery: {
    cams: {
      overview: { pos: [-20, 105, 260], target: [5, 3, -5], fov: 46 },
      top: { pos: [0, 620, 1], target: [0, 0, 0], fov: 45 },
      shore: { pos: [-24, 1.6, 120], target: [-54, 1.6, 66], fov: 50 },
      cliff: { pos: [-175, 9, -12], target: [-94, 9, -45], fov: 52 },
      meadow: { pos: [48, 2.2, 8], target: [36, 1.5, 6], fov: 48 },
    } as Record<string, GalleryCam>,
    setup(ctx) {
      Object.assign(mod.gallery!.cams, deriveCams(ctx));
    },
  },

  dispose() {
    if (!S) return;
    disposeBuilt(S);
    S.root.parent?.remove(S.root);
    S = null;
  },
});

export default mod;
export type { Vec3 };
