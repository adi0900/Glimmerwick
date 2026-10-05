# Orchestration ledger (orchestrator-owned — durable state across context resets)

Decisions from the user: Rust on `E:\RustToolchain` (not on PATH) · project at `E:\Pokemon+Minecraft+` · GitHub repo https://github.com/adi0900/Glimmerwick (public) · **staged waves** (≤ 2 concurrent builders; pause when plan limits hit, resume after reset — see "Usage pacing") · blind A/B reference screenshots: **not yet provided** (`reference/` empty → critics rubric-only until then).
Round policy: builder → separate harsh critic (`docs/CRITIC_PROMPT.md`) → same builder continued with the critique … max 6 rounds/module, PASS = all axes ≥ 9 (QUALITY_BAR.md), plateau rule escalates.
**User priority 2026-10-06: "the movements are stiff" → movement initiative comes before more content.**

## Infrastructure
- GitHub origin/main; orchestrator pushes at milestones via `tools/push.ps1` (uses the user's existing `gh` login). History was rewritten once before the first push so earlier plan/usage notes never went public.
- Dev server: orchestrator background task (`node web/node_modules/vite/bin/vite.js web --port 5173 --strictPort --host 127.0.0.1`, 2 h timeout — restart when it ends). Builders/critics fall back to `shot.mjs --serve`. In-app Browser pane is open on http://localhost:5173/?view=game (preview_start can't see the project's launch.json — MCP cwd is the old scratch dir; use `preview_start url=…`).
- Tests: `cargo test --workspace` (139 pass) · `node tools/smoke-wasm.mjs` (81 checks) — both green as of Wave 1a round 1.

## Done
- Wave 0 foundation (rust 519ec4c-equivalent, web 7e32f1c-equivalent; bevy_ecs+bevy_app =0.19.1 headless).
- Wave 1a round 1 builders: **look** (clouds, sky haze, cloud-shadow tex, AO fix, DOF/outlines/grade, ToonLit paint) and **world** (576 m world @ 0.5 m, 300×235 m island: highland tiers, pond+stream, coves, village, islets; chunked terrain w/ 4 LODs, splat shader, water, horizon). Critics NOT yet run.

## Round-2 TODO lists (from builder self-reports; critics will add more)
- look: night is dark/flat (no moonlit rim, fireflies), clouds paper-flat/weak silver lining, cirrus scratches, hero haze pale, sunset disc only ~18:10 (sim sun below horizon at 18:30 — align with systems), outlines depth-only (foliage inner contours), cloud shadows barely visible on terrain, weather + cascade shadows not started, DOF X3595 warning.
- world: sand dull salmon, forest flat dark-teal, village clearing barely reads, cliff strata blurry, horizon islands flat violet/orange blobs, no sea refraction/wave displacement, pond milky/pale, `world.edit` + dirty chunks, LOD seam checks, inland water in sim (`Terrain::water_surface`), 14 of 17 shots never inspected by the builder.

## Movement initiative (starts after the usage window resets ≈ 03:50 IST; brief `docs/briefs/movement.md`, protocol `docs/CLEANROOM.md`)
| step | who | output |
|---|---|---|
| M1 | analyst A (cold agent) | `docs/specs/MOVEMENT_SPEC.md` — Minecraft-style player movement from PUBLIC behaviour docs only (facts, formulas, test vectors) |
| M2 | analyst B (cold agent, parallel) | `docs/specs/CREATURE_LOCOMOTION_NOTES.md` — concepts from the open-source Cobblemon repo (gitlab.com/cable-mc/cobblemon, MPL-2.0 code; assets are non-commercial + Pokémon IP → never used) |
| M3 | implementer (separate agent; sees specs only) | controller + camera rig + avatar animation + creature locomotion, tests from test vectors, tuning panel |
| M4 | feel critic | filmstrips + traces → critique |
Then look + world critics (round 1) and their round 2.

## Usage pacing (measured)
Foundation (2 parallel agents, ~1 h) used ~85 % of a 5-hour usage window then a rate-limit 429 killed both mid-task. Two finishing runs ≈ 30 %. Look + world round-1 builders ≈ 50–55 % together (each ~35–40 min, 70–80 tool calls — they overran the 45–50 call caps). **≈ 15–25 % of a window per heavy agent run; a window ≈ 5–6 runs.** At ~00:50 IST the window was ~90 % used; it resets ≈ 03:50 IST.
Rules: `get_usage` before launching/resuming; don't launch above ~60 %; give agents hard call caps and ask them to report early; resume with SendMessage rather than cold spawns; budget 1 module-round (builder + critic) ≈ 25–30 % of a window.

## Scores ledger (module · round · min axis · verdict)
(none yet — no critic has run)
