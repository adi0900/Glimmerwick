/**
 * Procedural painted tile atlas (voxel world). Every tile is a seamless 64 px painting generated at load from the
 * registry's tile *names* (`world.blocks` -> `tex`): layered value-noise blotches, brush strokes, Worley stones and
 * hand-placed details (flowers, pebbles, fruit, nails ...). Unknown names fall back to a hashed colour so new blocks
 * never break the atlas. The result is one `DataArrayTexture` (one layer per tile): no atlas bleeding, trilinear mips.
 */
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

/** atlas tile size (px). Procedural recipes paint at `S` = 64 and are 2x nearest-upscaled; AI tiles are native 128. */
export const TILE = 128;
const S = 64;
type RGB = [number, number, number];

const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (i: number, n: number): number => ((i % n) + n) % n;

/** variant seed offset: every variant layer is a different painting */
let VS = 0;

function rnd(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s | 0) + VS * 7919, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** periodic value noise, (u, v) in [0, 1) tile space, `per` lattice cells per tile */
function vn(u: number, v: number, per: number, s: number): number {
  const x = u * per;
  const y = v * per;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const xa = wrap(x0, per);
  const xb = wrap(x0 + 1, per);
  const ya = wrap(y0, per);
  const yb = wrap(y0 + 1, per);
  const a = rnd(xa, ya, s);
  const b = rnd(xb, ya, s);
  const c = rnd(xa, yb, s);
  const d = rnd(xb, yb, s);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

function fbm(u: number, v: number, per: number, oct: number, s: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * vn(u, v, per * (1 << o), s + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/** tileable Worley: [F1, F2, cell id hash] */
function worley(u: number, v: number, cells: number, s: number): [number, number, number] {
  const x = u * cells;
  const y = v * cells;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const wx = wrap(gx, cells);
      const wy = wrap(gy, cells);
      const px = gx + 0.15 + 0.7 * rnd(wx, wy, s);
      const py = gy + 0.15 + 0.7 * rnd(wx, wy, s + 5);
      const d = Math.hypot(x - px, y - py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = rnd(wx, wy, s + 9);
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2, id];
}

class Img {
  readonly d = new Float32Array(S * S * 3);
  /** coverage (1 = opaque painting; overlay images start at 0 and are composited over an AI base tile) */
  readonly m = new Float32Array(S * S);
  constructor(opaque = true) {
    if (opaque) this.m.fill(1);
  }
  px(x: number, y: number, c: RGB, a = 1): void {
    const j = wrap(Math.round(y), S) * S + wrap(Math.round(x), S);
    const i = j * 3;
    const m0 = this.m[j]!;
    const m1 = a + m0 * (1 - a);
    const k = m0 * (1 - a);
    this.d[i] = (this.d[i]! * k + c[0] * a) / m1;
    this.d[i + 1] = (this.d[i + 1]! * k + c[1] * a) / m1;
    this.d[i + 2] = (this.d[i + 2]! * k + c[2] * a) / m1;
    this.m[j] = m1;
  }
  /** fn(u, v, x, y) with y = 0 at the visual TOP of the face */
  fill(fn: (u: number, v: number, x: number, y: number) => RGB): void {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const c = fn(x / S, y / S, x, y);
        const i = (y * S + x) * 3;
        this.d[i] = c[0];
        this.d[i + 1] = c[1];
        this.d[i + 2] = c[2];
        this.m[y * S + x] = 1;
      }
    }
  }
  disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    const n = Math.ceil(r);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const d = Math.hypot(i, j);
        if (d <= r) this.px(cx + i, cy + j, c, a * (d > r - 1 ? 0.55 : 1));
      }
    }
  }
  stroke(x: number, y: number, ang: number, len: number, c: RGB, a = 0.6): void {
    for (let t = 0; t <= len; t += 0.5) this.px(x + Math.cos(ang) * t, y + Math.sin(ang) * t, c, a);
  }
  /** translates the (periodic) painting by (dx, dy) px and scales brightness: a cheap seamless variant */
  roll(dx: number, dy: number, gain: number): void {
    const src = this.d.slice();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = (wrap(y - dy, S) * S + wrap(x - dx, S)) * 3;
        const o = (y * S + x) * 3;
        this.d[o] = src[k]! * gain;
        this.d[o + 1] = src[k + 1]! * gain;
        this.d[o + 2] = src[k + 2]! * gain;
      }
    }
  }
  /** TILE x TILE RGBA (nearest 2x upscale; image row 0 = visual top = texture t = 1) */
  rgba(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    for (let Y = 0; Y < TILE; Y++) {
      for (let X = 0; X < TILE; X++) {
        const i = ((Y >> 1) * S + (X >> 1)) * 3;
        const o = ((TILE - 1 - Y) * TILE + X) * 4;
        out[o] = this.d[i]!;
        out[o + 1] = this.d[i + 1]!;
        out[o + 2] = this.d[i + 2]!;
        out[o + 3] = 255;
      }
    }
    return out;
  }
  /** composites this overlay (coverage `m`) over a TILE x TILE visual-order RGB base (Float32 0..255) -> layer RGBA */
  over(base: Float32Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    for (let Y = 0; Y < TILE; Y++) {
      for (let X = 0; X < TILE; X++) {
        const j = (Y >> 1) * S + (X >> 1);
        const m = this.m[j]!;
        const bi = (Y * TILE + X) * 3;
        const o = ((TILE - 1 - Y) * TILE + X) * 4;
        out[o] = base[bi]! * (1 - m) + this.d[j * 3]! * m;
        out[o + 1] = base[bi + 1]! * (1 - m) + this.d[j * 3 + 1]! * m;
        out[o + 2] = base[bi + 2]! * (1 - m) + this.d[j * 3 + 2]! * m;
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------- recipes
// Painting rules (round 3): crisp posterised texels (no blurred noise), NO tile-scale brightness gradient (the shader's
// world-space macro noise provides the large-scale drift, so tiles never show a per-block stamp), asymmetric details only
// (no discs in pairs: they read as faces), every variant is a different painting (seed offset VS) with the same mean tone.

const MEADOW = ['#46A05A', '#66BB58', '#98D464', '#CBE673'].map(hx) as RGB[];
const FOREST = ['#34804F', '#4A9F58', '#72BA66', '#A6D678'].map(hx) as RGB[];
const HIGH = ['#86B055', '#B0D066', '#D2DE66', '#EAF08A'].map(hx) as RGB[];

/** posterised ramp lookup, t in [0, 1] */
const tone = (pal: RGB[], t: number): RGB => pal[Math.min(pal.length - 1, Math.max(0, Math.floor(t * pal.length)))]!;

function dirtFill(im: Img, s = 1, base = hx('#A5845A'), dark = hx('#876A4A'), light = hx('#BF9C6E'), roots = true): void {
  const hi = mixc(light, hx('#FFF2D8'), 0.25);
  const ramp = [dark, mixc(dark, base, 0.55), base, mixc(base, light, 0.5), light];
  im.fill((u, v, x, y) => {
    const n = fbm(u, v, 6, 3, s) * 0.8 + fbm(u, v, 16, 2, s + 4) * 0.2;
    let c = tone(ramp, (n - 0.22) / 0.56 + (rnd(x, y, s + 8) - 0.5) * 0.16);
    if (fbm(u, v, 14, 2, s + 6) > 0.74 && rnd(x, y, s + 3) > 0.35) c = hi;
    return c;
  });
  const stones = ['#B9A88F', '#9E9183', '#CDBB9E', '#8C7D6E'].map(hx);
  for (let k = 0; k < 8; k++) {
    const cx = rnd(k, 1, s) * S;
    const cy = rnd(k, 2, s) * S;
    const rx = 1.3 + rnd(k, 3, s) * 1.9;
    const ry = 1.0 + rnd(k, 4, s) * 1.3;
    const a = rnd(k, 5, s) * Math.PI;
    const sc = stones[Math.floor(rnd(k, 6, s) * stones.length)]!;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const R = Math.ceil(Math.max(rx, ry)) + 1;
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const qx = (i * ca + j * sa) / rx;
        const qy = (-i * sa + j * ca) / ry;
        const d = qx * qx + qy * qy;
        const lit = (-i - j) / (R * 2);
        if (d <= 1) im.px(cx + i, cy + j, d > 0.6 || lit < -0.12 ? scale(sc, 0.76) : lit > 0.1 ? scale(sc, 1.14) : sc);
        else if (d <= 2 && i + j > 0) im.px(cx + i, cy + j, scale(dark, 0.7), 0.45);
      }
    }
  }
  for (let k = 0; k < (roots ? 3 : 0); k++) {
    let x = rnd(k, 21, s) * S;
    let y = rnd(k, 22, s) * S;
    let a = rnd(k, 23, s) * 6.283;
    const len = 12 + rnd(k, 24, s) * 16;
    for (let t = 0; t < len; t++) {
      a += (rnd(k, 30 + t, s) - 0.5) * 0.7;
      x += Math.cos(a);
      y += Math.sin(a);
      im.px(x, y, hx('#5A4128'), 0.85);
      im.px(x - 1, y - 1, light, 0.25);
    }
  }
  for (let k = 0; k < 26; k++) im.px(rnd(k, 41, s) * S, rnd(k, 42, s) * S, hi, 0.8);
  for (let k = 0; k < 18; k++) im.px(rnd(k, 43, s) * S, rnd(k, 44, s) * S, scale(dark, 0.75), 0.8);
}

function grassTop(im: Img, pal: RGB[], s: number): void {
  const ramp = [mixc(pal[0]!, pal[1]!, 0.4), mixc(pal[0]!, pal[1]!, 0.75), pal[1]!, mixc(pal[1]!, pal[2]!, 0.3)];
  im.fill((u, v, x, y) => tone(ramp, (fbm(u, v, 8, 3, s) - 0.22) / 0.56 + (rnd(x, y, s + 2) - 0.5) * 0.55));
  const dry = hx('#D6E063');
  for (let k = 0; k < 80; k++) {
    const x = Math.floor(rnd(k, 5, s) * S);
    const y = Math.floor(rnd(k, 6, s) * S);
    const d = k > 72;
    im.px(x, y, d ? mixc(pal[1]!, dry, 0.5) : mixc(pal[0]!, pal[1]!, 0.3));
    im.px(x, y - 1, d ? dry : pal[1]!);
    if (rnd(k, 7, s) > 0.35) im.px(x, y - 2, d ? dry : pal[2]!);
    if (rnd(k, 8, s) > 0.6) im.px(x + (rnd(k, 9, s) > 0.5 ? 1 : -1), y - 1, pal[2]!);
  }
}

function grassSide(im: Img, pal: RGB[], s: number, overlay = false): void {
  if (!overlay) dirtFill(im, s + 2);
  const depth = (x: number): number => 11 + 8 * vn(x / S, 0.3, 8, s) + 3 * vn(x / S, 0.6, 16, s + 1);
  for (let x = 0; x < S; x++) {
    const d = depth(x);
    for (let y = 0; y < d; y++) {
      const n = fbm(x / S, y / S, 5, 2, s);
      let c = mixc(pal[0]!, pal[1]!, sstep(0.25, 0.7, n));
      if (y > d - 3) c = scale(c, 0.78);
      im.px(x, y, c, y > d - 1 ? 0.7 : 1);
    }
  }
  for (let k = 0; k < 36; k++) {
    const x = rnd(k, 11, s) * S;
    im.stroke(x, depth(x) - 2, Math.PI / 2 + (rnd(k, 12, s) - 0.5) * 0.6, 2 + rnd(k, 13, s) * 4, k % 2 ? pal[2]! : pal[0]!, 0.7);
  }
  for (let k = 0; k < 40; k++) im.stroke(rnd(k, 14, s) * S, rnd(k, 15, s) * 8, -Math.PI / 2 + (rnd(k, 16, s) - 0.5), 3 + rnd(k, 17, s) * 3, pal[3]!, 0.5);
}

function stone(im: Img, dark: RGB, mid: RGB, light: RGB, s: number): void {
  im.fill((u, v) => {
    const n = fbm(u, v, 3, 4, s);
    let c = mixc(mixc(dark, mid, sstep(0.2, 0.55, n)), light, sstep(0.55, 0.9, n) * 0.8);
    const band = Math.sin((v + 0.05 * fbm(u, v, 5, 2, s + 1)) * Math.PI * 2 * 4 + s);
    c = scale(c, 1 + 0.045 * band);
    const [f1, f2] = worley(u, v, 5, s + 3);
    if (f2 - f1 < 0.055) c = scale(c, 0.72);
    return scale(c, 0.97 + 0.06 * rnd(u * S, v * S, s));
  });
  for (let k = 0; k < 22; k++) im.disc(rnd(k, 21, s) * S, rnd(k, 22, s) * S, 0.9 + rnd(k, 23, s), scale(light, 1.08), 0.6);
}

/** leaf clusters: 3-5 x 2-3 texel clumps, light top row, shaded bottom row, soft contact shadow; crisp at native density */
function leaves(im: Img, pal: RGB[], s: number, dots?: { c: RGB; n: number; r: number }): void {
  im.fill((u, v, x, y) => scale(pal[0]!, 0.88 + 0.16 * fbm(u, v, 5, 2, s) + 0.05 * (rnd(x, y, s) - 0.5)));
  const shade = scale(pal[0]!, 0.68);
  const hiC = pal[3] ?? hx('#ffffff');
  const clump = (cx: number, cy: number, w: number, h: number, c: RGB): void => {
    for (let j = 0; j <= h + 1; j++) for (let i = 0; i <= w + 1; i++) if (!((i === 0 || i >= w) && (j === 0 || j >= h))) im.px(cx + i + 1, cy + j + 1, shade, 0.7);
    for (let j = 0; j <= h; j++) {
      for (let i = 0; i <= w; i++) {
        if ((i === 0 || i === w) && (j === 0 || j === h)) continue;
        im.px(cx + i, cy + j, j === 0 ? mixc(c, hiC, 0.35) : j === h ? scale(c, 0.86) : c);
      }
    }
  };
  for (let k = 0; k < 120; k++) {
    clump(Math.floor(rnd(k, 31, s) * S), Math.floor(rnd(k, 32, s) * S), 3 + Math.floor(rnd(k, 33, s) * 3), 2 + Math.floor(rnd(k, 36, s) * 2), rnd(k, 34, s) < 0.45 ? pal[1]! : pal[2]!);
  }
  if (dots) {
    for (let k = 0; k < dots.n; k++) {
      const x = rnd(k, 41, s) * S;
      const y = rnd(k, 42, s) * S;
      im.disc(x + 0.6, y + 0.8, dots.r, scale(dots.c, 0.55), 0.7);
      im.disc(x, y, dots.r, dots.c, 1);
      im.disc(x - dots.r * 0.3, y - dots.r * 0.3, dots.r * 0.35, hx('#FFF4D6'), 0.8);
    }
  }
}

/** pine / palm / willow: sprays of 1 texel needles (drooping fans), dark undercoat, bright tips */
function needles(im: Img, pal: RGB[], s: number, l0: number, l1: number, spread: number, count = 5): void {
  im.fill((u, v, x, y) => scale(pal[0]!, 0.78 + 0.16 * fbm(u, v, 5, 2, s) + 0.05 * (rnd(x, y, s) - 0.5)));
  const shade = scale(pal[0]!, 0.6);
  for (let k = 0; k < 120; k++) {
    const cx = rnd(k, 31, s) * S;
    const cy = rnd(k, 32, s) * S;
    const ba = Math.PI / 2 + (rnd(k, 39, s) - 0.5) * 0.9;
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 0; q < count; q++) {
        const a = ba + (q - (count - 1) / 2) * spread + (rnd(k * 8 + q, 40, s) - 0.5) * 0.25;
        const L = l0 + rnd(k * 8 + q, 41, s) * (l1 - l0);
        const col = q % 2 ? pal[1]! : pal[2]!;
        for (let t = 0; t <= L; t++) {
          if (pass === 0) im.px(cx + Math.cos(a) * t + 1, cy + Math.sin(a) * t + 1, shade, 0.7);
          else im.px(cx + Math.cos(a) * t, cy + Math.sin(a) * t, t > L - 1.2 ? (pal[3] ?? col) : t < 1.5 ? scale(col, 0.75) : col);
        }
      }
    }
  }
}

/** vertical ridged bark: broken grooves, lit ridge tops, 1-2 knots; spots <= 12 % darker than the base */
function bark(im: Img, base: RGB, ridge: RGB, crack: RGB, s: number): void {
  im.fill((u, v, x, y) => {
    const q = u * 8 + 0.45 * vn(u, v, 3, s) + 0.3 * vn(u, v, 9, s + 3);
    const f = q - Math.floor(q);
    const tri = Math.abs(f - 0.5) * 2; // 0 ridge centre .. 1 groove
    const broken = vn(u, v * 0.5, 6, s + 2);
    let c = tri < 0.28 ? scale(ridge, 1.04) : tri < 0.7 ? mixc(base, ridge, 0.35) : tri > 0.88 && broken > 0.3 ? mixc(base, crack, 0.5) : scale(base, 0.94);
    if (tri > 0.7 && tri <= 0.88) c = mixc(base, crack, 0.18);
    // ridges are broken into bark plates 8-16 texels tall, each a slightly different value
    const col = ((Math.floor(q) % 8) + 8) % 8;
    const seg = (Math.floor(v * 6) + Math.floor(rnd(col, 1, s) * 6)) % 6;
    return scale(c, (0.9 + 0.17 * rnd(col, seg, s + 9)) * (0.97 + 0.06 * rnd(x, y, s + 8)));
  });
  for (let k = 0; k < (rnd(7, 8, s) > 0.4 ? 1 : 0); k++) {
    const kx = 10 + rnd(k, 61, s) * (S - 20);
    const ky = 8 + rnd(k, 62, s) * (S - 16);
    const rx = 3.2 + rnd(k, 63, s) * 1.6;
    const ry = rx * 1.6;
    for (let j = -12; j <= 12; j++) {
      for (let i = -8; i <= 8; i++) {
        const r = Math.hypot(i / rx, j / ry);
        if (r > 1.15) continue;
        const ring = Math.floor(r * 3.2);
        im.px(kx + i, ky + j, r < 0.3 ? scale(crack, 0.9) : ring % 2 === 0 ? mixc(base, crack, 0.4) : scale(ridge, 1.02), 0.9);
      }
    }
  }
}

function sandPaint(im: Img): void {
  const P = ['#E6C768', '#F0D47A', '#F8E093', '#FFF0B8'].map(hx);
  im.fill((u, v, x, y) => tone([P[0]!, P[1]!, P[1]!, P[2]!], (fbm(u, v, 10, 3, 21) - 0.22) / 0.56 + (rnd(x, y, 23) - 0.5) * 0.3));
  // wind-ripple crescents (isotropic: the shader rotates / flips tops per block)
  for (let k = 0; k < 22; k++) {
    const x = rnd(k, 71, 21) * S;
    const y = rnd(k, 72, 21) * S;
    const len = 6 + rnd(k, 73, 21) * 10;
    const bow = (rnd(k, 74, 21) - 0.5) * 3.2;
    for (let i = 0; i <= len; i++) {
      const cy = Math.sin((i / len) * Math.PI) * bow;
      im.px(x + i, y + cy, P[3]!, 0.72);
      im.px(x + i, y + cy + 1, scale(P[0]!, 0.94), 0.55);
    }
  }
  for (let k = 0; k < 44; k++) im.px(rnd(k, 75, 21) * S, rnd(k, 76, 21) * S, hx('#BF9F52'), 0.85);
  for (let k = 0; k < 30; k++) im.px(rnd(k, 77, 21) * S, rnd(k, 78, 21) * S, hx('#FFF8DE'), 0.9);
}

function plasterPaint(im: Img): void {
  const P = [hx('#F2DFC0'), hx('#F7E6CA'), hx('#FFF1DA')];
  im.fill((u, v, x, y) => tone(P, (fbm(u, v, 8, 2, 191) - 0.25) / 0.5 + (rnd(x, y, 192) - 0.5) * 0.35));
  for (let k = 0; k < 16; k++) {
    const x = rnd(k, 1, 193) * S;
    const y = rnd(k, 2, 193) * S;
    const len = 5 + rnd(k, 3, 193) * 9;
    for (let i = 0; i < len; i++) im.px(x + i, y + Math.sin(i * 0.3) * 0.6, hx('#E4CFAA'), 0.5);
  }
}


const PAINT: Record<string, (im: Img) => void> = {
  grass_top: (im) => grassTop(im, MEADOW, 1),
  grass_side: (im) => grassSide(im, MEADOW, 1),
  grass_forest_top: (im) => grassTop(im, FOREST, 2),
  grass_forest_side: (im) => grassSide(im, FOREST, 2),
  grass_high_top: (im) => grassTop(im, HIGH, 3),
  grass_high_side: (im) => grassSide(im, HIGH, 3),
  grass_flower_top: (im) => {
    grassTop(im, MEADOW, 4);
    const cols = ['#FF8FC2', '#FFF7E0', '#FFD34D', '#8FB4FF'].map(hx);
    for (let k = 0; k < 11; k++) {
      const x = 4 + rnd(k, 61, 4) * (S - 8);
      const y = 4 + rnd(k, 62, 4) * (S - 8);
      const c = cols[k % 4]!;
      for (const [dx, dy] of [[0, 0], [1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6]] as const) im.disc(x + dx, y + dy, 1.3, c, 1);
      im.disc(x, y, 0.9, hx('#FFE38A'), 1);
    }
  },
  dirt: (im) => dirtFill(im, 7),
  stone_cool: (im) => stone(im, hx('#968BA6'), hx('#AEA4BC'), hx('#C9C0D3'), 11),
  stone_warm: (im) => stone(im, hx('#A98B72'), hx('#C9A98C'), hx('#E2C8AC'), 12),
  stone_dark: (im) => stone(im, hx('#6A5C76'), hx('#82738C'), hx('#9F90A6'), 13),
  sand: sandPaint,
  gravel: (im) => {
    const pal = ['#8C8580', '#A89F96', '#6F6A68', '#B8A98F', '#7A7470'].map(hx);
    im.fill((u, v) => {
      const [f1, f2, id] = worley(u, v, 7, 31);
      let c = pal[Math.floor(id * pal.length) % pal.length]!;
      c = scale(c, 0.8 + 0.3 * sstep(0.5, 0.0, f1) + 0.1 * rnd(u * S, v * S, 32));
      if (f2 - f1 < 0.07) c = scale(c, 0.55);
      return c;
    });
  },
  clay: (im) => im.fill((u, v) => scale(mixc(hx('#B8714F'), hx('#D79A70'), sstep(0.2, 0.8, fbm(u, v, 4, 3, 41))), 0.97 + 0.06 * rnd(u * S, v * S, 42))),
  mud: (im) => {
    im.fill((u, v) => {
      const n = fbm(u, v, 4, 3, 51);
      let c = mixc(hx('#7E5E44'), hx('#9C7A58'), sstep(0.2, 0.7, n));
      if (n > 0.7) c = mixc(c, hx('#B89C7C'), 0.5);
      return scale(c, 0.97 + 0.06 * rnd(u * S, v * S, 52));
    });
  },
  path_top: (im) => {
    dirtFill(im, 61, hx('#C9A26B'), hx('#B08850'), hx('#DDBB86'), false);
    for (let k = 0; k < 8; k++) im.stroke(rnd(k, 81, 61) * S, rnd(k, 82, 61) * S, (rnd(k, 83, 61) - 0.5) * 0.4, 12 + rnd(k, 84, 61) * 14, hx('#A5804C'), 0.35);
  },
  packed_top: (im) => {
    dirtFill(im, 71, hx('#C8BB6E'), hx('#AFA356'), hx('#E0D58C'), false);
    for (let k = 0; k < 40; k++) im.stroke(rnd(k, 91, 71) * S, rnd(k, 92, 71) * S, -Math.PI / 2 + (rnd(k, 93, 71) - 0.5), 2 + rnd(k, 94, 71) * 3, hx('#7FB85A'), 0.55);
  },
  snow_top: (im) => im.fill((u, v) => scale(mixc(hx('#DDE8F8'), hx('#FFFFFF'), sstep(0.2, 0.8, fbm(u, v, 4, 3, 81))), 1)),
  snow_side: (im) => {
    dirtFill(im, 82);
    for (let x = 0; x < S; x++) {
      const d = 14 + 6 * vn(x / S, 0.4, 8, 83);
      for (let y = 0; y < d; y++) im.px(x, y, y > d - 3 ? hx('#C9D8EE') : hx('#F4F8FF'));
    }
  },
  water: (im) => im.fill(() => hx('#2BB8D9')),
  log_top: (im) => {
    im.fill((u, v) => {
      const du = u - 0.5;
      const dv = v - 0.5;
      const r = Math.hypot(du, dv) + 0.025 * fbm(u, v, 6, 2, 91);
      let c = Math.floor(r * 15) % 2 === 0 ? hx('#C99C5C') : hx('#B58246');
      if (r < 0.06) c = hx('#8E5E30');
      if (Math.max(Math.abs(du), Math.abs(dv)) > 0.43) c = mixc(hx('#6E4528'), hx('#7F5232'), vn(u, v, 10, 92));
      return scale(c, 0.97 + 0.06 * rnd(u * S, v * S, 93));
    });
  },
  log_oak_side: (im) => bark(im, hx('#8E6C40'), hx('#AD8852'), hx('#5E4527'), 101),
  log_pine_side: (im) => bark(im, hx('#9A7048'), hx('#B98C5C'), hx('#634932'), 102),
  log_birch_side: (im) => {
    im.fill((u, v) => scale(mixc(hx('#E8E0D0'), hx('#F7F2E8'), vn(u, v, 6, 111)), 0.97 + 0.06 * rnd(u * S, v * S, 112)));
    for (let k = 0; k < 15; k++) {
      const x = rnd(k, 101, 111) * S;
      const y = rnd(k, 102, 111) * S;
      const w = 6 + rnd(k, 103, 111) * 12;
      for (let i = 0; i < w; i++) im.px(x + i, y, hx('#3E3A38'), 0.85);
      for (let i = 0; i < w * 0.6; i++) im.px(x + i + 2, y + 1, hx('#8E8680'), 0.55);
    }
  },
  log_palm_side: (im) => {
    im.fill((u, v) => {
      let c = mixc(hx('#B09468'), hx('#C9AE7E'), vn(u, v, 10, 121));
      if (Math.floor(v * 8 + 0.3 * vn(u, v, 8, 122)) % 2 === 0) c = scale(c, 0.84);
      return scale(c, 0.97 + 0.06 * rnd(u * S, v * S, 123));
    });
  },
  leaves_oak: (im) => leaves(im, ['#2D7A45', '#4DB85A', '#8FDC6A', '#C8F08A'].map(hx), 131),
  leaves_pine: (im) => needles(im, ['#2A6244', '#3C8A56', '#68B873', '#A2DE9C'].map(hx), 132, 4, 7, 0.55),
  leaves_blossom: (im) => leaves(im, ['#E0699A', '#FF8FBE', '#FFC2DA', '#FFF0F6'].map(hx), 133, { c: hx('#FFF7F0'), n: 12, r: 1.7 }),
  leaves_birch: (im) => leaves(im, ['#78A83A', '#A5D14E', '#CDE86A', '#EAF59A'].map(hx), 134),
  leaves_maple: (im) => leaves(im, ['#A8402A', '#CC6A34', '#E6933F', '#F6C677'].map(hx), 135),
  leaves_palm: (im) => needles(im, ['#2E8F4C', '#4DB85A', '#86DB78', '#C8F4A0'].map(hx), 136, 6, 11, 0.4),
  leaves_willow: (im) => needles(im, ['#5E9A44', '#86BE5A', '#B0DC7C', '#D8F2A4'].map(hx), 137, 6, 12, 0.18),
  leaves_berry: (im) => leaves(im, ['#2D7A45', '#4DB85A', '#8FDC6A', '#C8F08A'].map(hx), 138, { c: hx('#E0394A'), n: 9, r: 2 }),
  leaves_apple: (im) => leaves(im, ['#2D7A45', '#4DB85A', '#8FDC6A', '#C8F08A'].map(hx), 139, { c: hx('#E8453C'), n: 7, r: 2.6 }),
  leaves_orange: (im) => leaves(im, ['#2D7A45', '#4DB85A', '#8FDC6A', '#C8F08A'].map(hx), 140, { c: hx('#FF9A2E'), n: 7, r: 2.6 }),
  glowcap: (im) => {
    im.fill((u, v) => scale(mixc(hx('#127F86'), hx('#26B8A8'), fbm(u, v, 5, 3, 151)), 1));
    for (let k = 0; k < 22; k++) {
      const x = rnd(k, 111, 151) * S;
      const y = rnd(k, 112, 151) * S;
      im.disc(x, y, 4.5, hx('#5FF0D8'), 0.35);
      im.disc(x, y, 2.6, hx('#B8FFF2'), 0.8);
      im.disc(x, y, 1.2, hx('#FFFFFF'), 1);
    }
  },
  mushroom_stem: (im) => im.fill((u, v) => scale(mixc(hx('#E8DCC4'), hx('#FAF2E0'), vn(u, v, 4, 161)), 0.9 + 0.12 * Math.sin(u * Math.PI * 4))),
  planks: (im) => {
    im.fill((u, v, x, y) => {
      const board = Math.floor(y / 16);
      const t = rnd(board, 7, 171);
      let c = mixc(hx('#B87C44'), hx('#D79F5E'), t);
      c = scale(c, 0.93 + 0.14 * vn(u * 2, v * 8 + board, 8, 172 + board) + 0.05 * Math.sin((v * 40 + 3 * vn(u, v, 6, 173)) * 2));
      if (y % 16 === 15) c = scale(hx('#6B3F20'), 1);
      else if (y % 16 === 0) c = scale(c, 1.1);
      return c;
    });
    for (let b = 0; b < 4; b++) {
      im.disc(4, b * 16 + 8, 1.2, hx('#5C3A22'), 0.9);
      im.disc(S - 5, b * 16 + 8, 1.2, hx('#5C3A22'), 0.9);
    }
  },
  cobble: (im) => {
    im.fill((u, v) => {
      const [f1, f2, id] = worley(u, v, 4, 181);
      let c = mixc(hx('#8A8296'), hx('#B6AEC2'), id);
      c = scale(c, 0.85 + 0.3 * sstep(0.45, 0.0, f1) + 0.06 * rnd(u * S, v * S, 182));
      if (f2 - f1 < 0.075) c = hx('#4F4860');
      return c;
    });
  },
  plaster: plasterPaint,
  roof_tile: (im) => {
    im.fill((u, v, x, y) => {
      const row = Math.floor(y / 16);
      const xx = x + (row % 2) * 8;
      const tx = (xx % 16) / 16;
      const ty = (y % 16) / 16;
      let c = mixc(hx('#EE7C5C'), hx('#C4503A'), sstep(0.1, 0.95, ty));
      c = scale(c, 0.9 + 0.2 * rnd(Math.floor(xx / 16), row, 201));
      const edge = 0.78 + 0.22 * Math.abs(tx - 0.5) * 2;
      if (ty > edge) c = scale(hx('#7A2E22'), 1);
      if (tx < 0.04 || tx > 0.96) c = scale(c, 0.7);
      return c;
    });
  },
  glass: (im) => {
    im.fill((u, v) => mixc(hx('#4A3B30'), hx('#8A6C4C'), 1 - v));
    for (let i = 0; i < S; i++) {
      for (let w = 0; w < 7; w++) im.px(i, S - i + w - 6 + 14, hx('#D6F2FB'), 0.65);
    }
    for (let i = 0; i < S; i++) for (let b = 0; b < 4; b++) {
      for (const c of [i]) {
        im.px(c, b, hx('#B9783F'));
        im.px(c, S - 1 - b, hx('#B9783F'));
        im.px(b, c, hx('#B9783F'));
        im.px(S - 1 - b, c, hx('#B9783F'));
      }
    }
  },
  lantern: (im) => {
    im.fill((u, v) => mixc(hx('#FFB84A'), hx('#FFE9A8'), 1 - Math.hypot(u - 0.5, v - 0.5) * 1.6));
    for (let i = 0; i < S; i++) for (let b = 0; b < 4; b++) {
      im.px(i, b, hx('#5A3B22'));
      im.px(i, S - 1 - b, hx('#5A3B22'));
      im.px(b, i, hx('#5A3B22'));
      im.px(S - 1 - b, i, hx('#5A3B22'));
    }
  },
};

function fallback(name: string): (im: Img) => void {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  const base: RGB = [90 + (h & 127), 90 + ((h >> 7) & 127), 90 + ((h >> 14) & 127)];
  return (im) => im.fill((u, v) => scale(base, 0.9 + 0.2 * fbm(u, v, 4, 3, h & 255)));
}

// ------------------------------------------------------------------------------------------------- AI-painted tiles
// 1024 px hand-painted seamless tiles (FLORA, see docs/THIRD_PARTY.md), pre-downscaled to 128 px with wrap-aware filtering
// (assets-src/textures -> ./textures). They replace the procedural paintings when they load; if a PNG is missing or fails
// to decode the procedural tile stays. Each is re-graded onto the warm-key palette (target mean colour, kept contrast and
// chroma) so lawns / beaches / dirt sit in the lighting instead of fighting it.
const PNGS = import.meta.glob('./textures/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

interface AiTile {
  /** [source png, roll x, roll y] per variant layer */
  v: [string, number, number, number?][];
  /** graded mean colour */
  target: string;
  /** contrast around the mean luminance (1 = as painted) */
  k?: number;
  /** fraction of the painted chroma deviation kept (flowers, pebbles) */
  ch?: number;
}
const R2 = (n: string, t = 0.5): [string, number, number, number?][] => [[n, 0, 0], [n, t, 0.5 + t * 0.25]];
const AI: Record<string, AiTile> = {
  grass_top: { v: [['grass_b', 0, 0, 0.75], ['grass_b', 0.5, 0.5, 0.75], ['grass_a', 0, 0, 1.5], ['grass_b', 0.25, 0.75, 0.75]], target: '#64B050', ch: 0.5 },
  grass_forest_top: { v: [['grass_b', 0.25, 0.25, 0.75], ['grass_b', 0.75, 0.5, 0.75], ['grass_a', 0.5, 0.5, 1.5]], target: '#3F9150', ch: 0.5 },
  grass_high_top: { v: [['grass_b', 0.1, 0.6, 0.75], ['grass_b', 0.6, 0.1, 0.75], ['grass_a', 0.6, 0.9, 1.5]], target: '#9CC45E', ch: 0.5 },
  grass_flower_top: { v: [['grass_b', 0, 0, 0.75], ['grass_b', 0.5, 0.5, 0.75], ['grass_b', 0.25, 0.75, 0.75]], target: '#64B050', ch: 1.0 },
  sand: { v: [['sand_a', 0, 0], ['sand_b', 0, 0], ['sand_a', 0.5, 0.5], ['sand_b', 0.5, 0.5]], target: '#EFD38A', k: 1.0, ch: 0.7 },
  dirt: { v: [['dirt_a', 0, 0], ['dirt_a', 0.5, 0.5], ['dirt_b', 0, 0], ['dirt_a', 0.25, 0.75]], target: '#8C7650', k: 1.0, ch: 0.4 },
  path_top: { v: [['sand_b', 0, 0, 1.6], ['sand_b', 0.5, 0.5, 1.6]], target: '#C8AA78', ch: 0.5 },
  packed_top: { v: R2('sand_a'), target: '#CDB77A', k: 1.2, ch: 0.5 },
  cobble: { v: R2('cobble_a'), target: '#AAA49F', k: 0.95, ch: 0.5 },
  stone_cool: { v: R2('rock_strata'), target: '#A59CB5', k: 1.0, ch: 0.35 },
  stone_warm: { v: R2('rock_strata'), target: '#C9A98C', k: 1.0, ch: 0.7 },
  stone_dark: { v: R2('rock_strata'), target: '#7C6E88', k: 1.0, ch: 0.35 },
  log_oak_side: { v: [['bark_oak', 0, 0], ['bark_oak', 0.33, 0.5], ['bark_oak', 0.66, 0.2]], target: '#8E6C40', k: 0.95, ch: 0.5 },
  log_pine_side: { v: [['bark_oak', 0.1, 0.1], ['bark_oak', 0.5, 0.8], ['bark_oak', 0.8, 0.4]], target: '#9A7048', k: 0.95, ch: 0.5 },
  log_birch_side: { v: R2('bark_birch'), target: '#E6DDCC', k: 1.0, ch: 0.8 },
  leaves_oak: { v: [['leaves_oak', 0, 0], ['leaves_oak', 0.33, 0.5], ['leaves_oak', 0.66, 0.2]], target: '#3F9A52', k: 0.95, ch: 0.6 },
  leaves_pine: { v: [['leaves_pine', 0, 0], ['leaves_pine', 0.33, 0.5], ['leaves_pine', 0.66, 0.2]], target: '#2F7549', k: 0.95, ch: 0.6 },
};
/** grass sides = graded AI dirt + procedural grass fringe overlay */
const SIDES: Record<string, { pal: RGB[]; s: number }> = {
  grass_side: { pal: MEADOW, s: 1 },
  grass_forest_side: { pal: FOREST, s: 2 },
  grass_high_side: { pal: HIGH, s: 3 },
};
/** tiles whose tops may be rotated + offset per block (no directional pattern) and sides offset sideways */
const FREE_ALL = ['grass_top', 'grass_forest_top', 'grass_high_top', 'grass_flower_top', 'sand', 'dirt', 'path_top', 'cobble', 'stone_cool', 'stone_warm', 'stone_dark', 'leaves_oak', 'leaves_pine', 'gravel', 'clay', 'mud', 'snow_top', 'packed_top'];
/** tiles whose sides may be offset sideways (vertical structure survives) */
const FREE_SIDE = ['grass_side', 'grass_forest_side', 'grass_high_side', 'log_oak_side', 'log_pine_side', 'log_birch_side', 'log_palm_side'];

const loaded = new Map<string, Float32Array>(); // png name -> TILE*TILE*3 visual-order RGB 0..255
let loading: Promise<void> | null = null;

/** decodes every bundled PNG via canvas (halving box-filter steps down to TILE if a PNG is larger) */
export function preloadTiles(): Promise<void> {
  if (loading) return loading;
  loading = Promise.all(
    Object.entries(PNGS).map(async ([path, url]) => {
      const name = path.replace(/^.*\//, '').replace(/\.png$/, '');
      try {
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const cv = document.createElement('canvas');
        cv.width = cv.height = TILE;
        const cx = cv.getContext('2d', { willReadFrequently: true })!;
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        let w = bmp.width;
        let src: CanvasImageSource = bmp;
        while (w > TILE * 2) {
          w = Math.max(TILE, w >> 1);
          const t = document.createElement('canvas');
          t.width = t.height = w;
          const tc = t.getContext('2d')!;
          tc.imageSmoothingQuality = 'high';
          tc.drawImage(src, 0, 0, w, w);
          src = t;
        }
        cx.drawImage(src, 0, 0, TILE, TILE);
        const px = cx.getImageData(0, 0, TILE, TILE).data;
        const f = new Float32Array(TILE * TILE * 3);
        for (let i = 0; i < TILE * TILE; i++) {
          f[i * 3] = px[i * 4]!;
          f[i * 3 + 1] = px[i * 4 + 1]!;
          f[i * 3 + 2] = px[i * 4 + 2]!;
        }
        loaded.set(name, f);
      } catch (e) {
        console.warn(`[voxel] texture ${name} failed to load, procedural fallback`, e);
      }
    }),
  ).then(() => undefined);
  return loading;
}
if (typeof document !== 'undefined') void preloadTiles();

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/** rolled + graded copy of a loaded PNG (visual order RGB floats), or null if it has not loaded */
function gradedAi(cfg: AiTile, vi: number): Float32Array | null {
  const [src, rx, ry, kk] = cfg.v[vi]!;
  const f = loaded.get(src);
  if (!f) return null;
  const n = TILE * TILE;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    mr += f[i * 3]!;
    mg += f[i * 3 + 1]!;
    mb += f[i * 3 + 2]!;
  }
  mr /= n;
  mg /= n;
  mb /= n;
  const lm = luma(mr, mg, mb);
  const t = hx(cfg.target);
  const k = kk ?? cfg.k ?? 1;
  const ch = cfg.ch ?? 0.7;
  const dx = Math.round(rx * TILE);
  const dy = Math.round(ry * TILE);
  const out = new Float32Array(n * 3);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const si = (wrap(y + dy, TILE) * TILE + wrap(x + dx, TILE)) * 3;
      const r = f[si]!;
      const g = f[si + 1]!;
      const b = f[si + 2]!;
      const q = luma(r, g, b) / lm;
      const rr = 1 + (q - 1) * k; // contrast about the mean
      const o = (y * TILE + x) * 3;
      out[o] = Math.min(255, Math.max(0, rr * t[0] + ch * (r - q * mr)));
      out[o + 1] = Math.min(255, Math.max(0, rr * t[1] + ch * (g - q * mg)));
      out[o + 2] = Math.min(255, Math.max(0, rr * t[2] + ch * (b - q * mb)));
    }
  }
  return out;
}

/** variants per tile (procedural: rolled repaintings; AI tiles define their own count) */
const VARIANTS: Record<string, number> = {
  grass_top: 6, grass_forest_top: 6, grass_high_top: 5, grass_flower_top: 5, sand: 6, dirt: 5, log_oak_side: 3, log_pine_side: 3, leaves_oak: 3, leaves_pine: 3, plaster: 2,
  grass_side: 2, grass_forest_side: 2, grass_high_side: 2, stone_cool: 2, stone_warm: 2, stone_dark: 2, gravel: 2, path_top: 2, packed_top: 2,
};
for (const [n, c] of Object.entries(AI)) VARIANTS[n] = c.v.length;
for (const n of Object.keys(SIDES)) VARIANTS[n] = 4;

export interface Atlas {
  texture: DataArrayTexture;
  /** first layer of each tile */
  index: Map<string, number>;
  /** number of consecutive variant layers of each tile */
  variants: Map<string, number>;
  names: string[];
  layers: number;
}

/** paints `names` (+ variants; layer = running offset) into one sRGB texture array */
export function buildAtlas(names: string[], maxAnisotropy = 8): Atlas {
  // layer order: free (rotate + offset) tiles first, then side-offset tiles, then the rest (the shader tests tile < uVoxFree)
  const rank = (n: string): number => (FREE_ALL.includes(n) ? 0 : FREE_SIDE.includes(n) ? 1 : 2);
  const order = names.slice().sort((a, b) => rank(a) - rank(b) || names.indexOf(a) - names.indexOf(b));
  let layers = 0;
  let freeA = 0;
  let freeB = 0;
  for (const n of order) {
    layers += VARIANTS[n] ?? 1;
    if (rank(n) === 0) freeA = layers;
    if (rank(n) <= 1) freeB = layers;
  }
  const data = new Uint8Array(TILE * TILE * 4 * layers);
  const index = new Map<string, number>();
  const variants = new Map<string, number>();
  const slots: { name: string; v: number; layer: number }[] = [];
  let layer = 0;
  for (const name of order) {
    const nv = VARIANTS[name] ?? 1;
    index.set(name, layer);
    variants.set(name, nv);
    for (let v = 0; v < nv; v++) {
      const im = new Img();
      VS = v;
      (PAINT[name] ?? fallback(name))(im);
      VS = 0;
      data.set(im.rgba(), layer * TILE * TILE * 4);
      slots.push({ name, v, layer });
      layer++;
    }
  }
  /** overwrites procedural layers with graded AI tiles; a tile whose PNG is missing keeps its procedural painting */
  const applyAi = (): void => {
    const dirtCache = new Map<number, Float32Array | null>();
    const dirt = (vi: number): Float32Array | null => {
      if (!dirtCache.has(vi)) dirtCache.set(vi, gradedAi(AI.dirt!, vi % AI.dirt!.v.length));
      return dirtCache.get(vi)!;
    };
    for (const sl of slots) {
      const cfg = AI[sl.name];
      let rgba: Uint8ClampedArray | null = null;
      if (cfg) {
        const g = gradedAi(cfg, sl.v);
        if (g) {
          rgba = new Uint8ClampedArray(TILE * TILE * 4);
          for (let Y = 0; Y < TILE; Y++) {
            for (let X = 0; X < TILE; X++) {
              const b = (Y * TILE + X) * 3;
              const o = ((TILE - 1 - Y) * TILE + X) * 4;
              rgba[o] = g[b]!;
              rgba[o + 1] = g[b + 1]!;
              rgba[o + 2] = g[b + 2]!;
              rgba[o + 3] = 255;
            }
          }
        }
      } else if (SIDES[sl.name]) {
        const base = dirt(sl.v);
        if (base) {
          const side = SIDES[sl.name]!;
          const im = new Img(false);
          VS = sl.v;
          grassSide(im, side.pal, side.s, true);
          VS = 0;
          rgba = im.over(base);
        }
      }
      if (rgba) data.set(rgba, sl.layer * TILE * TILE * 4);
    }
  };
  const texture = new DataArrayTexture(data, TILE, TILE, layers);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(16, maxAnisotropy); // three clamps to the device maximum
  texture.userData.sandLayer = index.get('sand') ?? -1;
  texture.userData.freeAll = freeA;
  texture.userData.freeSide = freeB;
  texture.needsUpdate = true;
  texture.name = 'voxel.tiles';
  // the PNGs usually finished decoding during the wasm boot; if not, upgrade the layers in place when they arrive
  if (loaded.size > 0) applyAi();
  void preloadTiles().then(() => {
    if (loaded.size > 0) {
      applyAi();
      texture.needsUpdate = true;
    }
  });
  return { texture, index, variants, names, layers };
}
