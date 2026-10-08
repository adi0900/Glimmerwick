/**
 * Story engine: quest chain + village level + dialogue picking, evaluated against the gameplay Store (hud/state.ts).
 * Pure logic, no DOM / three. Data lives in quests.json / dialogue.json / npcs.json (writers edit those).
 * Progress persists next to the HUD profile in localStorage (`glimmerwick.story.v1`).
 */
import type { GoalView } from '../hud/ui';
import type { Store } from '../hud/state';
import dialogueJson from './dialogue.json';
import npcsJson from './npcs.json';
import questsJson from './quests.json';

// ---------------------------------------------------------------------------------------------- data types

export type Cond =
  | { kind: 'told' }
  | { kind: 'collect'; item: string; n: number }
  | { kind: 'craft'; item: string; n: number }
  | { kind: 'placedVillage'; n: number; label?: string }
  | { kind: 'friend'; species: number; n: number }
  | { kind: 'friends'; n: number }
  | { kind: 'dex'; n: number }
  | { kind: 'flag'; flag: string };

export interface Step {
  id: string;
  act: number;
  free?: boolean;
  title: string;
  hint: string;
  giver: string;
  intro?: string;
  needs?: Cond & { label?: string };
  cond: Cond;
  marker?: string;
  autoplay?: boolean;
  reward: Record<string, number>;
}

export interface MarkerDef {
  name: string;
  color: string;
  where: 'pond' | 'forest' | 'highland' | 'lighthouse';
  prompt: string;
  when: Cond;
  flag?: string;
  toast?: string;
}

export interface NpcDef {
  id: string;
  name: string;
  role: string;
  look: Record<string, string>;
  hat: { kind: 'tophat' | 'cap' | 'bucket' | 'sunhat'; color: string; band: string };
  home: { dx?: number; dz?: number; cottage?: number };
  wander: number;
  arrival: { level: number };
  hello: string;
  tint: string;
}

export interface DialogueNode {
  speaker: string;
  text: string;
  next?: string | null;
  choices?: Array<{ text: string; next?: string | null }>;
  set?: string[];
}

interface IdleLine {
  text: string;
  time?: 'day' | 'dusk' | 'night';
  minLevel?: number;
  maxLevel?: number;
}

export const STEPS = (questsJson as unknown as { steps: Step[] }).steps;
export const MARKERS = (questsJson as unknown as { markers: Record<string, MarkerDef> }).markers;
export const LEVELS = (questsJson as unknown as { levels: Array<{ level: number; name: string; npc?: string; toast?: string }> }).levels;
export const NPCS = (npcsJson as unknown as { npcs: NpcDef[] }).npcs;
const NODES = (dialogueJson as unknown as { nodes: Record<string, DialogueNode> }).nodes;
const IDLE = (dialogueJson as unknown as { idle: Record<string, IdleLine[]> }).idle;
const RULES = (questsJson as unknown as { levelRules: { l1PlacedVillage: number; l2Species: number; l3Species: number } }).levelRules;
/** the main chain (non-free steps) length, for "Step 3 of 11" */
export const MAIN_STEPS = STEPS.filter((s) => !s.free).length;

export const STORY_KEY = 'glimmerwick.story.v1';

export interface StoryState {
  v: 1;
  step: number;
  flags: Record<string, true>;
  told: Record<string, number>;
  level: number;
  introDone: boolean;
  /** lenses set on the pedestal (0-3) */
  lenses: number;
}

const fresh = (): StoryState => ({ v: 1, step: 0, flags: {}, told: {}, level: 0, introDone: false, lenses: 0 });

export interface UpdateResult {
  completed: Step[];
  levelUps: number[];
}

export class StoryEngine {
  s: StoryState = fresh();
  /** synthetic one-off nodes (idle chatter, recaps) */
  private readonly temp = new Map<string, DialogueNode>();
  private lastIdle: Record<string, number> = {};
  private saveTimer = 0;

  constructor(
    readonly store: Store,
    private readonly persist: boolean,
  ) {
    if (persist) this.load();
  }

  // ------------------------------------------------------------------ flags / told

  has(flag: string): boolean {
    return !!this.s.flags[flag];
  }
  setFlag(flag: string): void {
    if (this.s.flags[flag]) return;
    this.s.flags[flag] = true;
    this.save();
  }
  isTold(id?: string): boolean {
    return !!id && (this.s.told[id] ?? 0) > 0;
  }
  markTold(id: string): void {
    this.s.told[id] = (this.s.told[id] ?? 0) + 1;
    this.save();
  }

  // ------------------------------------------------------------------ conditions

  friends(species?: number): number {
    let n = 0;
    for (const [k, e] of Object.entries(this.store.dex)) {
      if (!e.friend) continue;
      if (species === undefined || k.startsWith(`${species}:`)) n++;
    }
    return n;
  }

  step(): Step | null {
    return STEPS[this.s.step] ?? null;
  }

  progress(c: Cond, step: Step | null = this.step()): { p: number; n: number } {
    const st = this.store.stats;
    switch (c.kind) {
      case 'told':
        return { p: step?.intro && this.isTold(step.intro) ? 1 : 0, n: 1 };
      case 'collect':
        return { p: st.collected[c.item] ?? 0, n: c.n };
      case 'craft':
        return { p: st.crafted[c.item] ?? 0, n: c.n };
      case 'placedVillage':
        return { p: st.placedVillage ?? 0, n: c.n };
      case 'friend':
        return { p: this.friends(c.species), n: c.n };
      case 'friends':
        return { p: this.friends(), n: c.n };
      case 'dex':
        return { p: this.store.dexSeenCount(), n: c.n };
      case 'flag':
        return { p: this.has(c.flag) ? 1 : 0, n: 1 };
    }
  }

  met(c: Cond, step: Step | null = this.step()): boolean {
    const r = this.progress(c, step);
    return r.p >= r.n;
  }

  // ------------------------------------------------------------------ village level

  computeLevel(): number {
    const l1 = (this.store.stats.placedVillage ?? 0) >= RULES.l1PlacedVillage;
    const l2 = l1 && this.friends(RULES.l2Species) >= 1;
    const l3 = l2 && this.friends(RULES.l3Species) >= 1;
    const l4 = this.has('beacon_lit');
    return l4 ? 4 : l3 ? 3 : l2 ? 2 : l1 ? 1 : 0;
  }

  get level(): number {
    return this.s.level;
  }

  /** is this villager living in the village yet? */
  present(def: NpcDef): boolean {
    return this.s.level >= def.arrival.level;
  }

  /** the step's giver may start it (needs-gate satisfied and giver present) */
  stepOpen(step: Step | null = this.step()): boolean {
    if (!step) return false;
    return !step.needs || this.met(step.needs, step);
  }

  /** a "!" belongs over this villager */
  hasBang(def: NpcDef): boolean {
    if (!this.present(def)) return false;
    const step = this.step();
    if (step && step.giver === def.id && step.intro && !this.isTold(step.intro) && this.stepOpen(step)) return true;
    return !this.isTold(def.hello) && def.id !== 'pip';
  }

  // ------------------------------------------------------------------ tick

  /** advance level + quest chain from the current Store state. UI effects (rewards, toasts) are the caller's job. */
  update(): UpdateResult {
    const res: UpdateResult = { completed: [], levelUps: [] };
    const lv = this.computeLevel();
    while (this.s.level < lv) {
      this.s.level++;
      res.levelUps.push(this.s.level);
    }
    for (let guard = 0; guard < 8; guard++) {
      const step = this.step();
      if (!step) break;
      if (step.needs && !this.met(step.needs, step)) break;
      if (!this.met(step.cond, step)) break;
      if (step.intro) this.s.told[step.intro] = this.s.told[step.intro] ?? 1; // skipped intros are not "!" forever
      this.s.step++;
      res.completed.push(step);
    }
    if (res.completed.length || res.levelUps.length) this.save();
    return res;
  }

  // ------------------------------------------------------------------ goal card

  goalView(): GoalView | null {
    const step = this.step();
    if (!step) {
      return { label: 'Village wishes', badge: '★', title: 'Every wish granted!', hint: 'You are a true Keeper. Keep building, exploring and making friends.', progress: 1, target: 1, done: true };
    }
    const idx = this.s.step;
    const label = step.free ? 'Village wish' : `Step ${idx + 1} of ${MAIN_STEPS}`;
    const badge = step.free ? '★' : String(idx + 1);
    if (step.needs && !this.met(step.needs, step)) {
      const r = this.progress(step.needs, step);
      return { label, badge, title: step.title, hint: step.hint, progress: r.p, target: r.n };
    }
    const r = this.progress(step.cond, step);
    return { label, badge, title: step.title, hint: step.hint, progress: r.p, target: r.n };
  }

  // ------------------------------------------------------------------ dialogue

  node(id: string): DialogueNode | undefined {
    return this.temp.get(id) ?? NODES[id];
  }

  /** hour 0-24 -> time bucket */
  static bucket(hours: number): 'day' | 'dusk' | 'night' {
    if (hours >= 6.5 && hours < 17.5) return 'day';
    if ((hours >= 17.5 && hours < 20.5) || (hours >= 5 && hours < 6.5)) return 'dusk';
    return 'night';
  }

  /** which conversation does talking to this villager start right now? */
  conversationFor(def: NpcDef, hours: number): string {
    const step = this.step();
    if (step && step.giver === def.id && step.intro && !this.isTold(step.intro) && this.stepOpen(step)) return step.intro;
    if (!this.isTold(def.hello)) return def.hello;
    // a short recap when this villager gave the current step
    if (step && step.giver === def.id && !step.free) {
      const id = `recap.${def.id}.${step.id}`;
      this.temp.set(id, { speaker: def.id, text: `${step.title}: ${step.hint}` });
      return id;
    }
    const b = StoryEngine.bucket(hours);
    const lines = (IDLE[def.id] ?? []).filter((l) => (!l.time || l.time === b) && (l.minLevel ?? 0) <= this.s.level && (l.maxLevel ?? 9) >= this.s.level);
    if (!lines.length) return def.hello;
    let i = Math.floor(Math.random() * lines.length);
    if (lines.length > 1 && i === this.lastIdle[def.id]) i = (i + 1) % lines.length;
    this.lastIdle[def.id] = i;
    const id = `idle.${def.id}.${Date.now()}`;
    this.temp.set(id, { speaker: def.id, text: lines[i]!.text });
    if (this.temp.size > 40) this.temp.delete(this.temp.keys().next().value as string);
    return id;
  }

  /** register an ad-hoc one-box conversation */
  say(speaker: string, text: string): string {
    const id = `say.${speaker}.${this.temp.size}.${Date.now()}`;
    this.temp.set(id, { speaker, text });
    return id;
  }

  // ------------------------------------------------------------------ persistence

  save(): void {
    if (!this.persist) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(STORY_KEY, JSON.stringify(this.s));
    } catch {
      /* private window */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORY_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<StoryState>;
      if (d.v !== 1) return;
      this.s = { ...fresh(), ...d, flags: d.flags ?? {}, told: d.told ?? {} };
      this.s.step = Math.min(STEPS.length, Math.max(0, this.s.step));
    } catch {
      /* ignore */
    }
  }
}
