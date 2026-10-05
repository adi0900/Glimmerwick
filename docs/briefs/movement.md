# Brief: movement (player controller, camera, avatar locomotion, creature locomotion)

User feedback (2026-10-06): **"the movements are stiff."** Priority: fix this before more content.
Process: `docs/CLEANROOM.md` (analysts write specs, a separate implementer builds from the specs only). Specs: `docs/specs/MOVEMENT_SPEC.md` (Minecraft-style player movement, public-behaviour facts only) and `docs/specs/CREATURE_LOCOMOTION_NOTES.md` (concepts studied from the open-source Cobblemon code; no code/assets copied).
Implementer owns: `crates/sim_player/**` (controller), `web/src/modules/camera/**`, `web/src/modules/player/**` (avatar + procedural animation), and the movement/steering parts of `crates/sim_creatures/**` + a locomotion layer in `web/src/modules/creatures/**` (coordinate with the creatures builder).

**Voxel pivot (2026-10-06):** the world is now a voxel world (ARCHITECTURE §4b). The controller must use **voxel AABB collision** (step-up, ledges, swimming through water voxels) — not the heightfield — and the avatar is a **micro-voxel chibi** whose model comes from the voxel-creatures brief; you drive its animation (part hierarchy + springs). Voxel collision queries come from the voxel-world owner (`is_solid`, `ground_height`, `raycast`, `aabb_sweep`).

## Orchestrator audit (so you don't start blind)
The controller already has exponential velocity smoothing (ground 14/s, air 3.5/s, swim 6/s), facing smoothing 14/s, walk 4.2 / sprint 7.0 m/s — so the stiffness is not simple "instant velocity". Likely culprits: the player is a **capsule with no body animation**, camera behaviour is unverified, creatures bob rigidly. **First task: measure** — record per-tick traces (player velocity/yaw/pos, camera pos/fov, creature pos/yaw/speed) from the running game, state the root causes, then change code.

## Goals — "responsive but weighty"
1. **Core model** from the spec (tick-based acceleration / friction / gravity / jump / sprint / step-up / swim), re-expressed at our 60 Hz fixed step (convert per-tick constants exactly; document the conversion).
2. **Polish layer:** coyote time, jump buffer, variable jump height, landing recovery, smooth slope + step-up (visual smoothing only), sprint FOV kick, water buoyancy.
3. **Camera rig:** critically-damped spring-arm follow, look-ahead, collision-safe, gentle auto-recenter when moving, no jitter at 144 Hz (render interpolation correct), sprint FOV.
4. **Avatar:** chibi player with procedural locomotion animation — idle / walk / run / jump / fall / land / swim / turn; stride-matched feet; lean into acceleration; squash-and-stretch on landing; secondary motion (hair/scarf springs); smooth blending (no pops). Honour ART_BIBLE (clay material, big eyes, chunky clothing).
5. **Creature locomotion (concept-level):** pose FSM (idle / walk / run / swim / sleep …), gait phase synced to speed, acceleration + turn-rate-limited steering, head/eye look-at, ear/tail springs, hop/bounce with squash.
6. **Live tuning panel** (lil-gui) for every feel constant, with saved presets.

## Acceptance
- Spec test vectors pass as Rust unit tests; trace metrics (time to 90 % speed, stopping distance, turn response, jump apex + hang time) are documented and within the spec's ranges.
- Filmstrips (8-12 frames @ ~60 ms) show continuous motion with no popping; frame-to-frame deltas are smooth at 144 Hz.
- Independent critic scores rubric axis 5 (animation & motion) ≥ 9 on filmstrips, and the player *feels* good in the live game.
