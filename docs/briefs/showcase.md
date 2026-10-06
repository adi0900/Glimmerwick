# Brief: showcase video (shareable trailer, frame-exact 60 fps)

Goal (user request 2026-10-06): a video to share online — **gameplay on the main area, the models on a sidebar, 60 fps, "exactly perfect"**. Be honest about the state of the game: it is an early prototype; do not fake footage or add claims. Original IP only (nothing from Pokémon/Minecraft appears on screen).

## Output
- `showcase/glimmerwick_showcase_1080p60.mp4` (git-ignored; ~45–60 s; 1920×1080, **constant 60 fps**, H.264 High, yuv420p, crf ≈ 16, `+faststart`), plus a 15 s vertical/teaser cut if cheap. ffmpeg 9.0 is installed (`Get-Command ffmpeg`); no downloads needed.
- Layout: **left 1440×1080 = live gameplay**, **right 480×1080 sidebar = four model cards stacked** (Puffbun, Tidler, Sprigfox, the avatar), each a slow turntable with a name label (Fredoka font from the game, ink-on-cream card style from ART_BIBLE §8), subtle bob/blink alive; a slim "Glimmerwick — early prototype" caption bar; intro 2 s fade-in and 2 s outro with the title (no fake feature claims).

## How (deterministic, not a screen recorder)
Frame-exact capture: freeze the game clock, advance exactly 1/60 s per frame (`__game.freeze/step/settle` photo API in `docs/ENGINE.md`; extend it if needed), screenshot each frame (JPEG q95 or PNG) with puppeteer (`tools/lib/browser.mjs`), then encode with ffmpeg. Capture the main view and each sidebar card as separate passes with the same frame count, then compose with ffmpeg (`hstack`/`vstack`/`overlay`, fonts via drawtext or pre-rendered DOM cards). Expect ~3–4 k frames per pass; run long renders as a background task and report progress. Add `tools/record-showcase.mjs` (+ a `showcase` choreography file) so it is repeatable.

## Choreography (≈ 50 s; scripted player input/waypoints, slow-in/slow-out cameras, no jitter)
1. 0–6 s island overview flythrough at golden hour → cut to the village green.
2. 6–20 s player walks, sprints, jumps through the village (cottages, props, smoke, petals) with 2–3 creatures wandering/hopping near (spawn with `debug.spawn_creature` near the player; use only what visibly looks good).
3. 20–32 s beach shoreline: waves/foam, sand path, creature at the water's edge.
4. 32–42 s sunset: sun disc/halo, long shadows.
5. 42–50 s night: moon, fireflies, glowing windows and creature glow markings.
Time of day progression via `sys.set_time` + `sys.set_time_scale`. Pick camera angles that show the game truthfully at its best (no hiding defects with fog), and re-shoot any segment where a critic-flagged defect (black avatar back, clipping into foliage) is visible.

## Acceptance
- 60 fps constant (verify with `ffprobe`: `r_frame_rate=60/1`, frame count = duration × 60), no dropped/duplicated frames, no visible stutter, no loading spinner, no console errors during capture.
- You LOOK at ≥ 12 evenly spaced frames and one contact sheet before declaring done; report resolution, bitrate, file size, duration and honest weaknesses.
- Audio: none is implemented in the game; ship silent (optionally a short original synthesized music bed only if trivial and clean; otherwise say "add your own music").
