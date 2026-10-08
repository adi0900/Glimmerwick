# Architecture & Collaboration Contract

Project root: the repository root (if your checkout path contains special characters such as `+`, quote it; if some tool chokes on it, tell the orchestrator).
Game: **Glimmerwick** (see GAME_DESIGN.md). Look: ART_BIBLE.md. Bar: QUALITY_BAR.md.

## 1. Stack
- **Rust sim = Bevy ECS running headless inside WASM.** No Bevy rendering/windowing/audio. Bevy is the game's brain:
  entities, systems, schedules, AI, physics, world data, save/load. Rust 1.99 (E:\RustToolchain), Bevy 0.19.x stable
  (`default-features = false`, add only what's needed; if the umbrella crate misbehaves on wasm32 use `bevy_ecs`/`bevy_app`/`bevy_time`/... directly),
  wasm-bindgen 0.2.129 (+ matching CLI already installed), glam, serde, rapier3d 0.36 (physics, optional per owner).
- **Three.js (WebGL2) = the renderer, UI host and audio host.** three 0.186, `postprocessing` (pmndrs) 6.x, Vite, TypeScript, Tone.js (optional audio).
- **All versions are newer than model training data.** Never rely on memory for APIs: read the real sources
  (`E:\RustToolchain\cargo\registry\src\*\<crate>-<ver>\`, `web\node_modules\<pkg>`), docs.rs, or search the web. Expect renames (e.g. Bevy events → messages).
- Dev machine: Windows 11, i7-12700H, RTX 3060 Laptop (+ Intel Iris Xe). Headless Chrome/Edge render real GPU WebGL2 (verified).

## 2. Layout & ownership (edit ONLY what you own)
```
Cargo.toml (workspace)                      foundation-rust
crates/sim_core      shared types, registries, bridge plumbing         foundation-rust
crates/sim_world     islands, heightfield, biomes, water, placement     world
crates/sim_player    player entity, controller, tools                   characters
crates/sim_creatures Glimmer species, AI, needs, bonding, dex           characters
crates/sim_build     blocks/furniture/crafting                          build        (wave 2)
crates/sim_systems   time, weather, economy, quests, save               systems      (wave 2)
crates/bridge        cdylib + wasm-bindgen API                          foundation-rust
web/index.html, package.json, vite.config.ts, src/main.ts, src/engine/**   foundation-web   (EXCEPT: engine/Materials.ts, Post.ts, Lighting.ts, glsl/** = look)
web/src/modules/<name>/**                   the module's owner (world, look→atmosphere, flora, characters, fx, ui, audio, build, ...)
tools/                                      foundation-web (shot.mjs, ab.mjs, dev.ps1) + foundation-rust (build-wasm.ps1, smoke-wasm.mjs)
docs/                                       orchestrator; docs/BRIDGE_API.md = foundation-rust (each owner appends/edits only its own section); docs/critiques/** = critics
shots/<module>/r<N>/  ab/                   generated, git-ignored
```
Need a change in a file you don't own? Append to `docs/REQUESTS.md`, use a local workaround, keep going.

## 3. Rust rules
- Headless, single-threaded (wasm). Never use `std::time::Instant/SystemTime` (panics on wasm32-unknown-unknown); time is driven by `dt` from JS.
- **Fixed timestep 60 Hz** accumulator inside `Game::tick(dt)` (max 5 steps per call, dt clamped ≤ 0.1). Interpolated channels are double-buffered.
- **Deterministic:** all randomness through `sim_core::Rng` (seeded, splittable per system); stable iteration order (sort by entity id / use BTreeMap or IndexMap); same seed + same inputs ⇒ byte-identical channels. Tested natively.
- Each domain crate exposes `pub struct XxxPlugin;` (`impl Plugin`) and depends only on `sim_core` (cross-module data flows through `sim_core` resources/traits, e.g. `HeightQuery`, so crates compile independently).
- Modules register things in ≤ 10 lines via `sim_core` registries: channels, commands, queries, events, save sections (see docs/BRIDGE_API.md once written).
- Native tests: `cargo test -p <crate>`; wasm check: `cargo check --target wasm32-unknown-unknown -p bridge`.
- Budgets: whole sim step ≤ 3 ms typical; no per-step allocation in hot systems; channel writes are plain memcpy-able arrays.

## 4. Bridge contract v1 (Rust ⇄ JS) — foundation-rust turns this into docs/BRIDGE_API.md (exact, authoritative)
`bridge` exports via wasm-bindgen (`--target web`), class **Game**:
```
new(seed: u32)
tick(dt: f32)                         once per rendered frame; runs 0..5 fixed steps
alpha() -> f32                        0..1 progress between the last two fixed steps (render interpolation)
set_input(input: Float32Array)        call before tick; layout below
command(name: &str, json: &str) -> String   mutate sim; returns JSON ("{}" or {"error":"..."}); names namespaced "player.*", "build.*", "sys.*", "debug.*"
query(name: &str, json: &str) -> String     read-only JSON for UI/HUD ("inventory", "dex", "world.info", ...)
channel_names() -> String             JSON array
channel_info(name: &str) -> String    JSON {"ptr","prev_ptr"(0 if not interpolated),"len","cap","stride","kind":"f32|u32|u16|u8","version"}
drain_events() -> Float32Array        packed stride 7: [kind,a,b,x,y,z,f]*n  (kind ranges: core 0-99, world 100-199, player 200-299, creatures 300-399, build 400-499, systems 500-599)
save() -> Uint8Array ; load(bytes) -> bool
```
Channels are flat typed arrays in WASM memory rewritten by Rust every fixed step. `len` = valid *elements*. `version` bumps when layout/static
data changes (terrain edited, flora regrown) so JS can skip rebuilds. JS must rebuild typed-array views when `memory.buffer` changes (Bridge wrapper does it).

Input `Float32Array[16]`: 0 move_x(-1..1, right+) · 1 move_y(-1..1, forward+) · 2 look_dx · 3 look_dy (px since last call) ·
4 buttons bitmask (1 jump, 2 interact, 4 sprint, 8 use_tool, 16 cancel, 32 menu, 64 build_toggle, 128 photo, 256 tool_next, 512 tool_prev) ·
5 camera_yaw (rad; movement is camera-relative) · 6 camera_pitch · 7 zoom · 8-15 reserved.

Core channels (stable names; owners may add more and document them):
| name | owner | kind | layout |
|---|---|---|---|
| `time` | sim_systems | f32 | 0 hours(0-24) · 1 day_index · 2 season(0-3) · 3 season_t(0-1) · 4 weather_kind(0 clear,1 cloudy,2 rain,3 storm,4 snow,5 fog) · 5 weather_intensity · 6 wind_x · 7 wind_z · 8-10 sun_dir xyz |
| `player` | sim_player | f32, interpolated | 0-2 pos · 3-5 vel · 6 yaw · 7 anim_state · 8 anim_t · 9 grounded · 10 water_depth · 11 tool · 12 speed01 · 13 look_target_id · 14-15 reserved |
| `creatures` | sim_creatures | f32, interpolated, stride 16 | 0 id · 1 species · 2 variant · 3-5 pos · 6 yaw · 7 scale · 8 anim_state · 9 anim_t · 10 mood · 11 emote · 12 flags · 13 target_id · 14-15 reserved |
| `world.height` | sim_world | f32 grid | N×N row-major metres; metadata via `query("world.info")` = {size_x,size_z,cell,origin_x,origin_z,sea_level,chunk,...} |
| `world.biome` | sim_world | u8 grid | biome id per cell |
| `world.dirty` | sim_world | u32 | chunk indices edited since last tick |
| `flora` | sim_world | f32, stride 8 | kind · x · y · z · yaw · scale · variant · state (static; changes bump `version`) |
| `props` | sim_build | f32, stride 12 | placed blocks / furniture |

## 4b. Voxel world contract (v2, 2026-10-06, supersedes the heightfield *terrain* model)
`sim_world` owns a chunked **voxel world** (terrain, cliffs, trees, houses, paths are all blocks). Block registry in `sim_core::blocks` (id `u16`, name, solid/transparent/liquid, light emission, texture slots, hardness, drops). Suggested chunk = 16×16 columns × full height (≤ 64). `HeightQuery` stays (top solid surface) for AI/spawns; the player uses **voxel AABB collision** (MOVEMENT_SPEC.md).
Channels (owner sim_world; exact layout goes in BRIDGE_API.md): `vox.chunks` (chunk directory + versions), `vox.data` (u16 block ids per chunk) **or** Rust-meshed `vox.mesh.*` buffers — the voxel-world owner picks one and documents it; `vox.dirty` (chunk ids edited since last tick). `world.height` / `world.biome` remain as derived read-only channels until every consumer has migrated.
Commands `world.set_block|break_block|place_block|fill`; queries `world.block`, `world.raycast`, `world.blocks` (registry for the atlas); event `world.block_changed`. Edits remesh only dirty chunks (< 4 ms each); saves store only edited chunks.
Ownership additions: `crates/sim_core/src/blocks.rs` + `web/src/modules/voxel/**` (meshing, procedural atlas, bevel/AO shader, water) → **voxel-world**; later `web/src/modules/voxel-flora/**` → voxel-flora; `web/src/modules/creatures/**` → voxel-creatures; `web/src/modules/player/**` + camera → movement. `web/src/modules/world/**` (old smooth terrain/water) is replaced and deleted once the voxel module reaches parity (git history keeps it).

## 5. Web engine (foundation-web builds it; look owns Materials/Post/Lighting/glsl)
- Auto-discovery: every `web/src/modules/<name>/index.ts` default-exports a `GameModule` (loaded via `import.meta.glob`, no shared registry file to edit):
```ts
interface GameModule { name: string; order?: number /*default 100*/; needs?: string[];
  init(ctx: Ctx): void|Promise<void>; update?(ctx: Ctx, dt: number): void; onEvents?(ctx: Ctx, ev: GameEvent[]): void;
  gallery?: { cams: Record<string,{pos:[number,number,number],target:[number,number,number],fov?:number}>; setup?(ctx: Ctx): void; };
  dispose?(): void }
```
  `Ctx` = { game(Bridge), renderer, scene, camera, post, mats, uniforms (shared: uTime,uSunDir,uSunColor,uWind,uPlayerPos,uTimeOfDay,uSeason,uRain…), clock{t,dt,frame}, quality, view, rngFor(name) }.
- Views: `/?view=game` (all modules) · `/?view=<module>` (that module + its `needs` + engine). Params: `seed, time(hours), weather, cam(preset), q(low|med|high|ultra), w, h, freeze=1, mock=1`.
- Photo API on `window.__game`: `ready:boolean, view, stats(){fps,ms,calls,tris,geoms,textures,heapMB}, setTime(h), setWeather(kind,intensity), freeze(b), setCam(name|{pos,target,fov}), cams():string[], step(n), settle(n), seed`.
- Renderer: WebGL2, `powerPreference:'high-performance'`, DPR cap 2, sRGB output, shadows PCFSoft/VSM fitted to camera, tone mapping inside the post stack.
- `shots.json` convention: each module ships `web/src/modules/<name>/shots.json` = array of `{id, cam, time?, weather?, seed?, size?, filmstrip?:{frames,interval}}`; `node tools/shot.mjs --pack <name> --round N` renders them to `shots/<name>/rN/`.

## 6. Tools (Windows; PowerShell 5.1 primary — no `&&`; quote paths; use `curl.exe`)
- Rust env: `. .\tools\env.ps1` (PowerShell) or `source tools/env.sh` (Git Bash) before cargo/wasm-bindgen.
- `tools/build-wasm.ps1 [-Release]` → builds `bridge`, runs wasm-bindgen into `web/src/wasm/pkg/` via atomic swap (never leaves a half-written pkg).
- Dev server: **http://localhost:5173** is kept running by the orchestrator (`preview_start web`). If it is down: `curl.exe -s -o NUL -w "%{http_code}" http://localhost:5173`, then ask the orchestrator in your report rather than starting servers.
- `node tools/shot.mjs --view V --cam C [--time H --weather K --seed S --size 1920x1080 --settle 90 --out FILE] [--filmstrip N --interval MS] [--crop x,y,w,h --zoom Z] [--pack M --round R]` → PNG(s) + one JSON line (fps, frameMs, drawCalls, triangles, consoleErrors, pageErrors).
- `node tools/ab.mjs make --ours FILE [--ref FILE|random] --id ID` / `reveal --id ID --pick left|right` — blind A/B (see QUALITY_BAR.md).

## 7. Performance budgets (RTX 3060 Laptop, 1080p, High)
60 fps · ≤ 1200 draw calls · ≤ 2.5 M triangles on screen · JS heap ≤ 800 MB · first interactive ≤ 8 s · sim step ≤ 3 ms. A `low` preset must hold ≥ 30 fps on Intel Iris Xe.

## 8. Collaboration protocol
1. Edit only files you own. Cross-module needs → `docs/REQUESTS.md`.
2. **Never run state-changing git commands** (add/commit/checkout/reset/stash/clean). The orchestrator snapshots after each round.
3. The tree is shared and live. Keep it compiling/running: edit in coherent chunks, re-check your area after each batch, never leave syntax errors for more than a couple of minutes.
4. Output screenshots only under `shots/<your-module>/r<N>/`.
5. New dependencies: allowed if truly needed (`npm install <pkg>` from `web/`; Cargo deps in your own crate's Cargo.toml) — list them in your report. Never run two package installs at once; check `package.json` first.
6. No long-lived background processes of your own (they die with you and confuse others). No extra dev servers.
7. Final report to the orchestrator ≤ 300 words: what you built · how to view it (URL/cam presets) · known gaps · files touched · REQUESTS you filed.
8. Quality first: you will be judged by a *harsh independent critic* against the polish of the best first-party cozy-adventure games (QUALITY_BAR.md). Do not hide weaknesses with camera angles or fog; fix them.
