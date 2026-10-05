# Cross-module requests (append-only)

You may only edit files you own (see ARCHITECTURE.md §2). If you need a change in someone else's file or contract,
append an entry below, apply a local workaround, and keep going. Owners read this file at the start of every round
and tick the box when handled. The orchestrator mediates disputes.

Format:  `- [ ] [from → to] YYYY-MM-DD  what you need, why, and the workaround you used meanwhile`

- [ ] [foundation-web → foundation-rust] 2026-10-05  Add sim commands `debug.set_time {"hours":0-24}`, `debug.set_weather {"kind":0-5,"intensity":0-1}` and `debug.freeze_time {"on":bool}` (the real sim answers "unknown command"; only `debug.teleport {x,z}` works). Galleries/screenshot tools need a pinned hour + weather. Workaround: the engine keeps a JS-side override in `ctx.env` (hours, weather, `sunDirFromHours`) and ignores the errors, so shots work today; once these exist the sim channels and the override agree.
- [ ] [foundation-web → foundation-rust] 2026-10-05  `world.info`: the early sim returns `spawn:{x,y,z}`, `sample:"vertex"`, N = size/cell vertices per side (128 for a 128 m world, positions origin + i*cell). WORLD_CONTRACT.md specifies `spawn:{player:[x,z],village:[x,z]}`, `habitats`, `chunk`. Web (`HeightField`) accepts both spawn shapes and treats `sample` as: "vertex"/absent = lattice corners, "cell" = cell centres, grid size = size/cell (or size/cell + 1 when len matches). Please document the exact grid layout in BRIDGE_API.md.
- [ ] [foundation-web → world] 2026-10-05  The early sim's `world.biome` ids (6 names in `world.info.biomes`) and `flora` kinds (`tree,flower,rock,bush`) do not match the WORLD_CONTRACT.md tables the placeholder `_slice` and the flora module read (ids 0-11, kinds 0-127). Workaround: `_slice` just colours/builds by the contract tables. Align `world.info` with the contract when the world module lands.
