# Movement trace notes (implementer, phase 1)

Tool: `node tools/trace-movement.mjs --label before|after` (real wasm sim, scripted input on a flat run near the spawn, 60 Hz steps; camera numbers come from a numeric replica of the follow camera fed with the real interpolated `player` channel at 144 / 60 Hz frames). Spec numbers: `MOVEMENT_SPEC.md` section 7.

## Root causes of "the movements are stiff" (measured on the pre-phase-1 build)
1. The ground response is **not** slow: 90 % of walk speed after 0.17 s, full stop after 0.32 s (spec model: about 0.20 s / 0.35 s). The accel curve alone does not explain the feeling.
2. **Air and jump feel detached**: gravity 22 m/s2 + 8 m/s take-off gives apex 1.39 m and 0.72 s airtime (spec 1.25 m / 0.60 s), and air control is 4x weaker than ground control (3.5/s vs 14/s) so a jump is a ballistic arc with no steering; sprint is 7.0 m/s (spec 5.6) and a sprint-jump flies 5.0 m (spec 3.63 m).
3. **Voxel pops**: the controller walks on `HeightQuery`, which turns every 1 m block step into a 0.4 m ramp, i.e. a vertical speed of about 10 m/s at walking pace (a pop); there is no step-up smoothing and no real box collision (walls / overhangs are invisible to it).
4. **Camera**: position and look target are plain first-order lerps (9/s, 14/s: infinite acceleration at t = 0, no weight), the look-ahead is 0.22 s of the *stepwise* sim velocity (measured: the look target sits 0.64 m ahead of the head while walking and jumps ahead on every start/stop), the orbit position itself is lerped so mouse-look is laggy, and the only collision is the **heightfield** (`sample + 0.55`), which pops the desired camera position by up to 1 m at each block edge and lets the camera clip into walls / trees. At constant speed the per-frame step jitter is 0.00 % at both 144 and 60 Hz, so interpolation itself is fine.
5. No body animation (a blob with a sine bounce) - phase 2.

## Before (pre-phase-1 controller + replica of the old camera)
| metric | measured | spec |
|---|---|---|
| walk steady speed (m/s) | 4.200 | 4.317 |
| walk: v at 0.1 s / 0.2 s (m/s) | 3.16 / 3.94 | 3.4 / 4.0 (TV-03 per-tick) |
| walk: time to 50 / 90 / 99 % (s) | 0.05 / 0.17 / 0.33 | ~0.05 / 0.20 / 0.35 |
| sprint steady speed (m/s) | 7.000 | 5.612 |
| stop from walk: time to 10 % / full stop (s), distance (m) | 0.17 / 0.32, 0.262 | - |
| stop from sprint: time to 10 % / full stop (s), distance (m) | 0.17 / 0.37, 0.441 | 0.333 m in 7 ticks |
| standing jump: apex (m) / airtime (s) | 1.388 / 0.72 | 1.2522 / 0.6 |
| sprint-jump from steady sprint: distance (m) / airtime (s) | 5.017 / 0.72 | 3.629 / 0.6 |
| bunny hop (sprint + jump pressed every other step): average speed (m/s) | 6.998 | 7.127 |
| camera 144 Hz walking: focus lead(-) / lag(+) vs head (m) | -0.64 | - |
| camera per-frame step jitter 144 Hz / 60 Hz (std/mean, %) | 0.00 / 0.00 | 0 |

## After (phase 1) - same script, `--label after --cam rig` (camera rows = numeric model of the rig with its default constants)
| metric | before | after | spec (section 7) |
|---|---|---|---|
| walk steady speed (m/s) | 4.200 | **4.317** | 4.317 |
| sprint steady speed (m/s) | 7.000 | **5.612** | 5.612 |
| walk time to 50 / 90 / 99 % (s) | 0.05 / 0.17 / 0.33 | 0.07 / 0.17 / 0.37 | ~0.05 / 0.20 / 0.35 |
| stop from walk: time to 10 % / full stop (s), distance (m) | 0.17 / 0.32, 0.262 | 0.20 / 0.40, 0.400 | - |
| stop from sprint: distance (m) | 0.441 | 0.520 (0.333 + up to 0.19, see 1) | 0.333 |
| standing jump apex (m) / airtime (s, between y > 2 cm samples) | 1.388 / 0.72 | **1.252** / 0.57 | 1.2522 / 0.6 |
| sprint-jump from steady sprint: distance (m) | 5.017 | 3.439 (tick-exact: 3.629, TV-09) | 3.629 |
| bunny hop average (m/s) | 6.998 | **7.191** | 7.127 |
| camera focus lead vs head while walking (m) | 0.64 | 0.36 | - |
| camera per-frame jitter 144 / 60 Hz (std/mean, %) | 0.00 / 0.00 | 0.00 / 0.00 | 0 |

Unit tests (`cargo test -p sim_player`, 38 tests) reproduce spec vectors TV-01 free fall, 02 jump, 03 walk, 04 sprint, 06 diagonal, 07 steady speeds (ground and air), 08 release decay, 09 sprint-jump (steady and from rest), 10 bunny hop, 11 jump cooldown, 12 head bump, 15 coyote tick, 16 / 17 water horizontal + vertical, 21 fall times, 22 threshold sensitivity, plus TV-13 and TV-18 adapted to whole-block geometry; TV-05, 14, 19, 20, 23 are not applicable (no sneak / ladder / jump boost, 60 Hz scheme C not used).

Known properties / follow-ups
1. Spec 8.1 samples input at 20 Hz tick boundaries: a *release* that lands inside a tick lets the body travel the rest of that tick (up to 2 sub-steps = 0.19 m at sprint, mean 0.09 m); starting from rest and jump taps are exempt (immediate tick restart / latch). Phase 2 candidate: restart the tick on digital input transitions.
2. Trace airtime / jump distances are sampled positions, so they differ slightly from the tick-exact unit tests.
3. Default `step_height` is 1.0 (spec 0.6): terrain is 1 m terraces, a child must be able to walk uphill; the pop is hidden by `step_dy` (render-facing easing, 14/s). `PlayerTuning::spec()` restores 0.6 for the vectors.
4. Camera numbers are a model (same constants as `rig.ts`), jitter uses the real interpolated `player` channel; in-browser check: `node tools/shot.mjs --view game`.
