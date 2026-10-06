/**
 * The three hero Glimmer species + the chibi explorer avatar, sculpted procedurally (original designs).
 *
 *  Puffbun  -- tall round "mochi" body, cheek puffs, very long ears with glowing tips + a crown star, cotton tail.
 *  Tidler   -- low long axolotl-like tide-dweller: wide smile, three gill fronds per side that glow, paddle tail, glowing back spots.
 *  Sprigfox -- slender fox with huge triangular ears, a forehead sprout and a fan of leaves for a tail (glowing leaf tips).
 *
 * Palette slots are model-specific (see each table); variants are palette rows chosen per instance.
 */
import type { ModelDef } from './actors';
import { P, type Paint, type Sculpt } from './sculpt';

const mir = (rows: string[]): string[] => rows.map((r) => r.split('').reverse().join(''));

/** glossy bead eye: dark base, 2-voxel white highlight (constant glow), small second highlight, tinted iris rows */
function eyeLegend(dark: number, iris: number, white: number): Record<string, Paint> {
  return { D: P(dark), W: P(white, 1.05, -0.85), w: P(white, 0.92, -0.45), I: P(iris, 1, -0.22) };
}
const EYE5 = ['.DD.', 'DWWD', 'DDDD', 'DIID', '.II.'];
const EYE4 = ['.DD.', 'DWWD', 'DIID', '.II.'];

// ------------------------------------------------------------------------------------------------ Puffbun
const PB = { FUR: 0, LIGHT: 1, PINK: 2, GLOW: 3, DARK: 4, IRIS: 5, WHITE: 6, NOSE: 7, TAIL: 8, PAD: 9, FUR2: 10 };

function buildPuffbun(s: Sculpt): void {
  const { FUR, LIGHT, PINK, GLOW, DARK, NOSE, TAIL, PAD } = PB;
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

  // face
  const lg = eyeLegend(DARK, PB.IRIS, PB.WHITE);
  s.decal({ on: 'head', into: 'eyes', x: 2, y: 19, rows: EYE5, legend: lg });
  s.decal({ on: 'head', into: 'eyes', x: -6, y: 19, rows: EYE5, legend: lg });
  s.decal({ on: 'head', x: -2, y: 14, rows: ['.NN.', 'D..D', '.DD.'], legend: { N: P(NOSE, 1, 0.1), D: P(DARK) } });
  const spark = ['.G.', 'GAG', '.G.'];
  const cl = { A: P(PINK, 1.05), G: P(GLOW, 1, 0.9) };
  s.decal({ on: 'head', x: 5, y: 15, rows: spark, legend: cl });
  s.decal({ on: 'head', x: -8, y: 15, rows: spark, legend: cl });
  s.decal({ on: 'head', dir: '+y', x: -2, y: 3, rows: ['.GG.', 'GGGG', '.GG.'], legend: { G: P(GLOW, 1, 0.95) } });

  // ears: very long, flat, rounded tips that glow, pink inner face
  const ear = (c: { y: number; nz: number; r: number }): Paint => (c.y > 32.6 ? P(GLOW, 1, 0.9) : c.nz > 0.45 && c.r > 0.3 ? P(PINK, 1.04) : P(FUR));
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'earR' : 'earL';
    s.taper(part, [sx * 4.7, 20.5, 0.8], [sx * 6.6, 34.4, -1.0], 3.2, 2.3, ear, { flat: 0.5 });
    s.ellipsoid(part, [sx * 6.6, 34.4, -1.0], [2.3, 2.1, 1.2], ear);
  }

  // cotton tail
  s.ellipsoid('tail', [0, 6.4, -9.8], [3.3, 3.3, 3.3], P(TAIL));
  s.ellipsoid('tail', [1.6, 7.9, -10.4], [2.2, 2.2, 2.2], P(TAIL));
  s.ellipsoid('tail', [-1.7, 5.2, -10.6], [2.1, 2.1, 2.1], P(TAIL));

  // hind feet with two toe beans
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'footR' : 'footL';
    s.ellipsoid(part, [sx * 4.4, 1.5, 4.6], [3.0, 1.6, 4.2], P(FUR));
    s.decal({ on: part, x: sx > 0 ? 3 : -5, y: 1, rows: ['PP'], legend: { P: P(PAD) } });
  }
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
    ['#FFC7DB', '#FFF8F0', '#FF9CC0', '#FFD84A', '#2B1A3A', '#7A3FB0', '#FFFFFF', '#E8507A', '#FFFFFF', '#FF9DBB', '#F2A9C2'],
    ['#C9B9FF', '#F6F2FF', '#9A7EF5', '#5CF2FF', '#241A45', '#3B4FD0', '#FFFFFF', '#7A5CE0', '#FFFFFF', '#A58FF5', '#AE98F2'],
    ['#B6EDC9', '#F6FFF2', '#62D69C', '#FF8AD4', '#1C3A33', '#1E8C6A', '#FFFFFF', '#3FB67E', '#FFFFFF', '#8EDDB0', '#98DCB2'],
  ],
  build: buildPuffbun,
};

// ------------------------------------------------------------------------------------------------ Tidler
const TD = { MAIN: 0, BELLY: 1, CORAL: 2, GLOW: 3, DARK: 4, IRIS: 5, WHITE: 6, MOUTH: 7, FIN: 8, PAD: 9 };

function buildTidler(s: Sculpt): void {
  const { MAIN, BELLY, CORAL, GLOW, DARK, MOUTH, FIN, PAD } = TD;
  s.ellipsoid('body', [0, 6.8, -3.5], [6.2, 5.0, 10.5], P(MAIN), { n: 2.2 });
  s.recolor(['body'], (c) => (c.ny < -0.25 || c.y < 4.2 ? P(BELLY) : null));
  s.box('body', [0, 11.2, -4.0], [2, 1.8, 16], (c) => (c.y > 12.0 && (((Math.floor(c.z) % 3) + 3) % 3 === 0) ? P(GLOW, 1, 0.8) : P(CORAL)), { round: 0.8 });
  for (const [x, z] of [
    [3, -8],
    [-4, -8],
    [3, -3],
    [-4, -3],
    [2, 1],
    [-3, 1],
  ] as const)
    for (let dx = 0; dx < 2; dx++) s.topCell('body', x + dx, z, P(GLOW, 1, 0.85));

  s.ellipsoid('head', [0, 9.4, 8.0], [6.9, 6.6, 6.0], P(MAIN), { n: 2.1 });
  s.recolor(['head'], (c) => (c.ny < -0.3 && c.y < 7 ? P(BELLY) : null));
  s.decal({ on: 'head', x: -4, y: 4, rows: ['D......D', '.DDDDDD.'], legend: { D: P(MOUTH) } });
  const lg = eyeLegend(DARK, TD.IRIS, TD.WHITE);
  s.decal({ on: 'head', into: 'eyes', x: 3, y: 10, rows: EYE5, legend: lg });
  s.decal({ on: 'head', into: 'eyes', x: -7, y: 10, rows: EYE5, legend: lg });
  for (const [x, z] of [
    [3, 6],
    [-4, 6],
  ] as const)
    s.topCell('head', x, z, P(GLOW, 1, 0.85));

  // gill fronds (3 per side) with glowing tips
  const gillPaint = (c: { t: number }): Paint => (c.t > 0.72 ? P(GLOW, 1, 0.85) : P(CORAL));
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'gillR' : 'gillL';
    const base: [number, number, number] = [sx * 5.6, 10.6, 6.0];
    s.taper(part, base, [sx * 10.8, 16.6, 3.8], 2.6, 1.5, gillPaint, { flat: 0.7 });
    s.taper(part, base, [sx * 13.6, 11.6, 3.4], 2.6, 1.5, gillPaint, { flat: 0.7 });
    s.taper(part, base, [sx * 11.6, 6.4, 4.4], 2.6, 1.5, gillPaint, { flat: 0.7 });
  }

  // stubby legs
  for (const sx of [1, -1]) {
    const n = sx > 0 ? 'R' : 'L';
    s.capsule(`legF${n}`, [sx * 5.0, 5.2, 4.0], [sx * 6.0, 0.9, 4.8], 2.4, 2.0, P(MAIN));
    s.ellipsoid(`legF${n}`, [sx * 6.0, 0.9, 5.8], [2.2, 0.9, 2.6], P(PAD));
    s.capsule(`legB${n}`, [sx * 5.0, 5.2, -8.5], [sx * 6.0, 0.9, -7.8], 2.6, 2.1, P(MAIN));
    s.ellipsoid(`legB${n}`, [sx * 6.0, 0.9, -6.8], [2.5, 1.0, 3.0], P(PAD));
  }

  // tail: round base + vertical paddle fin
  s.capsule('tail1', [0, 7.0, -12.0], [0, 6.4, -19.0], 4.0, 2.6, P(MAIN));
  s.recolor(['tail1'], (c) => (c.ny < -0.3 ? P(BELLY) : null));
  s.ellipsoid('tail2', [0, 6.4, -23.5], [1.3, 5.2, 5.6], (c) => (c.r > 0.8 ? P(CORAL) : P(FIN)), { n: 2.4 });
  for (const [y, z] of [
    [6, -22],
    [8, -25],
    [4, -25],
  ] as const)
    for (const x of [0, -1]) s.put('tail2', x, y, z, P(GLOW, 1, 0.85));
}

export const TIDLER: ModelDef = {
  name: 'tidler',
  vs: 0.03,
  parts: [
    { name: 'body', parent: null, pivot: [0, 6.8, -3.5] },
    { name: 'head', parent: 'body', pivot: [0, 7.5, 4.5] },
    { name: 'eyes', parent: 'head', pivot: [0, 8.5, 13.5] },
    { name: 'gillR', parent: 'head', pivot: [5.6, 10.6, 6] },
    { name: 'gillL', parent: 'head', pivot: [-5.6, 10.6, 6] },
    { name: 'legFR', parent: 'body', pivot: [5, 5.2, 4] },
    { name: 'legFL', parent: 'body', pivot: [-5, 5.2, 4] },
    { name: 'legBR', parent: 'body', pivot: [5, 5.2, -8.5] },
    { name: 'legBL', parent: 'body', pivot: [-5, 5.2, -8.5] },
    { name: 'tail1', parent: 'body', pivot: [0, 7, -12] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 6.4, -18.5] },
  ],
  palettes: [
    ['#38C0D0', '#FFF1D8', '#FF8A7A', '#8CFFF0', '#1B2B45', '#FFB62E', '#FFFFFF', '#3A2B45', '#66D6E0', '#FFE2BC'],
    ['#FFB466', '#FFF4DA', '#FF6A7C', '#FFF09A', '#3A2118', '#2D6BD6', '#FFFFFF', '#4A2A2A', '#FFCF92', '#FFE8C8'],
    ['#9082F5', '#F0EBFF', '#FF9AD2', '#6FF3FF', '#1E1A45', '#FFC83C', '#FFFFFF', '#3A2B55', '#B5A9FB', '#E2DCFF'],
  ],
  build: buildTidler,
};

// ------------------------------------------------------------------------------------------------ Sprigfox
const SF = { FUR: 0, CREAM: 1, DARK: 2, GLOW: 3, EYE: 4, IRIS: 5, WHITE: 6, NOSE: 7, LEAF: 8, LEAF2: 9, STEM: 10 };

function buildSprigfox(s: Sculpt): void {
  const { FUR, CREAM, DARK, GLOW, EYE, NOSE, LEAF, LEAF2, STEM } = SF;
  s.ellipsoid('body', [0, 11.2, -1.0], [5.3, 5.2, 9.6], P(FUR), { n: 2.2 });
  s.recolor(['body'], (c) => (c.ny < -0.3 || (c.nz > 0.3 && c.y < 13.5 && c.z > 3) ? P(CREAM) : null));
  s.decal({ on: 'body', x: -2, y: 10, rows: ['.GG.', 'GGGG', '.GG.'], legend: { G: P(GLOW, 1, 0.95) } });

  s.ellipsoid('head', [0, 17.4, 7.8], [6.9, 5.6, 5.9], P(FUR), { n: 2.2 });
  for (const sx of [1, -1]) s.taper('head', [sx * 5.0, 15.6, 7.6], [sx * 8.8, 14.8, 5.6], 2.4, 0.9, P(CREAM), { flat: 0.6, thin: [0, 1, 0] });
  s.ellipsoid('head', [0, 15.0, 12.8], [2.1, 1.9, 3.4], P(CREAM));
  s.recolor(['head'], (c) => (c.nz > 0.3 && c.y < 15.6 && c.z > 6 ? P(CREAM) : null));
  s.decal({ on: 'head', x: -1, y: 16, rows: ['NN'], legend: { N: P(NOSE, 1, 0.1) } });
  s.decal({ on: 'head', x: -2, y: 14, rows: ['D..D', '.DD.'], legend: { D: P(EYE) } });
  const lg = eyeLegend(EYE, SF.IRIS, SF.WHITE);
  s.decal({ on: 'head', into: 'eyes', x: 2, y: 21, rows: EYE5, legend: lg });
  s.decal({ on: 'head', into: 'eyes', x: -6, y: 21, rows: EYE5, legend: lg });

  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'earR' : 'earL';
    s.taper(part, [sx * 4.4, 21.0, 6.6], [sx * 7.8, 32.8, 4.2], 3.8, 0.4, (c) => (c.t > 0.72 ? P(DARK) : c.nz > 0.4 && c.r > 0.35 && c.t < 0.7 ? P(CREAM, 0.98) : P(FUR)), { flat: 0.4 });
  }

  // forehead sprout
  s.capsule('sprout', [0, 22.4, 9.6], [0, 24.6, 9.8], 0.95, 0.75, P(STEM));
  const sprout = (c: { t: number; lx: number }): Paint => (c.t > 0.7 ? P(GLOW, 1, 0.9) : c.lx > 0 ? P(LEAF2) : P(LEAF));
  s.leaf('sprout', [0.4, 24.4, 9.8], [3.9, 27.8, 9.8], 1.7, [0, 0, 1], sprout, 0.5);
  s.leaf('sprout', [-0.4, 24.4, 9.8], [-3.9, 27.8, 9.8], 1.7, [0, 0, 1], sprout, 0.5);

  // legs
  const sock = (c: { y: number }): Paint => (c.y < 4.4 ? P(DARK) : P(FUR));
  for (const sx of [1, -1]) {
    const n = sx > 0 ? 'R' : 'L';
    s.capsule(`legF${n}`, [sx * 3.3, 9.2, 5.2], [sx * 3.4, 1.4, 6.0], 2.0, 1.5, sock);
    s.ellipsoid(`legF${n}`, [sx * 3.4, 0.9, 6.8], [1.8, 0.9, 2.3], P(DARK));
    s.ellipsoid(`legB${n}`, [sx * 3.9, 9.0, -6.4], [2.7, 3.8, 3.8], P(FUR));
    s.capsule(`legB${n}`, [sx * 3.7, 6.4, -6.8], [sx * 3.6, 1.4, -5.4], 1.7, 1.4, sock);
    s.ellipsoid(`legB${n}`, [sx * 3.6, 0.9, -4.6], [1.7, 0.9, 2.4], P(DARK));
  }

  // tail: orange base + fan of leaves
  s.capsule('tail1', [0, 12.5, -9.5], [0, 14.6, -14.0], 3.1, 3.7, P(FUR));
  const leafP = (c: { t: number; lx: number }): Paint => (c.t > 0.74 ? P(GLOW, 1, 0.9) : c.lx > 0 ? P(LEAF2) : P(LEAF));
  const O: [number, number, number] = [0, 15.2, -14.6];
  const th: [number, number, number] = [0, 0.6, 0.8];
  s.leaf('tail2', O, [0, 27.6, -23.6], 3.3, th, leafP, 0.4);
  for (const sx of [1, -1]) {
    s.leaf('tail2', O, [sx * 7.2, 26.4, -19.8], 3.0, th, leafP, 0.4);
    s.leaf('tail2', O, [sx * 9.6, 19.6, -19.2], 2.6, th, leafP, 0.4);
  }
}

export const SPRIGFOX: ModelDef = {
  name: 'sprigfox',
  vs: 0.03,
  parts: [
    { name: 'body', parent: null, pivot: [0, 11, -1] },
    { name: 'head', parent: 'body', pivot: [0, 15.5, 5] },
    { name: 'eyes', parent: 'head', pivot: [0, 19.5, 13] },
    { name: 'earR', parent: 'head', pivot: [4.4, 21, 6.6] },
    { name: 'earL', parent: 'head', pivot: [-4.4, 21, 6.6] },
    { name: 'sprout', parent: 'head', pivot: [0, 22.4, 9.6] },
    { name: 'legFR', parent: 'body', pivot: [3.3, 9.2, 5.2] },
    { name: 'legFL', parent: 'body', pivot: [-3.3, 9.2, 5.2] },
    { name: 'legBR', parent: 'body', pivot: [3.9, 10, -6.4] },
    { name: 'legBL', parent: 'body', pivot: [-3.9, 10, -6.4] },
    { name: 'tail1', parent: 'body', pivot: [0, 12.5, -9.5] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 15.2, -14.6] },
  ],
  palettes: [
    ['#F58E3C', '#FFF6E6', '#5A3322', '#C6FF6A', '#2B1A24', '#E58A1C', '#FFFFFF', '#2B1A24', '#3CC46C', '#9BEB74', '#2F8F55'],
    ['#A6BEEE', '#F7FAFF', '#3A4A78', '#7DFFF0', '#1E2540', '#3F7FD0', '#FFFFFF', '#2B3555', '#EC6E92', '#FFB8C8', '#B84A66'],
    ['#F7CC50', '#FFF9E4', '#7A4A1F', '#FF9BE0', '#3A2418', '#D06A1E', '#FFFFFF', '#3A2418', '#24BCB4', '#86EFD6', '#1A7F78'],
  ],
  build: buildSprigfox,
};

// ------------------------------------------------------------------------------------------------ Explorer avatar
export const AV = { SKIN: 0, HAIR: 1, SHIRT: 2, PANTS: 3, BOOTS: 4, PACK: 5, EYE: 6, WHITE: 7, IRIS: 8, BLUSH: 9, MOUTH: 10, TRIM: 11, GLOW: 12, PACK2: 13 };

function buildAvatar(s: Sculpt): void {
  const { SKIN, HAIR, SHIRT, PANTS, BOOTS, PACK, EYE, BLUSH, MOUTH, TRIM, GLOW, PACK2 } = AV;
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'legR' : 'legL';
    s.box(part, [sx * 2.2, 3.8, 0], [3.8, 7.6, 4.0], (c) => (c.y < 2.6 ? P(BOOTS) : P(PANTS)), { round: 0.9 });
    s.ellipsoid(part, [sx * 2.2, 1.4, 1.1], [2.2, 1.5, 3.1], P(BOOTS));
  }
  s.box('body', [0, 11.2, 0], [9.0, 7.6, 5.6], P(SHIRT), { round: 1.6 });
  s.recolor(['body'], (c) => (c.y < 8.6 || c.y > 14.2 ? P(TRIM) : null));
  for (const sx of [1, -1]) s.box('body', [sx * 2.8, 11.6, 2.8], [1.6, 6.4, 0.8], P(PACK));
  s.decal({ on: 'body', x: -1, y: 12, rows: ['GG', 'GG'], legend: { G: P(GLOW, 1, 0.9) } });
  for (const sx of [1, -1]) {
    const part = sx > 0 ? 'armR' : 'armL';
    s.capsule(part, [sx * 5.5, 14.0, 0], [sx * 6.0, 8.8, 0.6], 2.0, 1.8, (c) => (c.y < 10.2 ? P(TRIM) : P(SHIRT)));
    s.ellipsoid(part, [sx * 6.1, 7.6, 0.7], [1.9, 1.9, 1.9], P(SKIN));
  }
  s.ellipsoid('head', [0, 20.8, 0.2], [7.3, 6.5, 6.7], P(SKIN), { n: 2.5 });
  for (const sx of [1, -1]) s.ellipsoid('head', [sx * 7.2, 20.4, 0], [1.4, 2.2, 1.8], P(SKIN));
  s.ellipsoid('head', [0, 22.6, -0.6], [7.9, 6.2, 7.6], (c) => (c.y < 18.6 || (c.nz > 0.3 && c.y < 24.2) ? null : P(HAIR)), { n: 2.5 });
  s.decal({ on: 'head', x: -6, y: 25, rows: ['HHHHHHHHHHHH', 'HHHHHHHHHHHH', 'HH.HH..HH.HH'], legend: { H: P(HAIR) } });
  const lg = eyeLegend(EYE, AV.IRIS, AV.WHITE);
  s.decal({ on: 'head', into: 'eyes', x: 2, y: 21, rows: EYE4, legend: lg });
  s.decal({ on: 'head', into: 'eyes', x: -6, y: 21, rows: EYE4, legend: lg });
  s.decal({ on: 'head', x: -2, y: 16, rows: ['M..M', '.MM.'], legend: { M: P(MOUTH) } });
  s.decal({ on: 'head', x: 4, y: 17, rows: ['BB'], legend: { B: P(BLUSH, 1.02) } });
  s.decal({ on: 'head', x: -6, y: 17, rows: ['BB'], legend: { B: P(BLUSH, 1.02) } });
  s.capsule('hair', [0, 23.0, -6.5], [0, 16.5, -10.0], 3.0, 1.4, (c) => (c.t < 0.2 ? P(TRIM) : P(HAIR)));
  s.box('pack', [0, 11.4, -5.6], [8.0, 9.2, 4.2], (c) => (c.y > 13.4 ? P(PACK2) : P(PACK)), { round: 1.1 });
  s.decal({ on: 'pack', dir: '-z', x: 0, y: 11, rows: ['GG'], legend: { G: P(GLOW, 1, 0.9) } });
}

export const AVATAR: ModelDef = {
  name: 'avatar',
  vs: 0.04,
  parts: [
    { name: 'body', parent: null, pivot: [0, 11.2, 0] },
    { name: 'head', parent: 'body', pivot: [0, 15.2, 0] },
    { name: 'eyes', parent: 'head', pivot: [0, 19.5, 6] },
    { name: 'hair', parent: 'head', pivot: [0, 22.5, -6] },
    { name: 'armR', parent: 'body', pivot: [5.6, 14, 0] },
    { name: 'armL', parent: 'body', pivot: [-5.6, 14, 0] },
    { name: 'legR', parent: 'body', pivot: [2.2, 7.8, 0] },
    { name: 'legL', parent: 'body', pivot: [-2.2, 7.8, 0] },
    { name: 'pack', parent: 'body', pivot: [0, 14.5, -4] },
  ],
  palettes: [['#FFD3B3', '#5B3A28', '#F0594E', '#3A55B0', '#7A4A2B', '#2BA6B4', '#2B1A24', '#FFFFFF', '#3F8FD0', '#FF9A9A', '#8A3B3B', '#FFF0D6', '#7DF4FF', '#E9C46A']],
  build: buildAvatar,
};

export const SPECIES_DEFS: ModelDef[] = [PUFFBUN, TIDLER, SPRIGFOX];
export const SPECIES_NAMES = ['Puffbun', 'Tidler', 'Sprigfox'];
/** sim base scales (crates/sim_creatures species table) -- used by the lab for true-size lineups */
export const SPECIES_BASE_SCALE = [0.8, 0.9, 0.75];
