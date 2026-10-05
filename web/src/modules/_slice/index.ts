/**
 * `_slice` -- PLACEHOLDER reference slice (order 50). NOT part of the final game: it exists so the engine, the
 * bridge (real wasm or mock), the galleries and the screenshot tools can be exercised end-to-end from day one.
 *
 * It renders whatever the bridge provides: terrain mesh from `world.height`, water plane, instanced flora from the
 * `flora` channel, interpolated creatures, the player and a third-person follow camera (mouse-look + WASD).
 * Sun / sky / fog / shadows come from the engine's Lighting (driven by the `time` channel).
 *
 * Delete this folder when the real world / flora / creatures / characters modules take over
 * (or run `/?view=game&without=_slice`).
 */
import { CircleGeometry, Color, Mesh, Object3D, Vector3 } from 'three';
import type { Ctx, GameModule } from '../../engine/types';
import { defineModule } from '../../engine/types';
import { buildCreatures, type CreatureSystem } from './creatures';
import { buildFlora, type FloraSystem } from './flora';
import { PlayerAvatar } from './player';
import { buildTerrain } from './terrain';
import { buildWater, type Water } from './water';
import { deriveCams, spawnXZ } from './cams';

interface State {
  root: Object3D;
  terrain: Mesh | null;
  water: Water | null;
  flora: FloraSystem | null;
  creatures: CreatureSystem | null;
  player: PlayerAvatar;
  worldVer: number;
  floraVer: number;
  camPos: Vector3;
  camLook: Vector3;
  camInit: boolean;
  fallback: Mesh | null;
}

let S: State | null = null;

const tmp = new Vector3();
const desired = new Vector3();
const target = new Vector3();

function rebuildWorld(ctx: Ctx, s: State): void {
  const world = ctx.game.world;
  if (s.terrain) {
    s.root.remove(s.terrain);
    s.terrain.geometry.dispose();
    (s.terrain.material as { dispose(): void }).dispose();
    s.terrain = null;
  }
  if (s.fallback) {
    s.root.remove(s.fallback);
    s.fallback = null;
  }
  if (!world.ready) {
    // No world from the sim (yet): a flat meadow disc keeps the scene readable and says so loudly in the console.
    console.warn('[_slice] no world.height from the bridge: rendering a flat fallback ground');
    const geo = new CircleGeometry(160, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = ctx.mats.ground({ vertexColors: false, color: new Color('#7BD35A'), name: 'slice.fallback' });
    s.fallback = new Mesh(geo, mat);
    s.fallback.receiveShadow = true;
    s.root.add(s.fallback);
    return;
  }
  const info = world.info!;
  s.terrain = buildTerrain(world, ctx.mats);
  s.root.add(s.terrain);
  if (s.water) s.water.refresh(world);
  else {
    s.water = buildWater(world, ctx.uniforms);
    s.root.add(s.water.mesh);
  }
  ctx.uniforms.uWorldSize.value.set(world.extentX, world.extentZ, info.origin_x, info.origin_z);
}

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

function followCamera(ctx: Ctx, s: State, dt: number): void {
  const p = ctx.game.player;
  if (!p.valid) return;
  const inp = ctx.input;
  const yaw = inp.yaw;
  const pitch = inp.pitch;
  const dist = 4.3 + inp.zoom * 5.4;
  // look target: shoulder height + a little look-ahead along the velocity
  target.set(p.pos.x + p.vel.x * 0.22, p.pos.y + 0.95, p.pos.z + p.vel.z * 0.22);
  const cp = Math.cos(pitch);
  desired.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).multiplyScalar(dist).add(target);
  // keep the camera above the terrain and the water surface
  const world = ctx.game.world;
  if (world.ready) {
    const g = Math.max(world.sample(desired.x, desired.z), world.seaLevel) + 0.55;
    if (desired.y < g) desired.y = g;
  }
  if (!s.camInit) {
    s.camPos.copy(desired);
    s.camLook.copy(target);
    s.camInit = true;
  } else {
    const k = 1 - Math.exp(-9 * Math.max(dt, 1 / 240));
    s.camPos.lerp(desired, dt > 0 ? k : 1);
    s.camLook.lerp(target, dt > 0 ? 1 - Math.exp(-14 * Math.max(dt, 1 / 240)) : 1);
  }
  const cam = ctx.camera;
  cam.position.copy(s.camPos);
  cam.lookAt(s.camLook);
  if (cam.fov !== 52) {
    cam.fov = 52;
    cam.updateProjectionMatrix();
  }
}

const mod: GameModule = defineModule({
  name: '_slice',
  order: 50,

  async init(ctx) {
    const root = new Object3D();
    root.name = 'slice.root';
    ctx.scene.add(root);
    S = {
      root,
      terrain: null,
      water: null,
      flora: null,
      creatures: null,
      player: new PlayerAvatar(ctx.mats),
      worldVer: -1,
      floraVer: -1,
      camPos: new Vector3(),
      camLook: new Vector3(),
      camInit: false,
      fallback: null,
    };
    root.add(S.player.group);
    rebuildWorld(ctx, S);
    S.worldVer = ctx.game.world.version;
    rebuildFlora(ctx, S);
    S.floraVer = ctx.game.has('flora') ? ctx.game.channel('flora').ver : 0;
    if (ctx.game.has('creatures')) {
      S.creatures = buildCreatures(ctx.game.channel('creatures'), ctx.mats);
      root.add(S.creatures.group);
    }
    // start the follow camera behind the player, looking along the way the player faces
    const p0 = ctx.game.player;
    ctx.input.setLook(p0.valid ? p0.yaw + Math.PI : 0, 0.38, 0.4);
    ctx.debug.line('slice', () => `flora ${S?.flora?.count ?? 0} · world v${S?.worldVer ?? '-'}`);
  },

  update(ctx, dt) {
    const s = S;
    if (!s) return;
    const world = ctx.game.world;
    const wv = world.version;
    if (wv !== s.worldVer) {
      s.worldVer = wv;
      rebuildWorld(ctx, s);
    }
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
    s.creatures?.update(ctx.clock.alpha, ctx.bend);
    followCamera(ctx, s, dt);
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
    S.creatures?.dispose();
    S.water?.dispose();
    S.player.dispose();
    S.root.parent?.remove(S.root);
    S = null;
  },
});

export default mod;
