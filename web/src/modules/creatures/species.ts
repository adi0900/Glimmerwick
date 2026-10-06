/**
 * The three hero Glimmer species + the chibi explorer avatar, sculpted procedurally (original designs).
 *
 *  Puffbun  -- tall round "mochi" body, cheek puffs, very long ears with glowing tips + a crown star, cotton tail.
 *  Tidler   -- low axolotl-like tide-dweller: wide grin, three round gill fronds per side with glowing tips, ONE tapering
 *              3-step back crest, a short tail ending in a round fin.
 *  Sprigfox -- compact fox: two clean cone ears, ONE forehead sprout, a three-tier leaf plume tail curling in an S.
 *
 * All faces share ONE language (EYE_R / EYE_L + the mouths below): a 5x5 voxel eye (dark lash line on the top + OUTER edge
 * only, iris in two tones of one hue, a 2x2 + a 1x1 white highlight, never a black pit) and a friendly up-turned mouth.
 * Palette slots are model-specific (see each table); variants are palette rows chosen per instance.
 */
import type { ModelDef } from './actors';
import { P, type Paint, type PaintCtx, type Sculpt, type V3 } from './sculpt';

// ------------------------------------------------------------------------------------------------ shared face language
/** O lash line (top + outer edge only) . I iris . i iris +30 % lighter (bottom row, same hue) . W 2x2 highlight . w 1x1 highlight */
const EYE_R = ['.OOO.', 'IWWIO', 'IWWIO', 'IIIwO', '.iii.'];
const EYE_L = ['.OOO.', 'OWWII', 'OWWII', 'OIIwI', '.iii.'];
const SMILE6 = ['M....M', '.MMMM.'];
const SMILE8 = ['M......M', '.MMMMMM.'];
/** the little cat "w" */
const OMEGA6 = ['M.MM.M', '.M..M.'];

interface EyeInk {
  line: number;
  iris: number;
  white: number;
  /** bottom-row brightening of the iris (same hue), default 1.3 */
  lift?: number;
}

/** stamp both eyes into part `eyes`: the right eye covers cells xr..xr+4 (viewer's right), the left one is its mirror */
function eyes(s: Sculpt, head: string, xr: number, yTop: number, ink: EyeInk): void {
  const lg: Record<string, Paint> = {
    O: P(ink.line),
    I: P(ink.iris, 1, -0.14),
    i: P(ink.iris, ink.lift ?? 1.3, -0.24),
    W: P(ink.white, 1.0, -0.28),
    w: P(ink.white, 0.95, -0.18),
  };
  s.decal({ on: head, into: 'eyes', x: xr, y: yTop, rows: EYE_R, legend: lg });
  s.decal({ on: head, into: 'eyes', x: -xr - 5, y: yTop, rows: EYE_L, legend: lg });
}

/** centred (symmetric) mouth pattern; rows[0] is the top row at height y */
function mouth(s: Sculpt, head: string, rows: string[], y: number, col: Paint): void {
  s.decal({ on: head, x: -rows[0]!.length / 2, y, rows, legend: { M: col } });
}

/** a 2x2 cheek blush pair, right one at cells xr..xr+1 */
function blush(s: Sculpt, head: string, xr: number, y: number, col: Paint): void {
  s.decal({ on: head, x: xr, y, rows: ['BB', 'BB'], legend: { B: col } });
  s.decal({ on: head, x: -xr - 2, y, rows: ['BB', 'BB'], legend: { B: col } });
}

const N6: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Orphan-voxel cleanup (run after the primitives, BEFORE the designed decals / markings): a non-glowing voxel with fewer than
 * two same-colour neighbours whose other neighbours agree on one colour takes that colour. Kills rule-painting speckle.
 */
function despeckle(s: Sculpt, passes = 2): void {
  for (let pass = 0; pass < passes; pass++) {
    const B = s.bounds();
    const ups: { part: string; x: number; y: number; z: number; slot: number; h: number }[] = [];
    for (let x = B.min[0]; x <= B.max[0]; x++)
      for (let y = B.min[1]; y <= B.max[1]; y++)
        for (let z = B.min[2]; z <= B.max[2]; z++) {
          const v = s.get(x, y, z);
          if (!v || v.e !== 0) continue;
          let same = 0;
          let tot = 0;
          const seen = new Map<number, { n: number; h: number }>();
          for (const d of N6) {
            const w = s.get(x + d[0], y + d[1], z + d[2]);
            if (!w || w.part !== v.part) continue;
            tot++;
            if (w.s === v.s) same++;
            else if (w.e === 0) {
              const r = seen.get(w.s);
              if (r) r.n++;
              else seen.set(w.s, { n: 1, h: w.h });
            }
          }
          if (same >= 2 || tot < 4) continue;
          let best = -1;
          let bn = 0;
          let bh = 1;
          for (const [slot, r] of seen)
            if (r.n > bn) {
              best = slot;
              bn = r.n;
              bh = r.h;
            }
          if (best >= 0 && bn >= 3) ups.push({ part: s.names[v.part]!, x, y, z, slot: best, h: bh });
        }
    if (ups.length === 0) return;
    for (const u of ups) s.put(u.part, u.x, u.y, u.z, P(u.slot, u.h));
  }
}

/** stack `h` voxels of `part` on whatever is highest in column (x, z) */
function stackOn(s: Sculpt, part: string, x: number, z: number, h: number, paint: (k: number) => Paint): void {
  const B = s.bounds();
  for (let y = B.max[1]; y >= B.min[1]; y--) {
    if (s.get(x, y, z)) {
      for (let k = 0; k < h; k++) s.put(part, x, y + 1 + k, z, paint(k));
      return;
    }
  }
}

// ------------------------------------------------------------------------------------------------ Puffbun
const PB = { FUR: 0, LIGHT: 1, PINK: 2, GLOW: 3, DARK: 4, IRIS: 5, WHITE: 6, NOSE: 7, TAIL: 8, PAD: 9, FUR2: 10 };

function buildPuffbun(s: Sculpt): void {
  const { FUR, LIGHT, PINK, GLOW, DARK, IRIS, WHITE, NOSE, TAIL, PAD } = PB;
  s.ellipsoid('body', [0, 8.2, -0.5], [8.2, 8.0, 8.4], P(FUR), { n: 2.3 });
  for (const sx of [1, -1]) s.ellipsoid('body', [sx * 5.9, 8.0, 6.4], [2.0, 2.6, 2.1], P(FUR));
  s.recolor(['body'], (c) => {
    const bx = c.x / 5.6,
      by = (c.y - 6.3) / 6.2;
    return c.nz > 0.2 && c.z > 0 && bx * bx + by * by < 1 ? P(LIGHT) : null;
  });

  s.ellipsoid('head', [0, 17.6, 1.4], [8.3, 6.9, 7.5], P(FUR), { n: 2.3 });
  for (const sx of [1, -1]) s.ellipsoid('head', [sx * 8.0, 15.4, 2.4], [2.6, 2.5, 3.0], P(LIGHT));
  s.recolor(['head'], (c) => (c.nz > 0.3 && c.y < 15.4 && Math.abs(c.x) < 4.4 && c.z > 3.5 ? P(LIGHT) : null));

  // ears: very long, flat, rounded tips that glow, ONE clean pink inner panel (front layer, centre 60 %)
  const ear = (c: PaintCtx): Paint => (c.y > 32.4 ? P(GLOW, 1, 0.9) : c.ly > 0.2 && Math.abs(c.lx) < 0.62 ? P(PINK, 1.04) : P(FUR));
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'earR' : 'earL';
    s.taper(part, [sx * 4.7, 20.5, 0.8], [sx * 6.6, 34.4, -1.0], 3.2, 2.3, ear, { flat: 0.5 });
    s.ellipsoid(part, [sx * 6.6, 34.4, -1.0], [2.3, 2.1, 1.2], ear);
  }

  // cotton tail
  s.ellipsoid('tail', [0, 6.4, -9.8], [3.3, 3.3, 3.3], P(TAIL));
  s.ellipsoid('tail', [1.6, 7.9, -10.4], [2.2, 2.2, 2.2], P(TAIL));
  s.ellipsoid('tail', [-1.7, 5.2, -10.6], [2.1, 2.1, 2.1], P(TAIL));

  // hind feet
  for (const sx of [1, -1]) s.ellipsoid(sx > 0 ? 'footR' : 'footL', [sx * 4.4, 1.5, 4.6], [3.0, 1.6, 4.2], P(FUR));

  despeckle(s);

  // face: shared eye + little nose + cat 'w' mouth, glowing cheek sparks, crown star, toe beans
  eyes(s, 'head', 2, 19, { line: DARK, iris: IRIS, white: WHITE });
  s.decal({ on: 'head', x: -1, y: 14, rows: ['NN'], legend: { N: P(NOSE, 1, 0.1) } });
  mouth(s, 'head', OMEGA6, 13, P(DARK));
  const spark = ['.G.', 'GAG', '.G.'];
  const cl = { A: P(PINK, 1.05), G: P(GLOW, 1, 0.9) };
  s.decal({ on: 'head', x: 5, y: 13, rows: spark, legend: cl });
  s.decal({ on: 'head', x: -8, y: 13, rows: spark, legend: cl });
  s.decal({ on: 'head', dir: '+y', x: -2, y: 3, rows: ['.GG.', 'GGGG', '.GG.'], legend: { G: P(GLOW, 1, 0.95) } });
  for (const sx of [1, -1]) s.decal({ on: sx > 0 ? 'footR' : 'footL', x: sx > 0 ? 3 : -5, y: 1, rows: ['PP'], legend: { P: P(PAD) } });
}

export const PUFFBUN: ModelDef = {
  name: 'puffbun',
  vs: 0.03,
  parts: [
    { name: 'body', parent: null, pivot: [0, 8, -0.5] },
    { name: 'head', parent: 'body', pivot: [0, 14, 1] },
    { name: 'eyes', parent: 'head', pivot: [0, 17.5, 8.5] },
    { name: 'earR', parent: 'head', pivot: [4.7, 20.5, 0.8] },
    { name: 'earL', parent: 'head', pivot: [-4.7, 20.5, 0.8] },
    { name: 'tail', parent: 'body', pivot: [0, 6.4, -8.5] },
    { name: 'footR', parent: 'body', pivot: [4.4, 2.6, 2.5] },
    { name: 'footL', parent: 'body', pivot: [-4.4, 2.6, 2.5] },
  ],
  palettes: [
    ['#FFC7DB', '#FFF8F0', '#FF9CC0', '#FFD84A', '#2B1A3A', '#6A32A8', '#FFFFFF', '#E8507A', '#FFFFFF', '#FF9DBB', '#F2A9C2'],
    ['#C9B9FF', '#F6F2FF', '#9A7EF5', '#5CF2FF', '#241A45', '#4636B8', '#FFFFFF', '#7A5CE0', '#FFFFFF', '#A58FF5', '#AE98F2'],
    ['#B6EDC9', '#F6FFF2', '#62D69C', '#FF8AD4', '#1C3A33', '#1E8C6A', '#FFFFFF', '#3FB67E', '#FFFFFF', '#8EDDB0', '#98DCB2'],
  ],
  build: buildPuffbun,
};

// ------------------------------------------------------------------------------------------------ Tidler
const TD = { MAIN: 0, BELLY: 1, CORAL: 2, GLOW: 3, DARK: 4, IRIS: 5, WHITE: 6, MOUTH: 7, FIN: 8, PAD: 9 };

function buildTidler(s: Sculpt): void {
  const { MAIN, BELLY, CORAL, GLOW, DARK, IRIS, WHITE, MOUTH, FIN, PAD } = TD;
  s.ellipsoid('body', [0, 6.8, -3.5], [6.9, 5.2, 10.5], P(MAIN), { n: 2.2 });
  s.recolor(['body'], (c) => (c.ny < -0.25 || c.y < 4.2 ? P(BELLY) : null));

  // head: one soft ellipsoid, no cap, wide enough for the 5x5 eyes
  s.ellipsoid('head', [0, 9.4, 8.0], [7.5, 6.6, 6.0], P(MAIN), { n: 2.1 });
  s.recolor(['head'], (c) => (c.ny < -0.3 && c.y < 7 ? P(BELLY) : null));

  // gill fronds (3 per side): round tapering stalks with glowing tips (no flat cards)
  const gillPaint = (c: PaintCtx): Paint => (c.t > 0.72 ? P(GLOW, 1, 0.85) : P(CORAL));
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'gillR' : 'gillL';
    const base: V3 = [sx * 6.4, 10.6, 6.0];
    s.taper(part, base, [sx * 11.4, 16.4, 3.8], 2.1, 1.0, gillPaint, { flat: 0.85 });
    s.taper(part, base, [sx * 13.8, 11.6, 3.4], 2.1, 1.0, gillPaint, { flat: 0.85 });
    s.taper(part, base, [sx * 11.8, 6.6, 4.2], 2.1, 1.0, gillPaint, { flat: 0.85 });
  }

  // stubby legs
  for (const sx of [1, -1]) {
    const n = sx > 0 ? 'R' : 'L';
    s.capsule(`legF${n}`, [sx * 5.0, 5.2, 4.0], [sx * 6.0, 0.9, 4.8], 2.4, 2.0, P(MAIN));
    s.ellipsoid(`legF${n}`, [sx * 6.0, 0.9, 5.8], [2.2, 0.9, 2.6], P(PAD));
    s.capsule(`legB${n}`, [sx * 5.0, 5.2, -8.5], [sx * 6.0, 0.9, -7.8], 2.6, 2.1, P(MAIN));
    s.ellipsoid(`legB${n}`, [sx * 6.0, 0.9, -6.8], [2.5, 1.0, 3.0], P(PAD));
  }

  // short tail ending in a round fin
  s.capsule('tail1', [0, 7.0, -12.0], [0, 6.6, -15.6], 4.0, 3.0, P(MAIN));
  s.recolor(['tail1'], (c) => (c.ny < -0.3 ? P(BELLY) : null));
  s.ellipsoid('tail2', [0, 6.4, -19.4], [1.3, 4.6, 4.2], (c) => (c.r > 0.78 ? P(CORAL) : P(FIN)), { n: 2.4 });

  // dorsal crest: ONE tapering 3-step ridge (3 -> 2 -> 1 high, 2 wide) fused to the back, glowing cap every 4th step
  for (let z = 1; z >= -14; z--) {
    const h = z > -3 ? 3 : z > -9 ? 2 : 1;
    const cap = (((z % 4) + 4) % 4) === 1;
    for (const x of [-1, 0]) stackOn(s, 'body', x, z, h, (k) => (k === h - 1 && cap ? P(GLOW, 1, 0.85) : P(CORAL)));
  }

  despeckle(s);

  // face: shared eyes, wide up-turned grin, two cheek blushes
  eyes(s, 'head', 1, 11, { line: DARK, iris: IRIS, white: WHITE });
  mouth(s, 'head', SMILE8, 5, P(MOUTH));
  blush(s, 'head', 5, 7, P(CORAL, 1.05));

  // glowing markings (designed shapes, >= 2 voxels)
  for (const [x, z] of [
    [3, -8],
    [-4, -8],
    [3, -3],
    [-4, -3],
    [2, 1],
    [-3, 1],
  ] as const)
    for (let dx = 0; dx < 2; dx++) s.topCell('body', x + dx, z, P(GLOW, 1, 0.85));
  for (const [x, z] of [
    [3, 6],
    [-5, 6],
  ] as const)
    for (let dx = 0; dx < 2; dx++) s.topCell('head', x + dx, z, P(GLOW, 1, 0.85));
  for (const [y, z] of [
    [6, -18],
    [8, -21],
    [4, -21],
  ] as const)
    for (const x of [0, -1]) s.put('tail2', x, y, z, P(GLOW, 1, 0.85));
}

export const TIDLER: ModelDef = {
  name: 'tidler',
  vs: 0.03,
  parts: [
    { name: 'body', parent: null, pivot: [0, 6.8, -3.5] },
    { name: 'head', parent: 'body', pivot: [0, 7.5, 4.5] },
    { name: 'eyes', parent: 'head', pivot: [0, 9.5, 13.5] },
    { name: 'gillR', parent: 'head', pivot: [6.4, 10.6, 6] },
    { name: 'gillL', parent: 'head', pivot: [-6.4, 10.6, 6] },
    { name: 'legFR', parent: 'body', pivot: [5, 5.2, 4] },
    { name: 'legFL', parent: 'body', pivot: [-5, 5.2, 4] },
    { name: 'legBR', parent: 'body', pivot: [5, 5.2, -8.5] },
    { name: 'legBL', parent: 'body', pivot: [-5, 5.2, -8.5] },
    { name: 'tail1', parent: 'body', pivot: [0, 7, -12] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 6.5, -15.6] },
  ],
  palettes: [
    ['#38C0D0', '#FFF1D8', '#FF8A7A', '#8CFFF0', '#1B2B45', '#E09A18', '#FFFFFF', '#5A2F45', '#66D6E0', '#FFE2BC'],
    ['#FFB466', '#FFF4DA', '#FF6A7C', '#FFF09A', '#3A2118', '#8A2A8C', '#FFFFFF', '#6A2F2F', '#FFCF92', '#FFE8C8'],
    ['#9082F5', '#F0EBFF', '#FF9AD2', '#6FF3FF', '#1E1A45', '#D98E10', '#FFFFFF', '#4F2F6A', '#B5A9FB', '#E2DCFF'],
  ],
  build: buildTidler,
};

// ------------------------------------------------------------------------------------------------ Sprigfox
const SF = { FUR: 0, CREAM: 1, DARK: 2, GLOW: 3, EYE: 4, IRIS: 5, WHITE: 6, NOSE: 7, LEAF: 8, LEAF2: 9, STEM: 10 };

function buildSprigfox(s: Sculpt): void {
  const { FUR, CREAM, DARK, GLOW, EYE, IRIS, WHITE, NOSE, LEAF, LEAF2, STEM } = SF;
  s.ellipsoid('body', [0, 9.2, -1.0], [5.3, 5.2, 9.6], P(FUR), { n: 2.2 });
  s.recolor(['body'], (c) => (c.ny < -0.3 || (c.nz > 0.3 && c.y < 11.5 && c.z > 3) ? P(CREAM) : null));

  // head: round, with cream cheek ruffs and a soft rounded muzzle
  s.ellipsoid('head', [0, 15.4, 7.8], [6.9, 5.6, 5.9], P(FUR), { n: 2.2 });
  s.ellipsoid('head', [0, 13.0, 12.4], [3.0, 1.9, 3.5], P(CREAM));
  s.recolor(['head'], (c) => (c.nz > 0.3 && c.y < 13.6 && c.z > 6 ? P(CREAM) : null));

  // ears: two clean cones, dark tip cap, ONE cream inner wedge on the front layer
  const earP = (c: PaintCtx): Paint => (c.t > 0.8 ? P(DARK) : P(FUR));
  for (const sx of [1, -1]) s.taper(sx > 0 ? 'earR' : 'earL', [sx * 4.2, 19.0, 6.4], [sx * 7.2, 30.6, 4.2], 3.3, 0.5, earP, { flat: 0.6 });

  // ONE small forehead sprout
  s.capsule('sprout', [0, 20.4, 9.6], [0, 22.0, 9.8], 0.95, 0.75, P(STEM));
  const sproutP = (c: PaintCtx): Paint => (c.t > 0.7 ? P(GLOW, 1, 0.9) : P(LEAF2));
  s.leaf('sprout', [0.3, 21.9, 9.8], [2.2, 25.2, 9.8], 1.35, [0, 0, 1], sproutP, 0.5);
  s.leaf('sprout', [-0.3, 21.9, 9.8], [-2.2, 25.2, 9.8], 1.35, [0, 0, 1], sproutP, 0.5);

  // legs (short, sturdy)
  const sock = (c: PaintCtx): Paint => (c.y < 3.6 ? P(DARK) : P(FUR));
  for (const sx of [1, -1]) {
    const n = sx > 0 ? 'R' : 'L';
    s.capsule(`legF${n}`, [sx * 3.3, 7.2, 5.2], [sx * 3.4, 1.4, 6.0], 2.0, 1.5, sock);
    s.ellipsoid(`legF${n}`, [sx * 3.4, 0.9, 6.8], [1.8, 0.9, 2.3], P(DARK));
    s.ellipsoid(`legB${n}`, [sx * 3.9, 7.0, -6.4], [2.7, 3.8, 3.8], P(FUR));
    s.capsule(`legB${n}`, [sx * 3.7, 4.6, -6.8], [sx * 3.6, 1.4, -5.4], 1.7, 1.4, sock);
    s.ellipsoid(`legB${n}`, [sx * 3.6, 0.9, -4.6], [1.7, 0.9, 2.4], P(DARK));
  }

  // tail: fluffy base + a three-tier leaf plume on a thin S-curved spine (tiers dark -> light, glowing tips)
  s.capsule('tail1', [0, 10.5, -9.5], [0, 12.4, -13.6], 3.1, 3.5, P(FUR));
  const T: V3 = [0, 13.2, -14.6];
  const A: V3 = [0, 16.8, -19.6];
  const Bp: V3 = [0, 22.0, -20.2];
  const C: V3 = [0, 26.0, -17.0];
  const D: V3 = [0, 27.8, -12.8];
  s.capsule('tail2', T, A, 2.4, 2.0, P(LEAF));
  s.capsule('tail2', A, Bp, 2.0, 1.8, P(LEAF));
  s.capsule('tail2', Bp, C, 1.8, 1.5, P(LEAF));
  s.capsule('tail2', C, D, 1.5, 1.1, P(LEAF));
  const tier = (col: number) => (c: PaintCtx): Paint => (c.t > 0.74 ? P(GLOW, 1, 0.9) : P(col));
  const th: V3 = [0, 0, 1];
  for (const sx of [1, -1]) {
    s.leaf('tail2', A, [sx * 7.4, 16.4, -24.6], 2.4, th, tier(STEM), 0.75);
    s.leaf('tail2', Bp, [sx * 6.8, 23.0, -25.4], 2.2, th, tier(LEAF), 0.75);
    s.leaf('tail2', C, [sx * 5.4, 28.0, -21.6], 1.8, th, tier(LEAF2), 0.75);
  }
  s.leaf('tail2', C, [0, 30.0, -14.2], 1.8, [0, 0, 1], tier(LEAF2), 0.75);

  despeckle(s);

  // inner ears: ONE clean tapering cream wedge per ear, stamped as a designed decal (rule-painting a thin leaning cone checkers)
  for (const sx of [1, -1])
    for (let y = 21; y <= 28; y++) {
      const cx = 4.2 + (y + 0.5 - 19) * 0.26;
      const hw = Math.max(0.55, 1.75 - (y - 21) * 0.17);
      for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
        if (Math.abs(x + 0.5 - cx) > hw) continue;
        s.decal({ on: sx > 0 ? 'earR' : 'earL', x: sx > 0 ? x : -x - 1, y, rows: ['C'], legend: { C: P(CREAM, 0.98) } });
      }
    }

  // face: shared eyes, small nose, cat 'w' mouth on the muzzle; glowing chest glyph
  eyes(s, 'head', 1, 19, { line: EYE, iris: IRIS, white: WHITE, lift: 1.4 });
  s.decal({ on: 'head', x: -1, y: 14, rows: ['NN'], legend: { N: P(NOSE, 1, 0.1) } });
  mouth(s, 'head', OMEGA6, 12, P(NOSE));
  s.decal({ on: 'body', x: -2, y: 8, rows: ['.GG.', 'GGGG', '.GG.'], legend: { G: P(GLOW, 1, 0.95) } });
}

export const SPRIGFOX: ModelDef = {
  name: 'sprigfox',
  vs: 0.03,
  parts: [
    { name: 'body', parent: null, pivot: [0, 9, -1] },
    { name: 'head', parent: 'body', pivot: [0, 13.5, 5] },
    { name: 'eyes', parent: 'head', pivot: [0, 17.5, 13] },
    { name: 'earR', parent: 'head', pivot: [4.2, 19, 6.4] },
    { name: 'earL', parent: 'head', pivot: [-4.2, 19, 6.4] },
    { name: 'sprout', parent: 'head', pivot: [0, 20.4, 9.6] },
    { name: 'legFR', parent: 'body', pivot: [3.3, 7.2, 5.2] },
    { name: 'legFL', parent: 'body', pivot: [-3.3, 7.2, 5.2] },
    { name: 'legBR', parent: 'body', pivot: [3.9, 8, -6.4] },
    { name: 'legBL', parent: 'body', pivot: [-3.9, 8, -6.4] },
    { name: 'tail1', parent: 'body', pivot: [0, 10.5, -9.5] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 13.2, -14.6] },
  ],
  palettes: [
    ['#F58E3C', '#FFCB8E', '#5A3322', '#C6FF6A', '#4A2A1C', '#3FAE5A', '#FFFFFF', '#8A2F3A', '#3CC46C', '#9BEB74', '#2F8F55'],
    ['#A6BEEE', '#EEF3FF', '#3A4A78', '#7DFFF0', '#2A3252', '#D2457F', '#FFFFFF', '#7A2F4A', '#EC6E92', '#FFB8C8', '#B84A66'],
    ['#F7CC50', '#FFE6A0', '#7A4A1F', '#FF9BE0', '#4A2A1C', '#1FA39A', '#FFFFFF', '#8A3A2A', '#24BCB4', '#86EFD6', '#1A7F78'],
  ],
  build: buildSprigfox,
};

// ------------------------------------------------------------------------------------------------ Explorer avatar
export const AV = { SKIN: 0, HAIR: 1, SHIRT: 2, PANTS: 3, BOOTS: 4, PACK: 5, EYE: 6, WHITE: 7, IRIS: 8, BLUSH: 9, MOUTH: 10, TRIM: 11, GLOW: 12, PACK2: 13 };

function buildAvatar(s: Sculpt): void {
  const { SKIN, HAIR, SHIRT, PANTS, BOOTS, PACK, EYE, WHITE, IRIS, BLUSH, MOUTH, TRIM, GLOW, PACK2 } = AV;
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'legR' : 'legL';
    s.box(part, [sx * 2.2, 3.8, 0], [3.8, 7.6, 4.0], (c) => (c.y < 2.6 ? P(BOOTS) : P(PANTS)), { round: 0.9 });
    s.ellipsoid(part, [sx * 2.2, 1.4, 1.1], [2.2, 1.5, 3.1], P(BOOTS));
  }
  s.box('body', [0, 11.2, 0], [9.0, 7.6, 5.6], P(SHIRT), { round: 1.6 });
  s.recolor(['body'], (c) => (c.y < 8.6 || c.y > 14.2 ? P(TRIM) : null));
  for (const sx of [1, -1]) s.box('body', [sx * 2.8, 11.6, 2.8], [1.6, 6.4, 0.8], P(PACK));
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'armR' : 'armL';
    s.capsule(part, [sx * 5.5, 14.0, 0], [sx * 6.0, 8.8, 0.6], 2.0, 1.8, (c) => (c.y < 10.2 ? P(TRIM) : P(SHIRT)));
    s.ellipsoid(part, [sx * 6.1, 7.6, 0.7], [1.9, 1.9, 1.9], P(SKIN));
  }
  s.ellipsoid('head', [0, 20.8, 0.2], [7.3, 6.5, 6.7], P(SKIN), { n: 2.5 });
  for (const sx of [1, -1]) s.ellipsoid('head', [sx * 7.2, 20.4, 0], [1.4, 2.2, 1.8], P(SKIN));
  s.ellipsoid('head', [0, 22.6, -0.6], [7.9, 6.2, 7.6], (c) => (c.y < 18.6 || (c.nz > 0.3 && c.y < 24.2) ? null : P(HAIR)), { n: 2.5 });
  s.capsule('hair', [0, 23.0, -6.5], [0, 16.5, -10.0], 3.0, 1.4, (c) => (c.t < 0.2 ? P(TRIM) : P(HAIR)));
  s.box('pack', [0, 11.4, -5.6], [8.0, 9.2, 4.2], (c) => (c.y > 13.4 ? P(PACK2) : P(PACK)), { round: 1.1 });

  despeckle(s);

  s.decal({ on: 'body', x: -1, y: 12, rows: ['GG', 'GG'], legend: { G: P(GLOW, 1, 0.9) } });
  s.decal({ on: 'pack', dir: '-z', x: 0, y: 11, rows: ['GG'], legend: { G: P(GLOW, 1, 0.9) } });
  // face: side locks frame the forehead, shared eyes, a real 6-voxel smile, 2-voxel blush per cheek
  eyes(s, 'head', 1, 23, { line: EYE, iris: IRIS, white: WHITE, lift: 1.6 });
  mouth(s, 'head', SMILE6, 17, P(MOUTH));
  s.decal({ on: 'head', x: 4, y: 18, rows: ['BB'], legend: { B: P(BLUSH, 1.02) } });
  s.decal({ on: 'head', x: -6, y: 18, rows: ['BB'], legend: { B: P(BLUSH, 1.02) } });
}

export const AVATAR: ModelDef = {
  name: 'avatar',
  vs: 0.04,
  parts: [
    { name: 'body', parent: null, pivot: [0, 11.2, 0] },
    { name: 'head', parent: 'body', pivot: [0, 15.2, 0] },
    { name: 'eyes', parent: 'head', pivot: [0, 21.5, 6] },
    { name: 'hair', parent: 'head', pivot: [0, 22.5, -6] },
    { name: 'armR', parent: 'body', pivot: [5.6, 14, 0] },
    { name: 'armL', parent: 'body', pivot: [-5.6, 14, 0] },
    { name: 'legR', parent: 'body', pivot: [2.2, 7.8, 0] },
    { name: 'legL', parent: 'body', pivot: [-2.2, 7.8, 0] },
    { name: 'pack', parent: 'body', pivot: [0, 14.5, -4] },
  ],
  palettes: [['#FFD3B3', '#5B3A28', '#F0594E', '#3A55B0', '#7A4A2B', '#2BA6B4', '#4A2C20', '#FFFFFF', '#8E5A26', '#FF9A9A', '#A0443A', '#FFF0D6', '#7DF4FF', '#E9C46A']],
  build: buildAvatar,
};

export const SPECIES_DEFS: ModelDef[] = [PUFFBUN, TIDLER, SPRIGFOX];
export const SPECIES_NAMES = ['Puffbun', 'Tidler', 'Sprigfox'];
/** sim base scales (crates/sim_creatures species table) -- used by the lab for true-size lineups */
export const SPECIES_BASE_SCALE = [0.8, 0.9, 0.75];
