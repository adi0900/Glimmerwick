# Brief: creatures (three hero Glimmer species + AI + animation)
Owner of: `crates/sim_creatures/**`, `web/src/modules/creatures/**`. Channel `creatures` (stride 16 — extend by *adding* documented channels; never change existing offsets).
Goal: creatures kids fall in love with at first sight — Pokémon-level charisma, **original** designs. Three species for the hero slice, each unforgettable at 64 px and gorgeous up close:
1. **Puffbun** — round, fluffy cloud-bunny critter with oversized ears that react to mood and glowing cheek marks.
2. **Tidler** — plump amphibious paddler (otter/frog/duck mash) with a big shiny belly, webbed feet, bubbles; shores and ponds.
3. **Sprigfox** — lithe fox-cat with a leafy tail-plume and glowing leaf markings; shy, curious; forest.
(Redesign freely if you find stronger concepts.) Each needs a signature silhouette feature, clear colour identity (1-2 colours + accent), bioluminescent markings that pulse with mood, ≥ 3 colour variants.

## Deliver
- Procedural **organic modelling** — suggestion: SDF/metaball smooth-union meshed with surface nets, or sculpted parametric meshes with smooth normals; NOT glued primitives. Painted patterns (vertex colour / UV / shader), fur/felt shader (fuzzy rim, soft AO), expressive faces (large eyes with 2-3 highlights, blink, pupils that track, mouth shapes, cheeks), skeleton + skinning (or spring-driven part hierarchy) with: idle (breathing, blink, glance, 3 fidgets), walk/run (bounce with squash-stretch, ear/tail follow-through), happy hop, curious head-tilt, sniff, eat, sleep (zzz), startled, sad, love; LOD.
- Emote/VFX hooks (hearts, notes, zzz, sparkle) as events; glow markings emissive driven by mood + night.
- Rust AI (`sim_creatures`): utility-based behaviours (wander within habitat, graze/play/idle, notice the player by personality, approach/follow/flee, sleep at night in dens, react to food), per-species stats + personalities, daily schedule, deterministic, perf-tested at 500 creatures; events for emotes; query for per-creature info (name/species/mood) for UI; save section.
- Uses `ToonLit` (`engine/Materials.ts`, owned by *look*) — request what you need via REQUESTS.md.
## Gallery cams & `shots.json` (≥ 12)
species turntables · face close-ups · every emote · colour variants · group shot in a meadow at golden hour · night glow · walk-cycle filmstrips · size lineup.
## Traps
capsule/sphere assemblies, static faces, rigid parts, identical clones, dead eyes, no secondary motion, linear animation, same silhouette across species, muddy fur shading.
