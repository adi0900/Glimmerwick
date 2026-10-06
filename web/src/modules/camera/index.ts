/**
 * `camera` -- third-person camera rig (order 60). Replaces the old lerp follow camera of `_slice`.
 *
 *  - FOCUS: the look target (player head + a look-ahead along the low-passed sim velocity) is followed by a
 *    critically damped spring (exact closed form => frame-rate independent, no overshoot, zero jitter at 144 Hz). The
 *    camera sits on a RIGID arm around the focus, so mouse-look has no lag and the follow has weight.
 *  - INPUT TIMING: everything is evaluated in render-frame time from `ctx.game.player`, which is already interpolated
 *    with the sim alpha; the stepwise sim velocity is low-passed (`velTau`) so the 20 Hz stepping of the movement model
 *    never reaches the screen.
 *  - COLLISION: the arm is ray-cast through the live voxel data (`vox.data`) from the head and from the focus; corners are
 *    checked with a small cross around the camera; pull-in is instant, relaxing out is a slow ease.
 *  - AUTO-RECENTER: after `recenterDelay` s without mouse input, moving sideways swings the yaw gently toward the travel
 *    direction (rate ~ sin(angle), so straight ahead / straight back never turn it).
 *  - SPRINT FOV kick from `speed01`, eased over `fovTau`.
 *  - F4 panel: camera constants + every sim movement constant (query `player.tuning`, command `player.tune`), presets
 *    saved to localStorage.
 *
 * Numeric mirror: `tools/trace-movement.mjs` (RIG) must follow RIG_DEFAULTS.
 */
import type { Ctx } from '../../engine/types';
import { defineModule } from '../../engine/types';

export const RIG_DEFAULTS = {
  /** focus spring stiffness (rad/s) horizontally / vertically (critically damped) */
  omegaXZ: 10,
  omegaY: 6,
  /** seconds of smoothed velocity the look target leads the player by */
  lookAhead: 0.28,
  /** time constant (s) of the velocity low-pass feeding look-ahead / recenter / fov */
  velTau: 0.12,
  /** look target height above the feet (m) */
  head: 0.95,
  /** arm length = armBase + zoom * armZoom (m) */
  armBase: 4.3,
  armZoom: 5.4,
  fov: 52,
  /** fov multiplier at full sprint (spec design default 1.12); 1 = no kick */
  fovKick: 1.12,
  fovTau: 0.15,
  collideRadius: 0.28,
  collideMargin: 0.3,
  minArm: 0.7,
  /** how fast the arm relaxes back out after a collision (1/s) */
  armOutRate: 2.5,
  /** auto-recenter: max yaw speed (rad/s, 0 = off), idle delay (s), minimum speed (m/s) */
  recenterRate: 0.6,
  recenterDelay: 1.2,
  recenterMinSpeed: 2.0,
};
export type RigTuning = typeof RIG_DEFAULTS;

function wrapPi(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Read-only view of the live voxel channel (chunk-major, see BRIDGE_API "voxel world"). */
class VoxelGrid {
  ready = false;
  private data: Uint16Array | null = null;
  private solid = new Uint8Array(65536);
  private nx = 352;
  private nz = 288;
  private ny = 56;
  private chunk = 16;
  private ncx = 22;
  private perChunk = 14336;
  private ox = -160;
  private oy = -14;
  private oz = -136;

  init(ctx: Ctx): void {
    if (!ctx.game.has('vox.data')) return;
    const info = ctx.game.world.info as any;
    const v = info?.vox;
    if (v) {
      this.nx = v.nx ?? this.nx;
      this.nz = v.nz ?? this.nz;
      this.ny = v.ny ?? this.ny;
      this.chunk = v.chunk ?? this.chunk;
      this.ncx = v.ncx ?? this.ncx;
      this.perChunk = v.cells_per_chunk ?? this.chunk * this.chunk * this.ny;
      if (Array.isArray(v.origin)) {
        this.ox = v.origin[0] ?? this.ox;
        this.oy = v.origin[1] ?? this.oy;
        this.oz = v.origin[2] ?? this.oz;
      }
    }
    try {
      const reg = ctx.game.query('world.blocks', {}) as any;
      for (const b of reg?.blocks ?? []) if (b.solid && b.id < 65536) this.solid[b.id] = 1;
    } catch {
      for (let i = 1; i < 40; i++) this.solid[i] = i === 16 ? 0 : 1;
    }
    this.ready = true;
  }

  /** the channel view can be rebuilt after a wasm memory growth: re-read it every frame */
  refresh(ctx: Ctx): void {
    if (this.ready) this.data = ctx.game.channel<Uint16Array>('vox.data').data;
  }

  isSolid(x: number, y: number, z: number): boolean {
    const d = this.data;
    if (!d) return false;
    const bx = x - this.ox;
    const bz = z - this.oz;
    const layer = y - this.oy;
    if (bx < 0 || bz < 0 || bx >= this.nx || bz >= this.nz) return false;
    if (layer < 0) return true;
    if (layer >= this.ny) return false;
    const cx = Math.floor(bx / this.chunk);
    const cz = Math.floor(bz / this.chunk);
    const lx = bx - cx * this.chunk;
    const lz = bz - cz * this.chunk;
    const idx = (cz * this.ncx + cx) * this.perChunk + (lz * this.chunk + lx) * this.ny + layer;
    const id = d[idx];
    return id !== undefined && this.solid[id] === 1;
  }

  /** distance along the unit direction to the first solid block (0 = start inside one), or `max` */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    let cx = Math.floor(ox);
    let cy = Math.floor(oy);
    let cz = Math.floor(oz);
    if (this.isSolid(cx, cy, cz)) return 0;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? cx + 1 : cx) - ox) / dx : Infinity;
    let tmy = dy !== 0 ? ((dy > 0 ? cy + 1 : cy) - oy) / dy : Infinity;
    let tmz = dz !== 0 ? ((dz > 0 ? cz + 1 : cz) - oz) / dz : Infinity;
    for (let i = 0; i < 96; i++) {
      let t: number;
      if (tmx <= tmy && tmx <= tmz) {
        t = tmx;
        if (t > max) return max;
        cx += sx;
        tmx += tdx;
      } else if (tmy <= tmz) {
        t = tmy;
        if (t > max) return max;
        cy += sy;
        tmy += tdy;
      } else {
        t = tmz;
        if (t > max) return max;
        cz += sz;
        tmz += tdz;
      }
      if (this.isSolid(cx, cy, cz)) return t;
    }
    return max;
  }

  blockedAt(x: number, y: number, z: number): boolean {
    return this.isSolid(Math.floor(x), Math.floor(y), Math.floor(z));
  }
}

export class CameraRig {
  readonly tuning: RigTuning = { ...RIG_DEFAULTS };
  readonly grid = new VoxelGrid();
  /** smoothed focus point and its velocity */
  private readonly f = new Float64Array(3);
  private readonly fv = new Float64Array(3);
  private readonly tgt = new Float64Array(3);
  private readonly vs = new Float64Array(2);
  private arm = 0;
  private fovT = 0;
  private idle = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private started = false;
  /** last arm length / collision state for the F3 line */
  armNow = 0;
  armWanted = 0;

  init(ctx: Ctx): void {
    this.grid.init(ctx);
    this.lastYaw = ctx.input.yaw;
    this.lastPitch = ctx.input.pitch;
  }

  update(ctx: Ctx, dt: number): void {
    const p = ctx.game.player;
    if (!p.valid) return;
    const T = this.tuning;
    const inp = ctx.input;
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.grid.refresh(ctx);

    // smoothed velocity (look-ahead, recenter, fov)
    if (!this.started) {
      this.vs[0] = p.vel.x;
      this.vs[1] = p.vel.z;
    } else if (step > 0) {
      const kv = 1 - Math.exp(-step / T.velTau);
      this.vs[0]! += (p.vel.x - this.vs[0]!) * kv;
      this.vs[1]! += (p.vel.z - this.vs[1]!) * kv;
    }
    const vx = this.vs[0]!;
    const vz = this.vs[1]!;
    const speed = Math.hypot(vx, vz);

    // gentle auto-recenter while moving without mouse input
    const moved = Math.abs(inp.yaw - this.lastYaw) > 1e-5 || Math.abs(inp.pitch - this.lastPitch) > 1e-5;
    if (moved) this.idle = 0;
    else this.idle += step;
    if (step > 0 && T.recenterRate > 0 && inp.lookEnabled && inp.enabled && this.idle > T.recenterDelay && speed > T.recenterMinSpeed) {
      const delta = wrapPi(Math.atan2(-vx, -vz) - inp.yaw);
      inp.yaw = wrapPi(inp.yaw + Math.sin(delta) * T.recenterRate * step);
    }
    this.lastYaw = inp.yaw;
    this.lastPitch = inp.pitch;

    // focus spring (critically damped, exact)
    this.tgt[0] = p.pos.x + vx * T.lookAhead;
    this.tgt[1] = p.pos.y + T.head;
    this.tgt[2] = p.pos.z + vz * T.lookAhead;
    const far = Math.hypot(this.tgt[0]! - this.f[0]!, this.tgt[2]! - this.f[2]!) > 10 || Math.abs(this.tgt[1]! - this.f[1]!) > 10;
    if (!this.started || far) {
      this.f.set(this.tgt);
      this.fv.fill(0);
    } else if (step > 0) {
      for (let i = 0; i < 3; i++) {
        const om = i === 1 ? T.omegaY : T.omegaXZ;
        const x = this.f[i]! - this.tgt[i]!;
        const e = Math.exp(-om * step);
        const tmp = (this.fv[i]! + om * x) * step;
        this.fv[i] = (this.fv[i]! - om * tmp) * e;
        this.f[i] = this.tgt[i]! + (x + tmp) * e;
      }
    }

    // spring arm with voxel collision
    const cp = Math.cos(inp.pitch);
    const dx = Math.sin(inp.yaw) * cp;
    const dy = Math.sin(inp.pitch);
    const dz = Math.cos(inp.yaw) * cp;
    const want = T.armBase + inp.zoom * T.armZoom;
    let d = want;
    if (this.grid.ready) {
      const reach = want + T.collideMargin;
      const fromHead = this.grid.ray(p.pos.x, p.pos.y + T.head, p.pos.z, dx, dy, dz, reach);
      const fromFocus = this.grid.ray(this.f[0]!, this.f[1]!, this.f[2]!, dx, dy, dz, reach);
      const hit = Math.min(fromHead, fromFocus === 0 ? Infinity : fromFocus);
      d = Math.min(want, hit - T.collideMargin);
      // corners: a small cross around the camera must be free
      const rx = Math.cos(inp.yaw);
      const rz = -Math.sin(inp.yaw);
      const ux = -Math.sin(inp.yaw) * Math.sin(inp.pitch);
      const uy = Math.cos(inp.pitch);
      const uz = -Math.cos(inp.yaw) * Math.sin(inp.pitch);
      const r = T.collideRadius;
      for (let k = 0; k < 12; k++) {
        const cx = this.f[0]! + dx * d;
        const cy = this.f[1]! + dy * d;
        const cz = this.f[2]! + dz * d;
        const free =
          !this.grid.blockedAt(cx, cy, cz) &&
          !this.grid.blockedAt(cx + rx * r, cy, cz + rz * r) &&
          !this.grid.blockedAt(cx - rx * r, cy, cz - rz * r) &&
          !this.grid.blockedAt(cx + ux * r, cy + uy * r, cz + uz * r) &&
          !this.grid.blockedAt(cx - ux * r, cy - uy * r, cz - uz * r);
        if (free) break;
        d -= 0.2;
      }
      d = Math.max(T.minArm, d);
    }
    if (!this.started || d < this.arm) this.arm = d;
    else if (step > 0) this.arm += (d - this.arm) * (1 - Math.exp(-T.armOutRate * step));
    this.arm = Math.min(this.arm, want);
    this.armNow = this.arm;
    this.armWanted = want;

    // sprint fov kick
    const kick = smoothstep(0.8, 0.98, p.speed01);
    if (!this.started) this.fovT = kick;
    else if (step > 0) this.fovT += (kick - this.fovT) * (1 - Math.exp(-step / T.fovTau));
    const fov = T.fov * (1 + (T.fovKick - 1) * this.fovT);

    const cam = ctx.camera;
    cam.position.set(this.f[0]! + dx * this.arm, this.f[1]! + dy * this.arm, this.f[2]! + dz * this.arm);
    cam.lookAt(this.f[0]!, this.f[1]!, this.f[2]!);
    if (Math.abs(cam.fov - fov) > 0.005) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.started = true;
  }
}

// --- F4 panel ----------------------------------------------------------------------------------------------

const PRESET_KEY = 'glimmerwick.feel.v1';

function buildGui(ctx: Ctx, rig: CameraRig): void {
  let gui;
  try {
    gui = ctx.debug.gui();
  } catch {
    return;
  }
  // the shared panel is hidden until F4 (the engine toggles `display`), so automated screenshots stay clean
  gui.domElement.style.display = 'none';
  const root = gui.addFolder('Movement + camera');
  const T = rig.tuning;
  const cam = root.addFolder('Camera rig');
  cam.add(T, 'omegaXZ', 2, 30, 0.1).name('follow stiffness xz');
  cam.add(T, 'omegaY', 1, 30, 0.1).name('follow stiffness y');
  cam.add(T, 'lookAhead', 0, 0.8, 0.01).name('look-ahead (s)');
  cam.add(T, 'velTau', 0.02, 0.5, 0.01).name('velocity low-pass (s)');
  cam.add(T, 'head', 0.4, 1.6, 0.01).name('look target height');
  cam.add(T, 'armBase', 1, 10, 0.05).name('arm base');
  cam.add(T, 'armZoom', 0, 12, 0.1).name('arm zoom range');
  cam.add(T, 'fov', 30, 80, 0.5).name('fov');
  cam.add(T, 'fovKick', 1, 1.4, 0.005).name('sprint fov kick x');
  cam.add(T, 'fovTau', 0.02, 0.6, 0.01).name('fov ease (s)');
  cam.add(T, 'armOutRate', 0.5, 12, 0.1).name('arm relax rate');
  cam.add(T, 'recenterRate', 0, 2, 0.05).name('auto-recenter (rad/s)');
  cam.add(T, 'recenterDelay', 0, 4, 0.1).name('recenter delay (s)');
  cam.close();

  const sim = root.addFolder('Movement (sim, per 20 Hz tick)');
  const values: Record<string, number> = {};
  const keys: string[] = [];
  try {
    const res = ctx.game.query('player.tuning', {}) as any;
    for (const f of res?.fields ?? []) {
      values[f.key] = f.value;
      keys.push(f.key);
      sim.add(values, f.key, f.min, f.max, f.step).onChange((v: number) => ctx.game.command('player.tune', { key: f.key, value: v }, true));
    }
  } catch {
    /* mock bridge: no sim tuning */
  }
  sim.close();

  const refreshAll = (): void => {
    try {
      const res = ctx.game.query('player.tuning', {}) as any;
      for (const f of res?.fields ?? []) values[f.key] = f.value;
    } catch {
      /* ignore */
    }
    (root as any).controllersRecursive?.().forEach((c: any) => c.updateDisplay());
  };
  const presets = {
    save: () => {
      try {
        localStorage.setItem(PRESET_KEY, JSON.stringify({ cam: { ...T }, sim: { ...values } }));
      } catch {
        /* storage blocked */
      }
    },
    load: () => {
      try {
        const s = JSON.parse(localStorage.getItem(PRESET_KEY) ?? 'null');
        if (!s) return;
        Object.assign(T, s.cam ?? {});
        for (const k of keys) {
          const v = s.sim?.[k];
          if (typeof v === 'number') {
            values[k] = v;
            ctx.game.command('player.tune', { key: k, value: v }, true);
          }
        }
        (root as any).controllersRecursive?.().forEach((c: any) => c.updateDisplay());
      } catch {
        /* no preset */
      }
    },
    reset: () => {
      Object.assign(T, RIG_DEFAULTS);
      ctx.game.command('player.tune_reset', {}, true);
      refreshAll();
    },
  };
  root.add(presets, 'save').name('save preset');
  root.add(presets, 'load').name('load preset');
  root.add(presets, 'reset').name('reset to defaults');
  root.close();
}

let rig: CameraRig | null = null;

const mod = defineModule({
  name: 'camera',
  order: 60,
  needs: ['voxel'],

  async init(ctx) {
    rig = new CameraRig();
    // start behind the player, looking the way the player faces
    const p0 = ctx.game.player;
    ctx.input.setLook(p0.valid ? p0.yaw + Math.PI : 0, 0.38, 0.4);
    rig.init(ctx);
    ctx.api.cameraRig = rig;
    buildGui(ctx, rig);
    ctx.debug.line('camera', () => (rig ? `arm ${rig.armNow.toFixed(2)} / ${rig.armWanted.toFixed(2)} m` : '-'));
  },

  update(ctx, dt) {
    rig?.update(ctx, dt);
  },

  dispose() {
    rig = null;
  },
});

export default mod;
