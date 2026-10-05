# Brief: world (island layout, terrain, water, shoreline, horizon)
Owner of: `crates/sim_world/**`, `web/src/modules/world/**`. Contract: `docs/WORLD_CONTRACT.md`; `docs/BRIDGE_API.md` (add/edit your own section only).
Goal: the island you'd want to live on — a diorama-perfect main island ~300 m across: beach ring, tiered cliffs, rolling meadows, a forest, a pond fed by a stream running to the sea, a flattened village clearing, 2-3 islets and distant silhouettes for horizon depth.
Judged against Animal Crossing: New Horizons terrain, Pokémon Legends: Arceus landscapes, Breath of the Wild water.

## Rust (`sim_world`)
- Seeded deterministic island generator: domain-warped fbm + shaping masks + terraced cliffs with rounded lips + carved stream & pond + flattened village clearing + beaches. Heightfield at ≤ 0.5 m cells (justify choice vs. wasm gen time and memory), biome map per contract, flora placement (blue-noise/Poisson with clumping: groves, flower fields, rock outcrops, shore driftwood; rules in contract) → `flora` channel.
- `HeightQuery` implementation (height / normal / slope / water depth / biome at any x,z, bilinear) published through `sim_core`; spawn points + habitats in `world.info`.
- Terrain edit command `world.edit` (raise/lower/flatten/paint brush; marks `world.dirty` chunk ids; bumps `version`; keeps `HeightQuery` consistent).
- Native tests: determinism; player start reachable/walkable; no flora in water/steep slopes; generation time (< 1.5 s in wasm for the hero island, or justify).
## Web (`modules/world`)
- Chunked terrain meshes (~32×32 m) with 3 LODs + skirts (no seams/cracks); smooth normals with crisp rounded cliff lips.
- Painterly **splat shader** (grass / dirt / sand / rock / forest-floor / flower-meadow) from biome + slope + noise with macro colour variation, triplanar rock, baked-feel AO at cliff bases and under trees, wet-sand darkening near the waterline, path wear, cloud shadows (`uCloudShadowTex`), cool shadows per ART_BIBLE. Never flat vertex colours, never visible tiling or texture stretch.
- Stylised **water**: depth gradient, animated noise-driven foam bands tracing the shoreline, sun glitter, fresnel sky reflection, soft refraction + caustics on the seabed, gentle waves, ripple hook `ctx.world.addRipple(x,z,strength)`, flowing stream + calm pond variants; never a flat blue plane.
- Horizon: islets + silhouettes + fog blending into the sky; no empty edges.
- Terrain edits update only dirty chunks without hitching.
## Gallery cams & `shots.json` (≥ 10)
overview @16:30 · shore low-angle · cliff close · meadow close · beach close (wet sand + foam) · pond · stream · sunset water · night water · seabed edge; times 08:00 / 16:30 / 18:30 / 23:00.
## Traps
flat colours, tiling, stretched cliff textures, a "plane of blue" for water, chunk/LOD seams, shimmering normals, flora floating or in water, empty horizon, harsh uniform slopes (nothing in nature or in Nintendo terrain is that uniform).
