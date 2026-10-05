/**
 * Gallery cameras derived from the actual world data (so they work for the mock island, the stub sim world and the
 * final 300 m island alike): hero wide, top map, south-shore low angle, steepest cliff, over-the-shoulder, creature.
 */
import type { Ctx, GalleryCam, Vec3 } from '../../engine/types';

export function spawnXZ(ctx: Ctx): [number, number] | null {
  const sp = ctx.game.world.info?.spawn as any;
  if (!sp) return null;
  if (Array.isArray(sp.player)) return [sp.player[0], sp.player[1]]; // WORLD_CONTRACT.md shape
  if (typeof sp.x === 'number' && typeof sp.z === 'number') return [sp.x, sp.z]; // early sim shape
  return null;
}

export function deriveCams(ctx: Ctx): Record<string, GalleryCam> {
  const cams: Record<string, GalleryCam> = {};
  const world = ctx.game.world;
  const info = world.info;
  if (info) {
    const sx = world.extentX;
    const sz = world.extentZ;
    const cx = info.origin_x + sx / 2;
    const cz = info.origin_z + sz / 2;
    const R = Math.max(sx, sz) / 2;
    const sea = info.sea_level;

    cams.wide = { pos: [cx + 0.11 * R, 0.36 * R, cz + 1.0 * R], target: [cx - 0.05 * R, 2, cz + 0.06 * R], fov: 50 };
    cams.top = { pos: [cx, 1.8 * R, cz + 1], target: [cx, 0, cz], fov: 40 };

    // south shore: walk north from the south edge along x = centre until we meet land
    let shoreZ: number | null = null;
    for (let z = info.origin_z + sz - 2; z > cz; z -= 1) {
      if (world.sample(cx, z) > sea + 0.15) {
        shoreZ = z;
        break;
      }
    }
    if (shoreZ !== null) {
      cams.shore = { pos: [cx + 0.18 * R, sea + 1.7, shoreZ + 0.17 * R], target: [cx + 0.06 * R, sea + 0.3, shoreZ - 0.2 * R], fov: 50 };
    }

    // steepest land patch (cliff face) above the waterline
    let best = 0;
    let bx = cx;
    let bz = cz;
    let bh = sea + 4;
    let gx = 0;
    let gz = 0;
    const step = Math.max(2, Math.round(R / 40));
    for (let z = info.origin_z + 4; z < info.origin_z + sz - 4; z += step) {
      for (let x = info.origin_x + 4; x < info.origin_x + sx - 4; x += step) {
        const h = world.sample(x, z);
        if (h < sea + 3) continue;
        const dx = world.sample(x + 1.5, z) - world.sample(x - 1.5, z);
        const dz = world.sample(x, z + 1.5) - world.sample(x, z - 1.5);
        const s = Math.hypot(dx, dz);
        if (s > best) {
          best = s;
          bx = x;
          bz = z;
          bh = h;
          gx = dx;
          gz = dz;
        }
      }
    }
    const gl = Math.hypot(gx, gz) || 1;
    // stand on the downhill side (terrain rises along +gradient), a little above ground
    const px = bx - (gx / gl) * 0.12 * R;
    const pz = bz - (gz / gl) * 0.12 * R;
    cams.cliff = { pos: [px, Math.max(world.sample(px, pz), sea) + 2.2, pz], target: [bx, bh + 0.5, bz], fov: 50 };
  }

  // over-the-shoulder at the spawn (what the follow camera shows at start)
  const sp = spawnXZ(ctx);
  if (sp) {
    const y = world.sample(sp[0], sp[1]);
    cams.player = { pos: [sp[0] + 2.8, y + 3.4, sp[1] + 6.6], target: [sp[0], y + 1.0, sp[1] - 1.5], fov: 52 };
  }

  // 'close' is framed on the first creature (they spawn deterministically from the seed)
  if (ctx.game.has('creatures')) {
    const ch = ctx.game.channel('creatures');
    const d = ch.data;
    if (ch.len >= ch.stride) {
      const x = d[3]!;
      const y = d[4]!;
      const z = d[5]!;
      const yaw = d[6]!;
      // try a ring of angles starting in front of the creature; keep the first with a clear line of sight
      // (no flora within ~1 m of the camera->creature segment in the xz plane)
      const flora = ctx.game.has('flora') ? ctx.game.channel('flora') : null;
      const fd = flora?.data;
      const fs = flora?.stride ?? 8;
      const fn = flora ? Math.floor(flora.len / fs) : 0;
      const clearance = (cx: number, cz: number): number => {
        let m = 99;
        const dx = x - cx;
        const dz = z - cz;
        const l2 = dx * dx + dz * dz || 1;
        for (let i = 0; i < fn; i++) {
          const fx = fd![i * fs + 1]!;
          const fz = fd![i * fs + 3]!;
          const t = Math.min(1, Math.max(0, ((fx - cx) * dx + (fz - cz) * dz) / l2));
          m = Math.min(m, Math.hypot(fx - (cx + dx * t), fz - (cz + dz * t)));
        }
        return m;
      };
      let best: { pos: Vec3; score: number } | null = null;
      for (let k = 0; k < 12; k++) {
        const a = yaw + 0.45 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.52; // 0.45, -0.07, 0.97, -0.59, ...
        const cx = x + Math.sin(a) * 2.7;
        const cz = z + Math.cos(a) * 2.7;
        const cy = Math.max(world.sample(cx, cz), world.seaLevel) + 1.05;
        const score = clearance(cx, cz);
        if (!best || score > best.score) best = { pos: [cx, cy, cz], score };
        if (score > 1.0) break;
      }
      cams.close = { pos: best!.pos, target: [x, y + 0.45, z], fov: 40 };
    }
  }
  return cams;
}
