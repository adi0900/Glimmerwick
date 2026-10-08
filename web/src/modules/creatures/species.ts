/**
 * The three hero Glimmer species + the chibi explorer avatar as AUTHORED voxel art (original designs).
 * Every model is explicit voxel data (see ./voxdata.ts for the slice format): front-view depth slices per part, a palette
 * legend with hue-shifted tone ramps, face sprites per expression frame. No primitives, no random speckle.
 * The bulk volumes were blocked out with a chamfered-box helper and then frozen into text and edited by hand
 * (ears, tails, gills, plumes, feet, faces and glow marks are drawn directly).
 *
 *  Puffbun  -- tall mochi body, cheek puffs, very long ears with glowing tips, cotton tail.
 *  Tidler   -- low axolotl-like tide-dweller: wide grin, three gill fronds per side with glowing tips, glowing dorsal crest,
 *              a tail ending in a vertical paddle fin with a glowing emblem.
 *  Sprigfox -- compact fox: stair-step ears with dark tips, a leafy forehead sprout, a two-tier leaf-plume tail in an S.
 *  Explorer -- 2.3-head chibi: hair cap + ponytail, 2x3 eyes, trim, backpack with a glow strap.
 *
 * Voxel scale: each model's `vs` is chosen so a voxel is ~3-5 cm in the world at the species' sim scale (the world's
 * texel-voxels are 4 cm), i.e. chunky enough to read as pixel art. Faces: 2x3 eyes (ink / white highlight / iris), cheek
 * marks, tiny mouths, frames 0 neutral, 1 blink, 2 happy, 3 sleep, 4 surprised (see FACE_FRAMES).
 */
import type { ModelDef } from './actors';
import { P } from './sculpt';
import { authorModel, ramp3, ramp5, tint, type FaceDef, type Legend, type VoxPart } from './voxdata';

const F5 = (a: number): number[] => [a, a + 1, a + 2, a + 3, a + 4];

// ------------------------------------------------------------------------------------------------ Puffbun
/** slots: 0-4 fur ramp . 5-9 cream ramp . 10-12 pink ramp . 13 glow . 14 glow core . 15 ink . 16 iris . 17 iris light . 18 white . 19 nose */
const PB = { FUR: 0, CREAM: 5, PINK: 10, GLOW: 13, CORE: 14, INK: 15, IRIS: 16, IRIS2: 17, WHITE: 18, NOSE: 19 };

function puffPal(fur: string, cream: string, pink: string, glow: string, ink: string, iris: string, nose: string): string[] {
  return [...ramp5(fur), ...ramp5(cream), ...ramp3(pink), glow, tint(glow, 0.22), ink, iris, tint(iris, 0.2), '#FFF8EC', nose];
}

const PB_LEGEND: Legend = {
  f: { ramp: F5(PB.FUR) },
  c: { ramp: F5(PB.CREAM) },
  C: { ramp: F5(PB.CREAM), dither: false },
  p: P(PB.PINK + 1),
  q: P(PB.PINK + 2),
  r: P(PB.PINK),
  d: P(PB.FUR),
  G: P(PB.GLOW, 1, 0.9),
  g: P(PB.CORE, 1, 1),
};

const PB_PARTS: VoxPart[] = [
  { part: 'body', mirror: true, y: 8, z: 4, text: `
......
ccfff.
cccff.
ccccf.
ccccf.
ccccf.
cccff.
......
-
fff...
ccfff.
cccfff
ccccff
ccccff
ccccff
cccff.
cff...
-
fff...
ccfff.
cccfff
ccccff
ccccff
ccccff
cccff.
cff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
......
fffff.
fffff.
fffff.
fffff.
fffff.
fffff.
......
` },
  { part: 'head', mirror: true, y: 17, z: 4, text: `
......
fffff.
fffff.
fffff.
fffff.
fffff.
fffff.
cccff.
......
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
cccff.
ccc...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
cccff.
ccc...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
Gff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
-
fff...
fffff.
ffffff
ffffff
ffffff
ffffff
ffffff
fffff.
fff...
` },
  // cheek puffs: a 3x3x3 plus-shaped nub on each side of the head
  { part: 'head', mirror: true, x: 6, y: 13, z: 3, text: `
.
c
.
-
c
c
c
-
.
c
.
` },
  // ears: 3 wide, pink panel on the front slice, rounded fur edge
  { part: 'earR', mirror: 'earL', x: 2, y: 21, z: 1, text: `
fpf
fpf
fpf
fpf
-
fff
fff
fff
fff
` },
  { part: 'earTipR', mirror: 'earTipL', x: 2, y: 23, z: 1, text: `
.G.
GgG
-
.G.
GGG
` },
  // cotton tail: 4x4x4, chamfered, cream
  { part: 'tail', mirror: true, y: 6, z: -5, text: `
..
C.
C.
..
-
C.
CC
CC
C.
-
=
-
..
C.
C.
..
` },
  // hind feet with a pink toe bean on the front
  { part: 'footR', mirror: 'footL', x: 1, y: 1, z: 3, text: `
ccc
cpc
-
ccc
ccc
-
=
` },
];

const PB_FACE: FaceDef = {
  on: 'head',
  x: -6,
  y: 16,
  legend: { k: P(PB.INK), w: P(PB.WHITE, 1, -0.25), I: P(PB.IRIS, 1, -0.1), i: P(PB.IRIS2, 1, -0.2), b: P(PB.PINK + 2), n: P(PB.NOSE, 1, 0.1), m: P(PB.INK), r: P(PB.PINK + 1), l: P(PB.FUR + 1) },
  frames: {
    0: `
............
..kk....kk..
..wk....wk..
..II....II..
bb...nn...bb
....m..m....
.....mm.....`,
    1: `
............
............
..kk....kk..
............
==...==...==
....=..=....
.....==.....`,
    2: `
............
............
...k....k...
..k.k..k.k..
==...==...==
....mmmm....
.....rr.....`,
    3: `
............
............
..ll....ll..
..kk....kk..
==...==...==
.....mm.....
............`,
    4: `
............
..kk....kk..
..wk....wk..
..kk....kk..
==II.==.II==
.....mm.....
.....mm.....`,
  },
};

export const PUFFBUN: ModelDef = {
  name: 'puffbun',
  vs: 0.045,
  parts: [
    { name: 'body', parent: null, pivot: [0, 5, 0] },
    { name: 'head', parent: 'body', pivot: [0, 10, 0.5] },
    { name: 'earR', parent: 'head', pivot: [3.5, 18, 1] },
    { name: 'earL', parent: 'head', pivot: [-3.5, 18, 1] },
    { name: 'earTipR', parent: 'earR', pivot: [3.5, 22, 1] },
    { name: 'earTipL', parent: 'earL', pivot: [-3.5, 22, 1] },
    { name: 'tail', parent: 'body', pivot: [0, 4.5, -4.5] },
    { name: 'footR', parent: 'body', pivot: [2.5, 2, 2] },
    { name: 'footL', parent: 'body', pivot: [-2.5, 2, 2] },
  ],
  palettes: [
    puffPal('#FFB6D0', '#FFF1E4', '#FF8FB6', '#FFD84A', '#3A2150', '#8A46D0', '#E8507A'),
    puffPal('#B9A6FF', '#F3EEFF', '#8F72F0', '#5CF2FF', '#271B4D', '#3F52E0', '#7A5CE0'),
    puffPal('#A4E6BC', '#F3FFEA', '#52CF92', '#FF8AD4', '#1E3B34', '#1E9C74', '#3FB67E'),
  ],
  build: (s) => authorModel(s, PB_PARTS, PB_LEGEND, [PB_FACE]),
};

// ------------------------------------------------------------------------------------------------ Tidler
/** slots: 0-4 main ramp . 5-9 cream ramp . 10-14 coral ramp . 15-19 fin ramp . 20 glow . 21 glow core . 22 ink . 23 white . 24 iris . 25 iris light . 26 mouth */
const TD = { MAIN: 0, CREAM: 5, CORAL: 10, FIN: 15, GLOW: 20, CORE: 21, INK: 22, WHITE: 23, IRIS: 24, IRIS2: 25, MOUTH: 26 };

function tidPal(main: string, cream: string, coral: string, fin: string, glow: string, ink: string, iris: string, mouth: string): string[] {
  return [...ramp5(main), ...ramp5(cream), ...ramp5(coral), ...ramp5(fin), glow, tint(glow, 0.2), ink, '#FFF8EC', iris, tint(iris, 0.2), mouth];
}

const TD_LEGEND: Legend = {
  f: { ramp: F5(TD.MAIN) },
  c: { ramp: F5(TD.CREAM) },
  r: { ramp: F5(TD.CORAL), dither: false },
  e: { ramp: F5(TD.FIN), dither: false },
  G: P(TD.GLOW, 1, 0.85),
  g: P(TD.CORE, 1, 1),
};

const TD_PARTS: VoxPart[] = [
  { part: 'body', mirror: true, y: 7, z: 4, text: `
.....
ffff.
ffff.
ffff.
ffff.
.....
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
fff..
fffff
fffff
fffff
fffff
ccc..
-
.....
ffff.
ffff.
ffff.
ffff.
.....
` },
  // dorsal crest: 2 wide, 2 tall at the shoulders tapering to 1, a glowing cap on every third step
  { part: 'body', mirror: true, y: 9, z: 3, text: `
.
r
-
G
r
-
r
r
-
r
r
-
.
G
-
.
r
-
.
G
` },
  { part: 'head', mirror: true, y: 8, z: 11, text: `
.......
fffff..
ffffff.
ffffff.
ffffff.
ffffff.
fffff..
.......
-
fff....
fffff..
ffffff.
fffffff
fffffff
ffffff.
fffff..
ccc....
-
fff....
fffff..
ffffff.
fffffff
fffffff
ffffff.
fffff..
ccc....
-
fff....
fffff..
ffffff.
fffffff
fffffff
ffffff.
fffff..
ccc....
-
fff....
fffff..
ffffff.
fffffff
fffffff
ffffff.
fffff..
ccc....
-
fff....
fffff..
ffffff.
fffffff
fffffff
ffffff.
fffff..
ccc....
-
.......
fffff..
ffffff.
ffffff.
ffffff.
ffffff.
fffff..
.......
` },
  // gills: a comb of four 3-long filaments per side on a 7-high spine; the glowing tip of each filament is its own springy part
  { part: 'gillR', mirror: 'gillL', x: 7, y: 8, z: 7, text: `
rr
r.
rr
r.
rr
r.
rr
-
=
` },
  { part: 'gillTipR', mirror: 'gillTipL', x: 9, y: 8, z: 7, text: `
G
.
G
.
G
.
G
-
=
` },
  { part: 'legFR', mirror: 'legFL', x: 3, y: 1, z: 4, text: `
ff
cc
-
=
-
=
` },
  { part: 'legBR', mirror: 'legBL', x: 3, y: 1, z: -1, text: `
ff
cc
-
=
-
=
` },
  { part: 'tail1', mirror: true, y: 5, z: -5, text: `
f.
ff
ff
c.
-
=
` },
  { part: 'tail2', mirror: true, y: 4, z: -7, text: `
f.
ff
c.
-
=
` },
  // vertical paddle fin (2 wide, 7 tall, 3 deep): coral rim, fin-colour body, glowing emblem on both faces
  { part: 'tail3', mirror: true, y: 8, z: -9, text: `
.
e
e
e
e
e
.
-
r
e
e
G
e
e
r
-
.
r
r
r
r
r
.
` },
];

const TD_FACE: FaceDef = {
  on: 'head',
  x: -7,
  y: 8,
  legend: { k: P(TD.INK), w: P(TD.WHITE, 1, -0.25), I: P(TD.IRIS, 1, -0.1), i: P(TD.IRIS2, 1, -0.2), b: P(TD.CORAL + 3), m: P(TD.MOUTH), r: P(TD.CORAL + 1), l: P(TD.MAIN + 1) },
  frames: {
    0: `
..............
...kk....kk...
...wk....wk...
...II....II...
.bb.m....m.bb.
.....mmmm.....
..............`,
    1: `
..............
..............
...kk....kk...
..............
.==.=....=.==.
.....====.....
..............`,
    2: `
..............
..............
....k....k....
...k.k..k.k...
.==.mmmmmm.==.
.....rrrr.....
..............`,
    3: `
..............
..............
...ll....ll...
...kk....kk...
.==.=....=.==.
......mm......
..............`,
    4: `
..............
...kk....kk...
...wk....wk...
...kk....kk...
.==II....II==.
......mm......
......mm......`,
  },
};

export const TIDLER: ModelDef = {
  name: 'tidler',
  vs: 0.05,
  parts: [
    { name: 'body', parent: null, pivot: [0, 4.5, 0] },
    { name: 'head', parent: 'body', pivot: [0, 5, 4.5] },
    { name: 'gillR', parent: 'head', pivot: [7, 5, 7] },
    { name: 'gillL', parent: 'head', pivot: [-7, 5, 7] },
    { name: 'gillTipR', parent: 'gillR', pivot: [8.5, 5, 7] },
    { name: 'gillTipL', parent: 'gillL', pivot: [-8.5, 5, 7] },
    { name: 'legFR', parent: 'body', pivot: [4, 2, 3] },
    { name: 'legFL', parent: 'body', pivot: [-4, 2, 3] },
    { name: 'legBR', parent: 'body', pivot: [4, 2, -3] },
    { name: 'legBL', parent: 'body', pivot: [-4, 2, -3] },
    { name: 'tail1', parent: 'body', pivot: [0, 3.5, -4] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 3.5, -6] },
    { name: 'tail3', parent: 'tail2', pivot: [0, 3.5, -8] },
  ],
  palettes: [
    tidPal('#3EC4D2', '#FFF1D8', '#FF8A7A', '#7FD8E6', '#8CFFF0', '#1B2B45', '#E09A18', '#3A1F4A'),
    tidPal('#FFB466', '#FFF4DA', '#FF6A7C', '#FFD09A', '#FFF09A', '#3A2118', '#C04AC0', '#4A2020'),
    tidPal('#9C8CF7', '#F0EBFF', '#FF9AD2', '#BDB1FC', '#6FF3FF', '#1E1A45', '#E8A020', '#3F2060'),
  ],
  build: (s) => authorModel(s, TD_PARTS, TD_LEGEND, [TD_FACE]),
};

// ------------------------------------------------------------------------------------------------ Sprigfox
/** slots: 0-4 fur ramp . 5-9 cream ramp . 10-12 dark ramp (socks, ear tips) . 13-17 leaf ramp . 18 glow . 19 glow core . 20 ink . 21 white . 22 iris . 23 iris light . 24 nose */
const SF = { FUR: 0, CREAM: 5, DARK: 10, LEAF: 13, GLOW: 18, CORE: 19, INK: 20, WHITE: 21, IRIS: 22, IRIS2: 23, NOSE: 24 };

function foxPal(fur: string, cream: string, dark: string, leaf: string, glow: string, ink: string, iris: string): string[] {
  return [...ramp5(fur), ...ramp5(cream), ...ramp3(dark), ...ramp5(leaf), glow, tint(glow, 0.2), ink, '#FFF8EC', iris, tint(iris, 0.2), tint(ink, -0.04)];
}

const SF_LEGEND: Legend = {
  f: { ramp: F5(SF.FUR) },
  c: { ramp: F5(SF.CREAM) },
  d: { ramp: [SF.DARK, SF.DARK, SF.DARK + 1, SF.DARK + 2, SF.DARK + 2], dither: false },
  l: { ramp: F5(SF.LEAF), dither: false },
  s: P(SF.LEAF),
  G: P(SF.GLOW, 1, 0.9),
  g: P(SF.CORE, 1, 1),
};

const SF_PARTS: VoxPart[] = [
  { part: 'body', mirror: true, y: 10, z: 5, text: `
....
fff.
fff.
ccc.
ccc.
ccc.
....
-
ff..
fff.
ffff
cccc
cccc
ccc.
cc..
-
ff..
fff.
ffff
cccc
cccc
ccc.
cc..
-
ff..
fff.
ffff
cccc
cccc
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
ff..
fff.
ffff
ffff
ffff
ccc.
cc..
-
....
fff.
fff.
fff.
fff.
ccc.
....
` },
  { part: 'head', mirror: true, y: 15, z: 10, text: `
.....
ffff.
ffff.
ffff.
ffff.
cccc.
cccc.
.....
-
fff..
ffff.
fffff
fffff
fffff
ccccc
cccc.
ccc..
-
fff..
ffff.
fffff
fffff
fffff
ccccc
cccc.
ccc..
-
fff..
ffff.
fffff
fffff
fffff
fffff
ffff.
fff..
-
fff..
ffff.
fffff
fffff
fffff
fffff
ffff.
fff..
-
fff..
ffff.
fffff
fffff
fffff
fffff
ffff.
fff..
-
fff..
ffff.
fffff
fffff
fffff
fffff
ffff.
fff..
-
.....
ffff.
ffff.
ffff.
ffff.
ffff.
ffff.
.....
` },
  // soft muzzle (cream, rounded front) and cheek ruffs that sweep back
  { part: 'head', mirror: true, y: 11, z: 13, text: `
c.
cc
c.
-
cc
cc
cc
-
=
` },
  { part: 'head', mirror: true, x: 5, y: 11, z: 8, text: `
c
.
-
c
c
-
.
c
` },
  // ears: stair-step cones leaning out, cream inner column on the front slice, dark tip as its own springy part
  { part: 'earR', mirror: 'earL', x: 2, y: 19, z: 6, text: `
.ff
.cf
fcf
fcf
-
.ff
.ff
fff
fff
` },
  { part: 'earTipR', mirror: 'earTipL', x: 3, y: 21, z: 6, text: `
.d
dd
-
=
` },
  // forehead sprout: a flared leaf cup, glowing tips
  { part: 'sprout', x: -3, y: 19, z: 9, text: `
gl..lg
.llll.
..ll..
..ss..
-
=
` },
  { part: 'legFR', mirror: 'legFL', x: 1, y: 3, z: 5, text: `
..
..
dd
dd
-
ff
ff
dd
dd
-
=
` },
  { part: 'legBR', mirror: 'legBL', x: 2, y: 3, z: -2, text: `
..
..
dd
dd
-
ff
ff
dd
dd
-
=
` },
  // tail: fluffy base + a two-tier leaf plume (S curve: back, up, forward) with a glowing tip
  { part: 'tail1', x: -2, y: 9, z: -7, text: `
.ff.
ffff
ffff
.cc.
-
=
-
=
` },
  { part: 'tail2', mirror: true, y: 12, z: -10, text: `
l..
ll.
lll
ll.
l..
-
=
` },
  { part: 'tail3', mirror: true, y: 18, z: -9, text: `
g..
l..
ll.
lll
ll.
l..
-
=
` },
];

const SF_FACE: FaceDef = {
  on: 'head',
  x: -5,
  y: 14,
  legend: { k: P(SF.INK), w: P(SF.WHITE, 1, -0.25), I: P(SF.IRIS, 1, -0.1), i: P(SF.IRIS2, 1, -0.2), n: P(SF.INK), m: P(SF.NOSE), r: P(SF.DARK + 2), l: P(SF.FUR + 1) },
  frames: {
    0: `
..kk..kk..
..wk..wk..
..II..II..
....nn....
...m..m...
..........`,
    1: `
..........
..kk..kk..
..........
....==....
...=..=...
..........`,
    2: `
..........
...k...k..
..k.k.k.k.
....==....
...mmmm...
....rr....`,
    3: `
..ll..ll..
..kk..kk..
..........
....==....
...=..=...
..........`,
    4: `
..........
.kkk..kkk.
.wkk..wkk.
....==....
...mmmm...
....mm....`,
  },
};

export const SPRIGFOX: ModelDef = {
  name: 'sprigfox',
  vs: 0.04,
  parts: [
    { name: 'body', parent: null, pivot: [0, 7, 0] },
    { name: 'head', parent: 'body', pivot: [0, 10, 4] },
    { name: 'earR', parent: 'head', pivot: [3.5, 16, 5.5] },
    { name: 'earL', parent: 'head', pivot: [-3.5, 16, 5.5] },
    { name: 'earTipR', parent: 'earR', pivot: [4, 20, 5.5] },
    { name: 'earTipL', parent: 'earL', pivot: [-4, 20, 5.5] },
    { name: 'sprout', parent: 'head', pivot: [0, 16, 8] },
    { name: 'legFR', parent: 'body', pivot: [2, 4, 4] },
    { name: 'legFL', parent: 'body', pivot: [-2, 4, 4] },
    { name: 'legBR', parent: 'body', pivot: [3, 4, -4] },
    { name: 'legBL', parent: 'body', pivot: [-3, 4, -4] },
    { name: 'tail1', parent: 'body', pivot: [0, 7.5, -6] },
    { name: 'tail2', parent: 'tail1', pivot: [0, 8, -10] },
    { name: 'tail3', parent: 'tail2', pivot: [0, 13, -9.5] },
  ],
  palettes: [
    foxPal('#F58E3C', '#FFE0B0', '#5A3322', '#3CC46C', '#C6FF6A', '#3A2218', '#3FAE5A'),
    foxPal('#A6BEEE', '#EEF3FF', '#3A4A78', '#EC6E92', '#7DFFF0', '#2A3252', '#D2457F'),
    foxPal('#F7CC50', '#FFE9A8', '#7A4A1F', '#24BCB4', '#FF9BE0', '#3A2A1C', '#1FA39A'),
  ],
  build: (s) => authorModel(s, SF_PARTS, SF_LEGEND, [SF_FACE]),
};

// ------------------------------------------------------------------------------------------------ Explorer avatar
/** base slots (customisable) 0-13, derived tones 14-31 (see avatarPalette) */
export const AV = { SKIN: 0, HAIR: 1, SHIRT: 2, PANTS: 3, BOOTS: 4, PACK: 5, EYE: 6, WHITE: 7, IRIS: 8, BLUSH: 9, MOUTH: 10, TRIM: 11, GLOW: 12, PACK2: 13 };
export const AV_BASE = ['#FFD3B3', '#D08446', '#F0594E', '#3A55B0', '#7A4A2B', '#2BA6B4', '#33201A', '#FFFFFF', '#B07A34', '#FF9A9A', '#A0443A', '#FFF0D6', '#7DF4FF', '#E9C46A'];

/** full 32-slot palette from the 14 customisable base colours (tone ramps are derived, hue-shifted) */
export function avatarPalette(b: string[]): string[] {
  const sk = ramp5(b[AV.SKIN]!);
  const ha = ramp5(b[AV.HAIR]!);
  const sh = ramp5(b[AV.SHIRT]!);
  const pa = ramp5(b[AV.PANTS]!);
  const bo = ramp5(b[AV.BOOTS]!);
  const pk = ramp5(b[AV.PACK]!);
  const out = [...b];
  out[14] = sk[1]!;
  out[15] = sk[3]!;
  // hair: lifted deep/shade tones (the back of the head is what you look at; never a dark slab)
  out[16] = tint(ha[0]!, 0.17);
  out[17] = tint(ha[1]!, 0.09);
  out[18] = ha[3]!;
  out[19] = tint(ha[3]!, 0.06); // crown/top lip: warm gold, not the near-white peach of ramp5's top tone
  out[20] = sh[0]!;
  out[21] = sh[1]!;
  out[22] = sh[3]!;
  out[23] = sh[4]!;
  out[24] = pa[1]!;
  out[25] = pa[3]!;
  out[26] = bo[1]!;
  out[27] = bo[3]!;
  out[28] = tint(pk[1]!, 0.05);
  out[29] = pk[3]!;
  out[30] = tint(b[AV.GLOW]!, 0.2);
  out[31] = tint(b[AV.IRIS]!, 0.2);
  return out;
}

const AV_LEGEND: Legend = {
  s: { ramp: [14, 14, AV.SKIN, 15, 15], dither: false },
  h: { ramp: [16, 17, AV.HAIR, 18, 19], strands: true },
  t: { ramp: [20, 21, AV.SHIRT, 22, 23], dither: false },
  p: { ramp: [24, 24, AV.PANTS, 25, 25], dither: false },
  b: { ramp: [26, 26, AV.BOOTS, 27, 27], dither: false },
  k: { ramp: [28, 28, AV.PACK, 29, 29], dither: false },
  H: P(19),
  D: P(17),
  K: P(AV.PACK2),
  m: P(AV.TRIM),
  G: P(AV.GLOW, 1, 0.9),
};

const AV_PARTS: VoxPart[] = [
  { part: 'legR', mirror: 'legL', x: 1, y: 4, z: 2, text: `
...
...
...
bbb
bbb
-
ppp
ppp
ppp
bbb
bbb
-
=
-
=
` },
  { part: 'body', mirror: true, y: 10, z: 2, text: `
mmm.
tttt
Gttt
Gttt
tttt
mmm.
-
mmm.
tttt
tttt
tttt
tttt
mmm.
-
mmm.
tttt
tttt
tttt
tttt
mmm.
-
mmm.
tttt
tttt
tttt
tttt
mmm.
-
mmm.
tttt
tttt
tttt
tttt
mmm.
-
mmm.
tttt
tttt
tttt
tttt
mmm.
` },
  { part: 'armR', mirror: 'armL', x: 4, y: 10, z: 1, text: `
tt
tt
tt
mm
ss
ss
-
=
` },
  { part: 'head', mirror: true, y: 20, z: 4, text: `
.....
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
.....
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
sss..
ssss.
sssss
sssss
sssss
sssss
sssss
sssss
ssss.
sss..
-
.....
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
ssss.
.....
` },
  { part: 'head', mirror: true, y: 22, z: 5, text: `
......
......
......
......
......
......
......
......
......
......
-
......
hhhhh.
hhhhh.
hhhhh.
...hh.
......
......
......
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
...hhh
......
......
......
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
....hh
....hh
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
....hh
....hh
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
....hh
....hh
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
....hh
....hh
......
......
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhh.
hhhh..
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhh.
hhhh..
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhh.
hhhh..
-
hhhh..
hhhhh.
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhhh
hhhhh.
hhhh..
-
......
DhhHh.
DhHhh.
hHHhh.
hhhhh.
hDhhH.
hhDhH.
hhhDh.
hhhhD.
hhhh..
` },
  { part: 'hair', mirror: true, x: 0, y: 19, z: -7, text: `
tt
hh
hh
hh
hh
h.
-
..
hh
hh
hh
h.
..
` },
  { part: 'pack', mirror: true, x: 0, y: 9, z: -6, text: `
kkkk
kkkk
kkkk
kkkk
kkkk
.kkk
-
KKKK
KKKK
kkkk
kkkk
kkkk
.kkk
-
KKK.
mKKK
kkkk
mmmm
Gkkk
kkk.
` },
];

const AV_FACE: FaceDef = {
  on: 'head',
  x: -5,
  y: 17,
  legend: { k: P(AV.EYE), w: P(AV.WHITE, 1, -0.25), I: P(AV.IRIS, 1, -0.1), i: P(31, 1, -0.2), b: P(AV.BLUSH, 1.02), m: P(14, 0.74), r: P(AV.BLUSH), l: P(14) },
  frames: {
    0: `
..kk..kk..
..wk..wk..
..II..II..
.b......b.
...m..m...
....mm....`,
    1: `
..........
..kk..kk..
..........
.=......=.
...=..=...
....==....`,
    2: `
..........
...k...k..
..k.k.k.k.
.=......=.
...mmmm...
....rr....`,
    3: `
..ll..ll..
..kk..kk..
..........
.=......=.
...=..=...
....==....`,
    4: `
..kk..kk..
..wk..wk..
..II..II..
.=......=.
....mm....
....mm....`,
  },
};

export const AVATAR: ModelDef = {
  name: 'avatar',
  vs: 0.05,
  parts: [
    { name: 'body', parent: null, pivot: [0, 8, 0] },
    { name: 'head', parent: 'body', pivot: [0, 11, 0] },
    { name: 'hair', parent: 'head', pivot: [0, 20, -6] },
    { name: 'armR', parent: 'body', pivot: [5, 10.5, 0] },
    { name: 'armL', parent: 'body', pivot: [-5, 10.5, 0] },
    { name: 'legR', parent: 'body', pivot: [2.5, 5, 0] },
    { name: 'legL', parent: 'body', pivot: [-2.5, 5, 0] },
    { name: 'pack', parent: 'body', pivot: [0, 9, -4] },
  ],
  palettes: [avatarPalette(AV_BASE)],
  build: (s) =>
    authorModel(s, AV_PARTS, AV_LEGEND, [AV_FACE], (m) =>
      // self-light floor (constant, scaled up at night by the actor shader): the player is seen from behind, often against the
      // sun, and a pure shadow-lit back reads as a dark slab. The face cells are stamped afterwards and keep their own paint.
      m.recolor(['head', 'hair', 'pack', 'body', 'armR', 'armL', 'legR', 'legL'], (c) => (c.v.e === 0 ? { s: c.v.s, h: c.v.h, e: -0.2 } : null)),
    ),
};

export const SPECIES_DEFS: ModelDef[] = [PUFFBUN, TIDLER, SPRIGFOX];
export const SPECIES_NAMES = ['Puffbun', 'Tidler', 'Sprigfox'];
/** sim base scales (crates/sim_creatures species table) -- used by the lab for true-size lineups */
export const SPECIES_BASE_SCALE = [0.8, 0.9, 0.75];
