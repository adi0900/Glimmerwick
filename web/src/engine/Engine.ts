/**
 * Engine: renderer, main loop, bridge, modules, gallery harness and the `window.__game` photo API.
 *
 * Frame order:  input -> bridge.tick(dt) -> events -> env/lighting -> module.update(dt) -> gallery camera override
 *               -> sky follow -> post render.
 * See docs/ENGINE.md for how to write a module and take shots.
 */
import {
  BufferGeometry,
  Mesh,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type GUI from 'lil-gui';
import { Bridge } from './Bridge';
import {
  DEFAULT_HOURS,
  FIXED_DT,
  QUALITY,
  WEATHER_NAMES,
  buildViewInfo,
  parseHours,
  parseQuality,
  parseVec3,
  parseWeather,
  readParams,
} from './config';
import { DebugOverlay, createGui, showFatal, type OverlayInfo } from './Debug';
import { createEnv, updateEnv } from './Env';
import { GalleryCamera, DEFAULT_FOV } from './Gallery';
import { registerGlsl } from './glsl';
import { Input } from './Input';
import { Lighting } from './Lighting';
import { Materials } from './Materials';
import { resolveModules } from './Modules';
import { FrameStats, GpuTimer } from './Perf';
import { Post, type ToneMapName } from './Post';
import { makeRngFactory } from './Rng';
import { Benders, createSharedUniforms } from './Uniforms';
import type {
  Clock,
  Ctx,
  EngineStats,
  GameEvent,
  GameModule,
  PhotoApi,
  QualityName,
  QualityPreset,
  Vec3,
  ViewInfo,
} from './types';

// three-mesh-bvh: accelerated raycasts + `geometry.computeBoundsTree()` for every module.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

const MODULE_ERR_EVERY = 600;

function qualityFromParams(params: Record<string, string>): QualityPreset {
  const q: QualityPreset = { ...QUALITY[parseQuality(params.q)] };
  const flag = (k: string): boolean | undefined => (params[k] === undefined ? undefined : params[k] === '1' || params[k] === 'true');
  if (params.msaa !== undefined && Number.isFinite(Number(params.msaa))) q.msaa = Math.max(0, Math.floor(Number(params.msaa)));
  if (params.dpr !== undefined && Number(params.dpr) > 0) q.dprCap = Number(params.dpr);
  q.shadows = flag('shadows') ?? q.shadows;
  q.bloom = flag('bloom') ?? q.bloom;
  q.ao = flag('ao') ?? q.ao;
  q.tiltShift = flag('tilt') ?? q.tiltShift;
  q.smaa = flag('smaa') ?? q.smaa;
  return q;
}

export class Engine {
  readonly view: ViewInfo;
  readonly photo: PhotoApi;

  private renderer!: WebGLRenderer;
  private canvas!: HTMLCanvasElement;
  private scene = new Scene();
  private camera = new PerspectiveCamera(DEFAULT_FOV, 16 / 9, 0.15, 1500);
  private bridge!: Bridge;
  private post!: Post;
  private mats!: Materials;
  private lighting!: Lighting;
  private input!: Input;
  private ctx!: Ctx;
  private modules: GameModule[] = [];
  private readonly moduleNames: string[] = [];
  private failedModules: { name: string; error: string }[] = [];
  private readonly uniforms = createSharedUniforms();
  private readonly benders = new Benders(this.uniforms);
  private readonly env = createEnv();
  private readonly gcam = new GalleryCamera();
  private readonly clock: Clock = { t: 0, dt: 0, frame: 0, alpha: 0, frozen: false };
  private readonly stats = new FrameStats();
  private gpu!: GpuTimer;
  private overlay!: DebugOverlay;
  private gui: GUI | null = null;
  private guiState = { time: DEFAULT_HOURS, weather: 0, intensity: 0, quality: 'high' as QualityName, freeze: false, cam: 'game', tone: 'neutral' as ToneMapName };
  private readonly inputBuf = new Float32Array(16);
  private frozen = false;
  private isReady = false;
  private rafId = 0;
  private lastNow = 0;
  private windTime = 0;
  private settleLeft = 0;
  private settleResolvers: Array<() => void> = [];
  private readonly errors: string[] = [];
  private readonly moduleErrCount = new Map<string, number>();
  private readonly lastPlayer = new Vector3();
  private fatal = false;
  private panicShown = false;

  private constructor(view: ViewInfo) {
    this.view = view;
    this.photo = this.makePhotoApi();
    Object.defineProperty(window, '__game', { value: this.photo, configurable: true });
    this.captureErrors();
  }

  static async boot(): Promise<Engine> {
    const params = readParams();
    const view = buildViewInfo(params);
    const engine = new Engine(view);
    try {
      await engine.init();
    } catch (e) {
      engine.fail('Boot failed', e);
      throw e;
    }
    return engine;
  }

  // ------------------------------------------------------------------------------------------ boot

  private progress(pct: number, msg: string): void {
    const bar = document.getElementById('boot-bar');
    const text = document.getElementById('boot-msg');
    if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
    if (text) text.textContent = msg;
  }

  private async init(): Promise<void> {
    const view = this.view;
    const params = view.params;
    this.progress(0.05, 'Starting the renderer…');
    registerGlsl();

    // ---- renderer
    const stage = document.getElementById('stage') ?? document.body;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;max-width:100%;max-height:100%;object-fit:contain;outline:none';
    this.canvas.tabIndex = 0;
    stage.append(this.canvas);
    const renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // AA is done by the post stack (MSAA on the HDR buffer / SMAA / FXAA)
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer = renderer;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping; // tone mapping happens inside the post stack
    renderer.info.autoReset = false; // the composer renders several times per frame: we reset manually
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.setClearColor(0x231a3d, 1);
    this.gpu = new GpuTimer(renderer);

    const quality = qualityFromParams(params);
    this.scene.name = 'gw.scene';

    // ---- engine services
    this.input = new Input(stage);
    this.input.pointerLockEnabled = view.isGame && !view.automated;
    this.mats = new Materials(this.uniforms, quality);
    this.lighting = new Lighting(this.scene, renderer, this.uniforms, quality);
    this.camera.position.set(0, 12, 22);
    this.camera.lookAt(0, 2, 0);
    this.post = new Post(renderer, this.scene, this.camera, quality);
    if (params.tm === 'agx' || params.tm === 'neutral' || params.tm === 'aces' || params.tm === 'linear') this.post.setToneMapping(params.tm);
    if (params.post === '0') this.post.enabled = false;
    this.applyTuning(params.set);
    if (params.exposure && Number.isFinite(Number(params.exposure))) this.lighting.tuning.exposure = Number(params.exposure);
    this.overlay = new DebugOverlay(document.body);

    // ---- bridge (wasm or mock)
    this.progress(0.15, 'Waking up the simulation…');
    this.bridge = await Bridge.create({ seed: view.seed, forceMock: view.mock, log: (m) => this.progress(0.2, m) });

    // ---- ctx
    const self = this;
    this.ctx = {
      game: this.bridge,
      renderer,
      scene: this.scene,
      camera: this.camera,
      post: this.post,
      mats: this.mats,
      lighting: this.lighting,
      uniforms: this.uniforms,
      env: this.env,
      clock: this.clock,
      quality,
      view,
      input: this.input,
      debug: {
        gui: () => self.getGui(),
        line: (key, fn) => self.overlay.line(key, fn),
      },
      modules: this.moduleNames,
      rngFor: makeRngFactory(view.seed),
      bend: (x, y, z, r) => this.benders.add(x, y, z, r),
      api: {},
    };

    // dev/debug handle for the console and tools: `__gw.ctx`, `__gw.bridge`, `__gw.engine`
    Object.defineProperty(window, '__gw', { value: { ctx: this.ctx, bridge: this.bridge, engine: this }, configurable: true });

    // gallery camera input
    this.input.onDrag = (dx, dy, buttons, e) => {
      if (!this.gcam.active) return false;
      if ((buttons & 2) !== 0 || e.shiftKey) this.gcam.pan(dx, dy);
      else this.gcam.orbit(dx, dy);
      return true;
    };
    this.input.onWheel = (dy) => {
      if (!this.gcam.active) return false;
      this.gcam.dolly(dy);
      return true;
    };

    this.bindKeys();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    // ---- modules
    this.progress(0.3, 'Loading modules…');
    const { list, failed } = await resolveModules(view);
    this.modules = list;
    this.failedModules = failed;
    for (const f of failed) this.noteError(`module ${f.name}: ${f.error}`, true);
    const inited: GameModule[] = [];
    const names = this.moduleNames;
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!;
      this.progress(0.3 + 0.5 * (i / Math.max(list.length, 1)), `Setting up ${m.name}…`);
      const missing = (m.needs ?? []).filter((n) => !names.includes(n));
      if (missing.length) {
        this.failedModules.push({ name: m.name, error: `needs ${missing.join(', ')} which failed to load` });
        this.noteError(`module ${m.name} skipped: needs ${missing.join(', ')}`, true);
        continue;
      }
      try {
        await m.init(this.ctx);
        inited.push(m);
        names.push(m.name);
        if (m.gallery?.cams) this.gcam.addPresets(m.gallery.cams, m.name === view.primary ? '' : `${m.name}:`);
      } catch (e) {
        this.failedModules.push({ name: m.name, error: e instanceof Error ? e.message : String(e) });
        this.noteError(`module ${m.name} init failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, true);
      }
    }
    this.modules = inited;
    if (view.primary && !names.includes(view.primary)) {
      throw new Error(`view "${view.primary}" could not be loaded: ${this.failedModules.map((f) => `${f.name}: ${f.error}`).join('; ') || 'unknown module'}`);
    }
    if (!this.gcam.names.length) this.gcam.addPresets({ default: { pos: [0, 12, 22], target: [0, 2, 0] } }, '');

    // ---- gallery setup of the primary view (before the URL camera is resolved: setup may add/reframe cams)
    const primary = this.modules.find((m) => m.name === view.primary);
    if (primary?.gallery?.setup) {
      try {
        await primary.gallery.setup(this.ctx);
      } catch (e) {
        this.noteError(`module ${primary.name} gallery.setup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, true);
      }
    }

    // ---- URL overrides (time / weather / camera / freeze), gallery defaults
    this.applyUrlState();
    for (const m of this.modules) m.onQuality?.(this.ctx, quality);
    this.guiState.quality = quality.name;

    // ---- first frames
    this.progress(0.88, 'Polishing shaders…');
    this.advance(0, 0);
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      console.warn('[engine] compileAsync failed (shaders will compile on first use)', e);
    }
    this.progress(0.97, 'Almost there…');
    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
    await new Promise<void>((resolve) => {
      this.settleResolvers.push(resolve);
      this.settleLeft = 3;
    });

    if (!view.automated || params.hud === '1') this.setupHud();
    this.isReady = true;
    this.progress(1, 'Ready');
    const boot = document.getElementById('boot');
    if (view.automated) boot?.remove(); // no fade ghost in screenshots
    else {
      boot?.classList.add('done');
      setTimeout(() => boot?.remove(), 600);
    }
    console.info(
      `[engine] ready: view=${view.name} bridge=${this.bridge.kind} seed=${view.seed} quality=${quality.name} modules=[${names.join(', ')}] cams=[${this.gcam.names.join(', ')}]`,
    );
  }

  /**
   * `?set=post.bloomIntensity:0.3,light.exposure:1.1,light.fogScale:0.2` -- tweak look knobs from the URL
   * (shots, A/B comparisons). Prefixes: `post` -> Post.params, `light` -> Lighting.tuning.
   */
  private applyTuning(spec: string | undefined): void {
    if (!spec) return;
    for (const item of spec.split(',')) {
      const [path, raw] = item.split(':');
      const v = Number(raw);
      if (!path || !Number.isFinite(v)) continue;
      const [group, key] = path.split('.');
      const target = group === 'post' ? (this.post.params as Record<string, unknown>) : group === 'light' ? (this.lighting.tuning as Record<string, unknown>) : null;
      if (target && key && key in target) target[key] = v;
      else console.warn(`[engine] ?set: unknown knob "${path}"`);
    }
    this.post.apply();
  }

  private setupHud(): void {
    const p = this.view.params;
    if (p.stats === '1') this.overlay.setVisible(true);
    if (p.gui === '1' || (this.view.isGallery && !this.view.automated && p.gui !== '0')) {
      const gui = this.getGui();
      if (p.gui !== '1') gui.close();
    }
  }

  private applyUrlState(): void {
    const view = this.view;
    const p = view.params;
    const time = parseHours(p.time);
    const weather = parseWeather(p.weather, p.wi);
    if (time !== null) this.setTime(time, view.isGallery); // game view: a start hour, the clock keeps running
    else if (view.isGallery) this.setTime(DEFAULT_HOURS); // galleries hold the hero hour unless told otherwise
    if (weather) this.setWeather(weather.kind, weather.intensity);
    else if (view.isGallery) this.setWeather(0, 0);
    if (p.freeze === '1' || p.freeze === 'true') this.setFrozen(true);

    const cp = parseVec3(p.camPos);
    const ct = parseVec3(p.camTarget);
    if (cp && ct) {
      this.setCam({ pos: cp, target: ct, fov: p.fov ? Number(p.fov) : undefined });
    } else if (p.cam) {
      if (!this.setCam(p.cam)) {
        this.noteError(`unknown cam "${p.cam}" (available: ${this.gcam.names.join(', ')})`, true);
      }
    } else if (view.isGallery) {
      this.setCam(this.gcam.names[0]!);
    }
  }

  // ------------------------------------------------------------------------------------------ state setters

  /**
   * Set the world hour through the sim (`sys.set_time`); `hold` also stops the sim clock (`sys.set_time_scale 0`)
   * so galleries keep the hour while animation runs. Sims without these commands (older builds, no wasm) fall back to a
   * JS-side override in `ctx.env`.
   */
  private setTime(hours: number, hold = true): void {
    const h = ((hours % 24) + 24) % 24;
    const r = this.bridge.command('sys.set_time', { hours: h }, true);
    if (r && r.error) this.env.override.hours = h;
    else delete this.env.override.hours;
    if (hold) this.bridge.command('sys.set_time_scale', { scale: 0 }, true);
    this.guiState.time = h;
  }

  private setWeather(kind: number | string, intensity?: number): void {
    let k = typeof kind === 'number' ? kind : WEATHER_NAMES.indexOf(kind as (typeof WEATHER_NAMES)[number]);
    if (typeof kind === 'string' && k < 0) k = Number(kind);
    if (!Number.isFinite(k) || k < 0 || k >= WEATHER_NAMES.length) k = 0;
    const i = Math.min(1, Math.max(0, intensity ?? (k === 0 ? 0 : 0.85)));
    const r = this.bridge.command('sys.set_weather', { kind: k, intensity: i, instant: true, auto: false }, true);
    if (r && r.error) {
      this.env.override.weatherKind = k;
      this.env.override.weatherIntensity = i;
    } else {
      delete this.env.override.weatherKind;
      delete this.env.override.weatherIntensity;
    }
    this.guiState.weather = k;
    this.guiState.intensity = i;
  }

  private setFrozen(on: boolean): void {
    this.frozen = on;
    this.clock.frozen = on;
    this.guiState.freeze = on;
  }

  private setCam(cam: string | { pos: Vec3; target: Vec3; fov?: number }): boolean {
    const ok = this.gcam.set(cam);
    this.input.lookEnabled = !this.gcam.active;
    this.guiState.cam = this.gcam.current ?? 'game';
    return ok;
  }

  private setQuality(name: QualityName): void {
    const q: QualityPreset = { ...QUALITY[name] };
    (this.ctx as { quality: QualityPreset }).quality = q;
    this.guiState.quality = name;
    this.mats.setQuality(q);
    this.lighting.setQuality(q);
    this.post.setQuality(q);
    this.resize();
    for (const m of this.modules) {
      try {
        m.onQuality?.(this.ctx, q);
      } catch (e) {
        this.reportModuleError(m.name, 'onQuality', e);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ loop

  private readonly loop = (now: number): void => {
    this.rafId = requestAnimationFrame(this.loop);
    const real = Math.min(Math.max((now - this.lastNow) / 1000, 0), 0.1);
    this.lastNow = now;
    this.stats.frame(now);
    const dt = this.frozen ? 0 : real;
    try {
      this.advance(dt, real);
      this.renderFrame(dt);
    } catch (e) {
      this.reportModuleError('engine', 'frame', e);
    }
    this.stats.endFrame(this.renderer);
    this.gpu.poll();
    if (this.bridge.panicked && !this.panicShown) {
      this.panicShown = true;
      showFatal('The simulation crashed (Rust panic): see the console for [glimmerwick-sim] PANIC. Reload the page to restart.');
    }
    if (this.overlay.isVisible) this.overlay.update(now, this.snapshotStats(), this.overlayInfo(), this.stats.recent);
    if (this.settleLeft > 0 && --this.settleLeft === 0) {
      const rs = this.settleResolvers.splice(0);
      for (const r of rs) r();
    }
  };

  /** input -> sim -> events -> env/lighting -> modules -> camera. `dt` may be 0 (frozen). */
  private advance(dt: number, realDt: number): void {
    const ctx = this.ctx;
    const clock = this.clock;

    // input (skipped while frozen so scripted shots stay deterministic)
    if (!this.frozen) {
      this.input.poll(realDt, this.inputBuf);
      this.bridge.setInput(this.inputBuf);
    } else {
      this.input.poll(realDt, this.inputBuf); // still integrates look deltas
    }

    this.bridge.tick(dt);
    clock.dt = dt;
    clock.t += dt;
    clock.frame++;
    clock.alpha = this.bridge.alpha;

    const events = this.bridge.drainEvents();
    if (events.length) this.dispatchEvents(events);

    updateEnv(this.env, this.bridge);
    const u = this.uniforms;
    u.uTime.value = clock.t;
    const windMag = Math.hypot(this.env.windX, this.env.windZ);
    this.windTime += dt * (0.55 + 0.45 * Math.min(windMag, 2.5));
    u.uWindTime.value = this.windTime;
    if (this.bridge.player.valid) this.lastPlayer.copy(this.bridge.player.pos);
    u.uPlayerPos.value.copy(this.lastPlayer);
    this.benders.clear();
    this.lighting.update(this.env, this.camera, realDt, this.frozen);

    for (const m of this.modules) {
      if (!m.update) continue;
      try {
        m.update(ctx, dt);
      } catch (e) {
        this.reportModuleError(m.name, 'update', e);
      }
    }

    this.gcam.apply(this.camera);
    this.camera.updateMatrixWorld();
    this.lighting.follow(this.camera);
    if (this.gui) this.syncGui();
  }

  private dispatchEvents(events: GameEvent[]): void {
    for (const m of this.modules) {
      if (!m.onEvents) continue;
      try {
        m.onEvents(this.ctx, events);
      } catch (e) {
        this.reportModuleError(m.name, 'onEvents', e);
      }
    }
  }

  private renderFrame(dt: number): void {
    this.renderer.info.reset();
    this.gpu.begin();
    this.post.render(dt);
    this.gpu.end();
  }

  private resize(): void {
    const q = this.ctx?.quality ?? QUALITY.high;
    const fs = this.view.fixedSize;
    const w = fs ? fs.w : Math.max(1, window.innerWidth);
    const h = fs ? fs.h : Math.max(1, window.innerHeight);
    const dpr = fs ? 1 : Math.min(window.devicePixelRatio || 1, q.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.ctx) {
      for (const m of this.modules) {
        try {
          m.onResize?.(this.ctx, w, h);
        } catch (e) {
          this.reportModuleError(m.name, 'onResize', e);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------ stats / photo API

  private snapshotStats(): EngineStats {
    return this.stats.snapshot(this.renderer, this.gpu.ms);
  }

  private overlayInfo(): OverlayInfo {
    return {
      bridge: this.bridge.kind,
      seed: this.view.seed,
      quality: this.ctx.quality.name,
      view: this.view.name,
      cam: this.gcam.current ?? 'game',
      hours: this.env.hours,
      weather: `${WEATHER_NAMES[this.env.weatherKind] ?? '?'} ${this.env.weatherIntensity.toFixed(2)}`,
      frozen: this.frozen,
      modules: this.ctx.modules.slice(),
      failed: this.failedModules.map((f) => f.name),
    };
  }

  private makePhotoApi(): PhotoApi {
    const self = this;
    return {
      get ready() {
        return self.isReady;
      },
      get view() {
        return self.view.name;
      },
      get seed() {
        return self.view.seed;
      },
      get bridge() {
        return self.bridge?.kind ?? 'mock';
      },
      get frame() {
        return self.clock.frame;
      },
      stats: () => self.snapshotStats(),
      setTime: (h, hold = true) => self.setTime(h, hold),
      setWeather: (k, i) => self.setWeather(k, i),
      freeze: (on = true) => self.setFrozen(on),
      setCam: (cam) => void self.setCam(cam),
      getCam: () => ({
        pos: self.camera.position.toArray() as Vec3,
        target: self.gcam.active ? (self.gcam.target.toArray() as Vec3) : (self.camera.getWorldDirection(new Vector3()).multiplyScalar(10).add(self.camera.position).toArray() as Vec3),
        fov: self.camera.fov,
      }),
      cams: () => self.gcam.names,
      setQuality: (q) => self.setQuality(q),
      step: (n = 1, dt = FIXED_DT) => {
        for (let i = 0; i < n; i++) {
          self.advance(dt, dt);
          if (i === n - 1) self.renderFrame(dt);
        }
        self.stats.endFrame(self.renderer);
      },
      settle: (n = 30) =>
        new Promise<void>((resolve) => {
          self.settleResolvers.push(resolve);
          self.settleLeft = Math.max(self.settleLeft, Math.max(1, Math.floor(n)));
        }),
      bench: (n = 120) => self.bench(n),
      errors: () => self.errors.slice(),
      modules: () => (self.ctx ? self.ctx.modules.slice() : []),
    };
  }

  /**
   * Uncapped benchmark: n fixed frames rendered back-to-back with a GPU sync at the end (blocks the page, advances the
   * sim) -> mean CPU+GPU ms per frame; then lets the live loop run so the GPU timer queries (which only resolve across
   * tasks) can report the median GPU ms per frame.
   */
  private async bench(n: number): Promise<{ frameMs: number; cpuMs: number; gpuMs: number; frames: number }> {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const px = new Uint8Array(4);
    const sync = () => {
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    for (let i = 0; i < 6; i++) {
      this.advance(FIXED_DT, FIXED_DT);
      this.renderFrame(FIXED_DT);
    }
    sync();
    let cpu = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const c0 = performance.now();
      this.advance(FIXED_DT, FIXED_DT);
      this.renderFrame(FIXED_DT);
      cpu += performance.now() - c0;
    }
    sync();
    const total = performance.now() - t0;
    this.stats.endFrame(this.renderer);
    // GPU timer queries resolve asynchronously: collect a fresh batch from the live loop
    if (this.gpu.supported) {
      this.gpu.clearSamples();
      await this.photo.settle(40);
    }
    return { frameMs: total / n, cpuMs: cpu / n, gpuMs: this.gpu.ms, frames: n };
  }

  // ------------------------------------------------------------------------------------------ gui / keys / errors

  private getGui(): GUI {
    if (this.gui) return this.gui;
    const gui = createGui();
    this.gui = gui;
    const s = this.guiState;
    const f = gui.addFolder('Scene');
    f.add(s, 'time', 0, 24, 0.05).name('time of day').listen().onChange((v: number) => this.setTime(v, this.view.isGallery));
    f.add(s, 'weather', { clear: 0, cloudy: 1, rain: 2, storm: 3, snow: 4, fog: 5 }).listen().onChange((v: number) => this.setWeather(Number(v), Number(v) === 0 ? 0 : s.intensity || 0.85));
    f.add(s, 'intensity', 0, 1, 0.01).name('weather intensity').listen().onChange((v: number) => this.setWeather(s.weather, v));
    f.add(s, 'freeze').name('freeze sim').listen().onChange((v: boolean) => this.setFrozen(v));
    f.add(s, 'quality', ['low', 'med', 'high', 'ultra']).listen().onChange((v: QualityName) => this.setQuality(v));
    const cams = ['game', ...this.gcam.names];
    f.add(s, 'cam', cams).name('camera').listen().onChange((v: string) => void this.setCam(v));

    const look = gui.addFolder('Look');
    const L = this.lighting.tuning;
    const P = this.post.params;
    look.add(L, 'exposure', 0.4, 2, 0.01);
    look.add(L, 'sunScale', 0, 2, 0.01).name('sun intensity x');
    look.add(L, 'hemiScale', 0, 3, 0.01).name('hemisphere x');
    look.add(s, 'tone', ['neutral', 'agx', 'aces', 'linear']).name('tone mapping').onChange((v: ToneMapName) => this.post.setToneMapping(v));
    look.add(P, 'bloomIntensity', 0, 2, 0.01).onChange(() => this.post.apply());
    look.add(P, 'bloomThreshold', 0.2, 2, 0.01).onChange(() => this.post.apply());
    look.add(P, 'aoStrength', 0, 1, 0.01).onChange(() => this.post.apply());
    look.add(P, 'aoRadius', 0.1, 3, 0.01).onChange(() => this.post.apply());
    look.add(P, 'tiltFocus', 0.2, 1, 0.01).onChange(() => this.post.apply());
    look.add(P, 'tiltFeather', 0.05, 0.8, 0.01).onChange(() => this.post.apply());
    look.close();
    return gui;
  }

  private syncGui(): void {
    const s = this.guiState;
    s.time = this.env.hours;
    s.freeze = this.frozen;
    s.cam = this.gcam.current ?? 'game';
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F3') {
        e.preventDefault();
        this.overlay.toggle();
      } else if (e.key === 'F4') {
        e.preventDefault();
        const gui = this.getGui();
        gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none';
      }
    });
  }

  private noteError(msg: string, log = false): void {
    this.errors.push(msg);
    if (this.errors.length > 100) this.errors.shift();
    if (log) console.error(`[engine] ${msg}`);
  }

  private reportModuleError(name: string, phase: string, e: unknown): void {
    const key = `${name}.${phase}`;
    const n = (this.moduleErrCount.get(key) ?? 0) + 1;
    this.moduleErrCount.set(key, n);
    if (n === 1 || n % MODULE_ERR_EVERY === 0) {
      const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.noteError(`[${key}] (x${n}) ${text}`, true);
    }
  }

  private captureErrors(): void {
    window.addEventListener('error', (ev) => {
      this.errors.push(`uncaught: ${ev.message} @ ${ev.filename}:${ev.lineno}`);
      if (!this.isReady && !this.fatal) this.fail('Uncaught error during boot', ev.error ?? ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      this.errors.push(`unhandled rejection: ${String(ev.reason)}`);
      if (!this.isReady && !this.fatal) this.fail('Unhandled promise rejection during boot', ev.reason);
    });
  }

  private fail(title: string, e: unknown): void {
    this.fatal = true;
    const text = e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e);
    console.error(`[engine] ${title}:`, e);
    this.errors.push(`${title}: ${text}`);
    showFatal(`${title}\n\n${text}`);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    for (const m of this.modules) m.dispose?.();
    this.post.dispose();
    this.lighting.dispose();
    this.input.dispose();
    this.renderer.dispose();
  }
}
