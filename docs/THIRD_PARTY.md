# Third-party material consulted or used

| what | where | licence | how used |
|---|---|---|---|
| Minecraft player-movement behaviour (public community documentation) | analyst fills in URLs in `docs/specs/MOVEMENT_SPEC.md` | wiki prose is CC BY-NC-SA → **facts and numbers only**, no prose, no code, no assets | re-expressed in our own spec; implementation written from the spec alone (see CLEANROOM.md) |
| Cobblemon open-source mod | https://gitlab.com/cable-mc/cobblemon (site https://cobblemon.com) | code MPL-2.0; assets non-commercial + Pokémon IP | **concepts only** — no code, assets or data copied |
| three, postprocessing, three-mesh-bvh, lil-gui, stats-gl, tone, vite, typescript, puppeteer-core, @fontsource-variable/* | npm | MIT / OFL etc. (see each package) | dependencies |
| bevy_ecs / bevy_app 0.19.1, glam, serde, serde_json, postcard, wasm-bindgen | crates.io | MIT / Apache-2.0 | dependencies |
| **Gen1Recomp** (Lua/LÖVE2D Pokémon fan engine; reads a player-supplied ROM) | https://github.com/bryanthaboi/gen1recomp | GPL-3.0 + extra terms (attribution; launcher proprietary); Pokémon data/art = Nintendo / Game Freak / TPC IP | **NOT used.** Incompatible with a commercial original-IP game (Pokémon IP; GPL would force our whole game under GPL). At most: rendering *techniques* studied as ideas |
| **DramaticShapeVoxelMod** (voxel-diorama renderer mod *for Gen1Recomp*; loads Gen 1-5 Pokémon art) | https://github.com/absol89/DramaticShapeVoxelMod (fork of TeJota1337/DramaticShapeVoxelMod) | **no licence** (all rights reserved); Pokémon art = third-party IP | **NOT used, no code copied.** Concept-level study only (extruded-tile voxel look, tilt-shift, depth-buffered shadows, water reflections, battle camera), reimplemented from scratch per CLEANROOM.md |
