/**
 * Procedural painted tile atlas (voxel world). Every tile is a seamless 64 px painting generated at load from the
 * registry's tile *names* (`world.blocks` -> `tex`): layered value-noise blotches, brush strokes, Worley stones and
 * hand-placed details (flowers, pebbles, fruit, nails ...). Unknown names fall back to a hashed colour so new blocks
 * never break the atlas. The result is one `DataArrayTexture` (one layer per tile): no atlas bleeding, trilinear mips.
 */
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

export const TILE = 64;
const S = TILE;
type RGB = [number, number, number];

const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (i: number, n: number): number => ((i % n) + n) % n;

function rnd(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
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
  px(x: number, y: number, c: RGB, a = 1): void {
    const i = (wrap(Math.round(y), S) * S + wrap(Math.round(x), S)) * 3;
    this.d[i] = this.d[i]! * (1 - a) + c[0] * a;
    this.d[i + 1] = this.d[i + 1]! * (1 - a) + c[1] * a;
    this.d[i + 2] = this.d[i + 2]! * (1 - a) + c[2] * a;
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
  rgba(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 3;
        const o = ((S - 1 - y) * S + x) * 4; // flip: image row 0 = visual top = texture t = 1
        out[o] = this.d[i]!;
        out[o + 1] = this.d[i + 1]!;
        out[o + 2] = this.d[i + 2]!;
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------- recipes

const MEADOW = ['#3FA65A', '#5CC95A', '#8FDB62', '#C6E86A'].map(hx) as RGB[];
const FOREST = ['#2A7F55', '#3E9E5E', '#63B867', '#9AD477'].map(hx) as RGB[];
const HIGH = ['#86B055', '#B0D066', '#D2DE66', '#EAF08A'].map(hx) as RGB[];

function dirtFill(im: Img, s = 1, base = hx('#A58250'), dark = hx('#866438'), light = hx('#C8A468')): void {
  im.fill((u, v) => {
    const n = fbm(u, v, 4, 3, s);
    const c = mixc(mixc(dark, base, sstep(0.25, 0.6, n)), light, sstep(0.6, 0.85, fbm(u, v, 9, 2, s + 4)) * 0.7);
    return scale(c, 0.96 + 0.08 * rnd(u * S, v * S, s));
  });
  for (let k = 0; k < 16; k++) {
    const x = rnd(k, 1, s) * S;
    const y = rnd(k, 2, s) * S;
    const r = 1.4 + rnd(k, 3, s) * 2.2;
    im.disc(x + 0.8, y + 0.8, r, scale(dark, 0.8), 0.5);
    im.disc(x, y, r, mixc(light, hx('#B7A58E'), 0.45), 0.85);
  }
}

function grassTop(im: Img, pal: RGB[], s: number): void {
  im.fill((u, v) => {
    const n = fbm(u, v, 4, 3, s);
    const c = mixc(pal[0]!, pal[1]!, sstep(0.2, 0.7, n));
    return mixc(c, pal[2]!, sstep(0.55, 0.9, fbm(u, v, 10, 2, s + 9)) * 0.75);
  });
  for (let k = 0; k < 110; k++) {
    const x = rnd(k, 5, s) * S;
    const y = rnd(k, 6, s) * S;
    const light = k % 3 === 0;
    im.stroke(x, y, -Math.PI / 2 + (rnd(k, 7, s) - 0.5) * 1.6, 3 + rnd(k, 8, s) * 4, light ? pal[3]! : scale(pal[0]!, 0.85), light ? 0.55 : 0.5);
  }
}

function grassSide(im: Img, pal: RGB[], s: number): void {
  dirtFill(im, s + 2);
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

function leaves(im: Img, pal: RGB[], s: number, dots?: { c: RGB; n: number; r: number }, streak = false): void {
  im.fill((u, v) => scale(pal[0]!, 0.85 + 0.2 * fbm(u, v, 6, 2, s)));
  for (let k = 0; k < 96; k++) {
    const cx = rnd(k, 31, s) * S;
    const cy = rnd(k, 32, s) * S;
    const r = 3 + rnd(k, 33, s) * 4.5;
    const c = rnd(k, 34, s) < 0.45 ? pal[1]! : pal[2]!;
    im.disc(cx + 0.7, cy + 0.9, r, scale(pal[0]!, 0.75), 0.6);
    im.disc(cx, cy, r, c, 0.95);
    im.disc(cx - r * 0.25, cy - r * 0.3, r * 0.55, mixc(c, pal[3] ?? hx('#ffffff'), 0.5), 0.55);
  }
  if (streak) for (let k = 0; k < 60; k++) im.stroke(rnd(k, 35, s) * S, rnd(k, 36, s) * S, Math.PI / 2 + (rnd(k, 37, s) - 0.5) * 0.5, 6 + rnd(k, 38, s) * 8, pal[3] ?? pal[2]!, 0.4);
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

function bark(im: Img, base: RGB, ridge: RGB, crack: RGB, s: number): void {
  im.fill((u, v) => {
    const r = vn(u, v, 8, s) * 0.7 + vn(u * 2 % 1, v, 16, s + 3) * 0.3;
    let c = mixc(base, ridge, sstep(0.35, 0.8, r));
    if (vn(u, v, 12, s + 5) < 0.2) c = mixc(c, crack, 0.75);
    return scale(c, 0.95 + 0.1 * rnd(u * S, v * S, s));
  });
  for (let k = 0; k < 12; k++) im.stroke(rnd(k, 51, s) * S, rnd(k, 52, s) * S, Math.PI / 2, 8 + rnd(k, 53, s) * 14, scale(ridge, 1.1), 0.5);
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
  stone_cool: (im) => stone(im, hx('#8E81A8'), hx('#A89CBF'), hx('#C4BAD6'), 11),
  stone_warm: (im) => stone(im, hx('#A98B72'), hx('#C9A98C'), hx('#E2C8AC'), 12),
  stone_dark: (im) => stone(im, hx('#54456A'), hx('#6C5B7B'), hx('#877699'), 13),
  sand: (im) => {
    im.fill((u, v) => {
      let c = mixc(hx('#F2D56E'), hx('#FFEFA6'), sstep(0.2, 0.7, fbm(u, v, 5, 3, 21)));
      c = scale(c, 1 + 0.035 * Math.sin((v + 0.04 * fbm(u, v, 6, 2, 22)) * Math.PI * 2 * 5));
      return scale(c, 0.97 + 0.06 * rnd(u * S, v * S, 23));
    });
    for (let k = 0; k < 14; k++) im.px(rnd(k, 71, 21) * S, rnd(k, 72, 21) * S, hx('#FFF8E2'), 0.9);
  },
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
    dirtFill(im, 61, hx('#C9A26B'), hx('#B08850'), hx('#DDBB86'));
    for (let k = 0; k < 8; k++) im.stroke(rnd(k, 81, 61) * S, rnd(k, 82, 61) * S, (rnd(k, 83, 61) - 0.5) * 0.4, 12 + rnd(k, 84, 61) * 14, hx('#A5804C'), 0.35);
  },
  packed_top: (im) => {
    dirtFill(im, 71, hx('#C8BB6E'), hx('#AFA356'), hx('#E0D58C'));
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
  leaves_pine: (im) => leaves(im, ['#1F5F4A', '#2F8A66', '#5DB88A', '#9AE0B4'].map(hx), 132, undefined, true),
  leaves_blossom: (im) => leaves(im, ['#E0699A', '#FF8FBE', '#FFC2DA', '#FFF0F6'].map(hx), 133, { c: hx('#FFF7F0'), n: 12, r: 1.7 }),
  leaves_birch: (im) => leaves(im, ['#78A83A', '#A5D14E', '#CDE86A', '#EAF59A'].map(hx), 134),
  leaves_maple: (im) => leaves(im, ['#A8402A', '#CC6A34', '#E6933F', '#F6C677'].map(hx), 135),
  leaves_palm: (im) => leaves(im, ['#2E8F4C', '#4DB85A', '#86DB78', '#C8F4A0'].map(hx), 136, undefined, true),
  leaves_willow: (im) => leaves(im, ['#5E9A44', '#86BE5A', '#B0DC7C', '#D8F2A4'].map(hx), 137, undefined, true),
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
  plaster: (im) => im.fill((u, v) => scale(mixc(hx('#F7E6CA'), hx('#FFF6E6'), sstep(0.2, 0.8, fbm(u, v, 3, 3, 191))), 0.98 + 0.04 * rnd(u * S, v * S, 192))),
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

/** tiles that get hash-picked variants (rolled copies of the painting; the shader also flips / rotates per block) */
const VARIANTS: Record<string, number> = {
  grass_top: 4, grass_forest_top: 4, grass_high_top: 4, grass_flower_top: 4, sand: 4, dirt: 3,
  grass_side: 2, grass_forest_side: 2, grass_high_side: 2, stone_cool: 2, stone_warm: 2, stone_dark: 2, gravel: 2, path_top: 2, packed_top: 2,
};

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
  let layers = 0;
  for (const n of names) layers += VARIANTS[n] ?? 1;
  const data = new Uint8Array(S * S * 4 * layers);
  const index = new Map<string, number>();
  const variants = new Map<string, number>();
  let layer = 0;
  for (const name of names) {
    const nv = VARIANTS[name] ?? 1;
    index.set(name, layer);
    variants.set(name, nv);
    for (let v = 0; v < nv; v++) {
      const im = new Img();
      (PAINT[name] ?? fallback(name))(im);
      if (v > 0) im.roll(Math.floor(rnd(v, 1, 777 + name.length) * S), name.includes('side') ? 0 : Math.floor(rnd(v, 2, 779 + name.length) * S), 0.96 + 0.08 * rnd(v, 3, 5));
      data.set(im.rgba(), layer * S * S * 4);
      layer++;
    }
  }
  const texture = new DataArrayTexture(data, S, S, layers);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  texture.name = 'voxel.tiles';
  return { texture, index, variants, names, layers };
}
