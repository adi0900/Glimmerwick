/**
 * `creatures` module (order 55): renders the sim's `creatures` channel as micro-voxel actors, and hosts the
 * **creature lab** gallery (`/?view=creatures&set=sheet|variants|states|turn|sizes|group`): turntables, colour variants,
 * size lineup, states, group shot in the meadow, night glow. The player avatar is `modules/player/model.ts`
 * (rendered by `_slice` in-game; the lab instantiates its own copies).
 */
import { Object3D, Vector3 } from 'three';
import type { Ctx, GalleryCam } from '../../engine/types';
import { defineModule } from '../../engine/types';
import { sunDirFromHours } from '../../engine/Env';
import { VoxelAvatar } from '../player/model';
import { CreatureRenderer, type ActorRow } from './render';
import { SPECIES_BASE_SCALE, SPECIES_NAMES } from './species';

const MAX = 256;
const chOut = new Float32Array(MAX * 16);
const row: ActorRow = { id: 0, species: 0, variant: 0, x: 0, y: 0, z: 0, yaw: 0, scale: 1, state: 0, at: 0, mood: 0.5, emote: 0, flags: 0 };

interface LabActor {
  avatar: boolean;
  species: number;
  variant: number;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  state: number;
  mood: number;
  emote: number;
  flags: number;
  id: number;
}

function actor(p: Partial<LabActor>): LabActor {
  return { avatar: false, species: 0, variant: 0, x: 0, z: 0, yaw: 0, scale: 1, state: 0, mood: 0.7, emote: 0, flags: 0, id: 0, ...p };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function layout(set: string): LabActor[] {
  const out: LabActor[] = [];
  let id = 100;
  const bs = SPECIES_BASE_SCALE;
  if (set === 'variants' || set === 'states') {
    const states = [0, 3, 4, 5];
    for (let s = 0; s < 3; s++) {
      const n = set === 'variants' ? 3 : 4;
      for (let v = 0; v < n; v++)
        out.push(actor({ id: id++, species: s, variant: set === 'variants' ? v : 0, x: (v - (n - 1) / 2) * 1.45, z: -s * 1.55, yaw: 0.3, scale: bs[s]!, state: set === 'states' ? states[v]! : 0, mood: set === 'states' && v === 2 ? 0.2 : 0.8 }));
    }
  } else if (set === 'turn') {
    const views = [0.5, Math.PI / 2, Math.PI + 0.5];
    for (let r = 0; r < 3; r++) {
      out.push(actor({ id: id++, avatar: true, x: -3, z: -r * 2.2, yaw: views[r]! }));
      for (let s = 0; s < 3; s++) out.push(actor({ id: id++, species: s, x: -1 + s * 2, z: -r * 2.2, yaw: views[r]!, scale: bs[s]! }));
    }
  } else if (set === 'sizes') {
    out.push(actor({ id: id++, avatar: true, x: 0, z: -2.0, yaw: 0.1 }));
    for (let s = 0; s < 3; s++)
      [0.65, 1.0, 1.45].forEach((k, i) => out.push(actor({ id: id++, species: s, variant: i, x: (s - 1) * 3.6 + [-0.8, 0.1, 1.15][i]!, z: 0.6, yaw: 0.25, scale: bs[s]! * k })));
  } else if (set === 'group') {
    const rnd = lcg(7);
    out.push(actor({ id: id++, avatar: true, x: 0, z: -0.4, yaw: 0 }));
    const pts: [number, number][] = [[0, -0.4]];
    const sts = [0, 0, 0, 0, 0, 0, 1, 1, 6, 6, 5, 4, 3, 3, 0, 2];
    for (let n = 0; n < 16 && pts.length < 40; ) {
      const a = rnd() * Math.PI * 2;
      const r = 1.5 + rnd() * 4.2;
      const x = Math.cos(a) * r * 1.35;
      const z = Math.sin(a) * r * 0.75 - 0.2;
      if (z > 3.2 || pts.some((q) => Math.hypot(q[0] - x, q[1] - z) < 1.05)) {
        if (++n > 400) break;
        continue;
      }
      pts.push([x, z]);
      const k = pts.length - 2;
      const sp = k % 3;
      out.push(actor({ id: id++, species: sp, variant: Math.floor(rnd() * 3), x, z, yaw: Math.atan2(-x, 3 - z) * 0.5 + (rnd() - 0.5) * 1.4, scale: bs[sp]! * (0.85 + rnd() * 0.35), state: sts[k % sts.length]!, mood: 0.5 + rnd() * 0.5, emote: sts[k % sts.length] === 5 ? 2 : 0 }));
      if (pts.length > 16) break;
    }
  } else {
    // sheet: avatar + the three species (variant 0)
    out.push(actor({ id: id++, avatar: true, x: -2.1, yaw: 0.3 }));
    for (let s = 0; s < 3; s++) out.push(actor({ id: id++, species: s, x: -0.7 + s * 1.3, yaw: 0.4, scale: bs[s]! }));
  }
  return out;
}

interface Stage {
  x: number;
  y: number;
  z: number;
}

function findStage(ctx: Ctx): Stage {
  const w = ctx.game.world;
  const info = w.info as any;
  const spawn: [number, number] = info?.spawn?.player ?? [0, 0];
  const pond = info?.water?.pond as { x: number; z: number; rx?: number; rz?: number } | undefined;
  let best = { x: spawn[0], z: spawn[1], score: 1e9 };
  for (let dx = -36; dx <= 36; dx += 3)
    for (let dz = -36; dz <= 36; dz += 3) {
      const cx = spawn[0] + dx,
        cz = spawn[1] + dz;
      let lo = 1e9,
        hi = -1e9;
      for (let a = -6; a <= 6; a += 3)
        for (let b = -6; b <= 6; b += 3) {
          const h = w.sample(cx + a, cz + b);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      let pen = lo < 0.6 ? 100 : 0;
      if (pond && Math.hypot(cx - pond.x, cz - pond.z) < Math.max(pond.rx ?? 14, pond.rz ?? 14) + 12) pen += 100;
      const score = (hi - lo) * 10 + Math.hypot(dx, dz) * 0.04 + pen;
      if (score < best.score) best = { x: cx, z: cz, score };
    }
  return { x: best.x, y: w.sample(best.x, best.z), z: best.z };
}

class Lab {
  readonly actors: LabActor[];
  readonly stage: Stage;
  readonly yaw: number;
  readonly turn: number;
  readonly avatars: VoxelAvatar[] = [];
  readonly cams: Record<string, GalleryCam> = {};
  readonly player = new Vector3();
  private readonly world: Ctx['game']['world'];

  constructor(
    private readonly ctx: Ctx,
    root: Object3D,
    readonly set: string,
  ) {
    this.world = ctx.game.world;
    this.actors = layout(set);
    this.stage = findStage(ctx);
    // orient the stage so the key light (sun, or moon at night) hits the creatures' faces from the camera's front-left
    const tp = ctx.view.params.time ?? '16.5';
    const hours = tp.includes(':') ? Number(tp.split(':')[0]) + Number(tp.split(':')[1]) / 60 : Number(tp);
    const sd = sunDirFromHours(Number.isFinite(hours) ? hours : 16.5, new Vector3());
    const sgn = sd.y < 0.05 ? -1 : 1;
    this.yaw = ctx.view.params.ly !== undefined ? Number(ctx.view.params.ly) : Math.atan2(sd.x * sgn, sd.z * sgn) + 0.7;
    this.turn = Number(ctx.view.params.turn ?? 0);
    for (const a of this.actors) if (a.avatar) {
      const av = new VoxelAvatar(ctx, 'lab');
      root.add(av.group);
      this.avatars.push(av);
    }
    this.buildCams();
  }

  /** local stage coords (x right, y up, z toward the camera) -> world */
  L(x: number, y: number, z: number): [number, number, number] {
    const a = this.yaw,
      s = this.stage;
    return [s.x + x * Math.cos(a) + z * Math.sin(a), s.y + y, s.z - x * Math.sin(a) + z * Math.cos(a)];
  }

  private buildCams(): void {
    const c = this.cams;
    const L = (x: number, y: number, z: number): [number, number, number] => this.L(x, y, z);
    const sheet = this.set === 'sheet';
    c.sheet = { pos: L(0.1, 0.95, 6.0), target: L(-0.1, 0.5, 0), fov: 30 };
    c.far = { pos: L(0.1, 1.2, 15.5), target: L(-0.1, 0.4, 0), fov: 30 };
    c.variants = { pos: L(0, 4.4, 6.8), target: L(0, 0.2, -1.6), fov: 38 };
    c.turn = { pos: L(0, 3.6, 7.6), target: L(0, 0.35, -2.2), fov: 40 };
    c.sizes = { pos: L(0, 1.6, 9.0), target: L(0, 0.55, -0.4), fov: 36 };
    c.group = { pos: L(0.6, 1.7, 8.4), target: L(0, 0.35, -0.6), fov: 42 };
    c.groupLow = { pos: L(-2.4, 0.7, 6.6), target: L(0.2, 0.55, -0.6), fov: 46 };
    const near = (i: number, dist: number, h: number, az: number, fov: number, ty: number): GalleryCam => {
      const a = this.actors[i];
      if (!a) return c.sheet!;
      const yaw = this.yaw + a.yaw + az;
      const px = a.x,
        pz = a.z;
      const tgt = this.L(px, ty, pz);
      const pos = this.L(px, h, pz);
      pos[0] += Math.sin(yaw) * dist;
      pos[2] += Math.cos(yaw) * dist;
      return { pos, target: tgt, fov };
    };
    if (sheet) {
      c.avatar = near(0, 2.5, 0.85, 0.5, 28, 0.78);
      c.puffbun = near(1, 1.9, 0.5, 0.45, 28, 0.42);
      c.tidler = near(2, 1.7, 0.42, 0.45, 28, 0.3);
      c.sprigfox = near(3, 2.1, 0.55, 0.5, 28, 0.42);
      c.macro = near(1, 0.95, 0.5, 0.3, 24, 0.5);
      c.trio = { pos: L(0.7, 0.8, 4.2), target: L(0.6, 0.38, 0), fov: 32 };
      c.back = { pos: L(0.2, 1.2, -5.6), target: L(0, 0.5, 0), fov: 30 };
    }
  }

  update(rend: CreatureRenderer, t: number, dt: number): void {
    const w = this.world;
    let ai = 0;
    for (const a of this.actors) {
      const [wx, , wz] = this.L(a.x, 0, a.z);
      const wy = w.sample(wx, wz);
      const yaw = this.yaw + a.yaw + this.turn * t;
      if (a.avatar) {
        const av = this.avatars[ai++]!;
        const walk = a.state === 1;
        av.draw(wx, wy, wz, yaw, walk ? Math.sin(yaw) * 3.5 : 0, 0, walk ? Math.cos(yaw) * 3.5 : 0, walk ? 1 : 0, t, true, 0, dt);
        if (ai === 1) this.player.set(wx, wy, wz);
        continue;
      }
      row.id = a.id;
      row.species = a.species;
      row.variant = a.variant;
      row.x = wx;
      row.y = wy;
      row.z = wz;
      row.yaw = yaw;
      row.scale = a.scale;
      row.state = a.state;
      row.at = t + a.id * 0.37;
      row.mood = a.mood;
      row.emote = a.emote;
      row.flags = a.flags | (a.state === 3 ? 4 : 0);
      rend.add(row);
    }
  }
}

interface State {
  root: Object3D;
  rend: CreatureRenderer;
  lab: Lab | null;
}
let S: State | null = null;

function feedChannel(ctx: Ctx, rend: CreatureRenderer): void {
  if (!ctx.game.has('creatures')) return;
  const ch = ctx.game.channel('creatures');
  const stride = ch.stride || 16;
  const n = Math.min(ch.lerpRows(ctx.clock.alpha, chOut, { idField: 0, angleFields: [6], rows: MAX }), MAX);
  let benders = 0;
  for (let r = 0; r < n; r++) {
    const o = r * stride;
    row.id = chOut[o]!;
    row.species = chOut[o + 1]!;
    row.variant = chOut[o + 2]!;
    row.x = chOut[o + 3]!;
    row.y = chOut[o + 4]!;
    row.z = chOut[o + 5]!;
    row.yaw = chOut[o + 6]!;
    row.scale = chOut[o + 7]!;
    row.state = chOut[o + 8]!;
    row.at = chOut[o + 9]!;
    row.mood = chOut[o + 10]!;
    row.emote = chOut[o + 11]!;
    row.flags = chOut[o + 12]!;
    rend.add(row);
    if (benders < 10) {
      ctx.bend(row.x, row.y, row.z, 0.9 * row.scale);
      benders++;
    }
  }
}

const mod = defineModule({
  name: 'creatures',
  order: 55,
  needs: ['voxel'],

  init(ctx) {
    const root = new Object3D();
    root.name = 'creatures.root';
    ctx.scene.add(root);
    const rend = new CreatureRenderer(ctx);
    root.add(rend.group);
    const isLab = ctx.view.name === 'creatures';
    const lab = isLab ? new Lab(ctx, root, ctx.view.params.set ?? 'sheet') : null;
    S = { root, rend, lab };
    const sc = rend.models.map((m) => `${m.def.name} ${m.baked.voxels}v`).join(' · ');
    ctx.debug.line('creatures', () => `${S?.rend.actors ?? 0} actors · ${sc}`);
    if (lab) Object.assign(mod.gallery!.cams, lab.cams);
  },

  update(ctx, dt) {
    const s = S;
    if (!s) return;
    const lab = s.lab;
    const p = ctx.game.player;
    s.rend.begin(ctx.clock.t, dt, lab ? lab.player : p.valid ? p.pos : null);
    if (lab) {
      lab.update(s.rend, ctx.clock.t, dt);
      if (ctx.view.params.live) feedChannel(ctx, s.rend);
    } else feedChannel(ctx, s.rend);
    s.rend.end();
  },

  gallery: {
    cams: {
      sheet: { pos: [0, 2, 8], target: [0, 0.5, 0], fov: 32 },
    },
    setup(ctx) {
      const lab = S?.lab;
      if (!lab) return;
      Object.assign(mod.gallery!.cams, lab.cams);
      // keep the sim creatures out of the lab's way: park the player on the stage so nothing wanders in
      ctx.game.command('debug.teleport', { x: lab.stage.x + 14, z: lab.stage.z + 14 }, true);
    },
  },

  dispose() {
    if (!S) return;
    S.rend.dispose();
    S.lab?.avatars.forEach((a) => a.dispose());
    S.root.parent?.remove(S.root);
    S = null;
  },
});

void SPECIES_NAMES;
export default mod;
