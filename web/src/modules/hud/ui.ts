/**
 * DOM layer of the gameplay HUD: chunky cream/ink paper-craft panels (ART_BIBLE section 8).
 * Hotbar, toasts, goal tracker + celebration, target label, break ring, companion chips, Workbench (C),
 * Glimmerdex (G) and the controls sheet (H / F1). No WebGL; ~40 DOM nodes at rest.
 */
import { GOALS, ITEMS, RECIPES, SPECIES_DEX, type Goal, type Recipe } from './data';
import { portraitSVG } from './icons';
import { HOTBAR, Store, TOTAL_SLOTS, dexKey } from './state';
import { TUNING } from './tuning';

export type PanelName = 'craft' | 'dex' | 'help' | null;

/** What the goal card shows when the story module drives the quest chain (see modules/story). */
export interface GoalView {
  label: string;
  badge: string;
  title: string;
  hint: string;
  progress: number;
  target: number;
  done?: boolean;
}

export interface UiHooks {
  icon(item: string): string;
  craft(recipeId: string): void;
  select(slot: number): void;
  swap(a: number, b: number): void;
  panelChanged(open: PanelName): void;
}

export interface CompanionChip {
  id: number;
  name: string;
  species: number;
  variant: number;
}

const CSS = /* css */ `
#gw-hud{pointer-events:none !important;--cream:#fff4dc;--paper:#fffaf0;--ink:#3a2a35;--ink2:#6b5560;--gold:#ffc94a;--coral:#ff7a6b;--mint:#58c46a;--sky:#6cc8e8;
  position:fixed;inset:0;z-index:30;font-family:'Nunito Variable','Nunito',system-ui,sans-serif;color:var(--ink);user-select:none;-webkit-user-select:none}
#gw-hud *{box-sizing:border-box}
#gw-hud .disp{font-family:'Fredoka Variable','Fredoka','Nunito Variable',system-ui,sans-serif;font-weight:600;letter-spacing:.01em}
.gw-card{background:linear-gradient(180deg,#fffaf0 0%,#fff1d6 100%);border:3px solid var(--ink);border-radius:18px;
  box-shadow:inset 0 2px 0 rgba(255,255,255,.9),inset 0 -3px 0 rgba(224,176,110,.35),0 3px 0 var(--ink),0 8px 0 rgba(58,42,53,.16),0 16px 28px rgba(40,20,60,.30)}
@keyframes gw-pop{0%{transform:scale(.92) translateY(8px);opacity:0}60%{transform:scale(1.02) translateY(-1px);opacity:1}100%{transform:scale(1) translateY(0);opacity:1}}
@keyframes gw-bump{0%{transform:translateY(-6px) scale(1)}40%{transform:translateY(-12px) scale(1.12)}100%{transform:translateY(-6px) scale(1)}}
@keyframes gw-toast{0%{transform:translateY(14px) scale(.9);opacity:0}12%{transform:translateY(0) scale(1.04);opacity:1}20%{transform:scale(1)}85%{opacity:1}100%{transform:translateY(-10px);opacity:0}}
@keyframes gw-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes gw-confetti{0%{transform:translate(0,0) rotate(0);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot));opacity:0}}
@keyframes gw-banner{0%{transform:translateX(-50%) translateY(-30px) scale(.8);opacity:0}14%{transform:translateX(-50%) translateY(0) scale(1.06);opacity:1}22%{transform:translateX(-50%) scale(1)}86%{opacity:1}100%{transform:translateX(-50%) translateY(-16px);opacity:0}}
@keyframes gw-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}

/* hotbar */
#gw-hotbar{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:7px;padding:9px 11px;pointer-events:auto}
.gw-slot{position:relative;width:58px;height:58px;border-radius:13px;border:3px solid var(--ink);background:linear-gradient(180deg,#fffdf6,#f6e6c4);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.95),inset 0 -3px 0 rgba(200,150,90,.28),0 2px 0 rgba(58,42,53,.85);cursor:pointer;transition:transform .12s cubic-bezier(.3,1.6,.5,1),box-shadow .12s}
.gw-slot:hover{transform:translateY(-3px)}
.gw-slot.sel{transform:translateY(-6px);border-color:var(--ink);background:linear-gradient(180deg,#fff3b8,#ffd96b);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.95),0 0 0 3px var(--gold),0 0 0 6px var(--ink),0 10px 14px rgba(40,20,60,.3)}
.gw-slot.bump{animation:gw-bump .32s ease-out}
.gw-slot img{position:absolute;left:50%;top:50%;width:46px;height:46px;transform:translate(-50%,-50%);image-rendering:auto;pointer-events:none;filter:drop-shadow(0 1px 0 rgba(255,255,255,.4))}
.gw-slot .k{position:absolute;left:5px;top:2px;font:600 11px 'Fredoka Variable',sans-serif;color:var(--ink2);opacity:.85}
.gw-slot .n{position:absolute;right:4px;bottom:1px;font:700 15px 'Fredoka Variable',sans-serif;color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill;text-shadow:0 2px 0 var(--ink)}
.gw-slot.sel .k{color:var(--ink)}
#gw-heldname{position:absolute;left:50%;bottom:98px;transform:translateX(-50%);padding:3px 14px;border-radius:12px;font-size:16px;white-space:nowrap;
  opacity:0;transition:opacity .25s;background:var(--ink);color:var(--cream);border:2px solid var(--ink)}
#gw-heldname.show{opacity:1}

/* toasts */
#gw-toasts{position:absolute;left:50%;bottom:150px;transform:translateX(-50%);display:flex;flex-direction:column-reverse;align-items:center;gap:6px}
.gw-toast{display:flex;align-items:center;gap:9px;padding:6px 15px 6px 8px;border-radius:999px;font-size:17px;white-space:nowrap;animation:gw-toast 2.6s ease-out forwards}
.gw-toast img{width:30px;height:30px}
.gw-toast.good{background:linear-gradient(180deg,#fffbe6,#ffe9a0)}
.gw-toast.warn{background:linear-gradient(180deg,#fff4ec,#ffd2c4)}
.gw-toast.love{background:linear-gradient(180deg,#fff0f6,#ffc4dc)}
.gw-toast .dot{width:12px;height:12px;border-radius:50%;background:var(--gold);border:2px solid var(--ink);margin:0 2px 0 6px}

/* goal tracker */
#gw-goal{position:absolute;left:16px;top:16px;width:292px;padding:11px 14px 12px 12px;animation:gw-pop .4s ease-out}
#gw-goal .top{display:flex;align-items:center;gap:9px}
#gw-goal .star{flex:none;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:var(--gold);border:3px solid var(--ink);font-size:17px;box-shadow:inset 0 2px 0 rgba(255,255,255,.8)}
#gw-goal .lbl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink2)}
#gw-goal .ttl{font-size:19px;line-height:1.1}
#gw-goal .bar{height:15px;margin-top:9px;border-radius:9px;border:3px solid var(--ink);background:#f1dfba;overflow:hidden;box-shadow:inset 0 2px 0 rgba(0,0,0,.12)}
#gw-goal .bar i{display:block;height:100%;width:0;border-radius:6px;background:linear-gradient(180deg,#8ee08a,#4fbf63);box-shadow:inset 0 2px 0 rgba(255,255,255,.55);transition:width .35s cubic-bezier(.3,1.4,.5,1)}
#gw-goal .num{position:absolute;right:16px;top:14px;font-size:14px;color:var(--ink2)}
#gw-goal .hint{margin-top:7px;font-size:13px;line-height:1.25;color:var(--ink2);font-weight:600}
#gw-goal.done .bar i{background:linear-gradient(180deg,#ffe27a,#ffbf2e)}
#gw-goal.pulse{animation:gw-pulse .4s ease-out}

/* banner + confetti */
#gw-banner{position:absolute;left:50%;top:70px;transform:translateX(-50%);padding:12px 26px 13px;text-align:center;min-width:300px;display:none}
#gw-banner.show{display:block;animation:gw-banner 4.2s ease-out forwards}
#gw-banner .b1{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink2)}
#gw-banner .b2{font-size:27px;line-height:1.1;margin-top:1px}
#gw-banner .b3{margin-top:6px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;font-size:14px}
#gw-banner .chip{display:flex;align-items:center;gap:4px;padding:2px 9px 2px 3px;border-radius:99px;background:#fff;border:2px solid var(--ink)}
#gw-banner .chip img{width:22px;height:22px}
.gw-confetti{position:absolute;width:9px;height:14px;border-radius:2px;border:2px solid var(--ink);animation:gw-confetti 1.5s ease-out forwards;pointer-events:none}

/* world labels */
#gw-target{position:absolute;left:0;top:0;transform:translate(-50%,-150%);padding:2px 11px;border-radius:11px;font-size:14px;white-space:nowrap;display:none;background:var(--ink);color:var(--cream);border:2px solid var(--ink);box-shadow:0 3px 0 rgba(0,0,0,.25)}
#gw-target small{font-weight:600;opacity:.75;margin-left:6px;font-size:12px}
#gw-ring{position:absolute;left:0;top:0;width:64px;height:64px;transform:translate(-50%,-50%);display:none}
#gw-ring circle{fill:none;stroke-linecap:round}
#gw-dot{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--cream);border:2px solid var(--ink);opacity:.9;display:none}

/* companions + hints */
#gw-pals{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column-reverse;gap:8px}
.gw-pal{display:flex;align-items:center;gap:8px;padding:4px 14px 4px 5px;border-radius:99px;animation:gw-pop .4s ease-out}
.gw-pal .pic{width:42px;height:42px;border-radius:50%;background:#fff;border:3px solid var(--ink);overflow:hidden;display:grid;place-items:center}
.gw-pal .pic svg{width:36px;height:36px}
.gw-pal b{font-size:16px;display:block;line-height:1}
.gw-pal span{font-size:12px;color:var(--ink2);font-weight:700}
#gw-keys{position:absolute;right:14px;top:16px;display:flex;gap:8px;pointer-events:auto}
.gw-key{padding:5px 11px 5px 6px;border-radius:12px;font-size:14px;cursor:pointer;display:flex;align-items:center;gap:7px;transition:transform .12s}
.gw-key:hover{transform:translateY(-2px)}
.gw-key kbd{font:600 13px 'Fredoka Variable',sans-serif;min-width:24px;height:24px;display:grid;place-items:center;border-radius:7px;background:var(--ink);color:var(--cream);padding:0 6px}

/* panels */
#gw-scrim{position:absolute;inset:0;background:rgba(40,24,60,.45);display:none;pointer-events:auto;backdrop-filter:blur(2px)}
.gw-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(940px,94vw);max-height:92vh;overflow:auto;padding:18px 20px 20px;display:none;pointer-events:auto}
.gw-panel.open{display:block;animation:gw-pop .26s ease-out}
.gw-panel .hd{display:flex;align-items:center;gap:12px;margin:-4px 0 12px}
.gw-panel .hd h2{margin:0;font-size:28px}
.gw-panel .hd .sub{color:var(--ink2);font-weight:700;font-size:14px}
.gw-x{margin-left:auto;width:36px;height:36px;border-radius:50%;border:3px solid var(--ink);background:var(--coral);color:#fff;font:700 18px 'Fredoka Variable',sans-serif;cursor:pointer;box-shadow:0 3px 0 var(--ink);transition:transform .1s}
.gw-x:active{transform:translateY(3px);box-shadow:none}
.gw-btn{border:3px solid var(--ink);border-radius:12px;padding:5px 16px;font:600 16px 'Fredoka Variable',sans-serif;background:linear-gradient(180deg,#8ee08a,#4fbf63);color:var(--ink);cursor:pointer;box-shadow:0 3px 0 var(--ink);transition:transform .08s,box-shadow .08s}
.gw-btn:active{transform:translateY(3px);box-shadow:0 0 0 var(--ink)}
.gw-btn[disabled]{background:#e8dcc4;color:#a39080;cursor:not-allowed;box-shadow:0 3px 0 rgba(58,42,53,.45);border-color:rgba(58,42,53,.5)}

/* workbench */
#gw-craft .cols{display:flex;gap:22px;flex-wrap:wrap}
#gw-craft .recipes{flex:1 1 330px;display:flex;flex-direction:column;gap:7px;min-width:300px}
.gw-rec{display:flex;align-items:center;gap:11px;padding:4px 10px;border-radius:14px;border:3px solid var(--ink);background:#fffdf6;box-shadow:0 3px 0 rgba(58,42,53,.2)}
.gw-rec.ok{background:#f1ffe9}
.gw-rec .out{position:relative;width:46px;height:46px;flex:none;border-radius:11px;background:#fff1d0;border:3px solid var(--ink)}
.gw-rec .out img{position:absolute;inset:1px;width:38px;height:38px}
.gw-rec .out b{position:absolute;right:2px;bottom:-3px;font:700 14px 'Fredoka Variable';color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill}
.gw-rec .nm{font-size:17px;line-height:1.1}
.gw-rec .needs{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px}
.gw-rec .need{display:flex;align-items:center;gap:2px;font-size:13px;font-weight:800;padding:0 7px 0 1px;border-radius:99px;background:#fff;border:2px solid var(--ink)}
.gw-rec .need img{width:20px;height:20px}
.gw-rec .need.no{background:#ffe0d8;color:#b04030}
.gw-rec .go{margin-left:auto}
#gw-craft .pack{flex:0 0 auto}
#gw-craft .pack h3{margin:0 0 6px;font-size:16px;color:var(--ink2);font-weight:600}
.gw-grid{display:grid;grid-template-columns:repeat(10,46px);gap:5px;margin-bottom:12px}
.gw-grid .gw-slot{width:46px;height:46px;border-radius:10px;border-width:2.5px}
.gw-grid .gw-slot img{width:36px;height:36px}
.gw-grid .gw-slot .n{font-size:12px}
.gw-grid .gw-slot.pick{outline:3px dashed var(--coral);outline-offset:2px}
.gw-tip{font-size:13px;color:var(--ink2);font-weight:700;max-width:480px}

/* dex */
#gw-dex .cols{display:flex;gap:22px;flex-wrap:wrap}
#gw-dex.gw-panel{width:min(860px,94vw)}
#gw-help.gw-panel{width:min(620px,94vw)}
#gw-dex .rows{flex:1 1 440px;display:flex;flex-direction:column;gap:12px}
.gw-sp{display:flex;align-items:center;gap:10px}
.gw-sp .lab{width:92px;font-size:18px}
.gw-sp .lab small{display:block;font:700 12px 'Nunito Variable';color:var(--ink2)}
.gw-vc{position:relative;width:104px;height:122px;border-radius:15px;border:3px solid var(--ink);background:linear-gradient(180deg,#fffdf6,#f6e8c8);cursor:pointer;text-align:center;
  box-shadow:inset 0 2px 0 #fff,0 3px 0 rgba(58,42,53,.85);transition:transform .12s cubic-bezier(.3,1.6,.5,1)}
.gw-vc:hover{transform:translateY(-3px) rotate(-1deg)}
.gw-vc.sel{box-shadow:0 0 0 3px var(--gold),0 0 0 6px var(--ink);transform:translateY(-3px)}
.gw-vc.new{animation:gw-pulse 1.2s ease-in-out infinite}
.gw-vc .pic{height:84px;padding:6px 8px 0}
.gw-vc .pic svg{width:100%;height:100%}
.gw-vc .nm{font-size:14px;margin-top:-2px}
.gw-vc .q{position:absolute;left:0;right:0;top:26px;font:700 30px 'Fredoka Variable';color:#fff;-webkit-text-stroke:4px #5a4868;paint-order:stroke fill;opacity:.95}
.gw-vc .heart{position:absolute;right:-8px;top:-9px;width:26px;height:26px;border-radius:50%;background:#ff7aa5;border:3px solid var(--ink);color:#fff;font-size:13px;display:grid;place-items:center}
#gw-dex .detail{flex:0 0 270px;padding:14px;border-radius:16px;border:3px solid var(--ink);background:#fffdf6;min-height:330px}
#gw-dex .detail .pic{height:130px;display:grid;place-items:center;border-radius:12px;background:linear-gradient(180deg,#d6f1ff,#f4ecff);border:2px solid var(--ink);margin-bottom:9px}
#gw-dex .detail .pic svg{height:118px}
#gw-dex .detail h3{margin:0;font-size:24px;line-height:1}
#gw-dex .detail dl{margin:8px 0 0;font-size:14px;font-weight:700}
#gw-dex .detail dt{color:var(--ink2);font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-top:6px}
#gw-dex .detail dd{margin:0;display:flex;align-items:center;gap:6px}
#gw-dex .detail dd img{width:24px;height:24px}
#gw-dex .detail p{margin:8px 0 0;font-size:13px;color:var(--ink2);font-weight:600;line-height:1.3}

/* help */
#gw-help .ctl{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;align-items:center;font-size:16px;font-weight:700}
#gw-help .ctl kbd{font:600 14px 'Fredoka Variable',sans-serif;padding:3px 9px;border-radius:8px;background:var(--ink);color:var(--cream);justify-self:end;white-space:nowrap}
#gw-help h3{margin:12px 0 4px;font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);font-weight:600}
@media (max-width:820px){.gw-slot{width:44px;height:44px}.gw-slot img{width:34px;height:34px}#gw-hotbar{gap:4px;padding:6px 7px}#gw-goal{width:220px}.gw-grid{grid-template-columns:repeat(10,30px)}.gw-grid .gw-slot{width:30px;height:30px}.gw-grid .gw-slot img{width:24px;height:24px}}
`;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class HudUi {
  readonly root: HTMLElement;
  private hotbar!: HTMLElement;
  private heldName!: HTMLElement;
  private toasts!: HTMLElement;
  private goal!: HTMLElement;
  private banner!: HTMLElement;
  private target!: HTMLElement;
  private ring!: SVGSVGElement;
  private ringArc!: SVGCircleElement;
  private pals!: HTMLElement;
  private scrim!: HTMLElement;
  private craft!: HTMLElement;
  private dex!: HTMLElement;
  private help!: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private shownSlots: string[] = [];
  private heldTimer = 0;
  private pick = -1;
  private dexSel = '0:0';
  private newDex = new Set<string>();
  private open: PanelName = null;
  private lastToast = '';
  private lastToastAt = 0;
  /** set by the story module: replaces the starter-goal card with the quest chain */
  goalView: (() => GoalView | null) | null = null;

  constructor(host: HTMLElement, private readonly store: Store, private readonly hooks: UiHooks) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.id = 'gw-hud';
    this.root.innerHTML = `
      <div id="gw-goal" class="gw-card"></div>
      <div id="gw-banner" class="gw-card disp"></div>
      <div id="gw-target" class="disp"></div>
      <svg id="gw-ring" viewBox="0 0 64 64"><circle cx="32" cy="32" r="22" stroke="rgba(58,42,53,.55)" stroke-width="9"/><circle id="gw-arc" cx="32" cy="32" r="22" stroke="#ffd44a" stroke-width="6" transform="rotate(-90 32 32)" stroke-dasharray="138.2" stroke-dashoffset="138.2"/></svg>
      <div id="gw-pals"></div>
      <div id="gw-toasts"></div>
      <div id="gw-heldname" class="disp"></div>
      <div id="gw-hotbar" class="gw-card"></div>
      <div id="gw-keys">
        <div class="gw-key gw-card disp" data-p="craft"><kbd>C</kbd>Workbench</div>
        <div class="gw-key gw-card disp" data-p="dex"><kbd>G</kbd>Glimmerdex</div>
        <div class="gw-key gw-card disp" data-p="help"><kbd>H</kbd>Help</div>
      </div>
      <div id="gw-scrim"></div>
      <div id="gw-craft" class="gw-panel gw-card"></div>
      <div id="gw-dex" class="gw-panel gw-card"></div>
      <div id="gw-help" class="gw-panel gw-card"></div>`;
    host.append(this.root);
    const q = <T extends Element>(id: string) => this.root.querySelector<T>(id)!;
    this.hotbar = q('#gw-hotbar');
    this.heldName = q('#gw-heldname');
    this.toasts = q('#gw-toasts');
    this.goal = q('#gw-goal');
    this.banner = q('#gw-banner');
    this.target = q('#gw-target');
    this.ring = q<SVGSVGElement>('#gw-ring');
    this.ringArc = q<SVGCircleElement>('#gw-arc');
    this.pals = q('#gw-pals');
    this.scrim = q('#gw-scrim');
    this.craft = q('#gw-craft');
    this.dex = q('#gw-dex');
    this.help = q('#gw-help');
    this.scrim.addEventListener('pointerdown', () => this.setPanel(null));
    for (const k of this.root.querySelectorAll<HTMLElement>('.gw-key')) k.addEventListener('click', () => this.togglePanel(k.dataset.p as PanelName));
    this.buildHotbar();
    this.buildHelp();
    this.refreshGoal();
    this.refresh();
  }

  get panel(): PanelName {
    return this.open;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  // ------------------------------------------------------------------ hotbar

  private buildHotbar(): void {
    this.hotbar.innerHTML = '';
    this.slotEls = [];
    for (let i = 0; i < HOTBAR; i++) {
      const d = document.createElement('div');
      d.className = 'gw-slot';
      d.innerHTML = `<span class="k">${(i + 1) % 10}</span>`;
      d.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.hooks.select(i);
      });
      this.hotbar.append(d);
      this.slotEls.push(d);
    }
  }

  /** re-render slots whose content changed, selection, goal bar */
  refresh(): void {
    for (let i = 0; i < HOTBAR; i++) {
      const s = this.store.slots[i];
      const sig = `${s?.item ?? ''}:${s?.n ?? 0}`;
      const el = this.slotEls[i]!;
      el.classList.toggle('sel', i === this.store.selected);
      if (this.shownSlots[i] === sig) continue;
      const prev = this.shownSlots[i];
      this.shownSlots[i] = sig;
      el.querySelectorAll('img,.n').forEach((n) => n.remove());
      if (s) {
        el.insertAdjacentHTML('beforeend', `<img src="${this.hooks.icon(s.item)}" alt="${esc(ITEMS[s.item]?.name ?? '')}"/>${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}`);
        if (prev !== undefined && prev !== sig) this.bump(i);
      }
    }
    this.showHeldName();
    this.refreshGoal();
    if (this.open === 'craft') this.renderCraft();
  }

  bump(i: number): void {
    const el = this.slotEls[i];
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  shakeHotbar(): void {
    this.hotbar.style.animation = 'none';
    void this.hotbar.offsetWidth;
    this.hotbar.style.animation = 'gw-shake .25s';
  }

  private showHeldName(): void {
    const s = this.store.held;
    this.heldName.textContent = s ? ITEMS[s.item]?.name ?? '' : '';
    this.heldName.classList.toggle('show', !!s);
    window.clearTimeout(this.heldTimer);
    this.heldTimer = window.setTimeout(() => this.heldName.classList.remove('show'), 1800);
  }

  // ------------------------------------------------------------------ toasts / banners

  toast(text: string, opts: { icon?: string; tone?: 'good' | 'warn' | 'love'; dedupeMs?: number } = {}): void {
    const now = performance.now();
    if (text === this.lastToast && now - this.lastToastAt < (opts.dedupeMs ?? 1200)) return;
    this.lastToast = text;
    this.lastToastAt = now;
    const t = document.createElement('div');
    t.className = `gw-toast gw-card disp ${opts.tone ?? 'good'}`;
    t.style.animationDuration = `${TUNING.toastMs}ms`;
    t.innerHTML = `${opts.icon ? `<img src="${opts.icon}" alt=""/>` : '<span class="dot"></span>'}<span>${esc(text)}</span>`;
    this.toasts.prepend(t);
    while (this.toasts.children.length > TUNING.toastMax) this.toasts.lastElementChild?.remove();
    window.setTimeout(() => t.remove(), TUNING.toastMs + 80);
  }

  showBanner(kicker: string, title: string, chips: Array<{ icon: string; text: string }> = []): void {
    this.banner.innerHTML = `<div class="b1">${esc(kicker)}</div><div class="b2">${esc(title)}</div>${
      chips.length ? `<div class="b3">${chips.map((c) => `<span class="chip"><img src="${c.icon}" alt=""/>${esc(c.text)}</span>`).join('')}</div>` : ''
    }`;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this.confetti(window.innerWidth / 2, 130, 34);
  }

  confetti(x: number, y: number, n = 24): void {
    const colors = ['#ffc94a', '#ff7a6b', '#58c46a', '#6cc8e8', '#ff9ad2', '#b9a6ff'];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('i');
      c.className = 'gw-confetti';
      const a = Math.random() * Math.PI * 2;
      const r = 90 + Math.random() * 220;
      c.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r * 0.7 + 120}px;--rot:${Math.random() * 720 - 360}deg;animation-delay:${Math.random() * 0.15}s`;
      this.root.append(c);
      window.setTimeout(() => c.remove(), 1900);
    }
  }

  // ------------------------------------------------------------------ goal

  refreshGoal(): void {
    if (this.goalView) {
      const v = this.goalView();
      if (v) {
        this.goal.classList.toggle('done', !!v.done);
        const p = Math.min(v.target, v.progress);
        this.goal.innerHTML = `<div class="top"><div class="star">${esc(v.badge)}</div><div><div class="lbl">${esc(v.label)}</div><div class="ttl disp">${esc(v.title)}</div></div></div>
      ${v.target > 1 ? `<div class="num disp">${p} / ${v.target}</div><div class="bar"><i style="width:${(100 * p) / v.target}%"></i></div>` : ''}<div class="hint">${esc(v.hint)}</div>`;
        return;
      }
    }
    const g: Goal | null = this.store.goal;
    if (!g) {
      this.goal.classList.add('done');
      this.goal.innerHTML = `<div class="top"><div class="star">★</div><div><div class="lbl">All starter goals</div><div class="ttl disp">Wonderful! You did it all.</div></div></div><div class="hint">Keep exploring, building and making friends. More goals soon.</div>`;
      return;
    }
    this.goal.classList.remove('done');
    const p = Math.min(g.target, this.store.goalProgress(g));
    this.goal.innerHTML = `<div class="top"><div class="star">${this.store.goalIndex + 1}</div><div><div class="lbl">Goal ${this.store.goalIndex + 1} of ${GOALS.length}</div><div class="ttl disp">${esc(g.title)}</div></div></div>
      <div class="num disp">${p} / ${g.target}</div><div class="bar"><i style="width:${(100 * p) / g.target}%"></i></div><div class="hint">${esc(g.hint)}</div>`;
  }

  pulseGoal(): void {
    this.goal.classList.remove('pulse');
    void this.goal.offsetWidth;
    this.goal.classList.add('pulse');
  }

  // ------------------------------------------------------------------ world-anchored labels

  setTarget(show: boolean, x = 0, y = 0, text = '', hint = ''): void {
    show = show && !this.banner.classList.contains('show');
    this.target.style.display = show ? 'block' : 'none';
    if (!show) return;
    this.target.style.transform = `translate(${x}px, ${y}px) translate(-50%,-190%)`;
    const html = `${esc(text)}${hint ? `<small>${esc(hint)}</small>` : ''}`;
    if (this.target.innerHTML !== html) this.target.innerHTML = html;
  }

  setRing(show: boolean, progress = 0, x = 0, y = 0): void {
    this.ring.style.display = show ? 'block' : 'none';
    if (!show) return;
    this.ring.style.left = `${x}px`;
    this.ring.style.top = `${y}px`;
    this.ringArc.setAttribute('stroke-dashoffset', String(138.2 * (1 - Math.min(1, progress))));
  }

  // ------------------------------------------------------------------ companions

  setCompanions(list: CompanionChip[]): void {
    this.pals.innerHTML = list
      .map((c) => {
        const sp = SPECIES_DEX[c.species];
        const v = sp?.variants[c.variant];
        return `<div class="gw-pal gw-card"><div class="pic">${sp && v ? portraitSVG(c.species, v) : ''}</div><div><b class="disp">${esc(c.name)}</b><span>${esc(sp?.name ?? '')} · friend</span></div></div>`;
      })
      .join('');
  }

  markNewDex(species: number, variant: number): void {
    this.newDex.add(dexKey(species, variant));
    if (this.open === 'dex') this.renderDex();
  }

  // ------------------------------------------------------------------ panels

  togglePanel(p: PanelName): void {
    this.setPanel(this.open === p ? null : p);
  }

  setPanel(p: PanelName): void {
    this.open = p;
    this.scrim.style.display = p ? 'block' : 'none';
    for (const [name, el] of [['craft', this.craft], ['dex', this.dex], ['help', this.help]] as const) el.classList.toggle('open', p === name);
    if (p === 'craft') {
      this.pick = -1;
      this.renderCraft();
    }
    if (p === 'dex') {
      const pick = Object.entries(this.store.dex).find(([, e]) => e.friend) ?? Object.entries(this.store.dex).find(([, e]) => e.seen);
      if (pick && !this.store.dex[this.dexSel]?.seen) this.dexSel = pick[0];
      this.newDex.clear();
      this.renderDex();
    }
    this.hooks.panelChanged(p);
  }

  private closeButton(): HTMLElement {
    const b = document.createElement('button');
    b.className = 'gw-x';
    b.textContent = '×';
    b.setAttribute('aria-label', 'Close');
    b.addEventListener('click', () => this.setPanel(null));
    return b;
  }

  private recipeCard(r: Recipe): HTMLElement {
    const ok = Object.entries(r.needs).every(([k, n]) => this.store.count(k) >= n);
    const out = ITEMS[r.out]!;
    const d = document.createElement('div');
    d.className = `gw-rec${ok ? ' ok' : ''}`;
    d.innerHTML = `<div class="out"><img src="${this.hooks.icon(r.out)}" alt=""/><b>${r.n}</b></div>
      <div><div class="nm disp">${esc(out.name)}</div><div class="needs">${Object.entries(r.needs)
        .map(([k, n]) => `<span class="need${this.store.count(k) >= n ? '' : ' no'}"><img src="${this.hooks.icon(k)}" alt=""/>${this.store.count(k)}/${n}</span>`)
        .join('')}</div></div>`;
    const b = document.createElement('button');
    b.className = 'gw-btn go';
    b.textContent = 'Make';
    b.disabled = !ok;
    b.addEventListener('click', () => this.hooks.craft(r.id));
    d.append(b);
    return d;
  }

  private slotCell(i: number): HTMLElement {
    const s = this.store.slots[i];
    const d = document.createElement('div');
    d.className = `gw-slot${i === this.store.selected ? ' sel' : ''}${i === this.pick ? ' pick' : ''}`;
    d.innerHTML = `${i < HOTBAR ? `<span class="k">${(i + 1) % 10}</span>` : ''}${s ? `<img src="${this.hooks.icon(s.item)}" alt="${esc(ITEMS[s.item]?.name ?? '')}" title="${esc(ITEMS[s.item]?.name ?? '')}"/>${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}` : ''}`;
    d.addEventListener('click', () => {
      if (this.pick < 0) {
        if (s) this.pick = i;
      } else {
        if (this.pick !== i) this.hooks.swap(this.pick, i);
        this.pick = -1;
      }
      this.renderCraft();
    });
    return d;
  }

  renderCraft(): void {
    const p = this.craft;
    p.innerHTML = `<div class="hd"><h2 class="disp">Workbench</h2><span class="sub">Make things from what you gather</span></div><div class="cols"><div class="recipes"></div><div class="pack"><h3 class="disp">Hotbar</h3><div class="gw-grid h"></div><h3 class="disp">Backpack</h3><div class="gw-grid b"></div><div class="gw-tip">Tap a slot, then another, to swap them. Items in the hotbar can be used with keys 1-0.</div></div></div>`;
    p.querySelector('.hd')!.append(this.closeButton());
    const rec = p.querySelector('.recipes')!;
    for (const r of RECIPES) rec.append(this.recipeCard(r));
    const h = p.querySelector('.gw-grid.h')!;
    const b = p.querySelector('.gw-grid.b')!;
    for (let i = 0; i < TOTAL_SLOTS; i++) (i < HOTBAR ? h : b).append(this.slotCell(i));
  }

  renderDex(): void {
    const p = this.dex;
    const total = SPECIES_DEX.reduce((a, s) => a + s.variants.length, 0);
    p.innerHTML = `<div class="hd"><h2 class="disp">Glimmerdex</h2><span class="sub">${this.store.dexSeenCount()} / ${total} found · ${this.store.dexFriendCount()} friends</span></div><div class="cols"><div class="rows"></div><div class="detail"></div></div>`;
    p.querySelector('.hd')!.append(this.closeButton());
    const rows = p.querySelector('.rows')!;
    for (const sp of SPECIES_DEX) {
      const row = document.createElement('div');
      row.className = 'gw-sp';
      row.innerHTML = `<div class="lab disp">${esc(sp.name)}<small>${esc(sp.personality)}</small></div>`;
      sp.variants.forEach((v, vi) => {
        const k = dexKey(sp.id, vi);
        const e = this.store.dex[k];
        const seen = !!e?.seen;
        const c = document.createElement('div');
        c.className = `gw-vc${this.dexSel === k ? ' sel' : ''}${this.newDex.has(k) ? ' new' : ''}`;
        c.innerHTML = `<div class="pic">${portraitSVG(sp.id, v, !seen)}</div>${seen ? '' : '<div class="q">?</div>'}<div class="nm disp">${seen ? esc(v.name) : '???'}</div>${e?.friend ? '<div class="heart">♥</div>' : ''}`;
        c.addEventListener('click', () => {
          this.dexSel = k;
          this.renderDex();
        });
        row.append(c);
      });
      rows.append(row);
    }
    const [ss, vs] = this.dexSel.split(':').map(Number) as [number, number];
    const sp = SPECIES_DEX[ss]!;
    const v = sp.variants[vs]!;
    const e = this.store.dex[this.dexSel];
    const seen = !!e?.seen;
    const fav = ITEMS[sp.favourite];
    const det = p.querySelector('.detail')!;
    det.innerHTML = seen
      ? `<div class="pic">${portraitSVG(sp.id, v)}</div><h3 class="disp">${esc(v.name)} ${esc(sp.name)}</h3>
         <dl><dt>Personality</dt><dd>${esc(sp.personality)}</dd><dt>Lives in</dt><dd>${esc(sp.habitat)}</dd>
         <dt>Favourite treat</dt><dd><img src="${this.hooks.icon(sp.favourite)}" alt=""/>${esc(fav?.name ?? '')}</dd>
         <dt>Friendship</dt><dd>${e?.friend ? `♥ Friends with ${esc(e.names.join(', '))}` : 'Not yet. Offer a treat!'}</dd></dl>
         <p>${esc(sp.blurb)} ${esc(sp.tip)}</p>`
      : `<div class="pic">${portraitSVG(sp.id, v, true)}</div><h3 class="disp">???</h3><p>You have not met this Glimmer yet. Explore ${esc(sp.habitat.toLowerCase())} to find a ${esc(sp.name)}.</p>`;
  }

  private buildHelp(): void {
    const rows: Array<[string, string]> = [
      ['W A S D', 'Walk (Shift to run)'],
      ['Space', 'Jump'],
      ['Mouse', 'Look around (click the game to capture it)'],
      ['Hold F / left click', 'Break the block you are looking at'],
      ['X / right click', 'Place the block you are holding'],
      ['1 - 0 / mouse wheel', 'Choose a hotbar slot (Shift + wheel zooms)'],
      ['E', 'Talk to villagers, pick things up, or offer a treat to a nearby Glimmer'],
      ['C', 'Workbench: craft & rearrange your pack'],
      ['G', 'Glimmerdex: the Glimmers you met'],
      ['H / F1', 'This help'],
      ['Esc', 'Close a window'],
    ];
    const pad: Array<[string, string]> = [
      ['Left stick / right stick', 'Move / look'],
      ['A', 'Jump'],
      ['Right trigger / D-pad down', 'Break / place'],
      ['L1 / R1', 'Previous / next hotbar slot'],
      ['X', 'Offer a treat'],
      ['D-pad left / right', 'Workbench / Glimmerdex'],
    ];
    const list = (r: Array<[string, string]>) => r.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join('');
    this.help.innerHTML = `<div class="hd"><h2 class="disp">How to play</h2><span class="sub">Gather, build, make friends</span></div>
      <div class="ctl">${list(rows)}</div><h3 class="disp">Gamepad</h3><div class="ctl">${list(pad)}</div>`;
    this.help.querySelector('.hd')!.append(this.closeButton());
  }
}
