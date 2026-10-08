/**
 * Player profile for the gameplay slice: inventory (10 hotbar + 20 backpack slots), stats, Glimmerdex, goal progress.
 *
 * Decision (documented in docs/BRIDGE_API.md "gameplay" section): the inventory lives in TypeScript and is persisted to
 * `localStorage`, NOT in the Rust sim. Reasons: the sim has no item concept yet, the profile is tiny, and keeping it
 * client-side lets the HUD ship without a contract change. Block edits themselves are authoritative in the sim
 * (`world.break_block / place_block`); companions are authoritative in the sim (`creature.*`). When village growth
 * lands (slice 2) the profile should move to a `sim_systems` save section so one `save()` covers world + profile.
 */
import { GOALS, ITEMS, type Goal } from './data';
import { TUNING } from './tuning';

export type Slot = { item: string; n: number } | null;

export interface DexEntry {
  seen: boolean;
  friend: boolean;
  /** names of befriended individuals of this variant (first one is shown) */
  names: string[];
}

export interface Stats {
  collected: Record<string, number>;
  crafted: Record<string, number>;
  placed: number;
  /** blocks placed within the village radius (story: village level 1 needs 60, step 4 needs 20) */
  placedVillage: number;
  broken: number;
  befriended: number;
}

interface SavedProfile {
  v: 1;
  slots: Slot[];
  selected: number;
  stats: Stats;
  dex: Record<string, DexEntry>;
  goalIndex: number;
  helpSeen: boolean;
}

export const HOTBAR = TUNING.hotbarSlots;
export const TOTAL_SLOTS = TUNING.hotbarSlots + TUNING.backpackSlots;

export const dexKey = (species: number, variant: number): string => `${species}:${variant}`;

export class Store {
  slots: Slot[] = Array.from({ length: TOTAL_SLOTS }, () => null);
  selected = 0;
  stats: Stats = { collected: {}, crafted: {}, placed: 0, placedVillage: 0, broken: 0, befriended: 0 };
  dex: Record<string, DexEntry> = {};
  goalIndex = 0;
  helpSeen = false;

  private listeners = new Set<() => void>();
  private saveTimer = 0;
  private readonly persist: boolean;

  constructor(persist: boolean) {
    this.persist = persist;
    const loaded = persist ? this.load() : false;
    if (!loaded) for (const [item, n] of Object.entries(TUNING.starter)) this.add(item, n, true);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
    if (!this.persist) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 350);
  }

  // ------------------------------------------------------------------ inventory

  count(item: string): number {
    let n = 0;
    for (const s of this.slots) if (s && s.item === item) n += s.n;
    return n;
  }

  /** returns how many were added (less than `n` when the inventory is full) */
  add(item: string, n: number, silent = false): number {
    if (!ITEMS[item] || n <= 0) return 0;
    let left = n;
    // top up existing stacks (hotbar first), then fill empty slots (hotbar first)
    for (const s of this.slots) {
      if (left <= 0) break;
      if (s && s.item === item && s.n < TUNING.stackMax) {
        const take = Math.min(left, TUNING.stackMax - s.n);
        s.n += take;
        left -= take;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue;
      const take = Math.min(left, TUNING.stackMax);
      this.slots[i] = { item, n: take };
      left -= take;
    }
    if (!silent) this.changed();
    return n - left;
  }

  remove(item: string, n: number): boolean {
    if (this.count(item) < n) return false;
    let left = n;
    // take from the selected slot first, then the rest back to front
    const order = [this.selected, ...this.slots.keys()].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of order) {
      const s = this.slots[i];
      if (!s || s.item !== item) continue;
      const take = Math.min(left, s.n);
      s.n -= take;
      left -= take;
      if (s.n <= 0) this.slots[i] = null;
      if (left <= 0) break;
    }
    this.changed();
    return true;
  }

  get held(): Slot {
    return this.slots[this.selected] ?? null;
  }

  select(i: number): void {
    const n = ((i % HOTBAR) + HOTBAR) % HOTBAR;
    if (n === this.selected) return;
    this.selected = n;
    this.changed();
  }

  /** swap two slots (backpack <-> hotbar) */
  swap(a: number, b: number): void {
    const t = this.slots[a] ?? null;
    this.slots[a] = this.slots[b] ?? null;
    this.slots[b] = t;
    this.changed();
  }

  /** first hotbar/backpack slot holding a treat, preferring `favourite` */
  findTreat(favourite?: string): number {
    let any = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s || ITEMS[s.item]?.kind !== 'treat') continue;
      if (favourite && s.item === favourite) return i;
      if (any < 0) any = i;
    }
    return any;
  }

  // ------------------------------------------------------------------ stats / dex / goals

  noteCollected(item: string, n: number): void {
    this.stats.collected[item] = (this.stats.collected[item] ?? 0) + n;
    this.changed();
  }
  noteCrafted(item: string, n: number): void {
    this.stats.crafted[item] = (this.stats.crafted[item] ?? 0) + n;
    this.changed();
  }
  notePlaced(nearVillage = false): void {
    this.stats.placed++;
    if (nearVillage) this.stats.placedVillage++;
    this.changed();
  }
  noteBroken(): void {
    this.stats.broken++;
    this.changed();
  }

  /** returns true when this variant was seen for the first time */
  markSeen(species: number, variant: number): boolean {
    const k = dexKey(species, variant);
    const e = (this.dex[k] ??= { seen: false, friend: false, names: [] });
    if (e.seen) return false;
    e.seen = true;
    this.changed();
    return true;
  }

  markFriend(species: number, variant: number, name: string): void {
    const k = dexKey(species, variant);
    const e = (this.dex[k] ??= { seen: true, friend: false, names: [] });
    e.seen = true;
    e.friend = true;
    if (!e.names.includes(name)) e.names.push(name);
    this.stats.befriended++;
    this.changed();
  }

  dexSeenCount(): number {
    return Object.values(this.dex).filter((e) => e.seen).length;
  }
  dexFriendCount(): number {
    return Object.values(this.dex).filter((e) => e.friend).length;
  }

  get goal(): Goal | null {
    return GOALS[this.goalIndex] ?? null;
  }

  goalProgress(g: Goal | null = this.goal): number {
    if (!g) return 0;
    const m = g.metric;
    switch (m.kind) {
      case 'collect':
        return this.stats.collected[m.item] ?? 0;
      case 'craft':
        return m.item ? (this.stats.crafted[m.item] ?? 0) : Object.values(this.stats.crafted).reduce((a, b) => a + b, 0);
      case 'placed':
        return this.stats.placed;
      case 'befriended':
        return this.stats.befriended;
      case 'dexSeen':
        return this.dexSeenCount();
    }
  }

  /** advance to the next goal; returns the goal that was completed (or null) */
  completeIfDone(): Goal | null {
    const g = this.goal;
    if (!g || this.goalProgress(g) < g.target) return null;
    this.goalIndex++;
    this.changed();
    return g;
  }

  // ------------------------------------------------------------------ persistence

  private save(): void {
    try {
      const data: SavedProfile = {
        v: 1,
        slots: this.slots,
        selected: this.selected,
        stats: this.stats,
        dex: this.dex,
        goalIndex: this.goalIndex,
        helpSeen: this.helpSeen,
      };
      localStorage.setItem(TUNING.storageKey, JSON.stringify(data));
    } catch {
      /* private window / quota: the game keeps working without persistence */
    }
  }

  flush(): void {
    window.clearTimeout(this.saveTimer);
    if (this.persist) this.save();
  }

  private load(): boolean {
    try {
      const raw = localStorage.getItem(TUNING.storageKey);
      if (!raw) return false;
      const d = JSON.parse(raw) as Partial<SavedProfile>;
      if (d.v !== 1 || !Array.isArray(d.slots)) return false;
      this.slots = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
        const s = d.slots![i];
        return s && ITEMS[s.item] && s.n > 0 ? { item: s.item, n: Math.min(s.n, TUNING.stackMax) } : null;
      });
      this.selected = Math.min(HOTBAR - 1, Math.max(0, d.selected ?? 0));
      this.stats = { collected: {}, crafted: {}, placed: 0, placedVillage: 0, broken: 0, befriended: 0, ...(d.stats ?? {}) };
      this.dex = d.dex ?? {};
      this.goalIndex = Math.min(GOALS.length, Math.max(0, d.goalIndex ?? 0));
      this.helpSeen = !!d.helpSeen;
      return true;
    } catch {
      return false;
    }
  }
}
