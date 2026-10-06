/**
 * `_slice` -- PLACEHOLDER reference slice (order 50). NOT part of the final game: it exists so the engine, the
 * bridge (real wasm or mock), the galleries and the screenshot tools can be exercised end-to-end from day one.
 *
 * It renders whatever the bridge provides: instanced flora from the `flora` channel and the player avatar (the
 * micro-voxel explorer from `modules/player/model.ts`; mouse-look + WASD are the engine Input; the third-person
 * follow camera lives in `modules/camera`, which also owns the F4 movement + camera panel).
 * The `creatures` channel is rendered by the `creatures` module (voxel actors) -- the smooth placeholders are gone.
 * Sun / sky / fog / shadows come from the engine's Lighting (driven by the `time` channel).
 *
 * Delete this folder when the real world / flora / characters modules take over
 * (or run `/?view=game&without=_slice`).
 */
import { Object3D } from 'three';
import type { Ctx, GameModule } from '../../engine/types';
import { defineModule } from '../../engine/types';
import { VoxelAvatar } from '../player/model';
import { buildFlora, type FloraSystem } from './flora';
import { deriveCams, spawnXZ } from './cams';

interface State {
  root: Object3D;
  flora: FloraSystem | null;
  player: VoxelAvatar;
  worldVer: number;
  floraVer: number;
}

let S: State | null = null;

function rebuildFlora(ctx: Ctx, s: State): void {
  if (s.flora) {
    s.root.remove(s.flora.group);
    s.flora.dispose();
    s.flora = null;
  }
  if (!ctx.game.has('flora')) return;
  const ch = ctx.game.channel('flora');
  if (ch.len === 0) return;
  s.flora = buildFlora(ch, ctx.mats, ctx.rngFor('_slice.flora'), ctx.game.world.info?.flora_kinds as string[] | undefined);
  s.root.add(s.flora.group);
}

const mod: GameModule = defineModule({
  name: '_slice',
  order: 50,
  needs: ['voxel'],

  async init(ctx) {
    const root = new Object3D();
    root.name = 'slice.root';
    ctx.scene.add(root);
    S = {
      root,
      flora: null,
      player: new VoxelAvatar(ctx, 'player'),
      worldVer: -1,
      floraVer: -1,
    };
    root.add(S.player.group);
    S.worldVer = ctx.game.world.version;
    rebuildFlora(ctx, S);
    S.floraVer = ctx.game.has('flora') ? ctx.game.channel('flora').ver : 0;
    ctx.debug.line('slice', () => `flora ${S?.flora?.count ?? 0} · world v${S?.worldVer ?? '-'}`);
  },

  update(ctx, dt) {
    const s = S;
    if (!s) return;
    const world = ctx.game.world;
    if (ctx.game.has('flora')) {
      const fv = ctx.game.channel('flora').ver;
      if (fv !== s.floraVer) {
        s.floraVer = fv;
        rebuildFlora(ctx, s);
      }
    }
    const p = ctx.game.player;
    s.player.update(p, dt, world.seaLevel);
    if (p.valid) ctx.bend(p.pos.x, p.pos.y, p.pos.z, 1.1);
  },

  gallery: {
    // defaults for the mock island; `setup` replaces them with cams derived from the real world data
    cams: {
      wide: { pos: [14, 46, 128], target: [-6, 2, 8], fov: 50 },
      close: { pos: [26, 2.3, 31], target: [21, 0.9, 22], fov: 46 },
      player: { pos: [-3.2, 4.9, 41.6], target: [-6, 1.9, 34], fov: 52 },
      shore: { pos: [24, 1.7, 112], target: [10, 0.2, 80], fov: 50 },
      cliff: { pos: [-6, 9, 2], target: [-30, 7, -30], fov: 50 },
      top: { pos: [0, 230, 1], target: [0, 0, 0], fov: 40 },
    },
    setup(ctx) {
      const sp = spawnXZ(ctx);
      if (sp) ctx.game.command('debug.teleport', { x: sp[0], z: sp[1] }, true);
      Object.assign(mod.gallery!.cams, deriveCams(ctx));
    },
  },

  dispose() {
    if (!S) return;
    S.flora?.dispose();
    S.player.dispose();
    S.root.parent?.remove(S.root);
    S = null;
  },
});

export default mod;
