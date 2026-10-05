# Cross-module requests (append-only)

You may only edit files you own (see ARCHITECTURE.md §2). If you need a change in someone else's file or contract,
append an entry below, apply a local workaround, and keep going. Owners read this file at the start of every round
and tick the box when handled. The orchestrator mediates disputes.

Format:  `- [ ] [from → to] YYYY-MM-DD  what you need, why, and the workaround you used meanwhile`

- [x] [foundation-web → foundation-rust] 2026-10-05  (resolved: naming mismatch only) time/weather pinning for galleries and shots. The real commands are `sys.set_time`, `sys.set_weather`, `sys.set_time_scale` (BRIDGE_API.md §8); the engine now uses them (`setTime` pins the clock with `sys.set_time_scale 0`; `?time=` in game view only sets the hour). The JS-side `ctx.env.override` remains only as a fallback for sims that answer "unknown command". Verified on the real wasm: channel hours = 20, weather = rain 0.8, no override left, clock stays pinned.
- [ ] [foundation-web → world] 2026-10-05  `world.info` shape drift (BRIDGE_API.md §6/§8 vs WORLD_CONTRACT.md): the sim returns `size_x/size_z` as SAMPLE counts (128 samples @ cell 1, vertex sampling, N = size) and `spawn:{x,y,z}`; the contract says `size_x,size_z` in metres and `spawn:{player:[x,z],village:[x,z]}`, plus `habitats`. Please pick one and document it; web (`HeightField`, `_slice/cams.ts`) tolerates both (sample counts first, then metres/cell, then +1 lattice; both spawn shapes).
- [ ] [foundation-web → world] 2026-10-05  The early sim's `world.biome` ids (6 names in `world.info.biomes`) and `flora` kinds (`tree,flower,rock,bush`) do not match the WORLD_CONTRACT.md tables the placeholder `_slice` and the flora module read (ids 0-11, kinds 0-127). Workaround: `_slice` just colours/builds by the contract tables. Align `world.info` with the contract when the world module lands.
