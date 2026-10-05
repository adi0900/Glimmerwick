# Brief: flora (grass, trees, bushes, flowers, mushrooms, rocks, reeds)
Owner of: `web/src/modules/flora/**`. Reads the `flora` channel (kinds in `docs/WORLD_CONTRACT.md`) and `world.biome` / `world.height`.
Goal: lush, hand-crafted, storybook foliage that makes every screenshot instantly beautiful — Animal Crossing's puffy trees, Pokémon Legends' meadows, Breath of the Wild's grass.

## Deliver
- **Grass system:** millions of blades via chunked instancing + GPU/CPU culling, LOD + distance fade into painted ground, root→tip gradient with hue variation and sun translucency, wind waves/gusts from `uWind`, bends away from the player and creatures (`uPlayerPos`, `uBenders`), flower sprinkles with clumping noise, tall-grass patches, rustle on interaction; zero shimmer/aliasing at rest and in motion; stable 60 fps.
- **Trees (all kinds 0-11 in the contract), procedural geometry:** puffy lobed canopies (NOT spheres) with inner shading, leaf-card detail, translucency, trunks with roots + bark detail + branches, per-instance variation (variant seed), LOD + impostors at distance, wind sway (trunk + canopy + leaf flutter), seasonal variants (spring blossom, summer, autumn colours, winter bare/snowy), falling leaves/petals particles.
- **Bushes, ≥ 8 flower types, mushrooms (incl. night-glow), rocks (mossy, crystal glow, sea-stacks), reeds/lily pads/cattails, shells/starfish/driftwood, logs/stumps** — each with a distinct charming silhouette, hand-painted material, clustering behaviour.
- Soft contact shadows / AO under trees and rocks (decal blobs or baked), shadow casting tuned for performance.
- Use the shared `ToonLit` materials from `engine/Materials.ts` (owned by *look*; request what you need via REQUESTS.md; the foliage/wind hooks already exist in v1).
## Gallery cams & `shots.json` (≥ 12)
meadow at eye height (grass + flowers) · portraits of every tree kind · forest interior · beach props · wind filmstrip · autumn / winter / spring variants · night glow · player-vs-grass interaction · distance LOD transition check.
## Perf
≤ 400 draw calls for flora, instancing everywhere, frustum + distance culling per chunk, no GC churn per frame.
## Traps
spheres-on-sticks trees, uniform-colour grass planes, popping LOD, shimmering grass, identical clones, flat lighting inside canopies, visible billboards, everything swaying in lock-step.
