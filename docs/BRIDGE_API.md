# Bridge API — Rust sim ⇄ JS (contract v1)

Authoritative and exact. Owner of this file: **foundation-rust**. Everything above the *Owner sections* is
foundation-rust's; each module owner edits **only its own section** at the bottom.
Source of truth in code: `crates/sim_core` (plumbing), `crates/bridge` (the `Game` class), `crates/sim_*` (modules).
Contract version: `CONTRACT_VERSION = 1` (`build_info().contract`). Changes are **additive** (new channels, columns in
*new* channels, commands, queries, events). Anything breaking bumps the version and is announced in `docs/REQUESTS.md`.

## 1. Build, load, verify

```powershell
. "E:\Pokemon+Minecraft+\tools\env.ps1"                       # Rust lives on E:
powershell -File tools/build-wasm.ps1 [-Release]              # -> web/src/wasm/pkg/{bridge.js,bridge_bg.wasm,*.d.ts}
node tools/smoke-wasm.mjs [--bench] [--expect-digest <hex>]   # 80 checks, non-zero exit on failure
cargo test --workspace                                        # native tests
cargo check --target wasm32-unknown-unknown -p bridge
```
`build-wasm.ps1` builds profile `wasm-dev` (opt-level 2, no LTO, incremental; cold 45 s, incremental ≈ 5 s) or `release`
(opt-level 3 + LTO, ≈ 95 s), runs `wasm-bindgen --target web` into a staging dir **outside** `web/`, then installs it:
by directory rename if possible, otherwise (Windows refuses to rename a directory a watcher holds open — the Vite dev
server does) by replacing each file with the atomic `ReplaceFile` API, `.wasm` first and `bridge.js` last. A reader never
sees a half-written file; a few ms of "new wasm + old glue" are possible in the fallback. Vite reloads on change.

```ts
import init, { Game, build_info } from './wasm/pkg/bridge.js';   // Vite resolves bridge_bg.wasm via new URL(...)
const wasm = await init();                  // InitOutput; `wasm.memory` is the WebAssembly.Memory (needed for views)
const game = new Game(seed >>> 0);          // generates the island, spawns player + creatures (≈ 40-75 ms)
// Node / tests: import { initSync } ...; const wasm = initSync({ module: fs.readFileSync('bridge_bg.wasm') });
```

## 2. `Game` (exactly these members; `bridge.d.ts` is generated from them)

| member | meaning |
|---|---|
| `new Game(seed: number)` | u32 seed → world. Same seed + same inputs ⇒ byte-identical channels (also native ⇄ wasm). |
| `tick(dt: number)` | once per rendered frame, `dt` real seconds: runs **0..5** fixed 60 Hz steps. `dt` is clamped to 0.1; NaN/negative/∞ count as 0. |
| `alpha(): number` | `0 ≤ α < 1`: progress between the last two steps; render `lerp(prev, cur, α)`. |
| `set_input(input: Float32Array)` | call before `tick`; layout §4; short/garbage arrays are sanitised. |
| `command(name, json): string` | mutate. Returns `{}` / a result object / `{"error":"..."}`. Afterwards all channels are re-published (no time passes), so the effect is visible at once. |
| `query(name, json): string` | read-only JSON for UI/HUD, or `{"error":"..."}`. |
| `channel_names(): string` | JSON array, registration order. |
| `channel_info(name): string` | JSON `{"ptr","prev_ptr","len","cap","stride","kind","version"}` or `{"error"}` (§6). |
| `drain_events(): Float32Array` | packed events (§7); clears the queue; returns a copy. |
| `save(): Uint8Array` | versioned + CRC-32 container (§9). **Empty array = failure** (logged). |
| `load(bytes: Uint8Array): boolean` | atomic: `false` ⇒ rejected, running game untouched. On `true` the world was rebuilt: **re-read `channel_info` (pointers changed)**. |
| `free()` | release the instance (each `Game` owns ≈ 1.3 MB of channel memory in wasm). |
| `build_info(): string` (free fn) | `{"contract":1,"bridge":"0.1.0","bevy_ecs":"0.19.1","debug_assertions":false}` |

Nothing reachable from JS panics on bad data: unknown names/JSON → `{"error"}`, `load` → `false`, input/`dt` sanitised.
A panic that still happens is a bug: it is logged with its source location to `console.error` (`[glimmerwick-sim] PANIC: …`)
and the instance is dead afterwards (wasm cannot unwind) — surface it as a fatal error. `log` output (`warn`/`error`/`info`)
goes to `console.*`.

## 3. Time, stepping, interpolation

* Fixed step = **60 Hz**: `STEP_NS = 16_666_667`, `SIM_DT = 1/60 s` (constant). The accumulator is integer nanoseconds: `tick(1/60)`
  forever yields exactly one step per tick. At most 5 steps per `tick`; surplus beyond one step is dropped (the sub-step phase is
  kept) and core event `core.frame_drop` carries the seconds lost.
* One step = one `App::update()`: `First → PreUpdate → … Update (SimSet::First → Env → Decide → Move → React → Last) → PostUpdate →
  SimPublish (channel writers) → Last`. Time in systems is `SimClock` (`tick`, `DT`); there is no wall clock and no `Instant`.
* **Interpolated channels** (`player`, `creatures`) are double-buffered: at the start of every step `prev := cur`, systems then rewrite
  `cur`; draw `prev + (cur − prev) · alpha()`. Records are matched **by index**; creatures are sorted by id and carry the id in column 0 —
  if `prev[i·16] !== cur[i·16]` snap instead of lerping. New records are mirrored into `prev` (no pop-in); teleports / `load` snap
  `prev := cur`. **Yaw columns must be lerped along the shortest arc** (wrap to ±π); discrete columns (anim state, flags, tool…) use `cur`.
* `tick` may run 0 steps (display faster than 60 Hz) — channels simply stay as they were, `alpha` advances.

## 4. Input — `set_input(Float32Array[16])`

| idx | meaning |
|---|---|
| 0 | `move_x` −1..1, right + (camera-relative) |
| 1 | `move_y` −1..1, forward + |
| 2, 3 | `look_dx`, `look_dy` px since the previous call (accumulated until a step consumes them) |
| 4 | `buttons` bitmask (held state): 1 jump · 2 interact · 4 sprint · 8 use_tool · 16 cancel · 32 menu · 64 build_toggle · 128 photo · 256 tool_next · 512 tool_prev |
| 5 | `camera_yaw` rad (three.js `camera.rotation.y`) — movement is camera-relative |
| 6 | `camera_pitch` rad · 7 `zoom` · 8-15 reserved (kept, unused) |

Edges are **latched**: a press+release between two steps is not lost (`pressed`/`released` live until a step consumed them), look deltas accumulate.
Send the *held* state every frame; the sim derives presses. `tool_next/prev` cycle tools 0-4 (net, rod, shovel, axe, watering can).

## 5. Conventions

Right-handed, **Y up**, metres; **+X east, −Z north** (the default three.js camera looks down −Z). **Entity yaw** (all `yaw` columns): facing =
`(sin yaw, 0, cos yaw)` ⇒ models whose front is **+Z** use `mesh.rotation.y = yaw`. **Camera yaw**: forward `(−sin, 0, −cos)`, right `(cos, 0, −sin)`.
`sun_dir` points **toward** the sun (moon = −sun_dir). Positions of characters are their **feet**.

## 6. Channels

`channel_info` JSON: `ptr`/`prev_ptr` byte addresses in `memory.buffer` (`prev_ptr = 0` ⇒ not interpolated), `len` valid **elements**, `cap` capacity in
elements, `stride` elements per record (`records = len / stride`), `kind` `f32|u32|u16|u8`, `version` (bumped by the owner when *static* content changes —
rebuild derived GPU data only when it differs). Storage is allocated once: **`ptr`, `prev_ptr`, `cap`, `stride`, `kind` never change for the life of a
`Game`** (until `load`), `len`/`version` do. All views must be rebuilt when `memory.buffer !== lastBuffer` (§11).

```ts
const CTOR = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };
function view(game: Game, memory: WebAssembly.Memory, name: string) {
  const i = JSON.parse(game.channel_info(name));
  const T = CTOR[i.kind as keyof typeof CTOR];
  return { info: i, cur: new T(memory.buffer, i.ptr, i.len), prev: i.prev_ptr ? new T(memory.buffer, i.prev_ptr, i.len) : null };
}
```

| channel | owner | kind | stride | cap (elements) | interp. | len now |
|---|---|---|---|---|---|---|
| `time` | sim_systems | f32 | 1 | 16 | no | 16 |
| `player` | sim_player | f32 | 16 | 16 (1 record) | **yes** | 16 |
| `creatures` | sim_creatures | f32 | 16 | 65 536 (4 096 records) | **yes** | 12·16 (grows with spawns) |
| `world.height` | sim_world | f32 | 1 | 16 384 | no | 16 384 |
| `world.biome` | sim_world | u8 | 1 | 16 384 | no | 16 384 |
| `world.dirty` | sim_world | u32 | 1 | 16 | no | 0 (chunk indices edited this step; cleared every step) |
| `flora` | sim_world | f32 | 8 | 65 536 (8 192 instances) | no | ≈ 1 900 |
| `props` | sim_build | f32 | 12 | 98 304 (8 192 props) | no | 0 |

**`time`** (16 f32): 0 `hours` 0-24 · 1 `day_index` · 2 `season` 0-3 (spring, summer, autumn, winter) · 3 `season_t` 0-1 · 4 `weather_kind`
(0 clear, 1 cloudy, 2 rain, 3 storm, 4 snow, 5 fog) · 5 `weather_intensity` 0-1 · 6 `wind_x` · 7 `wind_z` (m/s) · 8-10 `sun_dir` xyz · 11-15 reserved (0).
24 real minutes per day (1 game minute per real second), 7 days per season, a new world starts at 08:00, day 0.

**`player`** (1 record × 16, interpolated): 0-2 `pos` (feet) · 3-5 `vel` · 6 `yaw` · 7 `anim_state` (0 idle, 1 walk, 2 run, 3 jump/rising, 4 fall, 5 land,
6 swim_idle, 7 swim, 8 slide) · 8 `anim_t` s in state · 9 `grounded` 0/1 · 10 `water_depth` m of water above the ground at the feet · 11 `tool` 0-4 ·
12 `speed01` horizontal speed / sprint speed · 13 `look_target_id` (0 = none; the interactable the camera is aimed at) · 14-15 reserved.

**`creatures`** (n × 16, interpolated, **sorted by id ascending**): 0 `id` · 1 `species` (0 Puffbun, 1 Tidler, 2 Sprigfox) · 2 `variant` 0-2 · 3-5 `pos` ·
6 `yaw` · 7 `scale` · 8 `anim_state` (0 idle, 1 walk, 2 run, 3 notice, 4 sleep, 5 happy, 6 hop, 7 swim) · 9 `anim_t` · 10 `mood` 0 sad … 0.5 … 1 delighted ·
11 `emote` (0 none, 1 !, 2 heart, 3 zzz, 4 note, 5 ?, 6 sparkle) · 12 `flags` bitmask (1 asleep, 2 in water, 4 aware of player, 8 fleeing) ·
13 `target_id` (id it is looking at, usually the player's 1; 0 = none) · 14-15 reserved. Ids are exact in f32 up to 2²⁴.

**`world.height`**: `heights[z·size_x + x]` = ground height (m) at world `(origin_x + x·cell, origin_z + z·cell)` — samples sit on **vertices**, `size`
samples span `size−1` cells, bilinear in between, sea level `world.info.sea_level` = 0. **Read `size_x/size_z/cell/origin_*` from `world.info`, never hard-code.**
**`world.biome`**: same indexing, one `u8` per sample: 0 deep_water · 1 shallow_water · 2 beach · 3 meadow · 4 forest · 5 rock (names in `world.info.biomes`;
ids ≥ 6 are free for the world owner; existing ids never change meaning).
**`flora`**: `kind · x · y · z · yaw · scale · variant · state`, kinds 0 tree, 1 flower, 2 rock, 3 bush (`world.info.flora_kinds`); static, `version` bumps on change.
**`props`** — *provisional* (the build owner finalises; **stride 12 is fixed**): `kind · id · x · y · z · yaw · scale · variant · state · tint_r · tint_g · tint_b`.

## 7. Events — `drain_events(): Float32Array`

Packed stride **7**: `[kind, a, b, x, y, z, f] × n`. Kind ranges: **core 0-99 · world 100-199 · player 200-299 · creatures 300-399 · build 400-499 · systems 500-599**.
Queue holds 8 192 events between drains (`core.stats.events_dropped` counts overflow). Events are not saved and are cleared on `load`.
The full live table is `query("core.events")`. Current kinds (pos = `x,y,z`):

| kind | name | payload |
|---|---|---|
| 1 | `core.loaded` | a = restored tick (low 24 bits) — re-read channel infos |
| 2 | `core.frame_drop` | a = seconds of sim time dropped |
| 200 | `player.jump` | pos feet, f = take-off speed |
| 201 | `player.land` | a = impact speed m/s, pos feet |
| 202 | `player.splash` | a = impact speed (entered deep water), pos feet |
| 203 | `player.footstep` | a = biome id under the feet, b = 1 if sprinting, pos feet |
| 204 | `player.tool_changed` | a = new tool |
| 205 | `player.interact` | a = target id, b = tool, pos = target |
| 206 | `player.use_tool` | a = target id (0 none), b = tool, pos = feet |
| 300 | `creature.notice` | a = creature id, b = species, pos = creature, f = species |
| 301 | `creature.emote` | a = creature id, b = emote id, f = species, pos = creature |
| 302 | `creature.spawned` | a = id, b = species |
| 303 / 304 | `creature.sleep` / `creature.wake` | a = id, b = species |
| 500 | `sys.dawn` (06:00) · 501 `sys.dusk` (18:00) · 502 `sys.new_day` | a = day index |
| 503 | `sys.weather_changed` | a = target kind, b = target intensity |
| 504 | `sys.season_changed` | a = season, b = day index |

## 8. Commands and queries (JSON in → JSON out)

Names are namespaced. Arguments: an object (`""`/`null` = `{}`); unknown fields are ignored; wrong types → `{"error":"bad arguments for 'x': …"}`.
Result: the documented object, `{}` for "nothing to report", or `{"error":"…"}`. `f32` values may print widened (`0.8` → `0.800000011920929` when a
handler builds its result with `json!`); parse as numbers, never compare strings.

| command | arguments | result |
|---|---|---|
| `sys.set_time` | `{hours?: number (wraps into 0-24), day?: integer}` | `{hours, day}` |
| `sys.set_weather` | `{kind?: 0-5 \| "clear"\|"cloudy"\|"rain"\|"storm"\|"snow"\|"fog", intensity?: 0-1, auto?: bool (random weather, default false), instant?: bool (default true; false = ease)}` | `{kind, name, intensity}` |
| `sys.set_time_scale` | `{scale: 0-100}` (0 freezes the clock) | `{scale}` |
| `debug.teleport` | `{x, z, y?}` (clamped into the playable area; default `y` = ground, or the water surface in deep water) | `{x, y, z}` |
| `player.set_tool` | `{tool: 0-4}` | `{tool}` |
| `debug.spawn_creature` | `{species?: 0-2 \| "Puffbun"\|"Tidler"\|"Sprigfox", x?, z?, variant?: 0-2, count?: 1-1000}` — without `x,z`: in the species' habitat near the player; hard cap 4 096 creatures | `{id, ids: [...]}` |

| query | arguments | result |
|---|---|---|
| `world.info` | – | `{size_x, size_z, cell, origin_x, origin_z, sample:"vertex", sea_level, chunk, min_height, max_height, seed, spawn:{x,y,z}, bounds:{min_x,min_z,max_x,max_z}, biomes:[names], flora_kinds:[names], flora_count, version}` |
| `sys.time` | – | `{hours, day, season, season_name, season_t, time_scale, real_seconds_per_day, weather:{kind,name,intensity,target_kind,target_intensity,auto}, sun_dir:[x,y,z], wind:[x,z]}` |
| `player.info` | – | `{id, pos:[3], vel:[3], yaw, grounded, swimming, sliding, water_depth, anim_state, tool, look_target}` |
| `creature.info` | `{id}` | `{id, name, species, species_name, personality, variant, state, mood, emote, pos:[3], asleep}` |
| `creature.species` | – | `[{id, name, personality, habitat:[biome ids], swims, base_scale, variants}]` |
| `build.info` | – | `{props, stride, max_props}` |
| `core.digest` | – | `{digest: "<16 hex>", tick}` — FNV-1a over every channel's name, len and data (not versions): determinism fingerprint |
| `core.stats` | – | `{tick, entities, channels:[{name,kind,stride,cap,interpolated,len,version,doc}], channels_overflowed, events_dropped, commands, queries, save_sections}` |
| `core.events` | – | `[{kind, name, doc, domain}]` |

## 9. Save format

`save()` → one blob: `"GLMW"` · u16 container version (1) · u16 flags · u32 seed · u64 tick · i64 step accumulator ns · u16 section count · sections
(`u8 name_len, name, u16 version, u32 len, payload`) · CRC-32 of everything before it (all little-endian). Sections in load order: `core` (id counter),
`world`, `systems`, `player`, `creatures`, `build`. **Why:** the container is hand-rolled so it can be validated (magic, version, CRC, every length
bounds-checked) *before* anything is touched, skips unknown sections and keeps defaults for missing ones (forward/backward compatible); payloads are
**postcard** (serde): compact varints, deterministic bytes for equal state, tiny code, stable wire format. postcard is not self-describing, so each
section has its own `version`: typed sections reject other versions, `register_save_section_raw` receives the saved version to migrate.
`load` builds a fresh world from the saved seed, restores every section into it and only then replaces the running game (atomic). Measured: 1 917 bytes
with 15 creatures at tick 690 (≈ 100 B per creature). Not saved: input, events, interpolation buffers (snapped on load).

## 10. Measured numbers

Node 22 / V8 (same engine as Chrome), i7-12700H, `node tools/smoke-wasm.mjs --bench`; one `tick(1/60)` = exactly one step; 900 timed steps after 180 warm-up
steps, player walking (scripted input). Budget: ≤ 3 ms per step.

| build | wasm size | 12 creatures (mean / p50 / p95 / p99 / max, ms) | 2 000 creatures (same) |
|---|---|---|---|
| `wasm-dev` (opt 2) | 2 563 092 B (2.44 MB) | 0.022 / 0.015 / 0.064 / 0.154 / 0.337 | 0.363 / 0.341 / 0.570 / 0.726 / 1.245 |
| `release` (opt 3 + LTO) | 1 995 298 B (1.90 MB) | 0.009 / 0.007 / 0.016 / 0.062 / 0.114 | 0.220 / 0.205 / 0.336 / 0.415 / 0.519 |

`new Game(seed)` (generate 128² terrain + flora, spawn 12 creatures): 38-76 ms. Sizes are raw wasm-bindgen output (no `wasm-opt` installed). Bevy: `bevy_ecs` +
`bevy_app` **0.19.1** (`default-features = false, features = ["std"]`), not the umbrella crate: the umbrella with default features off still built for
wasm32 but gave 2.9 MB vs 1.0 MB for the spike, and `bevy_time::TimePlugin` panics on `Instant::now()` in wasm32-unknown-unknown. `glam 0.34` with `libm` +
`scalar-math`, `postcard`, `serde_json`.
**Determinism verified:** seed 42, 600 scripted ticks ⇒ digest `fb682ca886e0ef29` natively *and* in wasm (changes whenever gameplay changes; use
`--expect-digest` to compare after edits).

## 11. Gotchas

1. **`memory.grow` detaches every typed-array view.** Any call into wasm that allocates (spawn, query strings, `new Game`, `load`…) may grow memory. Compare
   `memory.buffer` with the one your views were built on and rebuild; a stale view has length 0. Channel *addresses* stay valid, only the `ArrayBuffer` changes.
2. After `load()` re-read **every** `channel_info` (pointers changed) and expect `version`s to have bumped.
3. Read `len` each frame (creatures spawn/despawn); never assume 12 creatures, never cache `len`.
4. Interpolating: shortest-arc for yaw; skip lerp when ids differ; don't lerp discrete columns; `prev` is empty for non-interpolated channels (`prev_ptr = 0`).
5. Don't `Float32Array`-view with an offset that is not a multiple of the element size (all `ptr`s are aligned for their `kind`).
6. `drain_events` returns a *copy*; `channel_*` views are *live* — copy data you need to keep across a tick.
7. Commands run between ticks (never inside one). `command()` republishes channels without advancing time.
8. A panic kills the instance (`RuntimeError: unreachable`); look for `[glimmerwick-sim] PANIC` in the console.
9. Several `Game`s may coexist in one module (they share the memory, ≈ 1.3 MB each); `free()` the old one when re-seeding.
10. Seeds are `u32` (`seed >>> 0`). The generated world depends only on the seed.
11. JSON floats come from f32 (see §8); ids in channels are f32 and exact up to 16 777 216.

## 12. Writing a module crate (Rust)

Model: **one `App::update()` = one 60 Hz step.** Put systems in `Update` ordered with `SimSet` (`First, Env, Decide, Move, React, Last`); put the code that copies ECS
state into channels in the **`SimPublish`** schedule (it also runs after start-up, after every command and after `load`); spawn in `Startup` ordered with
`StartupSet` (`World, Actors, Population`; ids are allocated in that order: player = 1). Do **not** use `FixedUpdate`/`Time` (no wall clock exists; adding systems to
a `Fixed*` schedule panics at build time). Depend only on `sim_core` (+ `bevy_ecs`, `bevy_app`, `serde`, `serde_json` for derives); share data through `sim_core`
types: `HeightQuery` (terrain height/normal/biome/water), `SpawnPoints`, `Environment` (time of day, sun, weather), `Input`, `EventBus`, `Id`/`IdIndex`,
`Position`/`Yaw`/`Velocity`/`Interactable`/`Player`, the `Interact` message.

```rust
pub const PICKUP: EventKind = EventKind::build(0);                          // 400 — range-checked at compile time
#[derive(Resource, Clone, Copy)] struct Chans { stats: ChannelId<f32> }

impl Plugin for MyPlugin {
    fn build(&self, app: &mut App) {
        let stats = app.register_channel::<f32>(                                       // CHANNEL (1 line + handle)
            ChannelSpec::records::<f32>("my.stats", 4, 64).interpolated().doc("a,b,c,d"));
        app.insert_resource(Chans { stats })
            .add_systems(Update, step.in_set(SimSet::Move))
            .add_systems(SimPublish, publish)                                          // writer: ch.writer(id).clear(); .extend_from_slice(&rec)
            .register_command("my.reset", |w: &mut World, a: ResetArgs| Ok(json!({ "ok": true })))   // COMMAND  (A: Deserialize, R: Serialize)
            .register_query("my.info", |w: &World, _: Value| Ok(json!({ "n": 3 })))                 // QUERY    (&World: read-only)
            .register_event(PICKUP, "build.pickup", "a = item id")                     // EVENT    (emit: bus.emit(PICKUP, a, b, pos, f))
            .register_save_section("my", 1, |w| MySave::capture(w), |w, s| s.restore(w));            // SAVE     (serde; raw variant migrates)
    }
}
// test: let mut sim = sim_core::Sim::build(1, |app| { app.add_plugins(MyPlugin); }); sim.tick(1.0 / 60.0); sim.query("my.info", "");
```
**Determinism rules** (tested by `crates/bridge/tests/contract.rs`): randomness only via `sim_core::Rng` (`app.sim_seed().rng("label")`, per-entity
`stream.split_u64(id)`); trig/exp/pow only via `sim_core::math` (libm — `f32::sin` differs between native and wasm); no `HashMap` iteration in sim logic; no `std::time`;
update entities from their own state + read-only inputs (query order must not matter); sort by `Id` wherever order is observable (channel records!); no `mul_add`.
**Performance**: no per-step allocation in hot systems (use `Local<Vec<_>>` scratch), channels are plain memcpy-able arrays, whole step ≤ 3 ms.
**Saves**: capture *everything* that influences the future (timers, rng states, ids); `load` must validate and return `Err` rather than panic; a restore replaces, never merges.

---
# Owner sections (append / edit only your own)

## world (owner: world — `crates/sim_world`)
*Now (round 1):* **1153 x 1153 samples @ 0.5 m** (world 576 m, origin (-288, -288), +X east, -Z north, sea level 0); `new Game` incl. flora + creatures takes 0.18-0.29 s in wasm-dev (world gen alone ~0.15 s native). Pipeline: 2 m coarse lattice (shoreline SDF of 4 land blobs - 2 coves + 3 islets, beach/shelf/cliff coast profile, hills, terrace mask, forest/flower masks, village + pond flattening) -> cubic B-spline upsample -> 0.5 m fine pass (3 terrace tiers 3.9/4.3/4.7 m with rounded lips, bumps, pond bowl, stream channels, village disc, paths) -> biome classification -> flora.
Layout (seed-jittered, fixed topology): main island ~300 x 235 m, NW highland with 3 cliff tiers facing W/SW and a walkable ramp on the E/NE flank (max height ~19-20 m), pond (~40 x 28 m, level ~5 m) fed by a stream from the highland foot, outflow stream to the SW cove, beach coves SW + SE, flattened village clearing (r = 21 m) east of the pond with 5 dirt paths, islets E (sand + palms), SW (tiny), N (rocky).
Channels (names/kinds unchanged, caps raised): `world.height` f32 and `world.biome` u8 len = cap = 1 329 409 · `world.dirty` u32 cap 361 (19 x 19 chunks of 64 cells = 32 m, row-major; still never written) · `flora` f32 stride 8, cap 262 144 (32 768 instances), ~2 300 now. Biome ids 0-11 and flora kinds 0-127 exactly per WORLD_CONTRACT.md (snow 11 unused; pond/stream beds + banks = 8).
`world.info` (contract shape, resolves REQUESTS #2): `size_x,size_z` = **metres** spanned (576) · `nx,nz` = sample counts (1153) · `cell` 0.5 · `origin_x/z` -288 · `sample:"vertex"` · `sea_level` · `chunk` = **cells** per chunk edge (64) · `min_height,max_height,seed` · `spawn:{player:[x,z],village:[x,z],x,y,z}` (x,y,z kept for old readers) · `habitats:{biome_name:[[x,z,r],...]}` · `bounds` · `biomes` (12 names) · `flora_kinds` (128 entries indexed by kind id, "" = unused) · `flora_count` · `version`; extras: `water:{sea,pond:{x,z,rx,rz,rot,level},streams:[{pts:[[x,z,half_width,level],...]}]}` (0 = highland spring -> pond, 1 = pond -> sea; level never rises along the flow) · `village:{x,z,r,h}` · `paths:[[[x,z],...],...]` (0 pond, 1 east beach, 2 SE cove, 3 north, 4 highland ramp) · `islets:[[x,z,r],...]` · `highland:[x,z,r]`.
*Caveats:* pond/stream water above sea level is **visual only** (`HeightQuery::water_depth` = sea_level - ground; see REQUESTS `Terrain::water_surface`). `sim_core::terrain::biome` consts are stale beyond id 4 (ROCK = 5): sim_world uses its own `sim_world::biome::*`. `world.edit` + dirty chunks are not implemented yet. The channel table in section 6 still lists the old world caps.
*Must keep:* channel names/kinds/layouts, contract biome ids + flora kinds, vertex sampling, determinism (IEEE ops + `sim_core::math` only), `HeightQuery` semantics. Tests: `cargo test -p sim_world` (12: determinism, topography, stream monotone, walkable-start BFS to village/beach/pond/plateau, flora rules); `cargo test -p sim_world preview -- --ignored --nocapture` writes `shots/world/r1/map_seedN.png`. Notes: _(world appends here)_

## characters (owner: characters — `crates/sim_player`, `crates/sim_creatures`)
*Now:* player = pure kinematic controller `sim_player::step_body` over `Body` (camera-relative move, smoothing, jump with coyote 0.12 s + buffer 0.12 s, gravity 22, walk 4.2 / sprint 7 m/s,
slope limit 46° with sliding, wading slow-down, swimming when water > 1 m with a damped-spring float, edge clamp), tunables in resource `PlayerTuning`; `PlayerBody` is authoritative,
`Position/Velocity/Yaw` on the player entity are mirrors. Creatures = 12 placeholders (5 Puffbun meadow/curious, 4 Tidler beach+shallows/playful/swims, 3 Sprigfox forest/shy), states
Idle/Wander/Notice/Approach/Flee/Play/Sleep/Happy in `sim_creatures::think` (pure fn; per-entity `CreatureRng`; never reads other creatures), `Interact` message ⇒ happy + heart, sleep at night.
*Must keep:* `player` and `creatures` column layouts, enum ids (anim states, emotes, flags, species ids — extend, never renumber), creatures sorted by id, events 200-206 / 300-304 payloads,
`debug.teleport`, `debug.spawn_creature`, `player.set_tool`, `creature.info`/`creature.species`, the `Player` marker and `Interactable` component. New per-creature data ⇒ **new documented channels**
(e.g. `creatures.ext`), never new columns in existing ones. Notes: _(characters appends here)_

## build (owner: build — `crates/sim_build`)
*Now:* empty plugin: channel `props` (stride 12, cap 8 192 props, static, `version` bumps on change), resource `Props { records }`, query `build.info`, save section `build` (raw records), publish-on-change.
*Must keep:* stride 12 and the name `props`; finalise the column layout (provisional one in §6) and document it here. Expected commands: `build.place`, `build.remove`, recipes/crafting queries. Notes: _(build appends here)_

## systems (owner: systems — `crates/sim_systems`)
*Now:* `GameTime` (f64 total hours, `time_scale`), `WeatherState` (eased kind/intensity, optional `auto` random weather from its own Rng stream), `compute_environment` → `Environment` resource +
`time` channel; commands `sys.set_time`, `sys.set_weather`, `sys.set_time_scale`; query `sys.time`; events 500-504; save section `systems`. 24 real min/day, 7 days/season.
*Must keep:* the `time` layout, `sun_dir` meaning (toward the sun, +X east at 06:00), weather kind ids, event payloads. Economy / quests / villagers / entitlements go in new channels/queries/commands under `sys.*`.
Notes: _(systems appends here)_
