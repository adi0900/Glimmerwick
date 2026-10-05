/**
 * Frame statistics + GPU timer queries (EXT_disjoint_timer_query_webgl2).
 * `fps`/`ms` are measured on real rAF intervals (capped by vsync); `cpuMs`/`gpuMs` are the actual work per frame,
 * which is what tells you the headroom under the 16.7 ms budget.
 */
import type { WebGLRenderer } from 'three';
import type { EngineStats } from './types';

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: any;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private readonly samples: number[] = [];

  /** median of the most recent GPU frame times in ms (-1 when unsupported / no result yet): robust to outliers */
  get ms(): number {
    return this.recentMedian(60);
  }

  constructor(renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported(): boolean {
    return !!this.ext;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 6) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** collect finished queries (call once per frame) */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        if (ms > 0 && ms < 250) {
          this.samples.push(ms);
          if (this.samples.length > 240) this.samples.shift();
        }
      }
      gl.deleteQuery(q);
    }
  }

  recentMedian(n = 60): number {
    const s = this.samples.slice(-n).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : -1;
  }

  clearSamples(): void {
    this.samples.length = 0;
  }
}

export class FrameStats {
  private readonly deltas: number[] = [];
  private readonly cpu: number[] = [];
  private last = 0;
  private t0 = 0;
  calls = 0;
  tris = 0;
  geoms = 0;
  textures = 0;

  /** call at the top of every rAF frame with the rAF timestamp */
  frame(now: number): void {
    if (this.last) {
      this.deltas.push(now - this.last);
      if (this.deltas.length > 90) this.deltas.shift();
    }
    this.last = now;
    this.t0 = performance.now();
  }

  /** call after the frame's render submission */
  endFrame(renderer: WebGLRenderer): void {
    this.cpu.push(performance.now() - this.t0);
    if (this.cpu.length > 90) this.cpu.shift();
    const i = renderer.info;
    this.calls = i.render.calls;
    this.tris = i.render.triangles;
    this.geoms = i.memory.geometries;
    this.textures = i.memory.textures;
  }

  /** last frame deltas for the graph */
  get recent(): ReadonlyArray<number> {
    return this.deltas;
  }

  snapshot(renderer: WebGLRenderer, gpuMs: number): EngineStats {
    const d = this.deltas;
    const ms = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
    const cpu = this.cpu.length ? this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length : 0;
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const size = renderer.getSize(TMP_SIZE);
    return {
      fps: ms > 0 ? 1000 / ms : 0,
      ms,
      cpuMs: cpu,
      gpuMs,
      calls: this.calls,
      tris: this.tris,
      geoms: this.geoms,
      textures: this.textures,
      heapMB: perf.memory ? perf.memory.usedJSHeapSize / 1048576 : 0,
      width: size.x,
      height: size.y,
      pixelRatio: renderer.getPixelRatio(),
    };
  }
}

import { Vector2 } from 'three';
const TMP_SIZE = new Vector2();
