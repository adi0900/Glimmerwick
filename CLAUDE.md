# Glimmerwick — project instructions (every agent reads this)

Kids' creature-collecting / building / island-life game. **Rust + Bevy ECS (headless, inside WASM) = simulation; Three.js (WebGL2) = rendering, UI, audio.** Original IP only (no Nintendo/Mojang names, creatures, assets).

Start here: `docs/ARCHITECTURE.md` (contracts + file ownership) → `docs/ART_BIBLE.md` → `docs/QUALITY_BAR.md` → your brief in `docs/briefs/` → `docs/WORLD_CONTRACT.md` / `docs/BRIDGE_API.md`.

Environment (Windows 11, PowerShell 5.1 — no `&&`; use `curl.exe`; the project path contains `+`, quote it):
- Rust is installed on E: and is NOT on PATH → run `. "E:\Pokemon+Minecraft+\tools\env.ps1"` (or `source tools/env.sh` in Git Bash) before cargo / wasm-bindgen.
- Build wasm: `powershell -File tools/build-wasm.ps1` · dev server http://localhost:5173 is run by the orchestrator · screenshots: `node tools/shot.mjs …` (real GPU, headless Chrome).
- Rust crates and npm packages are newer than model training data — read real sources/types (`E:\RustToolchain\cargo\registry\src\*`, `web\node_modules\*`), don't guess APIs.

Rules:
- Edit only files you own (ARCHITECTURE.md §2). Cross-module needs → append to `docs/REQUESTS.md` and use a workaround.
- Sub-agents never run state-changing git commands (the orchestrator snapshots) and never spawn sub-agents.
- The tree is shared and live: keep it compiling/running; no long-lived background processes; screenshots only under `shots/<module>/r<N>/`.
- Everything is judged by a harsh independent critic against Pokémon / Animal Crossing / Minecraft polish. Don't hide weaknesses behind camera angles or fog; fix them. Report only what you actually ran and looked at.
- Monetization is ethical only: premium + cosmetic packs behind a parent gate; no loot boxes / timers / FOMO / ads / pay-to-win.
