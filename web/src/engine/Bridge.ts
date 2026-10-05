/**
 * Bridge: typed wrapper over the wasm `Game` (docs/ARCHITECTURE.md §4, docs/BRIDGE_API.md).
 *
 *  - Loads `web/src/wasm/pkg/bridge.js` when it exists (through `import.meta.glob`, so a missing pkg is not a
 *    build error) and otherwise falls back to `MockGame` (same raw API, same channel layouts, fake linear memory).
 *    Which one is active is logged loudly and exposed as `bridge.kind` / `__game.bridge`.
 *  - Channels are flat typed arrays inside wasm memory. `Channel` hands out *live* views that are rebuilt whenever
 *    `memory.buffer` grows or Rust re-allocates the Vec (never cache `channel.data` across frames, re-read it).
 *  - Interpolated channels are double-buffered (`prev` = previous fixed step, `data` = latest); use
 *    `Channel.lerpRows(alpha, out, opts)` for render interpolation.
 */
import { Vector3 } from 'three';
import { MockGame } from './MockGame';
import { HeightField } from './HeightField';
import type { GameEvent } from './types';

export type ChannelKind = 'f32' | 'u32' | 'u16' | 'u8';
export type TypedArr = Float32Array | Uint32Array | Uint16Array | Uint8Array;

/** The raw surface of the wasm `Game` class (snake_case, as exported by wasm-bindgen). */
export interface RawGame {
  tick(dt: number): void;
  alpha(): number;
  set_input(input: Float32Array): void;
  command(name: string, json: string): string;
  query(name: string, json: string): string;
  channel_names(): string;
  channel_info(name: string): string;
  drain_events(): Float32Array;
  save(): Uint8Array;
  load(bytes: Uint8Array): boolean;
  free?(): void;
}

export interface ChannelInfo {
  ptr: number;
  prev_ptr: number;
  len: number;
  cap: number;
  stride: number;
  kind: ChannelKind;
  version: number;
}

const CTORS = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8: Uint8Array,
} as const;

const TWO_PI = Math.PI * 2;

function wrapPi(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

export interface LerpOpts {
  /** index inside a row holding a stable entity id; rows are matched by id when prev/cur ordering differs */
  idField?: number;
  /** indices inside a row that are angles (radians) and must lerp the short way round */
  angleFields?: ReadonlyArray<number>;
  startRow?: number;
  rows?: number;
}

/** A live view onto one Rust channel. Obtain with `bridge.channel(name)`; keep the object, re-read `.data`. */
export class Channel<T extends TypedArr = Float32Array> {
  private _kind: ChannelKind = 'f32';
  private _stride = 1;
  private _len = 0;
  private _cap = 0;
  private _version = 0;

  private _data: TypedArr = new Float32Array(0);
  private _prev: TypedArr | null = null;
  private _buffer: ArrayBufferLike | null = null;
  private _ptr = -1;
  private _prevPtr = -1;
  private _stamp = -1;
  private _idMap: Map<number, number> | null = null;

  constructor(
    readonly name: string,
    private readonly bridge: Bridge,
  ) {}

  /** element type of the channel */
  get kind(): ChannelKind {
    this.sync();
    return this._kind;
  }

  /** elements per row (e.g. 16 for creatures) */
  get stride(): number {
    this.sync();
    return this._stride;
  }

  /** number of valid elements (rows = len / stride) */
  get len(): number {
    this.sync();
    return this._len;
  }

  /** capacity in elements */
  get cap(): number {
    this.sync();
    return this._cap;
  }

  /** latest (most recent fixed step) values: `len` valid elements */
  get data(): T {
    this.sync();
    return this._data as T;
  }

  /** values of the previous fixed step (null for channels that are not interpolated) */
  get prev(): T | null {
    this.sync();
    return this._prev as T | null;
  }

  /** number of rows (len / stride) */
  get count(): number {
    this.sync();
    return this._stride > 0 ? Math.floor(this._len / this._stride) : 0;
  }

  get interpolated(): boolean {
    this.sync();
    return this._prev !== null;
  }

  /** bumps when static data changed (terrain edit, flora regrow) so you can skip rebuilds */
  get ver(): number {
    this.sync();
    return this._version;
  }

  /** re-read the channel descriptor if the sim ticked since the last read */
  sync(): void {
    const b = this.bridge;
    if (this._stamp === b.frameId) return;
    this._stamp = b.frameId;
    const info = b.rawChannelInfo(this.name);
    if (!info) {
      this._len = 0;
      this._data = new CTORS[this._kind](0);
      this._prev = null;
      return;
    }
    this._kind = info.kind;
    this._stride = info.stride;
    this._cap = info.cap;
    this._version = info.version;
    const buf = b.memory.buffer;
    const changed = buf !== this._buffer || info.ptr !== this._ptr || info.len !== this._len || info.prev_ptr !== this._prevPtr;
    this._len = info.len;
    if (!changed) return;
    this._buffer = buf;
    this._ptr = info.ptr;
    this._prevPtr = info.prev_ptr;
    const Ctor = CTORS[info.kind];
    if (info.len === 0 || info.ptr === 0) {
      this._data = new Ctor(0);
      this._prev = null;
      return;
    }
    this._data = new Ctor(buf as ArrayBuffer, info.ptr, info.len);
    this._prev = info.prev_ptr ? new Ctor(buf as ArrayBuffer, info.prev_ptr, info.len) : null;
  }

  /**
   * Interpolated copy of rows into `out` (Float32Array, needs `rows*stride` capacity). Returns the row count.
   * Rows are matched by id when `opts.idField` is set (creatures spawn/despawn between steps).
   */
  lerpRows(alpha: number, out: Float32Array, opts: LerpOpts = {}): number {
    this.sync();
    const cur = this._data as Float32Array;
    const prev = this._prev as Float32Array | null;
    const stride = this._stride;
    const total = Math.floor(this._len / stride);
    const start = opts.startRow ?? 0;
    const rows = Math.min(opts.rows ?? total - start, total - start);
    if (rows <= 0) return 0;
    const angles = opts.angleFields;
    const idf = opts.idField;
    let idMap: Map<number, number> | null = null;
    const prevRows = prev ? Math.floor(prev.length / stride) : 0;
    for (let r = 0; r < rows; r++) {
      const ci = (start + r) * stride;
      const oi = r * stride;
      let pi = -1;
      if (prev) {
        if (idf === undefined) {
          pi = ci < prev.length ? ci : -1;
        } else {
          const id = cur[ci + idf]!;
          if (ci < prev.length && prev[ci + idf] === id) pi = ci;
          else {
            if (!idMap) {
              idMap = this._idMap ?? (this._idMap = new Map());
              idMap.clear();
              for (let q = 0; q < prevRows; q++) idMap.set(prev[q * stride + idf]!, q * stride);
            }
            pi = idMap.get(id) ?? -1;
          }
        }
      }
      if (pi < 0 || !prev) {
        for (let k = 0; k < stride; k++) out[oi + k] = cur[ci + k]!;
        continue;
      }
      for (let k = 0; k < stride; k++) {
        const p = prev[pi + k]!;
        const c = cur[ci + k]!;
        out[oi + k] = p + (c - p) * alpha;
      }
      if (angles) {
        for (let a = 0; a < angles.length; a++) {
          const k = angles[a]!;
          const p = prev[pi + k]!;
          const c = cur[ci + k]!;
          out[oi + k] = p + wrapPi(c - p) * alpha;
        }
      }
    }
    return rows;
  }

  /** interpolated single element (e.g. player x): `ch.at(alpha, 0)` */
  at(alpha: number, index: number): number {
    this.sync();
    const c = this._data[index] ?? 0;
    const p = this._prev ? (this._prev[index] ?? c) : c;
    return p + (c - p) * alpha;
  }
}

/** Decoded `time` channel (layout: ARCHITECTURE.md §4). Refreshed on every `bridge.tick`. */
export interface TimeState {
  hours: number;
  dayIndex: number;
  season: number;
  seasonT: number;
  weatherKind: number;
  weatherIntensity: number;
  windX: number;
  windZ: number;
  sunDir: Vector3;
  /** false until the sim has produced a `time` channel */
  valid: boolean;
}

/** Decoded `player` channel, already interpolated with this frame's alpha. */
export interface PlayerState {
  pos: Vector3;
  vel: Vector3;
  yaw: number;
  animState: number;
  animT: number;
  grounded: boolean;
  waterDepth: number;
  tool: number;
  speed01: number;
  lookTargetId: number;
  valid: boolean;
}

export type BridgeKind = 'wasm' | 'mock';

const pkgLoaders = import.meta.glob('../wasm/pkg/bridge.js');

class PkgMissingError extends Error {}

async function loadWasm(seed: number): Promise<{ game: RawGame; memory: WebAssembly.Memory }> {
  const loader = pkgLoaders['../wasm/pkg/bridge.js'];
  if (!loader) throw new PkgMissingError('web/src/wasm/pkg/bridge.js not found (run tools/build-wasm.ps1)');
  const mod: any = await loader();
  const exportsObj: any = await mod.default();
  const memory: WebAssembly.Memory | undefined = exportsObj?.memory ?? mod.memory ?? mod.__wasm?.memory;
  if (!memory) throw new Error('wasm init did not expose `memory` (see docs/BRIDGE_API.md)');
  const game: RawGame = new mod.Game(seed >>> 0);
  return { game, memory };
}

export interface BridgeOptions {
  seed: number;
  forceMock?: boolean;
  log?: (msg: string) => void;
}

export class Bridge {
  readonly seed: number;
  readonly kind: BridgeKind;
  readonly memory: WebAssembly.Memory;
  /** increments on every tick(); channels use it to know when to re-read their descriptor */
  frameId = 0;
  /** last `alpha()` returned by the sim (render interpolation factor) */
  alpha = 0;
  /** true after the sim threw (Rust panic); the page keeps rendering the last data */
  panicked = false;
  readonly time: TimeState = {
    hours: 12,
    dayIndex: 0,
    season: 0,
    seasonT: 0,
    weatherKind: 0,
    weatherIntensity: 0,
    windX: 0,
    windZ: 0,
    sunDir: new Vector3(0, 1, 0),
    valid: false,
  };
  readonly player: PlayerState = {
    pos: new Vector3(),
    vel: new Vector3(),
    yaw: 0,
    animState: 0,
    animT: 0,
    grounded: true,
    waterDepth: 0,
    tool: 0,
    speed01: 0,
    lookTargetId: -1,
    valid: false,
  };
  /** terrain helper over `world.height` / `world.biome` + `query('world.info')` */
  readonly world: HeightField;

  private readonly raw: RawGame;
  private readonly channels = new Map<string, Channel<any>>();
  private infoCache = new Map<string, ChannelInfo | null>();
  private infoStamp = -1;
  private names: string[] | null = null;
  private inputBuf = new Float32Array(16);

  private constructor(kind: BridgeKind, raw: RawGame, memory: WebAssembly.Memory, seed: number) {
    this.kind = kind;
    this.raw = raw;
    this.memory = memory;
    this.seed = seed;
    this.world = new HeightField(this);
  }

  /** Create the bridge: real wasm when available, `MockGame` otherwise. Logs which one is active. */
  static async create(opts: BridgeOptions): Promise<Bridge> {
    const log = opts.log ?? (() => undefined);
    if (!opts.forceMock) {
      try {
        log('Loading the simulation…');
        const { game, memory } = await loadWasm(opts.seed);
        const b = new Bridge('wasm', game, memory, opts.seed);
        banner('wasm', 'Rust/Bevy simulation (wasm) is ACTIVE');
        b.refreshState();
        return b;
      } catch (e) {
        if (e instanceof PkgMissingError) {
          console.warn(`[bridge] ${e.message} -> falling back to MockGame`);
        } else {
          console.error('[bridge] wasm pkg present but failed to load -> falling back to MockGame', e);
        }
      }
    }
    const mock = new MockGame(opts.seed);
    const b = new Bridge('mock', mock, mock.memory, opts.seed);
    banner('mock', 'MOCK game is ACTIVE (no Rust simulation) -- ?mock=1 or missing wasm pkg');
    b.refreshState();
    return b;
  }

  // ---------------------------------------------------------------- sim stepping

  /** Advance the sim by `dt` seconds (runs 0..5 fixed steps) and refresh time/player state. */
  tick(dt: number): void {
    this.frameId++;
    if (!this.panicked) {
      try {
        this.raw.tick(dt);
        this.alpha = this.raw.alpha();
      } catch (e) {
        this.panicked = true;
        console.error('[bridge] sim threw during tick() (Rust panic?) -- simulation halted, rendering continues', e);
      }
    }
    this.refreshState();
  }

  /** Send the per-frame input block (Float32Array[16], layout: ARCHITECTURE.md §4). */
  setInput(input: Float32Array): void {
    if (this.panicked) return;
    try {
      this.raw.set_input(input);
    } catch (e) {
      this.panicked = true;
      console.error('[bridge] set_input threw', e);
    }
  }

  /** Convenience for scripts/tests: set input from named parts. */
  setInputParts(p: { moveX?: number; moveY?: number; lookDx?: number; lookDy?: number; buttons?: number; yaw?: number; pitch?: number; zoom?: number }): void {
    const a = this.inputBuf;
    a.fill(0);
    a[0] = p.moveX ?? 0;
    a[1] = p.moveY ?? 0;
    a[2] = p.lookDx ?? 0;
    a[3] = p.lookDy ?? 0;
    a[4] = p.buttons ?? 0;
    a[5] = p.yaw ?? 0;
    a[6] = p.pitch ?? 0;
    a[7] = p.zoom ?? 0;
    this.setInput(a);
  }

  /** Mutating call. Returns the parsed JSON reply (`{}` or `{error}`); errors are logged unless `quiet`. */
  command(name: string, args: unknown = {}, quiet = false): any {
    let out: any;
    try {
      out = JSON.parse(this.raw.command(name, JSON.stringify(args ?? {})) || '{}');
    } catch (e) {
      if (!quiet) console.warn(`[bridge] command ${name} threw`, e);
      return { error: String(e) };
    }
    if (out && out.error && !quiet) console.warn(`[bridge] command ${name} -> ${out.error}`);
    return out;
  }

  /** Read-only JSON call (HUD/UI data). */
  query(name: string, args: unknown = {}): any {
    try {
      return JSON.parse(this.raw.query(name, JSON.stringify(args ?? {})) || 'null');
    } catch (e) {
      console.warn(`[bridge] query ${name} threw`, e);
      return null;
    }
  }

  /** Decode this frame's events (call once per frame; the sim queue is drained). */
  drainEvents(): GameEvent[] {
    if (this.panicked) return [];
    let packed: Float32Array;
    try {
      packed = this.raw.drain_events();
    } catch {
      return [];
    }
    const n = Math.floor(packed.length / 7);
    if (n === 0) return EMPTY_EVENTS;
    const out: GameEvent[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      out[i] = { kind: packed[o]!, a: packed[o + 1]!, b: packed[o + 2]!, x: packed[o + 3]!, y: packed[o + 4]!, z: packed[o + 5]!, f: packed[o + 6]! };
    }
    return out;
  }

  private eventTable: Map<number, string> | null = null;

  /** event name (`player.jump`) from `query("core.events")`; falls back to the number (mock has no table) */
  eventName(kind: number): string {
    if (!this.eventTable) {
      this.eventTable = new Map();
      const rows = this.query('core.events');
      if (Array.isArray(rows)) for (const r of rows) this.eventTable.set(Number(r.kind), String(r.name));
    }
    return this.eventTable.get(kind) ?? String(kind);
  }

  save(): Uint8Array {
    return this.raw.save();
  }

  load(bytes: Uint8Array): boolean {
    const ok = this.raw.load(bytes);
    this.frameId++;
    this.refreshState();
    return ok;
  }

  // ---------------------------------------------------------------- channels

  channelNames(): string[] {
    if (!this.names) {
      try {
        this.names = JSON.parse(this.raw.channel_names()) as string[];
      } catch {
        this.names = [];
      }
    }
    return this.names;
  }

  has(name: string): boolean {
    return this.channelNames().includes(name);
  }

  /** Persistent live view of a channel (created lazily; safe to call every frame). */
  channel<T extends TypedArr = Float32Array>(name: string): Channel<T> {
    let c = this.channels.get(name);
    if (!c) {
      c = new Channel<T>(name, this);
      this.channels.set(name, c);
    }
    return c as Channel<T>;
  }

  /** descriptor lookup, cached per frame (used by Channel.sync) */
  rawChannelInfo(name: string): ChannelInfo | null {
    if (this.infoStamp !== this.frameId) {
      this.infoCache.clear();
      this.infoStamp = this.frameId;
    }
    let info = this.infoCache.get(name);
    if (info === undefined) {
      try {
        const s = this.raw.channel_info(name);
        info = s ? (JSON.parse(s) as ChannelInfo) : null;
        if (info && (info as any).error) info = null;
      } catch {
        info = null;
      }
      this.infoCache.set(name, info);
    }
    return info;
  }

  // ---------------------------------------------------------------- state mirrors

  private refreshState(): void {
    const a = this.alpha;
    if (this.has('time')) {
      const t = this.channel('time');
      const d = t.data;
      if (d.length >= 11) {
        const T = this.time;
        T.hours = d[0]!;
        T.dayIndex = d[1]!;
        T.season = d[2]!;
        T.seasonT = d[3]!;
        T.weatherKind = d[4]!;
        T.weatherIntensity = d[5]!;
        T.windX = d[6]!;
        T.windZ = d[7]!;
        T.sunDir.set(d[8]!, d[9]!, d[10]!);
        if (T.sunDir.lengthSq() > 1e-6) T.sunDir.normalize();
        else T.sunDir.set(0, 1, 0);
        T.valid = true;
      }
    }
    if (this.has('player')) {
      const ch = this.channel('player');
      const d = ch.data;
      if (d.length >= 14) {
        const P = this.player;
        P.pos.set(ch.at(a, 0), ch.at(a, 1), ch.at(a, 2));
        P.vel.set(d[3]!, d[4]!, d[5]!);
        const yp = ch.prev ? ch.prev[6]! : d[6]!;
        P.yaw = yp + wrapPi(d[6]! - yp) * a;
        P.animState = d[7]!;
        P.animT = d[8]!;
        P.grounded = d[9]! > 0.5;
        P.waterDepth = d[10]!;
        P.tool = d[11]!;
        P.speed01 = d[12]!;
        P.lookTargetId = d[13]!;
        P.valid = true;
      }
    }
  }
}

const EMPTY_EVENTS: GameEvent[] = [];

function banner(kind: BridgeKind, msg: string): void {
  const css =
    kind === 'wasm'
      ? 'background:#2e9e6b;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700'
      : 'background:#ff7a6b;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700';
  console.info(`%c[bridge:${kind}] ${msg}`, css);
}
