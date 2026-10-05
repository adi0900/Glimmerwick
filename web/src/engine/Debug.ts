/**
 * Debug tooling: F3 overlay (fps / ms / draw calls / tris / bridge / time ...), lazily-created lil-gui panel
 * (F4), and a crash screen. Nothing here is on by default in automated runs (puppeteer), so screenshots stay clean.
 */
import GUI from 'lil-gui';
import type { EngineStats } from './types';

export interface OverlayInfo {
  bridge: 'wasm' | 'mock';
  seed: number;
  quality: string;
  view: string;
  cam: string;
  hours: number;
  weather: string;
  frozen: boolean;
  modules: string[];
  failed: string[];
}

export class DebugOverlay {
  readonly el: HTMLDivElement;
  private readonly textEl: HTMLPreElement;
  private readonly graph: HTMLCanvasElement;
  private readonly lines = new Map<string, () => string>();
  private visible = false;
  private lastText = 0;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:60;display:none;padding:8px 10px;border-radius:10px;' +
      'background:rgba(30,22,51,.82);color:#fff7e8;font:12px/1.45 ui-monospace,Consolas,monospace;pointer-events:none;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:pre';
    this.textEl = document.createElement('pre');
    this.textEl.style.cssText = 'margin:0;font:inherit';
    this.graph = document.createElement('canvas');
    this.graph.width = 180;
    this.graph.height = 36;
    this.graph.style.cssText = 'display:block;margin-top:6px;width:180px;height:36px;border-radius:4px;background:rgba(0,0,0,.25)';
    this.el.append(this.textEl, this.graph);
    host.append(this.el);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  line(key: string, fn: () => string): void {
    this.lines.set(key, fn);
  }

  update(now: number, s: EngineStats, info: OverlayInfo, recent: ReadonlyArray<number>): void {
    if (!this.visible) return;
    // graph every frame
    const g = this.graph.getContext('2d')!;
    const w = this.graph.width;
    const h = this.graph.height;
    g.clearRect(0, 0, w, h);
    const n = recent.length;
    const bw = w / 90;
    for (let i = 0; i < n; i++) {
      const ms = recent[i]!;
      const bh = Math.min(h, (ms / 33.3) * h);
      g.fillStyle = ms < 17.5 ? '#5fd3b0' : ms < 25 ? '#ffc94d' : '#ff7a6b';
      g.fillRect(w - (n - i) * bw, h - bh, Math.max(1, bw - 0.5), bh);
    }
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fillRect(0, h - (16.7 / 33.3) * h, w, 1);
    // text 4x per second
    if (now - this.lastText < 250) return;
    this.lastText = now;
    const f = (v: number, d = 1) => (v < 0 ? '  n/a' : v.toFixed(d));
    const extra = [...this.lines.entries()].map(([k, fn]) => `${k}: ${safe(fn)}`);
    this.textEl.textContent =
      `${f(s.fps)} fps  ${f(s.ms)} ms   cpu ${f(s.cpuMs)}  gpu ${f(s.gpuMs)}\n` +
      `calls ${s.calls}  tris ${s.tris.toLocaleString('en-US')}  geo ${s.geoms}  tex ${s.textures}  heap ${f(s.heapMB, 0)} MB\n` +
      `${s.width}x${s.height} @${s.pixelRatio.toFixed(2)}  q:${info.quality}  seed ${info.seed}\n` +
      `bridge: ${info.bridge === 'wasm' ? 'WASM (Rust sim)' : 'MOCK (no Rust sim!)'}\n` +
      `view ${info.view}  cam ${info.cam}  ${info.hours.toFixed(2)}h  ${info.weather}${info.frozen ? '  [frozen]' : ''}\n` +
      `modules: ${info.modules.join(', ') || '-'}${info.failed.length ? '\nFAILED: ' + info.failed.join(', ') : ''}` +
      (extra.length ? '\n' + extra.join('\n') : '');
  }
}

function safe(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    return `(error: ${String(e)})`;
  }
}

/** Create the shared lil-gui root (top-right, collapsed folders by default). */
export function createGui(): GUI {
  const gui = new GUI({ title: 'Glimmerwick  (F4)', width: 270 });
  gui.domElement.style.zIndex = '70';
  gui.domElement.style.setProperty('--font-family', "'Nunito Variable', system-ui, sans-serif");
  return gui;
}

/** Fatal boot/runtime failure screen (index.html ships the markup). */
export function showFatal(message: string): void {
  const root = document.getElementById('fatal');
  const msg = document.getElementById('fatal-msg');
  if (root && msg) {
    msg.textContent = message;
    root.classList.add('on');
  }
}
