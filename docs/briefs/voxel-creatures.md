# Brief: voxel-creatures (VOXEL PIVOT) — three hero Glimmer species + the player avatar as micro-voxel models
Owner: `web/src/modules/creatures/**` (models + render), creature data in `crates/sim_creatures/**`; avatar *model* in `web/src/modules/player/model.ts` (avatar animation/controller belong to the movement implementer — coordinate via REQUESTS). Read: ART_BIBLE §0, `docs/briefs/creatures.md` (species concepts Puffbun / Tidler / Sprigfox — redesign freely), CLEANROOM.md (original designs only; no Pokémon / Cobblemon models, names or assets).
Goal: creatures kids fall in love with at first sight, in micro-voxel form (≈ 1/16 m voxels, ~10–14 voxels long): strong silhouette, limited palette, glowing marking voxels that pulse with mood, expressive eyes (voxel highlights), ≥ 3 colour variants each.

## Deliver
- A procedural **voxel sculptor** (primitives: ellipsoid / capsule / box / cone with clean voxelisation, colour rules, symmetry, hand-placed detail voxels) → baked greedy meshes **per body part** with a part hierarchy (body, head, ears, tail, limbs) so animation is transforms + springs, never one rigid block. Flat colour + AO shading consistent with the world; emissive glow voxels; LOD.
- 3 species + a chibi voxel **player avatar** (customisable skin / hair / outfit colours).
- A "creature lab" gallery: turntables, emotes, colour variants, size lineup, group shot in the meadow at golden hour, night glow.
- Basic life: idle breathing, blink, ear/tail springs, hop squash-and-stretch. Full locomotion + pose FSM comes from the movement initiative's specs.
Acceptance: independent critic ≥ 9 on rubric axes 3 (materials) and 4 (shape & appeal) for close-ups; each species readable at 64 px.
Traps: lumpy random blobs, noisy colour speckle, same silhouette across species, dead eyes, rigid single-mesh creatures.
