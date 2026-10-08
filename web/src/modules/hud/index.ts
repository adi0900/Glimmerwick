/**
 * Gameplay HUD + core loop (vertical slice 1): gather -> build -> befriend -> collect.
 *
 *  - hotbar / toasts / goal tracker / Workbench (C) / Glimmerdex (G) / help (H, F1)      -> ./ui.ts
 *  - target outline, crack overlay, placement ghost, chip particles                       -> ./fx.ts
 *  - inventory + dex + goals profile (localStorage)                                       -> ./state.ts
 *  - tuning constants (reach, break times, ...)                                           -> ./tuning.ts
 *  - items, drops, recipes, dex sheet, goals (plain data)                                 -> ./data.ts
 *
 * Block edits go through the sim (`world.break_block / place_block`); befriending through `creature.offer_treat`.
 * URL: `?ui=0` hides the HUD, `?ui=1` shows it in automated runs (it is hidden there by default so showcase
 * recordings stay clean), `?fresh=1` ignores the saved profile. Debug handle: `window.__gameplay`.
 */
import { Vector3 } from 'three';
import { defineModule } from '../../engine/types';
import type { Ctx, GameEvent } from '../../engine/types';
import { Btn } from '../../engine/Input';
import { ITEMS, RECIPES, SPECIES_DEX, dropsFor, isTreat } from './data';
import { GameFx } from './fx';
import { itemIcon } from './icons';
import { Sfx } from './sfx';
import { HOTBAR, Store, dexKey } from './state';
import { TUNING } from './tuning';
import { HudUi, type PanelName } from './ui';

interface BlockInfo {
  id: number;
  name: string;
  color: [number, number, number];
  hardness: number;
  liquid: boolean;
}

interface Hit {
  cell: [number, number, number];
  normal: [number, number, number];
  name: string;
  dist: number;
}

const EV_CREATURE_BEFRIENDED = 305;

const DIR = new Vector3();
const PROJ = new Vector3();

interface Runtime {
  store: Store;
  ui: HudUi;
  fx: GameFx;
  sfx: Sfx;
  blocks: Map<string, BlockInfo>;
  hit: Hit | null;
  progress: number;
  breakCooldown: number;
  chipTimer: number;
  placeTimer: number;
  placeWasHeld: boolean;
  placeEdge: boolean;
  lmb: boolean;
  rmb: boolean;
  padPrev: boolean[];
  dexTimer: number;
  pickups: Map<string, number>;
  pickupAt: number;
  celebrating: boolean;
  hintAt: Record<string, number>;
  visible: boolean;
  lastDir: Vector3;
  aimOverride: [number, number, number] | null;
  offTimers: number[];
  village: { x: number; z: number; r: number } | null;
  companionIds: Set<number>;
}

let R: Runtime | null = null;
const disposers: Array<() => void> = [];

const pretty = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const rgbOf = (r: Runtime | null, blockName: string): [number, number, number] => r?.blocks.get(blockName)?.color ?? [200, 190, 170];

function iconFor(r: Runtime | null, item: string): string {
  const def = ITEMS[item];
  return itemIcon(item, def?.block ? rgbOf(r, def.block) : undefined);
}

function cooldownHint(r: Runtime, key: string, ms: number): boolean {
  const now = performance.now();
  if ((r.hintAt[key] ?? 0) + ms > now) return false;
  r.hintAt[key] = now;
  return true;
}

// ------------------------------------------------------------------------------------------------ module

export default defineModule({
  name: 'hud',
  order: 200,
  needs: ['voxel'],

  init(ctx: Ctx) {
    const params = ctx.view.params;
    const show = params.ui === '1' || (params.ui !== '0' && !ctx.view.automated);
    const blocks = new Map<string, BlockInfo>();
    try {
      const reg = ctx.game.query('world.blocks') as unknown;
      const list: any[] = Array.isArray(reg) ? reg : ((reg as any)?.blocks ?? []);
      for (const b of list) {
        blocks.set(b.name, {
          id: b.id,
          name: b.name,
          color: (b.color as [number, number, number]) ?? [200, 200, 200],
          hardness: typeof b.hardness === 'number' ? b.hardness : 1,
          liquid: !!b.liquid,
        });
      }
    } catch (e) {
      console.warn('[hud] could not read the block registry', e);
    }

    const store = new Store(params.fresh !== '1');
    const sfx = new Sfx(() => ctx.api.audio);
    ctx.input.onFirstGesture(() => sfx.unlock());
    const host = document.getElementById('ui') ?? document.body;
    const fx = new GameFx(ctx.scene);

    // eslint-disable-next-line prefer-const
    let ui!: HudUi;
    const hooks = {
      icon: (item: string) => iconFor(R, item),
      craft: (id: string) => craft(ctx, id),
      select: (i: number) => {
        store.select(i);
        sfx.play('ui');
      },
      swap: (a: number, b: number) => store.swap(a, b),
      panelChanged: (p: PanelName) => {
        ctx.input.enabled = p === null;
        if (p) {
          try {
            document.exitPointerLock();
          } catch {
            /* ignore */
          }
          if (R) {
            R.lmb = R.rmb = false;
            R.progress = 0;
          }
        }
        sfx.play('ui');
      },
    };
    ui = new HudUi(host, store, hooks);
    ui.setVisible(show);

    R = {
      store,
      ui,
      fx,
      sfx,
      blocks,
      hit: null,
      progress: 0,
      breakCooldown: 0,
      chipTimer: 0,
      placeTimer: 0,
      placeWasHeld: false,
      placeEdge: false,
      lmb: false,
      rmb: false,
      padPrev: [],
      dexTimer: 0,
      pickups: new Map(),
      pickupAt: 0,
      celebrating: false,
      hintAt: {},
      visible: show,
      lastDir: new Vector3(0, 0, -1),
      aimOverride: null,
      offTimers: [],
      village: null,
      companionIds: new Set(),
    };
    const r = R;
    try {
      const v = (ctx.game.world.info as any)?.village;
      if (v && typeof v.x === 'number') r.village = { x: v.x, z: v.z, r: (v.r ?? 20) + 6 };
    } catch {
      /* no village info */
    }

    store.onChange(() => {
      ui.refresh();
      checkGoals(ctx);
    });
    refreshCompanions(ctx);

    // ---- input
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.tagName && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'F1' || (e.code === 'KeyH' && !e.repeat)) {
        e.preventDefault();
        ui.togglePanel('help');
        return;
      }
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyC':
          ui.togglePanel('craft');
          return;
        case 'KeyG':
          ui.togglePanel('dex');
          return;
        case 'Escape':
          if (ui.panel) ui.setPanel(null);
          return;
        case 'KeyE':
          if (!ui.panel) tryOffer(ctx);
          return;
        case 'KeyX':
          r.placeEdge = true; // latched: a very quick tap is never lost between frames
          return;
      }
      const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (m) {
        const n = Number(m[1]);
        store.select(n === 0 ? 9 : n - 1);
        sfx.play('ui');
      }
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('#gw-hud')) return;
      if (e.button === 0) r.lmb = true;
      if (e.button === 2) {
        r.rmb = true;
        r.placeEdge = true;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 0) r.lmb = false;
      if (e.button === 2) r.rmb = false;
    };
    const onBlur = () => {
      r.lmb = r.rmb = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    const prevWheel = ctx.input.onWheel;
    ctx.input.onWheel = (dy, e) => {
      if (prevWheel?.(dy, e)) return true;
      if (e.shiftKey || ui.panel || !r.visible) return false; // Shift + wheel keeps the camera zoom
      store.select(store.selected + (dy > 0 ? 1 : -1));
      sfx.play('ui');
      return true;
    };
    disposers.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
      ctx.input.onWheel = prevWheel;
      window.addEventListener('beforeunload', () => store.flush());
    });
    window.addEventListener('beforeunload', () => store.flush());

    if (!store.helpSeen && show) {
      store.helpSeen = true;
      window.setTimeout(() => ui.toast('Press H for controls', { tone: 'good' }), 1800);
    }

    // ---- services + debug handle
    const api = {
      store,
      ui,
      fx,
      sfx,
      tuning: TUNING,
      get target() {
        return r.hit;
      },
      get progress() {
        return r.progress;
      },
      offer: () => tryOffer(ctx),
      place: () => doPlace(ctx),
      craft: (id: string) => craft(ctx, id),
      setAim: (d: [number, number, number] | null) => {
        r.aimOverride = d;
      },
      blockInfo: (n: string) => r.blocks.get(n),
    };
    ctx.api.gameplay = api;
    (window as unknown as { __gameplay: unknown }).__gameplay = api;
    ctx.debug.line('gameplay', () => `target ${r.hit ? `${r.hit.name} @ ${r.hit.cell.join(',')}` : '-'} · dex ${store.dexSeenCount()} · goal ${store.goalIndex}`);
    ui.refresh();
  },

  update(ctx: Ctx, dt: number) {
    const r = R;
    if (!r || !ctx.game.player.valid) return;
    const { ui, store, fx } = r;
    const t = ctx.clock.t;

    pollGamepad(ctx, r);
    flushPickups(r);

    const panelOpen = ui.panel !== null;
    const held = store.held;

    // ---- aim ray from the eye along the camera direction (lifted a little: the follow camera never looks up)
    let hit: Hit | null = null;
    if (!panelOpen) {
      const p = ctx.game.player.pos;
      const dir = r.aimOverride ? DIR.set(...r.aimOverride) : ctx.camera.getWorldDirection(DIR);
      const h = Math.hypot(dir.x, dir.z);
      if (!r.aimOverride && h > 1e-4) {
        const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y))) + TUNING.aimLift;
        r.lastDir.set((dir.x / h) * Math.cos(pitch), Math.sin(pitch), (dir.z / h) * Math.cos(pitch));
      } else if (r.aimOverride) r.lastDir.copy(dir).normalize();
      const o: [number, number, number] = [p.x, p.y + TUNING.eyeHeight, p.z];
      const res = ctx.game.query('world.raycast', { origin: o, dir: [r.lastDir.x, r.lastDir.y, r.lastDir.z], max: TUNING.reach });
      if (res?.hit && Array.isArray(res.pos)) {
        hit = { cell: res.pos as [number, number, number], normal: res.normal as [number, number, number], name: String(res.name), dist: Number(res.dist) };
      }
    }
    const same = hit && r.hit && hit.cell[0] === r.hit.cell[0] && hit.cell[1] === r.hit.cell[1] && hit.cell[2] === r.hit.cell[2];
    if (!same) r.progress = 0;
    r.hit = hit;

    const info = hit ? r.blocks.get(hit.name) : undefined;
    const breakable = !!hit && !!info && info.hardness >= 0 && !info.liquid && hit.name !== 'bedrock';

    // ---- hold to break
    const breakHeld = !panelOpen && (ctx.input.key('KeyF') || (r.lmb && ctx.input.pointerLocked) || r.padPrev[7] === true);
    r.breakCooldown = Math.max(0, r.breakCooldown - dt);
    if (breakHeld && hit && breakable && info) {
      if (r.breakCooldown <= 0) {
        const secs = Math.min(TUNING.breakMax, Math.max(TUNING.breakMin, info.hardness * TUNING.secondsPerHardness));
        r.progress += dt / secs;
        r.chipTimer -= dt;
        if (r.chipTimer <= 0 && dt > 0) {
          r.chipTimer = 0.13;
          fx.burst(hit.cell[0] + 0.5 + hit.normal[0] * 0.5, hit.cell[1] + 0.5 + hit.normal[1] * 0.5, hit.cell[2] + 0.5 + hit.normal[2] * 0.5, info.color, 3, 1.8, 0.07);
          r.sfx.play('tick');
        }
        if (r.progress >= 1) doBreak(ctx, hit, info);
      }
    } else if (r.progress > 0) {
      r.progress = Math.max(0, r.progress - dt * 2.5);
    }

    // ---- place (press, then repeats while held)
    const placeHeld = !panelOpen && (ctx.input.key('KeyX') || r.rmb || r.padPrev[13] === true);
    r.placeTimer -= dt;
    const placeNow = r.placeEdge && !panelOpen;
    r.placeEdge = false;
    if (placeNow || (placeHeld && (!r.placeWasHeld || r.placeTimer <= 0))) {
      r.placeTimer = TUNING.placeRepeat;
      doPlace(ctx);
    }
    r.placeWasHeld = placeHeld;

    // ---- visuals
    const wantGhost = !panelOpen && hit && held && !!ITEMS[held.item]?.block && !playerOverlaps(ctx, hit);
    fx.setTarget(!panelOpen && hit ? hit.cell : null, breakable, r.progress);
    if (wantGhost && hit && held) {
      const def = ITEMS[held.item]!;
      fx.setGhost([hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]], rgbOf(r, def.block!));
    } else fx.setGhost(null);
    fx.update(dt, t);

    if (r.visible) {
      if (hit && !panelOpen) {
        // anchor on the block; when the avatar stands in front of it (screen overlap) park the bubble beside the avatar's head
        let sp = project(ctx, hit.cell[0] + 0.5, hit.cell[1] + 0.5, hit.cell[2] + 0.5);
        const pp = ctx.game.player.pos;
        const me = project(ctx, pp.x, pp.y + 0.9, pp.z);
        if (sp && me && Math.hypot(sp.x - me.x, sp.y - me.y) < 130) sp = { x: me.x + 78, y: me.y - 26 };
        ui.setTarget(!!sp, sp?.x, sp?.y, pretty(hit.name), breakable ? 'hold F' : 'too tough');
        ui.setRing(!!sp && r.progress > 0.02, r.progress, sp?.x, sp?.y);
      } else {
        ui.setTarget(false);
        ui.setRing(false);
      }
    }

    // ---- dex discovery
    r.dexTimer -= dt;
    if (r.dexTimer <= 0) {
      r.dexTimer = 0.45;
      scanDex(ctx);
    }
  },

  onEvents(ctx: Ctx, ev: GameEvent[]) {
    const r = R;
    if (!r) return;
    for (const e of ev) {
      if (e.kind === EV_CREATURE_BEFRIENDED) refreshCompanions(ctx);
    }
  },

  dispose() {
    for (const d of disposers) d();
    disposers.length = 0;
    R?.store.flush();
    R?.fx.dispose();
    R?.ui.root.remove();
    R = null;
  },
});

// ------------------------------------------------------------------------------------------------ helpers

function project(ctx: Ctx, x: number, y: number, z: number): { x: number; y: number } | null {
  PROJ.set(x, y, z).project(ctx.camera);
  if (PROJ.z > 1 || PROJ.z < -1) return null;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  return { x: rect.left + (PROJ.x * 0.5 + 0.5) * rect.width, y: rect.top + (-PROJ.y * 0.5 + 0.5) * rect.height };
}

function playerOverlaps(ctx: Ctx, hit: Hit): boolean {
  const p = ctx.game.player.pos;
  const cx = hit.cell[0] + hit.normal[0];
  const cy = hit.cell[1] + hit.normal[1];
  const cz = hit.cell[2] + hit.normal[2];
  const hw = TUNING.playerHalfWidth;
  return p.x + hw > cx && p.x - hw < cx + 1 && p.z + hw > cz && p.z - hw < cz + 1 && p.y + TUNING.playerHeight > cy && p.y < cy + 1;
}

function queuePickup(r: Runtime, item: string, n: number): void {
  r.pickups.set(item, (r.pickups.get(item) ?? 0) + n);
  r.pickupAt = performance.now();
}

function flushPickups(r: Runtime): void {
  if (!r.pickups.size || performance.now() - r.pickupAt < 380) return;
  for (const [item, n] of r.pickups) r.ui.toast(`+${n} ${ITEMS[item]?.name ?? item}`, { icon: iconFor(r, item), dedupeMs: 0 });
  r.pickups.clear();
  r.sfx.play('pickup');
}

function doBreak(ctx: Ctx, hit: Hit, info: BlockInfo): void {
  const r = R!;
  const [x, y, z] = hit.cell;
  const res = ctx.game.command('world.break_block', { x, y, z });
  r.progress = 0;
  r.breakCooldown = TUNING.breakRepeatDelay;
  if (res?.error) {
    r.ui.toast("Can't break that", { tone: 'warn' });
    r.sfx.play('nope');
    return;
  }
  r.fx.burst(x + 0.5, y + 0.5, z + 0.5, info.color, 18, 3.4, 0.12);
  r.sfx.play('break');
  r.store.noteBroken();
  const drops = dropsFor(info.name);
  for (const d of drops) {
    const added = r.store.add(d.item, d.n);
    if (added > 0) {
      r.store.noteCollected(d.item, added);
      queuePickup(r, d.item, added);
    }
    if (added < d.n && cooldownHint(r, 'full', 2500)) r.ui.toast('Pack is full!', { tone: 'warn' });
  }
}

function doPlace(ctx: Ctx): void {
  const r = R!;
  const held = r.store.held;
  const { ui } = r;
  if (!held) {
    if (cooldownHint(r, 'empty', 1500)) ui.toast('Pick something from your hotbar (1-0)', { tone: 'warn' });
    return;
  }
  const def = ITEMS[held.item];
  if (!def?.block) {
    if (cooldownHint(r, 'treat', 2500)) ui.toast(isTreat(held.item) ? 'Treats are for Glimmers: press E near one' : 'That cannot be placed', { tone: 'warn' });
    return;
  }
  const hit = r.hit;
  if (!hit) {
    if (cooldownHint(r, 'aim', 1500)) ui.toast('Look at a block to build next to it', { tone: 'warn' });
    return;
  }
  if (!hit.normal.some((n) => n !== 0)) return;
  if (playerOverlaps(ctx, hit)) {
    if (cooldownHint(r, 'self', 1200)) ui.toast('Step aside first!', { tone: 'warn' });
    ui.shakeHotbar();
    r.sfx.play('nope');
    return;
  }
  const x = hit.cell[0] + hit.normal[0];
  const y = hit.cell[1] + hit.normal[1];
  const z = hit.cell[2] + hit.normal[2];
  const res = ctx.game.command('world.place_block', { x, y, z, name: def.block });
  if (res?.error) {
    if (cooldownHint(r, 'cant', 1500)) ui.toast("Can't build there", { tone: 'warn' });
    r.sfx.play('nope');
    return;
  }
  r.store.remove(held.item, 1);
  r.store.notePlaced(!!r.village && Math.hypot(x + 0.5 - r.village.x, z + 0.5 - r.village.z) <= r.village.r);
  r.fx.burst(x + 0.5, y + 0.5, z + 0.5, rgbOf(r, def.block), 7, 1.8, 0.09);
  r.sfx.play('place');
  r.ui.bump(r.store.selected);
}

function craft(ctx: Ctx, id: string): void {
  const r = R!;
  const rec = RECIPES.find((x) => x.id === id);
  if (!rec) return;
  for (const [k, n] of Object.entries(rec.needs)) if (r.store.count(k) < n) return;
  for (const [k, n] of Object.entries(rec.needs)) r.store.remove(k, n);
  const added = r.store.add(rec.out, rec.n);
  if (added < rec.n) r.ui.toast('Pack is full!', { tone: 'warn' });
  r.store.noteCrafted(rec.out, added);
  r.ui.toast(`Made ${added} ${ITEMS[rec.out]?.name ?? rec.out}`, { icon: iconFor(r, rec.out) });
  r.sfx.play('pickup');
  void ctx;
}

// ---- befriending ---------------------------------------------------------------------------------------------

function nearestCreature(ctx: Ctx, maxDist: number): { id: number; species: number; variant: number; x: number; y: number; z: number; d: number } | null {
  const ch = ctx.game.channel('creatures');
  const p = ctx.game.player.pos;
  const s = ch.stride;
  const d = ch.data;
  const n = Math.floor(ch.len / s);
  let best: { id: number; species: number; variant: number; x: number; y: number; z: number; d: number } | null = null;
  for (let i = 0; i < n; i++) {
    const o = i * s;
    const dx = d[o + 3]! - p.x;
    const dz = d[o + 5]! - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= maxDist && (!best || dist < best.d)) {
      best = { id: Math.round(d[o]!), species: Math.round(d[o + 1]!), variant: Math.round(d[o + 2]!), x: d[o + 3]!, y: d[o + 4]!, z: d[o + 5]!, d: dist };
    }
  }
  return best;
}

function tryOffer(ctx: Ctx): void {
  const r = R!;
  const { ui, store } = r;
  const c = nearestCreature(ctx, TUNING.offerRange + 2.5);
  // E arbitration: a villager in talking range wins over a companion, and over any creature that is farther away than the villager
  const story = ctx.api.story as { nearestTalkDist?: () => number | null; interact?: () => boolean } | undefined;
  const npcD = story?.nearestTalkDist?.() ?? null;
  if (npcD !== null && (!c || r.companionIds.has(c.id) || c.d > npcD + 0.4)) {
    if (story?.interact?.()) return;
  }
  if (!c) return; // nothing close: the sim still handles the plain poke (E)
  const sp = SPECIES_DEX[c.species];
  // pick a treat: the held one, else the best one in the pack (favourite first); bring it into the hotbar
  let slot = store.selected;
  if (!isTreat(store.held?.item ?? '')) {
    slot = store.findTreat(sp?.favourite);
    if (slot < 0) {
      if (cooldownHint(r, 'notreat', 4000)) ui.toast('Hold a treat to make friends: berries, apples, oranges, or Leaf Cookies (C)', { tone: 'warn' });
      return;
    }
    if (slot >= HOTBAR) store.swap(slot, store.selected);
    else store.select(slot);
  }
  const item = store.held?.item;
  if (!item) return;
  const res = ctx.game.command('creature.offer_treat', { id: c.id, treat: item });
  if (!res || res.error) {
    ui.toast('Nothing happened', { tone: 'warn' });
    return;
  }
  const name = String(res.name ?? sp?.name ?? 'Glimmer');
  const variantName = SPECIES_DEX[c.species]?.variants[c.variant]?.name ?? '';
  switch (res.reason) {
    case 'befriended': {
      store.remove(item, 1);
      store.markFriend(c.species, c.variant, name);
      r.fx.sparkle(c.x, c.y + 0.8, c.z, [255, 120, 170], 22);
      r.fx.sparkle(c.x, c.y + 0.8, c.z, [255, 220, 90], 16);
      r.sfx.play('fanfare');
      ui.showBanner('New friend!', `${name} the ${variantName} ${sp?.name ?? ''}`.replace(/\s+/g, ' '), [
        { icon: iconFor(r, item), text: res.favourite ? 'Favourite treat!' : 'Tasty!' },
      ]);
      ui.toast(`${name} will follow you now`, { tone: 'love' });
      refreshCompanions(ctx);
      break;
    }
    case 'not_yet':
      r.sfx.play('nope');
      ui.toast(sp?.personality === 'Shy' ? `${name} is shy. Stay close, move slowly, try again` : `${name} is not sure yet. Try again soon`, { tone: 'warn' });
      break;
    case 'wait':
      ui.toast(`${name} needs a moment`, { tone: 'warn', dedupeMs: 2000 });
      break;
    case 'asleep':
      ui.toast(`Shh! ${name} is sleeping`, { tone: 'warn' });
      break;
    case 'too_far':
      ui.toast('Get a little closer', { tone: 'warn' });
      break;
    case 'already_friend':
      ui.toast(`${name} is your friend!`, { tone: 'love', dedupeMs: 2500 });
      break;
  }
}

function refreshCompanions(ctx: Ctx): void {
  const r = R;
  if (!r) return;
  try {
    const list = ctx.game.query('creature.companions') as Array<{ id: number; name: string; species: number; variant: number }>;
    if (Array.isArray(list)) {
      r.ui.setCompanions(list);
      r.companionIds = new Set(list.map((c) => c.id));
    }
  } catch {
    /* sim without companions */
  }
}

function scanDex(ctx: Ctx): void {
  const r = R!;
  const ch = ctx.game.channel('creatures');
  const p = ctx.game.player.pos;
  const s = ch.stride;
  const d = ch.data;
  const n = Math.floor(ch.len / s);
  const rad2 = TUNING.dexSeenRadius * TUNING.dexSeenRadius;
  for (let i = 0; i < n; i++) {
    const o = i * s;
    const dx = d[o + 3]! - p.x;
    const dz = d[o + 5]! - p.z;
    if (dx * dx + dz * dz > rad2) continue;
    const species = Math.round(d[o + 1]!);
    const variant = Math.round(d[o + 2]!);
    if (r.store.markSeen(species, variant)) {
      const sp = SPECIES_DEX[species];
      const v = sp?.variants[variant];
      r.ui.markNewDex(species, variant);
      r.ui.toast(`New Glimmer: ${v?.name ?? ''} ${sp?.name ?? ''}! (G)`, { tone: 'love', dedupeMs: 0 });
      r.sfx.play('chime');
      void dexKey;
    }
  }
}

// ---- goals ---------------------------------------------------------------------------------------------------

function checkGoals(ctx: Ctx): void {
  const r = R;
  if (!r || r.celebrating) return;
  if (ctx.api.story) {
    r.ui.refreshGoal(); // the story module owns goals/rewards
    return;
  }
  r.celebrating = true;
  try {
    for (let guard = 0; guard < 6; guard++) {
      const done = r.store.completeIfDone();
      if (!done) break;
      const chips: Array<{ icon: string; text: string }> = [];
      for (const [item, n] of Object.entries(done.reward)) {
        const added = r.store.add(item, n);
        if (added > 0) chips.push({ icon: iconFor(r, item), text: `${added} ${ITEMS[item]?.name ?? item}` });
      }
      r.ui.showBanner('Goal complete!', done.title, chips);
      r.ui.pulseGoal();
      r.sfx.play('fanfare');
      const p = ctx.game.player.pos;
      r.fx.sparkle(p.x, p.y + 1.2, p.z, [255, 214, 90], 26);
    }
  } finally {
    r.celebrating = false;
  }
  r.ui.refreshGoal();
}

// ---- gamepad -------------------------------------------------------------------------------------------------

function pollGamepad(ctx: Ctx, r: Runtime): void {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = Array.from(pads).find((p) => p && p.connected);
  if (!pad) {
    r.padPrev = [];
    return;
  }
  const down = (i: number) => !!pad.buttons[i]?.pressed || (pad.buttons[i]?.value ?? 0) > 0.45;
  const edge = (i: number) => down(i) && !r.padPrev[i];
  if (edge(4)) r.store.select(r.store.selected - 1);
  if (edge(5)) r.store.select(r.store.selected + 1);
  if (edge(2) && !r.ui.panel) tryOffer(ctx);
  if (edge(13)) r.placeEdge = true;
  if (edge(14)) r.ui.togglePanel('craft');
  if (edge(15)) r.ui.togglePanel('dex');
  if (edge(9)) r.ui.togglePanel('help');
  for (const i of [7, 13]) r.padPrev[i] = down(i);
  for (const i of [2, 4, 5, 9, 14, 15]) r.padPrev[i] = down(i);
  void Btn;
}
