# Critique - voxel world, round 3 (independent critic)

**Verdict: FAIL.** Axes 1-8 are below 9. Lighting and the top-down/overview read are clearly better than round 2, but the world still looks like a procedural hobby project: the close-up materials are still smeared or tiled, the shapes are still generator-made, and nothing moves.

| # | axis | score | one-line reason (benchmark named) |
|---|---|---|---|
| 1 | Art direction & cohesion | **6** | One voxel style, a warmer sky/sand, but the lawn is still saturated green, dirt and "amethyst" strata are still maroon/indigo, and the tree/prop vocabulary is uneven. ACNH/DQB2 hold one earth-tone family. |
| 2 | Lighting & colour | **6** | Real progress: sun-tinted haze, warm key on tiles/trunks, cool cast shadows, fireflies. But the 18:30 sky is a flat purple wash, the key does not carry onto the ground, 23:00 is flat teal grass with no moon and no bloom, and the open sea is a flat deep-blue slab. |
| 3 | Materials & texture | **6** | Roof tiles, cobble, bark (up close) and the grass lip are now good; 16x aniso fixed lawn smear. Sand is still a blurry scribbled tile, dirt is a dark maroon repeating crack, the bark has diagonal wrap seams, and tile boundaries show on the lawn at every distance. |
| 4 | Shape & modelling | **5** | Unchanged: hollow "arch" olive trees, zig-zag 1-voxel path, perfect ellipse pond with uniform rim, four cloned cottages with no props, stair-step shorelines. Terraces and roofs are the only designed shapes. |
| 5 | Animation & motion | **3** | 8-frame strip at 120 ms: trees, shoreline and clouds identical; only faint water ripple. No leaf sway, no foam, no grass motion. |
| 6 | Rendering polish | **6** | Clean AA, soft shadows, AO, DOF. But a hard sea/sky horizon line in 01, white-hot slivers where the stream cuts the bank (08), tiled-looking lawn at grazing angles, stripey ripple moire on open water (11), and a rectangular world edge from the top camera (02). |
| 7 | Composition & readability | **6** | Overview and village now read; 18:30 east cam and 23:00 are monochrome; village is four clones in a row on a vast empty lawn. |
| 8 | Delight & juice | **5** | Fireflies, flowers, mushrooms, lit windows and a glowing gem. Still no butterflies, falling leaves, foam, chimney smoke, props. |
| 9 | Performance | **9** | 118-206 draws (budget 1200), 0.41-0.71 M tris (2.5 M), 144 fps capped, GPU 6.4 ms max, 0 console/page errors. Heap, first-interactive and the Iris Xe `low` preset not measured. |

## Evidence
- Pack run by me: `node tools/shot.mjs --pack voxel --round 12` -> `shots/voxel/r12/` (17/17 ok, 0 console errors, 0 page errors, max 206 draws, max 710 k tris, gpuMs 6.39). Viewed 01, 02, 03, 06b, 07, 08, 10, 11, 12, 13, 14; **not viewed:** 04, 05, 06, 09, 15, 16.
- My own shots in `shots/voxel/critic-r3/` (1920x1080): `A_east_1830` (free cam 160,6,70 -> 60,9,-5), `B_build_0800` (72,30,22 -> 58,6,-12), `C_close_1630` (64,12,4 -> 58,8,-10, village close), `D_game_2300`, `E_game_1830` (game view), `F_strip_strip` (8 x 120 ms). `--crop` not used; close cameras instead. The 16:30 and 23:00 captures were taken via the village cam and game view, so no wide 23:00 view.
- Blind A/B: `reference/` is empty (only README) -> no references, rubric only.

## Round-2 defects - honest status
| r2 defect | status in r3 |
|---|---|
| 1 Up-close blur / tiling (sand, dirt, bark, pine, plaster) | **Partly fixed.** Bark, pine leaf, plaster, cobble, roof tiles are crisp and varied (14, 07, C). **Sand not fixed** (03: still a soft blurry tile with scribble marks). **Dirt not fixed** (13: dark maroon, same crack on every face). Lawn: smear gone but tile boundaries are visible as a grid at grazing angles (06b, E). Bark has diagonal wrap seams (07, 14). |
| 2 Sky lighting / haze / sun / night | **Partly fixed.** Warm key on roofs/trunks, visible cool shadows, sun-tinted horizon (10, 11), fireflies at night. Still: purple wash sky (A, 11), flat teal ground at night, no moon, no bloom on windows, abrupt sea/sky line in 01. |
| 3 Palette (acid green, maroon dirt, indigo stone) | **Partly fixed.** Lawn is calmer; pond/stream banks are now a warm brown (08). Cliff dirt and the indigo "amethyst" strata in 13 remain maroon/indigo; the lawn is still the most saturated mass on screen. |
| 4 Shapes (arch trees, zig-zag path, ellipse pond, clone cottages) | **Not fixed.** All five tells remain (10, 08, 02, B). |
| 5 Water / shoreline | **Partly fixed.** Hairline seam and moire rings gone, wet-sand band added, shallows now noise-warped (01). Still no foam line, stripey ripples at grazing angle (11), white slivers at stream cut (08). |

## Top 5 defects, ranked by visual impact

**1. World shape language is still generated (trees, path, pond, village, shoreline).**
- Where: 08 (olive "table" tree with the trunk visible under a cut-out canopy), 10/B (zig-zag 1-voxel path; four identical cottages with no chimney/porch/fence), 02 (perfect ellipse pond, uniform rim, constant-width stream), A (sand is a stack of identical 1-voxel steps).
- Why: DQB2/ACNH silhouettes are asymmetric and prop-rich; a director spots these tells at a glance, and they are ~70 % of the buildable-world frame.
- Fix: replace the arch tree with a 3-layer rounded oak (radii 3-4-3, trunk hidden except the last 2 voxels); path as a 2-3 wide meandering band with slab steps and gravel scatter; >= 3 cottage variants (L-plan, 2x2x3 chimney, porch with half-block rail, flower boxes) plus fence/lantern/mailbox/well/garden props; warp the pond outline with 2-3 octave noise (+-3 m) and make the rim partial with reeds/lily pads; stream width 2-4 m with meander; soften shoreline steps with half-height slabs.

**2. Sand and dirt textures are still the weakest, biggest surfaces.**
- Where: 03 (whole lower half = blurry yellow scribble), 13 and A (cliff/terrace dirt: dark maroon, same pattern on every face, nearly black in shade), 06b/E (visible lawn tile edges and repeating motif).
- Why: ACNH sand and DQB2 dirt are crisp, hand-painted, warm and non-repeating. Ours reads as low-contrast noise.
- Fix: repaint sand as 3-tone dune ripple (+-8 % value, no blur, native texel density), add 4-6 non-mirrored variants with hash-chosen 90 degree rotation; dirt albedo to warm umber `#8B5A3C`..`#A06A44` with pebbles/roots, violet only in AO; add a world-space macro noise (6-24 m period, +-8 % value, +-3 deg hue) over all terrain to hide tile edges; drop the indigo strata or limit it to ore accents; fix the bark wrap seam (use a per-axis UV rotation on the log side faces).

**3. Nothing moves.**
- Where: F strip (8 frames, canopy/shore/clouds identical), 08 (static water edge), 10 (static trees and roofs).
- Why: ACNH trees sway, grass bends, shores foam, smoke rises; a still diorama reads as a screenshot, not a world.
- Fix: vertex-shader sway for leaf blocks (amplitude 0.03-0.06 m, 0.5-1 Hz, phase by world xz) and grass tufts; depth-based foam band 0.4-0.8 m wide with a 2-3 s advance/retreat; drifting leaf/petal particles (10-30 on screen), butterflies by day, chimney smoke; cloud scroll parallax.

**4. Colour grading and the time-of-day extremes.**
- Where: A and 11 (18:30 is a flat violet wash; key light does not reach the sand or trunks), 12/D (23:00: flat teal ground, no moon, no bloom on lit windows), 01 (hard sea/sky line, flat deep-blue sea), 08/10 (acid-green lawn).
- Why: ART_BIBLE s1/s2 asks for warm key, cool fill, a clear dark/mid/light structure; here the evening is one hue and the night is one mid value.
- Fix: 18:30 sun `#FF9A5A` I 1.8-2.2 vs hemi `#8A74C8` 0.5-0.6; sky gradient violet -> peach with a visible sun disc + halo and shafts at elevation < 25 degrees; add a moon disc + stars, moon-blue rim `#8FB0FF` I 0.5 on top faces, bloom 0.6-0.9 on lanterns/windows; blend sea colour into the horizon with a 12 % screen-height fog band (fixes 01); desaturate the lawn toward `#5CC95A` with 8-15 % dry-grass blocks.

**5. Water and edge polish.**
- Where: 08 (white-hot slivers where the stream cuts the bank), 11 (stripey ripple aliasing, glitter discs), 01/02 (flat blue ocean, rectangular outer edge, stair-stepped surf line), 15 not viewed.
- Why: ACNH shores have crisp animated foam and wet-sand fade; ours exposes the water/terrain join and aliases at grazing angles.
- Fix: clamp glitter/specular <= ~1.2; Toksvig/roughness normal filtering, 2 octaves, amplitude -> 0 beyond ~120 m; lower the water surface 0.06-0.1 m under shore tops; replace the flat sea with a gradient `#6EE7D8` -> `#2BB8D9` -> `#2563C7` plus low-frequency wave normals; fade the world edge into fog.

## What is already good
- Roof tiles, cobble, window frames and bark close-ups (C, 14) are real diorama-grade work; 16x aniso fixed the lawn smear.
- The overview (01) and 08:00 build camera (B) now read as a charming island, with soft cast shadows and a fine sun-tinted horizon at 16:30.
- Performance has huge headroom (206 draws, 0.71 M tris, 6.4 ms GPU).

## Plateau?
Top-3 families r2: (1) up-close texture/tiling, (2) lighting/haze/night, (3) palette (maroon dirt/acid green). Top-3 r3: (1) generator-made shapes, (2) sand/dirt texture and tile edges, (3) static world. Families 1-2 of r2 persist in r3 as defect 2 and 4 (partly fixed, same surfaces), and shapes was r2 #4 but is r3 #1 as it was never touched. Verdict: **plateau = yes for texture/palette (3 rounds on the same family), no for the whole module**. Escalate: stop tuning procedural noise for sand/dirt; use a hand-painted or generated 4-variant atlas for those two blocks and spend the next round on the structure generators (trees, village, path) and motion.
