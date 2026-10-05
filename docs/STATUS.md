# Orchestration ledger (orchestrator-owned — durable state across context resets)

Decisions from the user: Rust on `E:\RustToolchain` (not on PATH) · project at `E:\Pokemon+Minecraft+` · GitHub repo https://github.com/adi0900/Glimmerwick (public) · **staged waves** (pause when plan limits hit, resume after reset — see "Usage pacing") · blind A/B reference screenshots: **not yet provided** (`reference/` empty → critics rubric-only until then).
Round policy: builder → separate harsh critic (`docs/CRITIC_PROMPT.md`) → same builder continued with the critique … max 6 rounds/module, PASS = all axes ≥ 9 (QUALITY_BAR.md), plateau rule escalates.
**2026-10-06 user decisions:** (1) "the movements are stiff" → movement initiative; (2) "the game looks bad" → **ART DIRECTION PIVOT to a voxel diorama** (chosen via question; ART_BIBLE §0). The two Pokémon mod repos (gen1recomp = GPL-3.0+terms Pokémon-ROM fan engine; DramaticShapeVoxelMod = unlicensed mod for it) are **not used** (IP/licence/stack) — only the *kind* of look is rebuilt from scratch.

## Infrastructure
- GitHub origin/main; orchestrator pushes at milestones via `tools/push.ps1` (user's existing `gh` login). Last push de4f90d.
- Dev server: orchestrator background task (`node web/node_modules/vite/bin/vite.js web --port 5173 --strictPort --host 127.0.0.1`, 2 h timeout, started ~23:35 IST → **expires ~01:35 IST; restart it when down**). Game URL http://localhost:5173/?view=game&time=16.5 (opened in the user's browser + in-app pane; in-app pane throttles when the window is behind others). Clock can be slowed with `__gw.bridge.command('sys.set_time_scale',{scale:0.1})`.
- Tests: `cargo test --workspace` (139 pass) · `node tools/smoke-wasm.mjs` (81 checks) — green as of de4f90d.
- Self-paced /loop armed (ScheduleWakeup, hourly). The pending 01:22 wake carries an OUTDATED prompt text — on waking, follow THIS file, then re-issue ScheduleWakeup with the updated prompt: "/loop Continue the Glimmerwick staged build per docs/STATUS.md (voxel pivot plan). First get_usage; launch only if the 5-hour window is < ~60% used, else reschedule; restart the dev server if down."

## Done
- Wave 0 foundation. Wave 1a round 1 (look: clouds/haze/cloud-shadow tex/AO fix/DOF/outlines/grade; world: 576 m smooth island worldgen + chunked terrain + water) — pushed de4f90d. Look module (sky, clouds, post, lighting, ToonLit) is style-agnostic and **stays**; the smooth terrain/water renderer (`modules/world`) is **replaced** by the voxel module.
- Honest quality: prototype tier (~4–5/10). No critic has run yet.

## PLAN after the usage window resets (≈ 03:50 IST)
| order | agent | brief | notes |
|---|---|---|---|
| A1 | **voxel-world builder** (big) | `docs/briefs/voxel-world.md` | blocks, worldgen, meshing + atlas + bevel/AO shader, water, edit pipeline, collision API; fixes ~25 s first-load shader warm-up |
| A2 | analyst A (cold, cheap) | `docs/briefs/movement.md` + `docs/CLEANROOM.md` | `docs/specs/MOVEMENT_SPEC.md` from PUBLIC behaviour docs only |
| A3 | analyst B (cold, cheap) | same | `docs/specs/CREATURE_LOCOMOTION_NOTES.md` — concepts from open-source Cobblemon (gitlab.com/cable-mc/cobblemon; code MPL-2.0; assets non-commercial/Pokémon IP → never used) |
| A4 | critic for voxel-world r1 | `docs/CRITIC_PROMPT.md` | when A1 finishes and usage allows |
| B1 | **movement implementer** | movement.md | needs A1's collision API + A2/A3 specs; controller + camera + avatar animation + creature locomotion |
| B2 | **voxel-creatures builder** | `docs/briefs/voxel-creatures.md` | 3 species + voxel avatar model |
| later | look round 2 (voxel-tuned lighting/post, night, weather), voxel-flora variety, building UI, audio, systems, A/B vs references, Director critic |
Dropped: look/world round-1 critics (world module is being replaced). Look's round-2 TODO list: night flat/dark, clouds paper-flat, sunset alignment (sim sun below horizon at 18:30), outlines depth-only, cloud shadows faint, weather + cascades not started.

## Usage pacing (measured)
Foundation ~85 % of a 5-hour window; resumed finishing runs ~30 %; look + world r1 builders ~50–55 % together (35–40 min, 70–80 tool calls each — they overrun call caps). **≈ 15–25 % of a window per heavy agent run; ≈ 5–6 runs per window.** Window was ~92 % used at 01:15 IST; resets ≈ 03:50 IST.
Rules: `get_usage` before launching; don't launch above ~60 %; hard call caps (~45) + "report early"; resume with SendMessage rather than cold spawns; 1 module-round (builder + critic) ≈ 25–30 % of a window; expect the voxel rebuild (world → movement/creatures) to span 2–3 windows.

## Scores ledger (module · round · min axis · verdict)
(none yet — no critic has run)
