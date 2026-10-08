/**
 * Cinematic camera director on top of the engine's photo camera (`window.__game.setCam` / `getCam`): glides through
 * keyframes, then hands the camera back with `setCam('game')`. The follow camera module is never touched.
 */
export interface Key {
  pos: [number, number, number];
  target: [number, number, number];
  fov?: number;
  /** seconds to reach this key from the previous one */
  t: number;
  /** seconds to hold after arriving */
  hold?: number;
}

const ease = (x: number): number => x * x * (3 - 2 * x);
const mix = (a: number[], b: number[], k: number): [number, number, number] => [a[0]! + (b[0]! - a[0]!) * k, a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k];

export class CamDirector {
  private keys: Key[] = [];
  private from: Key | null = null;
  private i = 0;
  private t = 0;
  private holdLeft = 0;
  private onDone: (() => void) | null = null;
  active = false;
  /** 0-1 progress through the whole shot list (for captions) */
  elapsed = 0;

  play(keys: Key[], onDone?: () => void): void {
    const cam = window.__game.getCam();
    this.from = { pos: cam.pos, target: cam.target, fov: cam.fov, t: 0 };
    this.keys = keys;
    this.i = 0;
    this.t = 0;
    this.holdLeft = 0;
    this.elapsed = 0;
    this.onDone = onDone ?? null;
    this.active = true;
  }

  /** stop and hand the camera back */
  release(): void {
    if (!this.active) return;
    this.active = false;
    window.__game.setCam('game');
    const cb = this.onDone;
    this.onDone = null;
    cb?.();
  }

  update(dt: number): void {
    if (!this.active || !this.from) return;
    this.elapsed += dt;
    const k = this.keys[this.i];
    if (!k) {
      this.release();
      return;
    }
    let pos: [number, number, number];
    let target: [number, number, number];
    let fov: number;
    if (this.t < k.t) {
      this.t += dt;
      const e = ease(Math.min(1, this.t / Math.max(0.001, k.t)));
      pos = mix(this.from.pos, k.pos, e);
      target = mix(this.from.target, k.target, e);
      fov = (this.from.fov ?? 52) + ((k.fov ?? this.from.fov ?? 52) - (this.from.fov ?? 52)) * e;
      if (this.t >= k.t) this.holdLeft = k.hold ?? 0;
    } else {
      this.holdLeft -= dt;
      pos = k.pos;
      target = k.target;
      fov = k.fov ?? this.from.fov ?? 52;
      if (this.holdLeft <= 0) {
        this.from = k;
        this.i++;
        this.t = 0;
        if (this.i >= this.keys.length) {
          window.__game.setCam({ pos, target, fov });
          this.release();
          return;
        }
      }
    }
    window.__game.setCam({ pos, target, fov });
  }
}
