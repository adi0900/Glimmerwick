/**
 * Small deterministic PRNG for JS-side visuals (jitter, scatter, variation). Gameplay randomness lives in Rust
 * (`sim_core::Rng`); this is only for things the renderer invents (variation seeds, particle jitter, ...).
 * Same (seed, name) => same sequence, on every machine.
 */

/** 32-bit FNV-1a string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32-bit integer mix (murmur3 finaliser). */
export function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export class Rng {
  private s: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = this.seed;
  }

  /** uniform float in [0, 1) (mulberry32) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: ArrayLike<T>): T {
    return arr[this.int(arr.length)]!;
  }

  /** approx. standard normal (sum of 4 uniforms, Irwin-Hall) */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  /** an independent child stream, stable for (this.seed, name) */
  fork(name: string): Rng {
    return new Rng(mix32(this.seed ^ hashString(name)));
  }
}

/** Build the per-name factory used by `ctx.rngFor`. */
export function makeRngFactory(worldSeed: number) {
  return (name: string) => new Rng(mix32((worldSeed >>> 0) ^ hashString(name)));
}
