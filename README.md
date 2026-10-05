# Glimmerwick (working title)

A cozy 3D creature-collecting / building / island-life game for kids. **Rust + Bevy (headless ECS in WASM) simulation, Three.js rendering.**

- Design: `docs/GAME_DESIGN.md` · Look: `docs/ART_BIBLE.md` · Architecture & contracts: `docs/ARCHITECTURE.md` · Quality bar: `docs/QUALITY_BAR.md`
- Rust toolchain lives on E: — run `. .\tools\env.ps1` first (PowerShell) before any cargo command.
- Build WASM: `powershell -File tools/build-wasm.ps1` · Dev server: `cd web; npm run dev` → http://localhost:5173
