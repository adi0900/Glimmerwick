/**
 * Data tables for the gameplay slice: items, block drops, recipes, the Glimmerdex species sheet and the starter goals.
 * Everything here is plain data -- add rows, no code changes needed.
 */

export type ItemKind = 'block' | 'treat' | 'material';

export interface ItemDef {
  key: string;
  name: string;
  kind: ItemKind;
  /** registry block name this item places (undefined = cannot be placed) */
  block?: string;
  /** icon colour override (sRGB 0-255); cubes default to the block's registry colour */
  color?: [number, number, number];
  /** custom icon drawn instead of a cube */
  icon?: 'berry' | 'apple' | 'orange' | 'cookie';
  /** one-line description for the workbench */
  blurb?: string;
}

export const ITEMS: Record<string, ItemDef> = {
  log: { key: 'log', name: 'Log', kind: 'block', block: 'log_oak', blurb: 'Chop trees for these.' },
  planks: { key: 'planks', name: 'Planks', kind: 'block', block: 'planks', blurb: 'Warm and cosy walls.' },
  stone: { key: 'stone', name: 'Stone', kind: 'block', block: 'stone' },
  cobble: { key: 'cobble', name: 'Cobble', kind: 'block', block: 'cobble', blurb: 'Sturdy paths and walls.' },
  dirt: { key: 'dirt', name: 'Dirt', kind: 'block', block: 'dirt' },
  sand: { key: 'sand', name: 'Sand', kind: 'block', block: 'sand' },
  gravel: { key: 'gravel', name: 'Gravel', kind: 'block', block: 'gravel' },
  clay: { key: 'clay', name: 'Clay', kind: 'block', block: 'clay' },
  leaves: { key: 'leaves', name: 'Leaves', kind: 'block', block: 'leaves_oak' },
  glass: { key: 'glass', name: 'Glass', kind: 'block', block: 'glass', blurb: 'Windows that let the light in.' },
  plaster: { key: 'plaster', name: 'Plaster', kind: 'block', block: 'plaster', blurb: 'Smooth cream walls.' },
  roof_tile: { key: 'roof_tile', name: 'Roof Tile', kind: 'block', block: 'roof_tile', blurb: 'Rusty red roofs.' },
  lantern: { key: 'lantern', name: 'Lantern', kind: 'block', block: 'lantern', blurb: 'Glows when it gets dark.' },
  glowcap: { key: 'glowcap', name: 'Glowcap', kind: 'block', block: 'glowcap' },
  berry: { key: 'berry', name: 'Berry', kind: 'treat', icon: 'berry', blurb: 'Puffbuns adore these.' },
  apple: { key: 'apple', name: 'Apple', kind: 'treat', icon: 'apple', blurb: 'A Sprigfox favourite.' },
  orange: { key: 'orange', name: 'Orange', kind: 'treat', icon: 'orange', blurb: 'Tidlers go wild for these.' },
  cookie: { key: 'cookie', name: 'Leaf Cookie', kind: 'treat', icon: 'cookie', blurb: 'Every Glimmer likes a cookie.' },
};

export const isTreat = (item: string): boolean => ITEMS[item]?.kind === 'treat';

export interface Drop {
  item: string;
  n: number;
  /** probability 0-1 (default 1) */
  p?: number;
}

/** First matching rule wins. `test` is run against the registry block name. */
const DROP_RULES: Array<[RegExp, Drop[]]> = [
  [/^log_/, [{ item: 'log', n: 1 }]],
  [/^leaves_berry$/, [{ item: 'berry', n: 1 }, { item: 'leaves', n: 1, p: 0.35 }]],
  [/^leaves_apple$/, [{ item: 'apple', n: 1, p: 0.7 }, { item: 'leaves', n: 1, p: 0.5 }]],
  [/^leaves_orange$/, [{ item: 'orange', n: 1, p: 0.7 }, { item: 'leaves', n: 1, p: 0.5 }]],
  [/^leaves_/, [{ item: 'leaves', n: 1 }]],
  [/^(grass|dirt|path|packed_earth|mud|snow)/, [{ item: 'dirt', n: 1 }]],
  [/^stone/, [{ item: 'stone', n: 1 }]],
  [/^cobble$/, [{ item: 'cobble', n: 1 }]],
  [/^sand$/, [{ item: 'sand', n: 1 }]],
  [/^gravel$/, [{ item: 'gravel', n: 1 }]],
  [/^clay$/, [{ item: 'clay', n: 1 }]],
  [/^planks$/, [{ item: 'planks', n: 1 }]],
  [/^plaster$/, [{ item: 'plaster', n: 1 }]],
  [/^roof_tile$/, [{ item: 'roof_tile', n: 1 }]],
  [/^glass$/, [{ item: 'glass', n: 1 }]],
  [/^lantern$/, [{ item: 'lantern', n: 1 }]],
  [/^(glowcap|mushroom_stem)$/, [{ item: 'glowcap', n: 1 }]],
];

/** What breaking `blockName` gives. `roll` returns 0..1 (pass Math.random or a seeded stream). */
export function dropsFor(blockName: string, roll: () => number = Math.random): Array<{ item: string; n: number }> {
  for (const [re, drops] of DROP_RULES) {
    if (!re.test(blockName)) continue;
    return drops.filter((d) => d.p === undefined || roll() < d.p).map((d) => ({ item: d.item, n: d.n }));
  }
  return [];
}

/** Item key that places a block of this registry name when picked up again (inverse hint for tooltips). */
export function itemForBlock(blockName: string): string | undefined {
  return dropsFor(blockName, () => 0)[0]?.item;
}

export interface Recipe {
  id: string;
  out: string;
  n: number;
  needs: Record<string, number>;
}

export const RECIPES: Recipe[] = [
  { id: 'planks', out: 'planks', n: 4, needs: { log: 1 } },
  { id: 'cobble', out: 'cobble', n: 3, needs: { stone: 2 } },
  { id: 'glass', out: 'glass', n: 1, needs: { sand: 2 } },
  { id: 'plaster', out: 'plaster', n: 2, needs: { sand: 1, clay: 1 } },
  { id: 'roof_tile', out: 'roof_tile', n: 2, needs: { clay: 2 } },
  { id: 'lantern', out: 'lantern', n: 1, needs: { glowcap: 1, planks: 1 } },
  { id: 'cookie', out: 'cookie', n: 2, needs: { leaves: 4 } },
];

// ------------------------------------------------------------------------------------------------ Glimmerdex

export interface VariantInfo {
  name: string;
  /** body colour, accent colour, belly colour (portrait) */
  main: string;
  accent: string;
  belly: string;
}

export interface SpeciesInfo {
  id: number;
  name: string;
  personality: string;
  habitat: string;
  favourite: string;
  /** one friendly sentence */
  blurb: string;
  /** how to befriend it */
  tip: string;
  variants: VariantInfo[];
}

/** Indexed by the sim's species id (0 Puffbun, 1 Tidler, 2 Sprigfox); variants by the sim's variant 0-2. */
export const SPECIES_DEX: SpeciesInfo[] = [
  {
    id: 0,
    name: 'Puffbun',
    personality: 'Curious',
    habitat: 'Sunny meadows',
    favourite: 'berry',
    blurb: 'A fluffy bunny-cloud that bounces over to say hello.',
    tip: 'Walk up calmly and offer a Berry.',
    variants: [
      { name: 'Rosie', main: '#FFB6D0', accent: '#8A46D0', belly: '#FFF1E4' },
      { name: 'Lilac', main: '#B9A6FF', accent: '#3F52E0', belly: '#F3EEFF' },
      { name: 'Mint', main: '#A4E6BC', accent: '#1E9C74', belly: '#F3FFEA' },
    ],
  },
  {
    id: 1,
    name: 'Tidler',
    personality: 'Playful',
    habitat: 'Beaches and shallows',
    favourite: 'orange',
    blurb: 'A splashy little tide-lizard that loves games.',
    tip: 'Join its bouncing, then offer an Orange.',
    variants: [
      { name: 'Lagoon', main: '#3EC4D2', accent: '#FF8A7A', belly: '#FFF1D8' },
      { name: 'Sunset', main: '#FFB466', accent: '#FF6A7C', belly: '#FFF4DA' },
      { name: 'Violet', main: '#9C8CF7', accent: '#FF9AD2', belly: '#F0EBFF' },
    ],
  },
  {
    id: 2,
    name: 'Sprigfox',
    personality: 'Shy',
    habitat: 'Cosy forests',
    favourite: 'apple',
    blurb: 'A leafy little fox that hides from loud visitors.',
    tip: 'Tiptoe closer, slowly, then offer an Apple.',
    variants: [
      { name: 'Ember', main: '#F58E3C', accent: '#3CC46C', belly: '#FFE0B0' },
      { name: 'Frost', main: '#A6BEEE', accent: '#EC6E92', belly: '#EEF3FF' },
      { name: 'Honey', main: '#F7CC50', accent: '#24BCB4', belly: '#FFE9A8' },
    ],
  },
];

// ------------------------------------------------------------------------------------------------ goals

export type Metric =
  | { kind: 'collect'; item: string }
  | { kind: 'craft'; item?: string }
  | { kind: 'placed' }
  | { kind: 'befriended' }
  | { kind: 'dexSeen' };

export interface Goal {
  id: string;
  title: string;
  hint: string;
  metric: Metric;
  target: number;
  reward: Record<string, number>;
}

/** Chained starter goals: each unlocks after the previous one. */
export const GOALS: Goal[] = [
  {
    id: 'wood',
    title: 'Gather 6 Logs',
    hint: 'Hold F (or click) on a tree trunk to chop it.',
    metric: { kind: 'collect', item: 'log' },
    target: 6,
    reward: { planks: 4 },
  },
  {
    id: 'craft',
    title: 'Craft some Planks',
    hint: 'Press C to open the Workbench.',
    metric: { kind: 'craft', item: 'planks' },
    target: 1,
    reward: { log: 3 },
  },
  {
    id: 'build',
    title: 'Place 20 blocks',
    hint: 'Pick a block (1-0), then press X or right-click to build.',
    metric: { kind: 'placed' },
    target: 20,
    reward: { cookie: 3, glass: 4 },
  },
  {
    id: 'friend',
    title: 'Befriend a Glimmer',
    hint: 'Walk up slowly, hold a treat and press E.',
    metric: { kind: 'befriended' },
    target: 1,
    reward: { lantern: 2 },
  },
  {
    id: 'dex',
    title: 'Meet 3 different Glimmers',
    hint: 'Explore: meadows, beaches and forests hide different friends. Press G for your Glimmerdex.',
    metric: { kind: 'dexSeen' },
    target: 3,
    reward: { cookie: 4, roof_tile: 6 },
  },
];
