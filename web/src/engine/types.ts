/**
 * Engine contracts shared by every web module. This file is the "public header" of the engine:
 * keep it small, stable and well commented. Additive changes only (other agents compile against it).
 *
 * See docs/ENGINE.md for the how-to.
 */
import type {
  Color,
  IUniform,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import type GUI from 'lil-gui';
import type { Bridge } from './Bridge';
import type { Input } from './Input';
import type { Lighting } from './Lighting';
import type { Materials } from './Materials';
import type { Post } from './Post';
import type { Rng } from './Rng';

export type Vec3 = [number, number, number];

/** A camera preset used by the gallery harness (`/?view=<module>&cam=<name>`) and `__game.setCam`. */
export interface GalleryCam {
  pos: Vec3;
  target: Vec3;
  /** vertical field of view in degrees (default 52) */
  fov?: number;
}

/** One decoded bridge event (packed stride 7 `[kind,a,b,x,y,z,f]` on the wire). Do not retain the array between calls. */
export interface GameEvent {
  kind: number;
  a: number;
  b: number;
  x: number;
  y: number;
  z: number;
  f: number;
}

export interface GameModule {
  /** unique name == folder name under `web/src/modules/` */
  name: string;
  /** update/init order, ascending; default 100 */
  order?: number;
  /** other module names that must be loaded (and initialised) before this one */
  needs?: string[];
  init(ctx: Ctx): void | Promise<void>;
  /** called once per rendered frame, after the sim tick; `dt` is 0 while frozen */
  update?(ctx: Ctx, dt: number): void;
  /** called with the frame's decoded bridge events (only when non-empty) */
  onEvents?(ctx: Ctx, ev: GameEvent[]): void;
  /** canvas size changed (CSS px) */
  onResize?(ctx: Ctx, width: number, height: number): void;
  /** quality preset changed at runtime (also called once after init) */
  onQuality?(ctx: Ctx, q: QualityPreset): void;
  /** gallery harness data: camera presets + optional scene setup used when this module is the `view` */
  gallery?: {
    cams: Record<string, GalleryCam>;
    /** runs after every module is initialised, only for the module that is the primary `view` */
    setup?(ctx: Ctx): void | Promise<void>;
  };
  dispose?(): void;
}

/** Identity helper that gives modules full type inference: `export default defineModule({...})`. */
export function defineModule(m: GameModule): GameModule {
  return m;
}

export type QualityName = 'low' | 'med' | 'high' | 'ultra';

/** Numeric hints every module should scale its cost by. Engine-owned parts are applied automatically. */
export interface QualityPreset {
  name: QualityName;
  /** max devicePixelRatio */
  dprCap: number;
  /** MSAA samples on the post-stack frame buffer (0 = off; clamped to the GPU limit) */
  msaa: number;
  smaa: boolean;
  fxaa: boolean;
  shadows: boolean;
  /** shadow map resolution per cascade (px) */
  shadowMap: number;
  /** metres from the camera that cast shadows */
  shadowDistance: number;
  /** PCF kernel radius in texels */
  shadowRadius: number;
  bloom: boolean;
  ao: boolean;
  tiltShift: boolean;
  /** --- content hints for modules (multipliers; 1 = the "high" design target) --- */
  grassDensity: number;
  drawDistance: number;
  particleScale: number;
  /** 0 flat · 1 depth gradient · 2 + foam/glitter · 3 + refraction/caustics */
  waterQuality: 0 | 1 | 2 | 3;
  /** 0 low-poly · 1 normal · 2 hero detail */
  detail: 0 | 1 | 2;
}

/** Effective time-of-day / weather. Comes from the `time` channel, with photo-API overrides on top. */
export interface Env {
  /** 0..24 */
  hours: number;
  dayIndex: number;
  /** 0 spring · 1 summer · 2 autumn · 3 winter */
  season: number;
  seasonT: number;
  /** 0 clear · 1 cloudy · 2 rain · 3 storm · 4 snow · 5 fog */
  weatherKind: number;
  weatherIntensity: number;
  windX: number;
  windZ: number;
  /** unit vector pointing TOWARD the sun (below the horizon at night) */
  sunDir: Vector3;
  /** set by the photo API (`__game.setTime/setWeather`); `undefined` = follow the channel */
  override: { hours?: number; weatherKind?: number; weatherIntensity?: number };
}

/**
 * Shared shader uniforms (contract: docs/WORLD_CONTRACT.md). Created by the engine, filled by `Lighting` (look)
 * and the engine. Everybody samples, nobody redefines. All objects are stable for the page lifetime: capture
 * the `{value}` holders into your own materials' `uniforms` and they stay live.
 */
export interface SharedUniforms {
  uTime: IUniform<number>;
  /** unit vector toward the key light (sun by day, moon at night) */
  uSunDir: IUniform<Vector3>;
  /** linear colour of the key light (intensity separate) */
  uSunColor: IUniform<Color>;
  uSunIntensity: IUniform<number>;
  uSkyZenith: IUniform<Color>;
  uSkyHorizon: IUniform<Color>;
  uHemiSky: IUniform<Color>;
  uHemiGround: IUniform<Color>;
  uFogColor: IUniform<Color>;
  uFogDensity: IUniform<number>;
  /** xz wind direction * strength (m/s-ish, 0..~3) */
  uWind: IUniform<Vector2>;
  /** monotonically increasing wind phase time (avoids jumps when wind changes) */
  uWindTime: IUniform<number>;
  uPlayerPos: IUniform<Vector3>;
  /** 0..24 */
  uTimeOfDay: IUniform<number>;
  /** 0..1, how night-like it is (0 day · 1 deep night) */
  uNight: IUniform<number>;
  uSeason: IUniform<number>;
  uSeasonT: IUniform<number>;
  uRain: IUniform<number>;
  uSnow: IUniform<number>;
  uWetness: IUniform<number>;
  /** world-space cloud shadow mask (R channel, 1 = lit). Default: 1x1 white. */
  uCloudShadowTex: IUniform<Texture>;
  /** x: world metres per texture repeat · y,z: scroll xz (metres) · w: strength 0..1 */
  uCloudShadowParams: IUniform<Vector4>;
  /** (sizeX, sizeZ, originX, originZ) in metres; filled from `world.info` once the world exists */
  uWorldSize: IUniform<Vector4>;
  /** up to 16 nearest grass benders: xyz = position, w = radius (0 = unused slot) */
  uBenders: IUniform<Vector4[]>;
}

export interface Clock {
  /** engine seconds since boot; frozen while `freeze` is on */
  t: number;
  /** this frame's dt in seconds (0 while frozen) */
  dt: number;
  frame: number;
  /** sim interpolation factor 0..1 for the current frame */
  alpha: number;
  /** true while `__game.freeze(true)` / `?freeze=1` holds the sim and animation (dt = 0) */
  frozen: boolean;
}

export interface ViewInfo {
  /** `game` or a module name */
  name: string;
  isGame: boolean;
  isGallery: boolean;
  /** the module that owns the gallery (== name when !isGame) */
  primary: string | null;
  seed: number;
  /** raw URL params */
  params: Record<string, string>;
  /** fixed canvas size from `?w=&h=` (CSS px) */
  fixedSize: { w: number; h: number } | null;
  /** true when driven by puppeteer (navigator.webdriver): HUD/gui are hidden by default */
  automated: boolean;
  mock: boolean;
}

export interface DebugApi {
  /** lazily-created lil-gui root; modules add folders: `ctx.debug.gui().addFolder('flora')` */
  gui(): GUI;
  /** F3 overlay extra line provider: `ctx.debug.line('flora', () => '1.2M blades')` */
  line(key: string, fn: () => string): void;
}

/** Everything a module can touch. Extend via interface augmentation or `ctx.api`. */
export interface Ctx {
  game: Bridge;
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  post: Post;
  mats: Materials;
  lighting: Lighting;
  uniforms: SharedUniforms;
  env: Env;
  clock: Clock;
  quality: QualityPreset;
  view: ViewInfo;
  input: Input;
  debug: DebugApi;
  /** names of the loaded modules, in init order */
  modules: ReadonlyArray<string>;
  /** deterministic per-name PRNG derived from the world seed (same name + seed => same sequence) */
  rngFor(name: string): Rng;
  /** register ≤16 grass benders for this frame (call from update(); cleared every frame) */
  bend(x: number, y: number, z: number, radius: number): void;
  /** modules publish services for other modules here (`ctx.api.world = {...}`) */
  api: Record<string, any>;
}

/** The `window.__game` photo / automation API (tools/shot.mjs is its main client). */
export interface PhotoApi {
  readonly ready: boolean;
  readonly view: string;
  readonly seed: number;
  readonly bridge: 'wasm' | 'mock';
  readonly frame: number;
  stats(): EngineStats;
  /** hours 0..24 via `sys.set_time`; `hold` (default true) also pins the sim clock (`sys.set_time_scale 0`) */
  setTime(hours: number, hold?: boolean): void;
  setWeather(kind: number | string, intensity?: number): void;
  /** freeze=true stops sim time and animation (dt = 0) for deterministic shots */
  freeze(on?: boolean): void;
  /** a preset name, `game` (release override), or a free camera */
  setCam(cam: string | { pos: Vec3; target: Vec3; fov?: number }): void;
  getCam(): { pos: Vec3; target: Vec3; fov: number };
  cams(): string[];
  setQuality(q: QualityName): void;
  /** advance n frames at dt = 1/60 (sim + animation); only the last frame is rendered */
  step(n?: number, dt?: number): void;
  /** resolve after n rendered frames with dt = 0 (lets shadows / post / async loads converge) */
  settle(n?: number): Promise<void>;
  /** uncapped benchmark: n frames back-to-back (blocks the page, advances the sim) -> mean CPU+GPU ms; gpuMs from timer queries */
  bench(n?: number): Promise<{ frameMs: number; cpuMs: number; gpuMs: number; frames: number }>;
  /** modules that failed to init, console errors seen by the engine */
  errors(): string[];
  modules(): string[];
}

export interface EngineStats {
  fps: number;
  /** mean frame interval over the last second (ms) */
  ms: number;
  /** CPU ms per frame (JS update + render submit) */
  cpuMs: number;
  /** GPU ms per frame (timer query; -1 if unavailable) */
  gpuMs: number;
  calls: number;
  tris: number;
  geoms: number;
  textures: number;
  heapMB: number;
  width: number;
  height: number;
  pixelRatio: number;
}

declare global {
  interface Window {
    __game: PhotoApi;
  }
}
