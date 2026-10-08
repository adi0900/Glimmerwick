/**
 * Paper-craft dialogue box (same cream/ink language as hud/ui.ts): speaker tab, typewriter text (~40 chars/s, tap to
 * finish), up to two friendly choice buttons, E / Space / Enter / click to advance, Esc to close.
 * Lives inside the HUD root (#gw-hud) so it shares the CSS variables and the font stack.
 */
import type { DialogueNode } from './engine';

const CSS = /* css */ `
#gw-dlg{position:absolute;left:50%;bottom:26px;transform:translateX(-50%) translateY(30px);width:min(780px,92vw);padding:30px 24px 16px 24px;pointer-events:auto;
  opacity:0;visibility:hidden;transition:opacity .18s,transform .22s cubic-bezier(.3,1.5,.5,1),visibility 0s .22s;cursor:pointer;z-index:5}
#gw-dlg.open{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);transition:opacity .18s,transform .22s cubic-bezier(.3,1.5,.5,1)}
#gw-dlg .tab{position:absolute;left:22px;top:-22px;display:flex;align-items:center;gap:9px;padding:4px 18px 5px 5px;border-radius:999px;border:3px solid var(--ink);
  background:linear-gradient(180deg,var(--tint,#ffc94a),color-mix(in srgb,var(--tint,#ffc94a) 78%,#fff));box-shadow:inset 0 2px 0 rgba(255,255,255,.7),0 3px 0 var(--ink);font-size:22px;color:var(--ink)}
#gw-dlg .tab .ini{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#fffaf0;border:3px solid var(--ink);font-size:18px}
#gw-dlg .tab small{font:700 11px 'Nunito Variable',sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:.7;margin-left:2px}
#gw-dlg .txt{min-height:58px;font-size:25px;line-height:1.28;font-weight:700;color:var(--ink);padding:2px 6px 0}
#gw-dlg .txt.glim{font-family:'Fredoka Variable',sans-serif;letter-spacing:.06em;color:#8a5ad0;text-shadow:0 0 12px rgba(255,220,120,.9)}
#gw-dlg .row{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-height:44px;margin-top:6px}
#gw-dlg .choices{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end}
#gw-dlg .choices .gw-btn{font-size:19px;padding:7px 22px}
#gw-dlg .choices .gw-btn.alt{background:linear-gradient(180deg,#bfe8ff,#79c3ee)}
#gw-dlg .more{font:600 15px 'Fredoka Variable',sans-serif;color:var(--ink2);display:flex;align-items:center;gap:8px}
#gw-dlg .more kbd{padding:2px 9px;border-radius:8px;background:var(--ink);color:var(--cream);font:600 14px 'Fredoka Variable',sans-serif}
#gw-dlg .more i{display:inline-block;animation:gw-dlgbob .8s ease-in-out infinite;font-style:normal}
@keyframes gw-dlgbob{0%,100%{transform:translateY(0)}50%{transform:translateY(4px)}}
`;

export interface DialogueHost {
  node(id: string): DialogueNode | undefined;
  speaker(id: string): { name: string; tint: string; initial: string };
  onSet(flag: string): void;
  /** the whole conversation reached its end (not Esc) */
  onEnd(startId: string): void;
  onOpen(): void;
  onClose(): void;
  sound(kind: 'blip' | 'choose' | 'open'): void;
}

const CPS = 40;

export class DialogueUi {
  readonly root: HTMLElement;
  private tab!: HTMLElement;
  private txt!: HTMLElement;
  private choices!: HTMLElement;
  private more!: HTMLElement;
  private startId = '';
  private cur: DialogueNode | null = null;
  private shown = 0;
  private acc = 0;
  private lastBlip = 0;
  open = false;
  /** open time (s), so the opening E press does not instantly skip the first box */
  private age = 0;

  constructor(
    host: HTMLElement,
    private readonly h: DialogueHost,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.id = 'gw-dlg';
    this.root.className = 'gw-card';
    this.root.innerHTML = `<div class="tab disp"><span class="ini"></span><span class="nm"></span></div><div class="txt"></div><div class="row"><div class="choices"></div><div class="more disp"><kbd>E</kbd> <span>Next</span> <i>▾</i></div></div>`;
    host.append(this.root);
    this.tab = this.root.querySelector('.tab')!;
    this.txt = this.root.querySelector('.txt')!;
    this.choices = this.root.querySelector('.choices')!;
    this.more = this.root.querySelector('.more')!;
    this.root.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest('button')) return;
      this.advance();
    });
  }

  start(id: string): boolean {
    const n = this.h.node(id);
    if (!n) return false;
    this.startId = id;
    this.open = true;
    this.age = 0;
    this.root.classList.add('open');
    this.show(n);
    this.h.sound('open');
    this.h.onOpen();
    return true;
  }

  private show(n: DialogueNode): void {
    this.cur = n;
    this.shown = 0;
    this.acc = 0;
    for (const f of n.set ?? []) this.h.onSet(f);
    const sp = this.h.speaker(n.speaker);
    this.root.style.setProperty('--tint', sp.tint);
    this.tab.querySelector('.ini')!.textContent = sp.initial;
    this.tab.querySelector('.nm')!.textContent = sp.name;
    this.txt.classList.toggle('glim', n.speaker === 'glim');
    this.txt.textContent = '';
    this.choices.innerHTML = '';
    this.more.style.display = 'none';
  }

  private finishTyping(): void {
    const n = this.cur;
    if (!n) return;
    this.shown = n.text.length;
    this.txt.textContent = n.text;
    if (n.choices?.length) {
      this.more.style.display = 'none';
      this.choices.innerHTML = '';
      n.choices.slice(0, 2).forEach((c, i) => {
        const b = document.createElement('button');
        b.className = `gw-btn${i ? ' alt' : ''}`;
        b.textContent = `${i + 1}  ${c.text}`;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.choose(i);
        });
        this.choices.append(b);
      });
    } else {
      this.more.style.display = '';
      this.more.querySelector('span')!.textContent = n.next ? 'Next' : 'Done';
    }
  }

  private typing(): boolean {
    return !!this.cur && this.shown < this.cur.text.length;
  }

  choose(i: number): void {
    const c = this.cur?.choices?.[i];
    if (!c || this.typing()) return;
    this.h.sound('choose');
    this.go(c.next ?? null);
  }

  private go(next: string | null): void {
    const n = next ? this.h.node(next) : undefined;
    if (!n) {
      const id = this.startId;
      this.close(false);
      this.h.onEnd(id);
      return;
    }
    this.show(n);
  }

  /** E / Space / Enter / click */
  advance(): void {
    if (!this.open || !this.cur || this.age < 0.18) return;
    if (this.typing()) {
      this.finishTyping();
      return;
    }
    if (this.cur.choices?.length) return; // buttons / 1-2 keys
    this.go(this.cur.next ?? null);
  }

  /** returns true when the key was consumed */
  key(code: string): boolean {
    if (!this.open) return false;
    switch (code) {
      case 'KeyE':
      case 'Space':
      case 'Enter':
      case 'NumpadEnter':
        this.advance();
        return true;
      case 'Escape':
        this.close(true);
        return true;
      case 'Digit1':
      case 'Numpad1':
        this.choose(0);
        return true;
      case 'Digit2':
      case 'Numpad2':
        this.choose(1);
        return true;
    }
    return code.startsWith('Digit') || code === 'KeyF' || code === 'KeyX' || code === 'KeyC' || code === 'KeyG' || code === 'KeyH';
  }

  close(user: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.cur = null;
    this.root.classList.remove('open');
    this.h.onClose();
    void user;
  }

  update(dt: number): void {
    if (!this.open) return;
    this.age += dt;
    const n = this.cur;
    if (!n || !this.typing()) return;
    this.acc += dt * CPS;
    const target = Math.min(n.text.length, Math.floor(this.acc));
    if (target !== this.shown) {
      this.shown = target;
      this.txt.textContent = n.text.slice(0, this.shown);
      const now = performance.now();
      if (now - this.lastBlip > 70 && /\S/.test(n.text[this.shown - 1] ?? ' ')) {
        this.lastBlip = now;
        this.h.sound('blip');
      }
      if (this.shown >= n.text.length) this.finishTyping();
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
