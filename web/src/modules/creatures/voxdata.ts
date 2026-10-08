/**
 * Authored voxel data (the "3D pixel art" pipeline): a model is a stack of hand-drawn *depth slices*.
 *
 * FORMAT (like a tiny .vox file in text form)
 *   Each part is a `VoxPart`: a block of text where every slice is a FRONT-VIEW sprite (what a viewer in front of the
 *   creature sees: columns left -> right = +x, rows top -> bottom = -y) and the slices run from the FRONT of the part
 *   (+z, the face side) to the back. So the first slice is the face-side silhouette, the next slice is the sprite one
 *   voxel deeper, and so on -- you can read a model like a stack of pixel-art cross sections.
 *     rows   one text row per voxel row, `.` or space = empty, any other glyph = a voxel painted by the model legend
 *     `-`    a line holding only `-` ends a slice;   `=` a line holding only `=` repeats the previous slice (extrusion)
 *     origin `y` = world row of the first text row, `z` = world slice of the first slice (later slices are z-1, z-2 ...),
 *            `x` = world column of the first text char (default 0); `mirror: true` means the text holds only the
 *            viewer-RIGHT half starting at column x (>= 0) and is mirrored to -1-x (models are symmetric about x = 0);
 *            `mirror: 'earL'` additionally copies the mirrored half into another part (a separate pivot) instead of the same one.
 *   Legend glyphs are either a fixed `Paint` ({ s: palette slot, h: shade, e: emissive }) or an auto-toned ramp
 *   `{ ramp: [deep, shade, base, light, hi] }`: after the whole model is placed each ramp voxel is toned by how it is lit
 *   (top lip = hi, top = light, side = base, the row under a light edge dithers base/light in a checkerboard, underside =
 *   shade, bottom/back corners = deep), i.e. painted-in lighting + selective outline + deliberate dither, never noise.
 *   Faces are `FaceDef`s: 2D sprites per expression frame (0 neutral, 1 blink, 2 happy, 3 sleep, 4 surprised ...) stamped
 *   onto the first voxel of the part along +z; frames only recolour surface voxels (same geometry), the renderer picks the
 *   frame per instance (see `bake` / the actor material), so expressions are frame swaps exactly like sprite animation.
 *   `.` in a frame = the plain surface colour, `=` = same as the neutral frame.
 * Palettes: `ramp5(hex)` builds 5 hue-shifted tones (shadow toward blue-violet, light toward warm) from one base colour.
 */
import { Color, SRGBColorSpace } from 'three';
import { P, type Paint, type Sculpt } from './sculpt';

export interface VoxPart {
  part: string;
  text: string;
  y: number;
  z: number;
  x?: number;
  mirror?: boolean | string;
}
export type Glyph = Paint | { ramp: number[]; dither?: boolean; /** back faces get vertical light strands (every 3rd column) -- hair */ strands?: boolean };
export type Legend = Record<string, Glyph>;
export interface FaceDef {
  on: string;
  /** world column of the first text char (viewer-left cell of the patch) and world row of the first text row */
  x: number;
  y: number;
  /** frame index -> text rows (frame 0 = neutral) */
  frames: Record<number, string>;
  legend: Record<string, Paint>;
}
export const FACE_FRAMES = { NEUTRAL: 0, BLINK: 1, HAPPY: 2, SLEEP: 3, SURPRISED: 4 } as const;

export function parseSlices(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l === '') continue;
    if (l === '-' || l === '=') {
      if (l === '=') out.push(out[out.length - 1]!.slice());
      else out.push(cur);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

interface Pend {
  x: number;
  y: number;
  z: number;
  ramp: number[];
  dither: boolean;
  strands: boolean;
}

/** place every part's voxels, then tone the auto-ramp voxels from the finished model */
export function authorModel(s: Sculpt, parts: VoxPart[], legend: Legend, faces: FaceDef[] = [], post?: (s: Sculpt) => void): void {
  const pend: Pend[] = [];
  const put = (part: string, x: number, y: number, z: number, g: Glyph): void => {
    if ('ramp' in g) {
      s.put(part, x, y, z, P(g.ramp[2]!));
      pend.push({ x, y, z, ramp: g.ramp, dither: g.dither !== false, strands: g.strands === true });
    } else s.put(part, x, y, z, g);
  };
  for (const vp of parts) {
    const slices = parseSlices(vp.text);
    slices.forEach((rows, k) => {
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
          const ch = row[c]!;
          if (ch === '.' || ch === ' ') continue;
          const g = legend[ch];
          if (!g) throw new Error(`voxdata: glyph "${ch}" has no legend entry (part ${vp.part})`);
          const y = vp.y - r;
          const z = vp.z - k;
          if (vp.mirror) {
            const x0 = vp.x ?? 0;
            put(vp.part, x0 + c, y, z, g);
            put(typeof vp.mirror === 'string' ? vp.mirror : vp.part, -1 - (x0 + c), y, z, g);
          } else put(vp.part, (vp.x ?? 0) + c, y, z, g);
        }
      });
    });
  }
  tone(s, pend);
  post?.(s);
  for (const f of faces) stampFace(s, f);
}

const has = (s: Sculpt, x: number, y: number, z: number): boolean => s.get(x, y, z) !== undefined;

function tone(s: Sculpt, pend: Pend[]): void {
  const key = new Map<string, Pend>();
  for (const p of pend) key.set(`${p.x},${p.y},${p.z}`, p);
  const exposedUp = (x: number, y: number, z: number): boolean => !has(s, x, y + 1, z);
  const res: [Pend, number][] = [];
  for (const p of pend) {
    const { x, y, z } = p;
    const up = !has(s, x, y + 1, z);
    const dn = !has(s, x, y - 1, z);
    const front = !has(s, x, y, z + 1);
    const back = !has(s, x, y, z - 1);
    const side = !has(s, x + 1, y, z) || !has(s, x - 1, y, z);
    let t = 2;
    if (up) t = front ? 4 : 3;
    else if (dn && !front) t = (back ? 1 : 0) + (side ? 1 : 0) >= 1 ? 0 : 1;
    else if (dn) t = 2;
    else if (back && side) t = 1;
    else if (p.dither && side) {
      const par = (x + y + z) & 1;
      const aboveUp = has(s, x, y + 1, z) && exposedUp(x, y + 1, z);
      if (aboveUp && (front || side) && par) t = 3;
    }
    if (p.strands && back && !up && t <= 2 && (((x % 3) + 3) % 3) === 0) t = 3;
    res.push([p, t]);
  }
  for (const [p, t] of res) {
    const v = s.get(p.x, p.y, p.z)!;
    v.s = p.ramp[Math.min(t, p.ramp.length - 1)]!;
  }
}

/** stamp the frames of a face sprite onto the surface of `on`: frame 0 recolours the voxel, the others store alternates */
function stampFace(s: Sculpt, f: FaceDef): void {
  const on = s.idx(f.on);
  const B = s.bounds();
  const frames = Object.keys(f.frames)
    .map(Number)
    .sort((a, b) => a - b);
  const rows: Record<number, string[]> = {};
  for (const k of frames) rows[k] = f.frames[k]!.split('\n').map((l) => l.trim()).filter((l) => l.length);
  const n = rows[0]!.length;
  const w = Math.max(...rows[0]!.map((l) => l.length));
  for (let r = 0; r < n; r++)
    for (let c = 0; c < w; c++) {
      const x = f.x + c;
      const y = f.y - r;
      let z = B.max[2];
      let v = s.get(x, y, z);
      while (z >= B.min[2] && !(v && v.part === on)) {
        z--;
        v = s.get(x, y, z);
      }
      if (!v) continue;
      const base: Paint = { s: v.s, h: v.h, e: v.e };
      const paintOf = (k: number): Paint => {
        const ch = rows[k]?.[r]?.[c] ?? '.';
        if (ch === '.' || ch === ' ') return base;
        if (ch === '=') return paintOf(0);
        const p = f.legend[ch];
        if (!p) throw new Error(`voxdata: face glyph "${ch}" has no legend entry`);
        return p;
      };
      const p0 = paintOf(0);
      for (const k of frames) {
        if (k === 0) continue;
        const pk = paintOf(k);
        if (pk.s !== p0.s || (pk.h ?? 1) !== (p0.h ?? 1) || (pk.e ?? 0) !== (p0.e ?? 0)) s.setFrame(x, y, z, k, pk);
      }
      s.put(f.on, x, y, z, p0);
    }
}

// ------------------------------------------------------------------------------------------------ palettes
const _c = new Color();
const hsl = { h: 0, s: 0, l: 0 };
const lerpHue = (h: number, to: number, k: number): number => {
  let d = ((to - h + 1.5) % 1) - 0.5;
  if (d < -0.5) d += 1;
  return (h + d * k + 1) % 1;
};
const hex = (h: number, s: number, l: number): string => '#' + _c.setHSL(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)), SRGBColorSpace).getHexString(SRGBColorSpace);

/** 5 tones from one base colour: [deep, shade, base, light, hi]; shadows hue-shift to blue-violet, lights to warm yellow */
export function ramp5(base: string): string[] {
  _c.set(base).getHSL(hsl, SRGBColorSpace);
  const { h, l } = hsl;
  // very light pastels (cream) have HSL saturation ~1, which would make their shadows vivid orange: damp it
  const s = hsl.s * (l > 0.7 ? 1 - Math.min(0.55, (l - 0.7) * 2.4) : 1);
  const cool = 0.74;
  const k = l > 0.75 ? 2.2 : 1; // pale colours shift further so their shadows go mauve instead of muddy brown
  const warm = 0.12;
  return [
    hex(lerpHue(h, cool, 0.1 * k), s * 1.02 + 0.03, l * (l > 0.85 ? 0.8 : l > 0.75 ? 0.74 : 0.7)),
    hex(lerpHue(h, cool, 0.05 * k), s * 1.0 + 0.01, l * (l > 0.85 ? 0.91 : 0.86)),
    base,
    hex(lerpHue(h, warm, 0.06), s * 0.97, l + (1 - l) * 0.2),
    hex(lerpHue(h, warm, 0.1), s * 0.85, l + (1 - l) * 0.42),
  ];
}
/** 3 tones: [shade, base, light] */
export function ramp3(base: string): string[] {
  const r = ramp5(base);
  return [r[1]!, r[2]!, r[3]!];
}
/** slightly lighter / darker copy of a colour (same hue family) */
export function tint(base: string, dl: number): string {
  _c.set(base).getHSL(hsl, SRGBColorSpace);
  return hex(hsl.h, hsl.s, hsl.l + dl);
}
