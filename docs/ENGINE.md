# Web engine (foundation-web) — how to build on it

Vite + TypeScript + three r186 (WebGL2) + pmndrs `postprocessing`. Sources: `web/src/engine/**` (owners: foundation-web; **look** owns `Materials.ts`, `Post.ts`, `Lighting.ts`, `glsl/**`).
Run: dev server `http://localhost:5173` (`tools/dev.ps1`, or `.claude/launch.json` config `web`). The `+` in the project path is fine for Vite/rolldown/puppeteer (tested): no junction needed.
Typecheck: `cd web; node node_modules/typescript/bin/tsc --noEmit` (TypeScript 7, ~0.4 s).

## Views and URL params
`/?view=game` = every module · `/?view=<module>` = that module + its `needs` (the **gallery**; `gallery.setup` runs, first cam is applied, time is held at 16:30 and weather clear unless told otherwise, drag = orbit, wheel = dolly, right-drag/shift = pan, F4 = lil-gui, F3 = overlay).
| param | meaning |
|---|---|
| `seed` `time`(16.5 or 16:30) `weather`(rain, rain:0.7, 0-5) `wi` | world seed · hour · weather kind (+intensity) |
| `cam` | preset name · `game`/`follow` (no override) · `camPos=x,y,z&camTarget=x,y,z&fov=` free camera |
| `q` low/med/high/ultra, `w` `h` | quality preset · fixed canvas size (CSS px) |
| `freeze=1` | dt = 0 (sim + animation + `uTime`) — deterministic shots · `mock=1` force MockGame |
| `with=a,b` `without=a,b` | add/remove modules in any view (e.g. `view=game&without=_slice`) |
| `hud=1&stats=1&gui=1` | overlay / panel (hidden in automated runs by default) |
| `tm=agx\|neutral\|aces` `exposure=` `post=0` `msaa=` `dpr=` `shadows=0` `bloom=0` `ao=0` `tilt=0` `smaa=1` | debug overrides |
| `set=post.bloomIntensity:0.3,light.exposure:1.1,light.fogScale:0.2` | tweak `Post.params` / `Lighting.tuning` from the URL |

## A module = `web/src/modules/<name>/index.ts` (auto-discovered, nothing to register)
```ts
import { defineModule } from '../../engine/types';
export default defineModule({
  name: 'flora', order: 100, needs: ['world'],
  init(ctx) { /* build meshes, ctx.scene.add(...) */ },
  update(ctx, dt) { /* dt is 0 while frozen */ },
  onEvents(ctx, ev) {}, onResize(ctx, w, h) {}, onQuality(ctx, q) {}, dispose() {},
  gallery: { cams: { hero: { pos: [0, 8, 14], target: [0, 1, 0], fov: 50 } }, setup(ctx) {} },
});
```
`ctx` = `game`(Bridge) `renderer scene camera post mats lighting uniforms env clock{t,dt,frame,alpha,frozen} quality view input debug rngFor(name) bend(x,y,z,r) api`.
Share services with `ctx.api.world = {...}` (or interface-augment `Ctx`). `ctx.debug.gui().addFolder('x')`, `ctx.debug.line('k', () => 'text')` (F3). Camera: your follow-cam writes `ctx.camera`; a gallery/photo camera overrides it afterwards (no cooperation needed). Errors in a module are caught, logged once (rate-limited) and counted — they never stop the loop.
Put `shots.json` next to it: `[{ "id":"hero","cam":"hero","time":16.5,"weather":"rain:0.8","seed":1,"size":"1280x720","filmstrip":{"frames":8,"interval":120} }]`. Delete `modules/_slice` when the real modules exist.

## Bridge (`ctx.game`) — mock or real wasm, same API
`kind` 'wasm'|'mock' (logged loudly; F3 shows it) · `channel(name)` → live `Channel`: `.data .prev .len .stride .count .ver`; **re-read `.data` every frame** (wasm memory grows) · `ch.lerpRows(ctx.clock.alpha, out, {idField, angleFields})` · `command(name,args)` / `query(name,args)` → parsed JSON · `drainEvents()` is done by the engine (`onEvents`) · `time` and `player` (already interpolated) mirrors · `world`: `ready info sample(x,z) normal() biomeAt() waterDepthAt() version`.
The mock mirrors the core channels (time, player, creatures, world.height/biome, flora) in a fake `WebAssembly.Memory` and the real command names: `sys.set_time {hours,day}`, `sys.set_weather {kind,intensity}`, `sys.set_time_scale {scale}` (0 pins the clock), `debug.teleport`, query `sys.time`, plus mock-only `debug.grow_memory`. Galleries pin the hero hour through them (`__game.setTime(h)` = `sys.set_time` + clock pin); `ctx.env` is the channel plus a JS-side fallback override used only when a sim answers "unknown command", so **read `ctx.env` / `ctx.uniforms`, not the raw `time` channel, for visuals**. `bridge.eventName(kind)` resolves event ids via `core.events`.
Conventions: Y up, 1 unit = 1 m; `yaw` rotates about +Y, model forward = (sin yaw, cos yaw); camera forward = (−sin yaw, −cos yaw) (`ctx.input.yaw/pitch/zoom` are integrated from look deltas and sent as input[5..7]).

## Look API (v1 by foundation-web, owned by look)
- `ctx.mats.clay|foliage|stone|wood|lacquer|glow|ground(color, opts)` / `toon({cls,...})` → patched `MeshToonMaterial` ("ToonLit"): soft 3–4 band ramp, cool shade colour, warm rim, hand-painted albedo (`gw_paint`), fog, weather (wetness/snow), cloud-shadow hook, wind + grass benders (`wind:{amp,height}`, `bend:true`), instancing-safe. Call `ctx.mats.prepare(mesh)` (shadow flags + wind-aware shadow depth material). Knobs live in `m.userData.gw.uniforms`.
- GLSL snippets are `ShaderChunk`s: `#include <gw_noise|gw_fbm|gw_worley|gw_curl|gw_hash|gw_toon|gw_fog|gw_paint>` (include-guarded, any order).
- Shared uniforms (WORLD_CONTRACT.md): `uTime uSunDir uSunColor uSunIntensity uSkyZenith uSkyHorizon uHemiSky uHemiGround uFogColor uFogDensity uWind uWindTime uPlayerPos uTimeOfDay uNight uSeason uSeasonT uRain uSnow uWetness uCloudShadowTex uCloudShadowParams uWorldSize uBenders[16]`. Capture the `{value}` holders into your own materials; never replace them.
- Lighting: one `SunLight` (2 fitted cascades, PCF) + hemisphere, colour script of ART_BIBLE §2 (Hermite-interpolated), sun↔moon swap with an intensity dip, sky dome (gradient, sun, moon, stars, placeholder clouds), `FogExp2` kept in sync with ToonLit's fog. `Lighting.tuning` / `Post.params` are the look knobs. Post: HDR → [tilt-shift] → AO (custom depth-only) → bloom + tone map (Neutral) + violet grade/vignette → FXAA/SMAA; MSAA 0/2/4/8 by preset.
- Quality presets (`ctx.quality`): numeric hints `grassDensity drawDistance particleScale waterQuality detail` — scale your cost by them; `onQuality` fires on change.

## Taking shots (real GPU, headless Chrome; needs the dev server)
`node tools/shot.mjs --view _slice --cam wide [--time 16.5 --weather rain --seed 1 --size 1280x720 --q high --settle 90 --out F --filmstrip 8 --interval 120 --crop x,y,w,h --zoom 3 --cam-pos x,y,z --cam-target x,y,z --fov 50 --mock --hud --serve --verbose]` · `--pack <module> --round N` → `shots/<module>/rN/`. One JSON line on stdout: `fps frameMs cpuMs gpuMs drawCalls triangles consoleErrors pageErrors bridge …`; exit 1 on console/page errors. `fps` = rAF rate (display-capped, 144 here); `frameMs` = uncapped CPU+GPU per frame; `gpuMs` = timer-query median. Draw calls / triangles include the shadow cascades.
`node tools/ab.mjs make --ours F --ref random --id a1` → `ab/a1.png` (random side, sealed key); `reveal --id a1 --pick left|right|close` → `docs/ab_results.json`; `status`.
In the page: `__game` (photo API: `ready stats() setTime() setWeather() freeze() setCam() cams() setQuality() step(n) settle(n) bench(n) errors()`) and `__gw.{ctx,bridge,engine}` for the console.

## Input map (`Input.ts` → `Float32Array[16]`)
WASD/arrows move · mouse drag or pointer-lock look · wheel zoom · Space jump · Shift sprint · E/Enter interact · F or click(locked) use tool · Q/R tool prev/next · B build · P photo · Tab menu · Esc cancel · gamepad (sticks, A/B/X/Y, bumpers, triggers) · touch (left stick, right look, Jump/Use buttons). `ctx.input.enabled=false` while menus are open; `ctx.input.onFirstGesture(cb)` for audio unlock.

## Gotchas
- Vite reloads open pages when files change (also when a wasm rebuild rewrites `src/wasm/pkg`); shot.mjs forgets errors from replaced documents.
- ToonLit patches three's toon shader by string replace; a three upgrade that renames chunks logs `ToonLit patch failed` loudly.
- `renderer.info.autoReset` is off (the composer renders many times per frame); the engine resets it per frame.
- Frozen = deterministic: `settle(n)` renders n frames with dt 0; `step(n)` advances n fixed frames then renders; `bench()` advances the sim.
- Geometry attributes for ToonLit instancing: use `InstancedMesh` + `setColorAt`; wind weight = height/`windHeight`, or an `aSway` float attribute with `wind:{attr:true}`.
- The in-engine Rust sim is optional: no pkg ⇒ MockGame automatically (console warning); present-but-broken pkg ⇒ console error + MockGame.

## Voxel round 2 - look-file changes made by voxel-world (no look agent was active)
- `Lighting.ts`: `tuning.fogScale` 0.24 -> 0.09 (milky haze); `lookState.hint` = external DOF focus distance in metres (0 = none). `Lighting.follow` uses it before the flat-ground guess; the voxel module writes the exact view-ray hit distance (`world.raycast`), so close-ups and ground-level cams focus on what they look at.
- `Post.ts` (DOF): near blur only within ~0.15 x focus (1.5-5 m, was 0.3 x focus); far blur starts at >= 16 m; the tilt-shift band widens to ~97 % of the frame when the focus is close (< 6 m) and returns to `tiltFocus` beyond 40 m; sky pixels get 25 % of the tilt blur (clouds stay crisp); AO defaults `aoIntensity` 1.35 -> 1.0 and `aoStrength` 0.85 -> 0.55 (the voxel shader already has per-vertex AO; the screen-space pass double-darkened cliff / dirt faces).
- Gotcha: shots are only comparable at an explicit `q=high` (the default quality can fall back under load; tall contact sheets also posterise when composited, look at the individual PNGs).
