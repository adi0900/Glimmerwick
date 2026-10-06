# Critique - voxel world, round 4 (independent critic)

**Verdict: FAIL.** Textures took a real step up (sand, bark, cobble, tiles are now hand-painted-grade) and trees/cottages/path/pond are no longer the old generator tells, but nothing reaches 9: the world still reads as "good Minecraft resource pack", not DQB2/ACNH. Motion is nearly invisible, evening/night grading is flat, and shorelines/palms/path are still stair-step artifacts.

| # | axis | score | one-line reason (benchmark named) |
|---|---|---|---|
| 1 | Art direction & cohesion | **7** | One voxel style and earth-toned paths/roofs; but crimson and magenta trees, bright lawn and violet/black cliff dirt fight each other. ACNH/DQB2 keep one tonal family. |
| 2 | Lighting & colour | **6** | 08:00 and 16:30 are warm and good (soft long shadows). 18:30 is still a violet wash with no sun disc; 23:00 is flat teal ground with no moon, no bloom beyond window quads. |
| 3 | Materials & texture | **7** | Sand ripple, bark, cobble, roof tiles, leaves are crisp and varied. Cliff strata read as purple brick/plank, cliff dirt is near-black, lawn is a uniform noise carpet with a visible tile grid at 06b/D. |
| 4 | Shape & modelling | **6** | Rounded multi-tier trees, 4 cottage designs, fences, chimneys, warped pond: real gains. Still: 1-voxel stair-step coastlines (A, 03), twisted zig-zag palms, uniform brown pond collar (02), path still 1-voxel in places, terraces are uniform stair rows. |
| 5 | Animation & motion | **4** | Live 8-frame strips (freeze=0, 400 ms): a few 1-2 px smoke/petal specks, no perceptible leaf sway, no water foam. A viewer reads it as static. |
| 6 | Rendering polish | **6** | Clean AA/AO/shadows. Defects: big floating tilted petal/leaf quads (05), cyan pebble-textured stream with white-hot edge slivers (09), ripple moire at 18:30 water (11), rectangular world edge in top view (02), flat sea slab (01). |
| 7 | Composition & readability | **7** | Overview and village read well; 18:30 and 23:00 are low-contrast monochrome; village still sits on a big empty lawn. |
| 8 | Delight & juice | **5** | Lit windows, chimneys, crates, fences, flowers, fireflies. Smoke/petals too small to register; no foam, butterflies, grass motion. |
| 9 | Performance | **9** | 120-210 draws (budget 1200), 0.42-0.73 M tris, 144 fps capped, GPU 6.7 ms max, 0 console/page errors. Heap and Iris Xe `low` preset not measured. |

## Evidence
- Pack: `node tools/shot.mjs --pack voxel --round 15` -> `shots/voxel/r15/` (17/17 ok, 0 errors, max 210 draws, 727 k tris, gpuMs 6.73). All 17 PNGs viewed.
- My shots in `shots/voxel/critic-r4/`: A east 18:30 (150,10,60 -> 60,9,-5), B build 08:00 (70,26,24 -> 58,6,-12), C village 16:30 (64,12,4 -> 58,8,-10), D game view 23:00, F frozen strip, G/H live strips 8 x 400 ms (village and tree/cottage cameras). shot.mjs forces `freeze=1`, so its filmstrips cannot show motion; I overrode with `--param "freeze=0"` (the pack's own filmstrip 16 is therefore blind to motion - tool defect worth fixing). `--crop` not used.
- `reference/` empty -> no blind A/B, rubric only. Not captured: a live-motion pond close-up; sway amplitude not measured numerically.

## Round-3 defects - honest status
| r3 defect | status in r4 |
|---|---|
| 1 Generated shapes (arch trees, zig-zag path, ellipse pond, clone cottages, no props) | **Partly fixed.** Trees are solid rounded canopies; 4 cottage designs with chimneys, crates, fences, a gazebo; pond outline warped, path meanders. Still stair-stepped shorelines, 1-voxel path stretches, twisted palms, uniform pond rim, identical terrace rows. |
| 2 Sand/dirt textures, tile edges | **Mostly fixed for sand/bark/cobble** (03, 14: crisp 3-tone ripples, painted bark). Dirt still near-black on faces (04, 13), strata look like purple bricks, lawn tile grid still visible (D, 06b). |
| 3 Nothing moves | **Barely fixed.** Smoke and petal specks exist (live strips) but at 1-2 px and sparse; sway not perceivable; no foam; no butterflies. |
| 4 Time-of-day extremes (18:30 wash, flat night, hard sea/sky line) | **Not fixed.** 18:30 (A, 11) still violet; 23:00 (D, 12) flat teal, no moon; sea is still a flat blue slab. |
| 5 Water/edge polish | **Not fixed.** White slivers at stream cut (09), moire stripes at sunset (11), no foam line, rectangular edge in 02. |

## Top 5 remaining defects (by visual impact)

**1. Ambient motion is not perceivable (axes 5, 8).**
- Where: G/H live strips; 01/10 static canopies; shore without foam.
- Why: ACNH trees and flowers visibly bob, shores foam, smoke is thick and drifting. Here sway and smoke are sub-pixel specks.
- Fix: leaf-block vertex sway amplitude 0.06-0.12 m at 0.6-1.0 Hz, phase from world xz plus a slow gust wave (6-9 s period); smoke as 8-12 soft billboards 0.25-0.4 m growing to 0.8 m over 4 s, alpha 0.5 -> 0; petals 0.12-0.2 m, 25+ visible; depth-based foam band 0.5 m wide advancing/retreating over 2.5 s; 6-10 daytime butterflies; bending grass tufts. Also make shot.mjs filmstrips run unfrozen.

**2. 18:30 and 23:00 grading is flat (axes 2, 7).**
- Where: A, 11 (violet wash, no sun disc); D, 12 (single teal mid value, no moon, trees merge).
- Why: Minecraft shaders and DQB2 give warm/cool contrast, a visible sun/moon, bloom and rim light.
- Fix: dusk sun `#FF9A5A` I 1.8-2.2 with disc + halo at horizon, hemi `#8A74C8` 0.5; sky gradient violet -> peach; night: moon disc + stars, moon rim `#8FB0FF` I 0.5 on top faces, bloom 0.6-0.9 on windows/lanterns, wider value contrast on the ground (not hue-only).

**3. Stair-step silhouettes: shoreline, terraces, palms (axis 4).**
- Where: A (sand/wet-sand as ruler-straight 1-voxel steps), 03, 02 (brown pond collar), twisted zig-zag palms in A/01, 04 cliff steps.
- Why: DQB2/ACNH soften edges with half-slabs and irregular rims; this reads as heightmap quantisation.
- Fix: half-height slab/stair blocks (0.5 m) on shore and terrace edges, noise-jitter terrace width 1-3 blocks, partial pond rim with reeds/lily pads, palm rebuilt as a 6-8 block curved trunk with a 5-frond crown, path 2-3 wide with pebble border.

**4. Palette and cliff materials (axes 1, 3).**
- Where: 01, 04, 13 (violet brick strata, near-black dirt), crimson/magenta trees dominate, bright lawn, 06b/D lawn tile grid.
- Why: red/pink masses overpower the island; cliffs read as planks/bricks, not rock; macro variation missing.
- Fix: strata -> warm sandstone/grey stone with violet only in AO; dirt albedo `#8B5A3C`..`#A06A44`; cap red/pink trees ~10% in 2 warm-autumn hues; lawn toward `#5CC95A` plus 8-15% dry/clover patches; world-space macro noise +-8% value over terrain.

**5. Water and edge artifacts (axis 6).**
- Where: 09 (cyan pebble stream texture, white slivers at bank cut), 11 (stripe moire), 05 (huge tilted petal/leaf quads), 02 (rectangular world edge), 01 (flat sea).
- Why: exposes seams; flagship water is smooth, shaded, with foam.
- Fix: clamp glitter/spec <= 1.2 and fade ripple normals beyond ~120 m; soft gradient stream bed with water lowered 0.06-0.1 m; fade petal quads near the camera; fog band at sea horizon and island-edge falloff.

## What is already good
- Painted sand, bark, cobble, roof tiles and leaf textures are crisp and cohesive (03, 14, C).
- The village has varied cottages with chimneys, fences, crates and warm windows; 08:00/16:30 lighting and soft cast shadows are charming (B, C).
- Performance headroom is huge (210 draws, 6.7 ms GPU).

## Plateau?
No for textures (sand/dirt family clearly improved r3 -> r4) and for shapes (structure generators changed). Risk: motion and dusk/night grading (r3 #3/#4) are unchanged in impact; next round should target them plus shoreline slabs, not more texture work.
