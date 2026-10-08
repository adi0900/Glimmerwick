/**
 * Story slice (docs/STORY.md): villagers, dialogue, quest chain, village levels, lighthouse, intro.
 *
 *  - data (editable by writers) ............ npcs.json · quests.json · dialogue.json
 *  - quest/level/dialogue logic ............ ./engine.ts (persists to localStorage `glimmerwick.story.v1`)
 *  - villager actors (VoxelAvatar + hat) ... ./npcs.ts
 *  - dialogue box ........................... ./dialogue-ui.ts
 *  - lighthouse, lens markers, terrain ...... ./world.ts (bridge commands only, no Rust changes)
 *  - cinematic camera ....................... ./cam.ts (engine photo camera: `__game.setCam`)
 *
 * Hooks into the HUD: `ui.goalView` replaces the starter goal card, `ctx.api.story.{interact,nearestTalkDist}` is used by
 * the HUD's E key (hud/index.ts tryOffer). URL: `?story=0` disables the module, `?intro=0` skips the intro.
 * Debug handle: `window.__story`.
 */
import { Vector3 } from 'three';
import { defineModule } from '../../engine/types';
import type { Ctx } from '../../engine/types';
import { ITEMS } from '../hud/data';
import { itemIcon } from '../hud/icons';
import type { HudUi } from '../hud/ui';
import type { Store } from '../hud/state';
import type { GameFx } from '../hud/fx';
import type { Sfx } from '../hud/sfx';
import { CamDirector, type Key } from './cam';
import { DialogueUi } from './dialogue-ui';
import { LEVELS, MARKERS, NPCS, STEPS, StoryEngine, type NpcDef, type Step } from './engine';
import { Npc } from './npcs';
import { Lighthouse, Marker, Terrain, findLighthouseSite } from './world';

interface Gameplay {
  store: Store;
  ui: HudUi;
  fx: GameFx;
  sfx: Sfx;
}

const CSS = /* css */ `
.gw-bang{position:absolute;left:0;top:0;width:34px;height:34px;margin:-34px 0 0 -17px;border-radius:50%;background:linear-gradient(180deg,#ffe27a,#ffbf2e);border:3px solid var(--ink);
  display:grid;place-items:center;font:700 22px 'Fredoka Variable',sans-serif;color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill;box-shadow:inset 0 2px 0 rgba(255,255,255,.7),0 3px 0 var(--ink);
  animation:gw-bangbob 1s ease-in-out infinite;pointer-events:none;z-index:2}
.gw-bang::after{content:'';position:absolute;left:50%;bottom:-9px;width:11px;height:11px;background:#ffbf2e;border:3px solid var(--ink);border-top:0;border-left:0;transform:translateX(-50%) rotate(45deg);z-index:-1}
@keyframes gw-bangbob{0%,100%{margin-top:-34px}50%{margin-top:-42px}}
#gw-prompt{position:absolute;left:50%;bottom:176px;transform:translateX(-50%);display:none;align-items:center;gap:9px;padding:6px 18px 6px 8px;border-radius:999px;font-size:19px;white-space:nowrap}
#gw-prompt kbd{padding:2px 11px;border-radius:9px;background:var(--ink);color:var(--cream);font:600 16px 'Fredoka Variable',sans-serif}
#gw-vil{position:absolute;left:326px;top:16px;display:flex;align-items:center;gap:10px;padding:7px 14px 7px 8px;border-radius:999px;font-size:15px;animation:gw-pop .4s ease-out}
#gw-vil .lv{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:linear-gradient(180deg,#a8e6a0,#58c46a);border:3px solid var(--ink);font-size:17px;box-shadow:inset 0 2px 0 rgba(255,255,255,.7)}
#gw-vil .nm{line-height:1.05}
#gw-vil .nm small{display:block;font:700 10px 'Nunito Variable',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ink2)}
#gw-vil .pips{display:flex;gap:3px}
#gw-vil .pips i{width:11px;height:11px;border-radius:50%;border:2px solid var(--ink);background:#f1dfba}
#gw-vil .pips i.on{background:var(--gold)}
#gw-vil .lens{display:flex;gap:3px;margin-left:2px}
#gw-vil .lens i{width:13px;height:13px;border:2px solid var(--ink);background:#f1dfba;transform:rotate(45deg) scale(.82)}
#gw-vil .lens i.on{box-shadow:0 0 6px currentColor}
#gw-vil.pop{animation:gw-pulse .6s ease-out 2}
#gw-title{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;z-index:40;opacity:0;transition:opacity 1s}
#gw-title.show{opacity:1}
#gw-title .in{text-align:center;color:#fff8e6;text-shadow:0 3px 0 rgba(58,42,53,.85),0 0 28px rgba(255,200,110,.7)}
#gw-title h1{margin:0;font:600 clamp(48px,9vw,104px)/1 'Fredoka Variable','Nunito Variable',sans-serif;letter-spacing:.02em;-webkit-text-stroke:6px #3a2a35;paint-order:stroke fill}
#gw-title p{margin:8px 0 0;font:700 clamp(16px,2.4vw,26px) 'Nunito Variable',sans-serif;letter-spacing:.1em;-webkit-text-stroke:4px #3a2a35;paint-order:stroke fill}
#gw-skip{position:fixed;right:22px;bottom:18px;z-index:41;font:600 15px 'Fredoka Variable',sans-serif;color:#fff8e6;background:rgba(58,42,53,.7);padding:5px 14px;border-radius:999px;display:none}
#gw-skip.show{display:block}
`;

const PROJ = new Vector3();
const TALK_RANGE = 2.8;

interface Runtime {
  ctx: Ctx;
  gp: Gameplay;
  engine: StoryEngine;
  terrain: Terrain;
  dlg: DialogueUi;
  cam: CamDirector;
  npcs: Map<string, Npc>;
  lighthouse: Lighthouse;
  markers: Map<string, Marker>;
  markerSpot: Map<string, { x: number; y: number; z: number }>;
  glim: Marker | null;
  village: { x: number; z: number };
  chip: HTMLElement;
  prompt: HTMLElement;
  title: HTMLElement;
  skip: HTMLElement;
  t: number;
  tickT: number;
  dirty: boolean;
  intro: { active: boolean; autoStart: number };
  arrivals: Map<string, number>;
  festivalUntil: number;
  pendingDialogue: { id: string; at: number } | null;
  visible: boolean;
  lastGoalSig: string;
  disposers: Array<() => void>;
  builtDone: boolean;
  lookTo: number | null;
}

let R: Runtime | null = null;

const hudVisible = (r: Runtime): boolean => r.gp.ui.root.style.display !== 'none';

function project(ctx: Ctx, x: number, y: number, z: number): { x: number; y: number; on: boolean } {
  PROJ.set(x, y, z).project(ctx.camera);
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  return { x: rect.left + (PROJ.x * 0.5 + 0.5) * rect.width, y: rect.top + (-PROJ.y * 0.5 + 0.5) * rect.height, on: PROJ.z < 1 && PROJ.z > -1 };
}

// ------------------------------------------------------------------------------------------------ module

export default defineModule({
  name: 'story',
  order: 210,
  needs: ['hud', 'creatures'],

  init(ctx: Ctx) {
    const params = ctx.view.params;
    const gp = ctx.api.gameplay as Gameplay | undefined;
    if (params.story === '0' || !gp) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const host = gp.ui.root;
    const engine = new StoryEngine(gp.store, params.fresh !== '1');
    const terrain = new Terrain(ctx);
    const info = ctx.game.world.info as any;
    const vi = info?.village ?? { x: 58, z: -1 };
    const village = { x: vi.x as number, z: vi.z as number };

    // ---- dialogue
    const speakers: Record<string, { name: string; tint: string; initial: string }> = {
      glim: { name: 'Glim', tint: '#FFD35A', initial: '★' },
    };
    for (const d of NPCS) speakers[d.id] = { name: d.name.split(' ')[0]!, tint: d.tint, initial: d.name[0]! };
    const dlg = new DialogueUi(host, {
      node: (id) => engine.node(id),
      speaker: (id) => speakers[id] ?? { name: id, tint: '#FFC94A', initial: id[0]?.toUpperCase() ?? '?' },
      onSet: (f) => engine.setFlag(f),
      onEnd: (id) => {
        engine.markTold(id);
        R!.dirty = true;
        tick(ctx);
      },
      onOpen: () => {
        ctx.input.enabled = false;
        try {
          document.exitPointerLock();
        } catch {
          /* ignore */
        }
      },
      onClose: () => {
        if (!gp.ui.panel) ctx.input.enabled = true;
        for (const n of R?.npcs.values() ?? []) n.talking = false;
      },
      sound: (k) => gp.sfx.play(k === 'blip' ? 'tick' : k === 'open' ? 'chime' : 'ui'),
    });

    // ---- world pieces
    const site = findLighthouseSite(terrain, village);
    const lighthouse = new Lighthouse(ctx, ctx.scene, site);
    const npcs = new Map<string, Npc>();
    const cottages: number[][] = info?.vox?.cottages ?? [];
    for (const def of NPCS) {
      const npc = new Npc(ctx, def, ctx.scene, host);
      let hx = village.x + (def.home.dx ?? 0);
      let hz = village.z + (def.home.dz ?? 0);
      if (def.home.cottage !== undefined && cottages[def.home.cottage]) {
        const c = cottages[def.home.cottage]!;
        const dx = village.x - c[0]!;
        const dz = village.z - c[1]!;
        const d = Math.hypot(dx, dz) || 1;
        hx = c[0]! + (dx / d) * 6.2;
        hz = c[1]! + (dz / d) * 6.2;
      }
      const spot = terrain.freeSpot(hx, hz, 8);
      const g = spot ?? { x: hx, z: hz, g: terrain.ground(hx, hz) };
      npc.setHome(g.x, g.z, g.g.h);
      npcs.set(def.id, npc);
    }

    const chip = document.createElement('div');
    chip.id = 'gw-vil';
    chip.className = 'gw-card disp';
    host.append(chip);
    const prompt = document.createElement('div');
    prompt.id = 'gw-prompt';
    prompt.className = 'gw-card disp';
    host.append(prompt);
    const title = document.createElement('div');
    title.id = 'gw-title';
    title.innerHTML = '<div class="in"><h1>Glimmerwick</h1><p>Keeper of the Glimmerlight</p></div>';
    document.body.append(title);
    const skip = document.createElement('div');
    skip.id = 'gw-skip';
    skip.textContent = 'Press Space to skip';
    document.body.append(skip);

    const r: Runtime = {
      ctx,
      gp,
      engine,
      terrain,
      dlg,
      cam: new CamDirector(),
      npcs,
      lighthouse,
      markers: new Map(),
      markerSpot: new Map(),
      glim: null,
      village,
      chip,
      prompt,
      title,
      skip,
      t: 0,
      tickT: 0,
      dirty: true,
      intro: { active: false, autoStart: params.intro === '0' ? -1 : 1.4 },
      arrivals: new Map(),
      festivalUntil: 0,
      pendingDialogue: null,
      visible: true,
      lastGoalSig: '',
      disposers: [],
      builtDone: false,
      lookTo: null,
    };
    R = r;
    lighthouse.startBuild();
    if (engine.has('beacon_lit')) {
      lighthouse.setLit(true);
      spawnGlim(r);
    }
    gp.ui.goalView = () => engine.goalView();
    gp.store.onChange(() => {
      r.dirty = true;
    });

    // ---- input: dialogue keys (capture phase so the HUD / sim never see them), intro skip, click-to-talk
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (r.intro.active) {
        if (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          endIntro(r, false);
        }
        return;
      }
      if (r.dlg.open && r.dlg.key(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (r.intro.active) {
        endIntro(r, false);
        return;
      }
      if (e.button !== 0 || r.dlg.open || gp.ui.panel) return;
      if ((e.target as HTMLElement | null)?.closest?.('#gw-hud')) return;
      const pp = ctx.game.player.pos;
      for (const n of npcs.values()) {
        if (!n.present || Math.hypot(n.x - pp.x, n.z - pp.z) > 3.6) continue;
        const s = project(ctx, n.x, n.y + 0.7, n.z);
        if (s.on && Math.hypot(s.x - e.clientX, s.y - e.clientY) < 80) {
          talk(r, n);
          e.stopPropagation();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('beforeunload', () => engine.flush());
    r.disposers.push(
      () => window.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('pointerdown', onDown, true),
    );

    // ---- services + debug handle
    const api = {
      engine,
      dlg,
      cam: r.cam,
      npcs,
      lighthouse,
      markers: r.markers,
      interact: () => interact(r),
      nearestTalkDist: () => nearestInteractable(r)?.d ?? null,
      talk: (id: string) => {
        const n = npcs.get(id);
        if (n) talk(r, n);
        return !!n;
      },
      say: (id: string) => dlg.start(id),
      tick: () => tick(ctx),
      level: () => engine.level,
      skipIntro: () => endIntro(r, false),
      get introActive() {
        return r.intro.active;
      },
      state: () => ({ ...engine.s, goal: engine.goalView() }),
      npcInfo: (id: string) => {
        const n = npcs.get(id);
        return n ? { x: n.x, y: n.y, z: n.z, present: n.present, bang: engine.hasBang(n.def) } : null;
      },
      markerInfo: () => [...r.markers.entries()].map(([k, m]) => ({ id: k, x: m.x, y: m.y, z: m.z, active: m.active })),
      lighthouseInfo: () => ({ site: lighthouse.site, pedestal: lighthouse.pedestal, top: lighthouse.top, lit: lighthouse.lit, building: lighthouse.building }),
      beginIntro: () => beginIntro(r),
      reset: () => {
        try {
          localStorage.removeItem('glimmerwick.story.v1');
        } catch {
          /* ignore */
        }
      },
    };
    ctx.api.story = api;
    (window as unknown as { __story: unknown }).__story = api;
    ctx.debug.line('story', () => `step ${engine.s.step + 1}/${STEPS.length} · village lv ${engine.level} · npcs ${[...npcs.values()].filter((n) => n.present).length}`);
    tick(ctx, true);
    gp.ui.refreshGoal();
    renderChip(r);
  },

  update(ctx: Ctx, dt: number) {
    const r = R;
    if (!r || !ctx.game.player.valid) return;
    r.t += dt;
    const pp = ctx.game.player.pos;
    r.visible = hudVisible(r);

    if (r.lighthouse.building) r.lighthouse.tick(40);
    r.lighthouse.update(r.t, dt);

    // quest / level evaluation: at 4 Hz, or right away after a store change
    r.tickT -= dt;
    if (r.dirty || r.tickT <= 0) {
      r.tickT = 0.25;
      r.dirty = false;
      tick(ctx);
    }

    // villagers
    const ground = (x: number, z: number) => {
      const g = r.terrain.ground(x, z);
      return { h: g.h, ok: g.ok };
    };
    const festival = r.t < r.festivalUntil || (r.engine.has('beacon_lit') && r.engine.s.step <= STEPS.findIndex((s) => s.id === 's11'));
    let fi = 0;
    for (const n of r.npcs.values()) {
      if (!n.present) continue;
      const arrive = r.arrivals.get(n.def.id);
      if (arrive !== undefined) {
        // walking in from the edge of the village; snap home if the path is blocked
        const h = n.homePos;
        if (Math.hypot(n.x - h.x, n.z - h.z) < 1.2 || r.t - arrive > 9) {
          r.arrivals.delete(n.def.id);
          if (r.t - arrive > 9) n.placeAt(h.x, h.z, r.terrain.ground(h.x, h.z).h);
          n.gather = null;
        } else n.gather = { x: h.x, z: h.z };
      } else if (festival) {
        const a = (fi++ / Math.max(3, r.npcs.size)) * Math.PI * 2 + 0.6;
        n.gather = n.def.id === 'pip' ? { x: r.village.x - 1.2, z: r.village.z + 1.6 } : { x: r.village.x + Math.cos(a) * 3.6, z: r.village.z + Math.sin(a) * 3.6 };
      } else if (n.gather && r.arrivals.size === 0) n.gather = null;
      n.excited = r.engine.hasBang(n.def);
      n.update(ctx, dt, pp.x, pp.z, ground);
    }

    // markers
    syncMarkers(r);
    for (const m of r.markers.values()) m.update(r.t, dt, (x, y, z, rgb) => r.gp.fx.sparkle(x, y, z, rgb, 6));
    r.glim?.update(r.t, dt, () => {});
    if (r.glim) {
      r.glim.group.position.y = r.glim.y + 1.6 + Math.sin(r.t * 1.4) * 0.35;
      r.glim.group.rotation.y = r.t * 0.9;
    }

    r.cam.update(dt);
    r.dlg.update(dt);
    // turn the follow camera towards the villager while talking
    if (r.lookTo !== null) {
      if (!r.dlg.open) r.lookTo = null;
      else {
        const inp = ctx.input;
        let d = r.lookTo - inp.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) < 0.015) r.lookTo = null;
        else inp.setLook(inp.yaw + d * Math.min(1, dt * 6), Math.min(inp.pitch, 0.3), inp.zoom);
      }
    }

    // delayed dialogue (finale / intro)
    if (r.pendingDialogue && r.t >= r.pendingDialogue.at && !r.dlg.open && !r.cam.active) {
      const id = r.pendingDialogue.id;
      r.pendingDialogue = null;
      r.dlg.start(id);
    }

    // intro start
    if (r.intro.autoStart >= 0 && !r.engine.s.introDone && r.visible) {
      r.intro.autoStart -= dt;
      if (r.intro.autoStart < 0 && !r.lighthouse.building) beginIntro(r);
      else if (r.intro.autoStart < 0) r.intro.autoStart = 0.1;
    }

    // UI overlays
    updateBangs(r, pp);
    updatePrompt(r);
    const sig = `${r.engine.s.step}:${JSON.stringify(r.engine.goalView())}`;
    if (sig !== r.lastGoalSig) {
      r.lastGoalSig = sig;
      r.gp.ui.refreshGoal();
      renderChip(r);
    }
  },

  dispose() {
    const r = R;
    if (!r) return;
    r.engine.flush();
    for (const d of r.disposers) d();
    r.dlg.dispose();
    for (const n of r.npcs.values()) n.dispose();
    for (const m of r.markers.values()) m.dispose();
    r.glim?.dispose();
    r.lighthouse.dispose();
    r.chip.remove();
    r.prompt.remove();
    r.title.remove();
    r.skip.remove();
    r.gp.ui.goalView = null;
    R = null;
  },
});

// ------------------------------------------------------------------------------------------------ quest / level tick

function tick(ctx: Ctx, silent = false): void {
  const r = R;
  if (!r) return;
  const res = r.engine.update();
  for (const lv of res.levelUps) onLevelUp(r, lv, silent);
  for (const step of res.completed) onStepDone(r, step, silent);
  // villagers move in
  for (const n of r.npcs.values()) {
    if (r.engine.present(n.def) && !n.present) {
      n.spawn();
      if (!silent && n.def.arrival.level > 0) startArrival(r, n);
    }
  }
  if (res.completed.length || res.levelUps.length) {
    r.gp.ui.refreshGoal();
    renderChip(r);
  }
  void ctx;
}

function onStepDone(r: Runtime, step: Step, silent: boolean): void {
  const { ui, store, sfx, fx } = r.gp;
  const chips: Array<{ icon: string; text: string }> = [];
  for (const [item, n] of Object.entries(step.reward)) {
    const added = store.add(item, n);
    if (added > 0) chips.push({ icon: itemIcon(item, undefined), text: `${added} ${ITEMS[item]?.name ?? item}` });
  }
  if (silent) return;
  ui.showBanner(step.free ? 'Village wish granted!' : 'Quest complete!', step.title, chips);
  ui.pulseGoal();
  sfx.play('fanfare');
  const p = r.ctx.game.player.pos;
  fx.sparkle(p.x, p.y + 1.2, p.z, [255, 214, 90], 26);
  const next = r.engine.step();
  if (next && !(step.id === 's10')) {
    window.setTimeout(() => {
      if (!R) return;
      const giver = NPCS.find((d) => d.id === next.giver);
      const gp2 = r.gp.ui;
      if (giver && next.intro && !r.engine.isTold(next.intro) && r.engine.stepOpen(next)) gp2.toast(`${giver.name.split(' ')[0]} has something for you! Look for the !`, { tone: 'love', dedupeMs: 0 });
      else gp2.toast(`New goal: ${next.title}`, { tone: 'good', dedupeMs: 0 });
    }, 2200);
  }
  if (next?.autoplay && next.intro) r.pendingDialogue = { id: next.intro, at: r.t + 4.5 };
  if (!next && step.id === 'w3') ui.toast('Every Village Wish granted!', { tone: 'love' });
}

function onLevelUp(r: Runtime, level: number, silent: boolean): void {
  renderChip(r, true);
  if (silent) return;
  const def = LEVELS.find((l) => l.level === level);
  if (!def) return;
  r.gp.ui.toast(def.toast ?? `Village level ${level}!`, { tone: 'love', dedupeMs: 0 });
  r.gp.sfx.play('fanfare');
  r.gp.ui.confetti(window.innerWidth / 2, 140, 28);
  if (level === 4) {
    r.lighthouse.setLit(true);
    spawnGlim(r);
    r.festivalUntil = r.t + 180;
  }
}

function startArrival(r: Runtime, n: Npc): void {
  // appear at the edge of the village and walk to the cottage
  const h = n.homePos;
  const dx = h.x - r.village.x;
  const dz = h.z - r.village.z;
  const d = Math.hypot(dx, dz) || 1;
  const sx = r.village.x + (dx / d) * 22;
  const sz = r.village.z + (dz / d) * 22;
  const spot = r.terrain.freeSpot(sx, sz, 6);
  const g = spot ?? { x: sx, z: sz, g: r.terrain.ground(sx, sz) };
  n.placeAt(g.x, g.z, g.g.h);
  n.gather = { x: h.x, z: h.z };
  r.arrivals.set(n.def.id, r.t);
  r.gp.fx.sparkle(g.x, g.g.h + 1, g.z, [255, 214, 90], 20);
  if (!hudVisible(r) || r.dlg.open || r.intro.active || r.cam.active) return;
  // short camera glance at the newcomer appearing at the edge of the village and walking in, then back
  const cam = window.__game.getCam();
  const ux = (h.x - g.x) / (Math.hypot(h.x - g.x, h.z - g.z) || 1);
  const uz = (h.z - g.z) / (Math.hypot(h.x - g.x, h.z - g.z) || 1);
  const tx = g.x + ux * 3;
  const tz = g.z + uz * 3;
  const th = g.g.h;
  const keys: Key[] = [
    { pos: [tx - uz * 5 - ux * 1.5, th + 2.2, tz + ux * 5 - uz * 1.5], target: [tx, th + 0.9, tz], t: 0.8, hold: 2.8 },
    { pos: cam.pos, target: cam.target, t: 0.8 },
  ];
  r.ctx.input.enabled = false;
  r.cam.play(keys, () => {
    if (!r.dlg.open && !r.gp.ui.panel && !r.intro.active) r.ctx.input.enabled = true;
  });
}

function spawnGlim(r: Runtime): void {
  if (r.glim) return;
  const g = r.terrain.ground(r.village.x, r.village.z);
  r.glim = new Marker('glim', { name: 'Glim', color: '#FFD35A', where: 'lighthouse', prompt: '', when: { kind: 'flag', flag: 'beacon_lit' } }, r.ctx.scene, r.village.x, g.h, r.village.z);
}

// ------------------------------------------------------------------------------------------------ interaction

type Hit = { kind: 'npc'; npc: Npc; d: number } | { kind: 'marker'; marker: Marker; d: number };

function nearestInteractable(r: Runtime): Hit | null {
  if (r.dlg.open || r.intro.active || r.cam.active) return null;
  const p = r.ctx.game.player.pos;
  let best: Hit | null = null;
  for (const n of r.npcs.values()) {
    if (!n.present || Math.abs(n.y - p.y) > 2.6) continue;
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d <= TALK_RANGE && (!best || d < best.d)) best = { kind: 'npc', npc: n, d };
  }
  for (const m of r.markers.values()) {
    if (!m.active || Math.abs(m.y - p.y) > 3.6) continue;
    const d = Math.hypot(m.x - p.x, m.z - p.z);
    if (d <= TALK_RANGE && (!best || d < best.d)) best = { kind: 'marker', marker: m, d };
  }
  return best;
}

function interact(r: Runtime): boolean {
  const h = nearestInteractable(r);
  if (!h) return false;
  if (h.kind === 'npc') talk(r, h.npc);
  else activateMarker(r, h.marker);
  return true;
}

function talk(r: Runtime, n: Npc): void {
  if (r.dlg.open) return;
  tick(r.ctx);
  const id = r.engine.conversationFor(n.def, r.ctx.env.hours);
  for (const o of r.npcs.values()) o.talking = o === n;
  const pl = r.ctx.game.player.pos;
  r.lookTo = Math.atan2(-(n.x - pl.x), -(n.z - pl.z)) - 0.5; // villager appears left of the avatar, not hidden behind it
  if (!r.dlg.start(id)) for (const o of r.npcs.values()) o.talking = false;
}

function activateMarker(r: Runtime, m: Marker): void {
  const { ui, sfx, fx, store } = r.gp;
  if (m.id === 'pedestal') {
    const lenses = ['lens_ripple', 'lens_whisper', 'lens_cheer'].filter((f) => r.engine.has(f)).length;
    if (lenses < 3) {
      r.dlg.start(r.engine.say('bram', `Still missing a lens or two (${lenses} of 3). They nap at the pond, in the forest and up on the highland.`));
      return;
    }
    if (store.count('cobble') < 10) {
      r.dlg.start(r.engine.say('bram', 'The pedestal needs 10 cobble to stay put. Break some stone and press C to craft cobble!'));
      return;
    }
    store.remove('cobble', 10);
    r.engine.s.lenses = 3;
    r.engine.setFlag('beacon_lit');
    m.active = false;
    sfx.play('fanfare');
    ui.toast('The three lenses are in place!', { tone: 'love', dedupeMs: 0 });
    fx.sparkle(m.x, m.y + 1.5, m.z, [255, 230, 140], 40);
    // look up at the lamp, then the festival dialogue starts (finale step autoplay)
    if (hudVisible(r)) {
      const cam = window.__game.getCam();
      const top = r.lighthouse.top;
      const s = r.lighthouse.site;
      const keys: Key[] = [
        { pos: [top.x - s.vx * 11, top.y - 3, top.z - s.vz * 11 + 5], target: [top.x, top.y, top.z], t: 1.2, hold: 3.2 },
        { pos: cam.pos, target: cam.target, t: 1.0 },
      ];
      r.ctx.input.enabled = false;
      r.cam.play(keys, () => {
        if (!r.dlg.open && !r.gp.ui.panel) r.ctx.input.enabled = true;
      });
    }
    r.dirty = true;
    tick(r.ctx);
    return;
  }
  const def = m.def;
  if (def.flag) {
    r.engine.setFlag(def.flag);
    m.active = false;
    sfx.play('fanfare');
    fx.sparkle(m.x, m.y + 1.2, m.z, m.rgb, 40);
    ui.showBanner('Lens found!', def.name, []);
    if (def.toast) ui.toast(def.toast, { tone: 'love', dedupeMs: 0 });
    r.dirty = true;
    tick(r.ctx);
  }
}

// ------------------------------------------------------------------------------------------------ markers

function markerSpot(r: Runtime, id: string): { x: number; y: number; z: number } | null {
  const cached = r.markerSpot.get(id);
  if (cached) return cached;
  const def = MARKERS[id];
  if (!def) return null;
  const info = r.ctx.game.world.info as any;
  let spot: { x: number; z: number; h: number } | null = null;
  if (def.where === 'lighthouse') {
    const [px, py, pz] = r.lighthouse.pedestal;
    spot = { x: px + 0.5, z: pz + 0.5, h: py + 1 };
  } else {
    let tx = r.village.x;
    let tz = r.village.z;
    if (def.where === 'pond' && info?.water?.pond) {
      const p = info.water.pond as { x: number; z: number; level: number };
      const dx = r.village.x - p.x;
      const dz = r.village.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      tx = p.x;
      tz = p.z;
      for (let s = 2; s < 60; s += 0.5) {
        const x = p.x + (dx / d) * s;
        const z = p.z + (dz / d) * s;
        if (r.terrain.ground(x, z).h > p.level + 0.3) {
          tx = x + (dx / d) * 1.2;
          tz = z + (dz / d) * 1.2;
          break;
        }
      }
    } else if (def.where === 'forest') {
      const list: number[][] = info?.habitats?.forest_floor ?? [];
      let best = Infinity;
      for (const h of list) {
        const d = Math.hypot(h[0]! - r.village.x, h[1]! - r.village.z);
        if (d < best) {
          best = d;
          tx = h[0]!;
          tz = h[1]!;
        }
      }
    } else if (def.where === 'highland' && info?.highland) {
      tx = info.highland[0];
      tz = info.highland[1];
    }
    const s = r.terrain.freeSpot(tx, tz, 14);
    if (s) spot = { x: s.x, z: s.z, h: s.g.h };
  }
  if (!spot) return null;
  const v = { x: spot.x, y: spot.h, z: spot.z };
  r.markerSpot.set(id, v);
  return v;
}

function syncMarkers(r: Runtime): void {
  for (const step of STEPS) {
    if (!step.marker) continue;
    const id = step.marker;
    const def = MARKERS[id]!;
    const idx = STEPS.indexOf(step);
    const done = id === 'pedestal' ? r.engine.has('beacon_lit') : def.flag ? r.engine.has(def.flag) : false;
    const want = !done && r.engine.s.step >= idx && r.engine.met(def.when);
    const have = r.markers.get(id);
    if (want && !have) {
      const spot = markerSpot(r, id);
      if (spot) r.markers.set(id, new Marker(id, def, r.ctx.scene, spot.x, spot.y, spot.z));
    } else if (!want && have) {
      have.dispose();
      r.markers.delete(id);
    }
  }
}

// ------------------------------------------------------------------------------------------------ overlays

function updateBangs(r: Runtime, pp: { x: number; y: number; z: number }): void {
  for (const n of r.npcs.values()) {
    const show = n.present && r.visible && !r.dlg.open && !r.intro.active && !r.cam.active && r.engine.hasBang(n.def);
    if (!show) {
      n.bang.style.display = 'none';
      continue;
    }
    const d = Math.hypot(n.x - pp.x, n.z - pp.z);
    const s = project(r.ctx, n.x, n.y + 1.62 + (n.excited ? 0.06 : 0), n.z);
    if (!s.on || d > 60 || s.x < 40 || s.y < 70 || s.x > window.innerWidth - 40 || s.y > window.innerHeight - 90) {
      n.bang.style.display = 'none';
      continue;
    }
    n.bang.style.display = 'grid';
    n.bang.style.transform = `translate(${s.x}px, ${s.y}px) scale(${Math.max(0.65, Math.min(1.15, 11 / (d + 5) + 0.45))})`;
  }
}

function updatePrompt(r: Runtime): void {
  const h = r.visible ? nearestInteractable(r) : null;
  if (!h) {
    r.prompt.style.display = 'none';
    return;
  }
  const text = h.kind === 'npc' ? `Talk to ${h.npc.def.name.split(' ')[0]}` : h.marker.def.prompt;
  const html = `<kbd>E</kbd><span>${text}</span>`;
  if (r.prompt.innerHTML !== html) r.prompt.innerHTML = html;
  r.prompt.style.display = 'flex';
}

function renderChip(r: Runtime, pop = false): void {
  const lvl = r.engine.level;
  const def = LEVELS.find((l) => l.level === lvl);
  const lens = [
    ['lens_ripple', '#59C8F0'],
    ['lens_whisper', '#7FE6A0'],
    ['lens_cheer', '#FFD35A'],
  ] as const;
  const html = `<div class="lv">${lvl}</div><div class="nm"><small>Village level</small>${def?.name ?? ''}</div><div class="pips">${[1, 2, 3, 4].map((i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}</div><div class="lens" title="Lenses">${lens
    .map(([f, c]) => `<i class="${r.engine.has(f) ? 'on' : ''}" style="${r.engine.has(f) ? `background:${c};color:${c}` : ''}"></i>`)
    .join('')}</div>`;
  if (r.chip.innerHTML !== html) r.chip.innerHTML = html;
  if (pop) {
    r.chip.classList.remove('pop');
    void r.chip.offsetWidth;
    r.chip.classList.add('pop');
  }
}

// ------------------------------------------------------------------------------------------------ intro

function beginIntro(r: Runtime): void {
  if (r.intro.active) return;
  const { ctx } = r;
  const pip = r.npcs.get('pip')!;
  r.engine.s.introDone = true;
  r.engine.flush();
  r.intro.active = true;
  ctx.input.enabled = false;
  try {
    document.exitPointerLock();
  } catch {
    /* ignore */
  }
  r.gp.ui.root.style.transition = 'opacity .6s';
  r.gp.ui.root.style.opacity = '0';
  r.title.classList.add('show');
  r.skip.classList.add('show');
  const top = r.lighthouse.top;
  const s = r.lighthouse.site;
  const pp = ctx.game.player.pos;
  // shot 1: from the sea side, looking up at the dim lamp; shot 2: around to the land side; shot 3: Pip on the green
  const seaX = -s.vx;
  const seaZ = -s.vz;
  const ph = r.terrain.ground(pip.x, pip.z).h;
  const toP = new Vector3(pp.x - pip.x, 0, pp.z - pip.z).normalize();
  const keys: Key[] = [
    { pos: [top.x + seaX * 24 - seaZ * 6, top.y - 7, top.z + seaZ * 24 + seaX * 6], target: [top.x, top.y - 1, top.z], t: 0.02, hold: 3.4 },
    { pos: [top.x + seaX * 15 + seaZ * 9, top.y - 4, top.z + seaZ * 15 - seaX * 9], target: [top.x, top.y - 1, top.z], t: 3.4, hold: 0.6 },
    { pos: [pip.x + toP.x * 4.4 + toP.z * 1.4, ph + 1.75, pip.z + toP.z * 4.4 - toP.x * 1.4], target: [pip.x, ph + 0.95, pip.z], t: 3.6, hold: 0.5 },
  ];
  window.setTimeout(() => r.title.classList.remove('show'), 3600);
  r.cam.play(keys, () => endIntro(r, true));
}

function endIntro(r: Runtime, finished: boolean): void {
  if (!r.intro.active) return;
  r.intro.active = false;
  r.title.classList.remove('show');
  r.skip.classList.remove('show');
  r.gp.ui.root.style.opacity = '1';
  if (r.cam.active) r.cam.release();
  else window.__game.setCam('game');
  r.ctx.input.enabled = !r.gp.ui.panel;
  const pip = r.npcs.get('pip');
  if (finished && pip && !r.dlg.open) {
    r.pendingDialogue = { id: 'pip.s1', at: r.t + 0.9 };
    pip.talking = true;
  }
}
