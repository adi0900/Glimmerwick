# Critique - voxel world, round 2 (independent critic)

**Verdict: FAIL.** Axes 1-8 are all below 9. The look is a coherent voxel diorama and is clearly better than round 1, but it is still "competent hobby project" tier, not first-party polish.

| # | axis | score | one-line reason (benchmark named) |
|---|---|---|---|
| 1 | Art direction & cohesion | **6** | One voxel style, but the palette is undisciplined (acid-green lawn, brick-maroon dirt, indigo "amethyst" strata) and the tree/prop vocabulary is uneven. DQB2 / ACNH hold one warm earth-tone family. |
| 2 | Lighting & colour | **5** | Lovely painted sky, but the world is lit like noon under a sunset skybox: no sun disc/halo/shafts, no warm rim, key:fill is weak, 16:30 horizon is a milky lavender band, night and under-canopy are murky. BotW, ACNH and Minecraft shader packs carry the sky light onto every surface. |
| 3 | Materials & texture | **5** | Roof tiles, cobble and the grass-lip dirt are good. Sand is blurry and tiled, dirt carries a mirrored "owl-face" stain on every block, bark reads as leopard spots, pine leaf is stretched, plaster shows a block grid, bevel is faint/inconsistent. |
| 4 | Shape & modelling | **5** | Terrace lips and lavender strata read as real voxel landforms. Generator tells everywhere else: hollow "arch/table" trees, zig-zag palms, 1-voxel stair-stepped paths, a perfectly elliptical pond, four cloned cottages with no props. |
| 5 | Animation & motion | **4** | 8-frame strip (120 ms) at the pond: canopy silhouettes identical across frames, only water glints change. No readable leaf sway, foam or idle life. |
| 6 | Rendering polish | **5** | Soft cast shadows, AO, DOF, clean AA, no acne/z-fight. But aliased sine-stripe/moire water, hairline dark seam on the sand/water boundary, white-hot slivers on stream cuts, smeared mips on sand, visible rectangular world edge from the top camera. |
| 7 | Composition & readability | **6** | Sunset treeline and the 08:00 build-cam frame read well. Overview wastes the top third on haze, forest and night are muddy, village is four clones in a row. |
| 8 | Delight & juice | **4** | Warm window glow at night, blossom accents, pond glitter. No fireflies/butterflies/falling leaves/grass tufts/props; the edit demo exists but I did not view it. |
| 9 | Performance | **9** | 118-216 draw calls (budget 1200), 0.41-0.71 M tris (2.5 M), 144 fps display-capped, GPU <= 6.9 ms at 1920x1080, 0 console/page errors in the pack. Matches the ARCHITECTURE s7 bar with large headroom. First-interactive time, heap and the Iris Xe `low` preset were not measured. |

## Evidence
- Pack run by me: `node tools/shot.mjs --pack voxel --round c2` -> `shots/voxel/rc2/` (17/17 ok, 0 console errors, 0 page errors, max 206 draw calls, max 710 k tris, max frameMs 4.4, max gpuMs 5.6 at 1280x720; the filmstrip capture ran at ~71 fps because of capture overhead).
- My own shots in `shots/voxel/critic-r2/` (1920x1080): `A_free_east_sunset_1830` (free cam, 160,6,70 -> 60,9,-5, 18:30, 216 draws / 655 k tris / 6.9 ms GPU), `B_free_buildcam_0800` (free cam, 72,30,22 -> 58,6,-12, 08:00, 148 draws / 493 k tris), `C_crop_shore_sand_water_1830_crop` (3x crop of sand + waterline), `D_crop_village_roof_path_0800_crop` (3x crop of cottage roof/wall/path), `E_filmstrip_pond_1830_strip` (8 frames x 120 ms, 18:30).
- Pack frames actually looked at: 01, 02, 03, 04, 06b, 07, 08, 10, 12, 13, 14. **Not viewed (tool-call budget):** 05, 06, 09, 11, 15 and the builder's edit filmstrip 16 - judged only from stats. Blind A/B: `reference/` is empty -> no refs, rubric only. Own-shot stats lines were truncated, so their console-error counts were not captured (all five returned `ok:true`).
- Times of day seen: 08:00, 12:00, 16:30, 18:30, 23:00.

## Round-1 defects (orchestrator interim) - honest status
| r1 defect | status in r2 |
|---|---|
| 1 Grid seams on flat ground | Lawn: mostly fixed (continuous painted blades, soft mottling; a few faint diagonal seams in `06b` lower-left). **Sand: not fixed** (`03`, crop C: ~1 m tiles + blur). Plaster: faint block grid (crop D). |
| 2 Sky and horizon | Clouds now present and painterly, sea slab edge gone from the overview. **Milky lavender haze band (~25 % of `01`) with concentric moire rings remains**; top camera still shows the rectangular world edge against a flat outer ocean. |
| 3 Shaded faces navy/maroon | Cliff strata now lavender/pink (`04`, good). **Dirt is still brick-maroon** and is the darkest, most saturated mass in `08`, `A`, `E`, and `12`. |
| 4 Trees lumpy/noisy | Canopies are clean rounded stair-step domes now (real progress). Olive "arch" trees, zig-zag palms and one repeated pine remain. |
| 5 Shallows and water | Depth gradient, sun glitter and blurry tree reflections added (`A`, `08`) - real progress. Stamped oval discs in the shallows (`01`), moire stripes and no foam band remain. |

## Top 5 defects, ranked by visual impact

**1. Up-close surfaces are blurry, tiled and repeated (sand, dirt, bark, pine, plaster).**
- Where: `03_shore` foreground and crop `C` (sand = soft checkerboard of 1 m tiles + hairline dark seam along the waterline); `13_cave_overhang` (every dirt block has the same mirrored stain that reads as a face; indigo and pink cobble are one crack pattern tinted); `07_forest` (pine leaf and bark smeared/stretched, bark = leopard spots); crop `D` (visible light seams between whitewash blocks); `14_block_closeup` (post corners razor-sharp, bevel highlight absent).
- Why non-AAA: ~60 % of a third-person frame is ground. ACNH sand/grass and DQB2 floors are crisp, hand-painted and non-repeating with large-scale tonal drift; even Minecraft with a good pack has crisp texel edges. Ours looks like an upscaled low-res noise texture with a per-block stamp.
- Fix: 16x anisotropy + mip bias -0.5..-1 on the terrain atlas, 2-texel gutters (or a texture array) so seams vanish; 4-6 non-mirrored variants per top face chosen by hash(x,y,z) with random 90-degree rotation; multiply a world-space triplanar macro noise (period 6-24 m, +-8-10 % value, +-3-5 deg hue) over all terrain; repaint sand as 3-tone painted dune ripples (not blurred noise), dirt with pebbles/roots and no symmetry, bark with vertical ridges (spots <= 12 % darker), pine leaf as needle clusters at native texel density; bevel 5-7 % highlight on top/left edges and 8-10 % darkening on bottom edges for every opaque block including logs and walls; wet-sand band (-12 % luminance, +gloss) within 2-3 m of water.

**2. The world is not lit by the sky: flat value structure, no sun, milky horizon, murky night/forest.**
- Where: `A_free_east_sunset_1830` (purple/salmon sky above neutrally lit trees, no sun, halo, shafts, rim or long shadows); `01_overview` (haze band + moire rings across the far sea); `12_night` (grass/trees flat mid-dark, no moon, no lantern bloom, cut-out blue-plastic clouds); `07_forest` (teal/maroon murk).
- Why non-AAA: the "shadows cool and saturated, lights warm" tell from ART_BIBLE s1 is barely present. BotW/ACNH/DQB2 and shader-pack Minecraft put a warm key on sun-facing sides, violet fill in shade, rim light on foliage, bloom on the sun and shafts through canopies; the frame always has dark/mid/light. Ours is mostly one mid value.
- Fix: drive the block shader from the ART_BIBLE s2 table (18:30 sun `#FF9A5A` I 1.8-2.2 vs hemi `#8A74C8` 0.5-0.6 => key:fill about 2.5:1; shadow tint `#5B4B8A`, min 12 % luminance); visible sun disc + halo (bloom threshold ~0.85, intensity 0.6-0.9) and radial light shafts when elevation < 25 deg (6-10 samples, 0.15-0.25); +20-30 % warm back-light on foliage facing the sun; cut horizon fog density 40-50 %, tint with the per-hour fog colour, cap the band at <= 12 % screen height; fade water normals to flat beyond ~120-150 m to kill the moire; night: moon disc + stars, moon-blue rim (`#8FB0FF`, I 0.55) on top faces, emissive lanterns with bloom, 20-40 fireflies, soft-edged clouds.

**3. Palette discipline: acid-green lawn, brick-maroon dirt, indigo stone.**
- Where: lawn in `06b`, `10_village`, `B` (about `#1FC030` hot green with yellow strokes, one hue family); terrace and stream-trench sides in `08`, `E`, `A` (maroon, darkest saturated planes on screen); indigo band next to pink cobble in `13`.
- Why non-AAA: ART_BIBLE s1 gives meadow `#9BE564` / `#5CC95A` / shadow `#2E9E6B`, cliff-warm `#C9A98C`, wood `#B9783F`. First-party games keep earth warm and mid-value (ACNH beige-brown cliffs, DQB2 umber dirt); ours has materials that look like they come from different games and a pond bank that reads as a red trench.
- Fix: grass ramp = 3 hue-shifted tones (light `#9BE564` -> mid `#5CC95A` -> shadow `#2E9E6B`) with +-6 % per-block jitter and 8-15 % of blocks in dry-grass `#D6E063`; dirt albedo warm umber (`#8B5A3C`..`#A06A44`) with violet only in AO/shadow; one rock ramp (lavender `#B8A9C9` -> crevice `#6C5B7B` -> warm `#C9A98C`) and drop the flat indigo variant (or limit to ore accents); no lit face under ~20 % luminance.

**4. Shape language of trees, paths, pond and village feels generated.**
- Where: `08_pond` and `E` (olive "table/arch" trees: cube canopy with the trunk visible under a cut-out); `A` (palms = zig-zag 1-voxel trunk + flat slab frond); `10_village` and `B` (1-voxel zig-zag stair path; four identical cottages, no chimney/porch/fence/garden, flush doors); `02_top` (pond = perfect ellipse with a uniform 3-voxel rim, stream = constant-width ditch).
- Why non-AAA: DQB2/ACNH silhouettes are designed and asymmetric, with props (chimneys, flower boxes, fences, lanterns, signposts, wells) and organic curves. These are the generator tells a Nintendo art director spots in one glance.
- Fix: >= 3 cottage variants (L-plan, chimney 2x2x3, porch with half-block rail, flower boxes, arched door) plus fence/lantern/mailbox/well/garden props; path as a 2-3 wide meandering band with slab steps and gravel scatter; replace the arch tree with a 3-layer rounded oak (r 3-4-3, trunk hidden except the last 2 voxels) and give palms a leaning 2-voxel curved trunk + 5-frond cross; pond outline warped by 2-3 octave noise (+-3 m), partial rim, lily pads and reeds; stream width 2-4 m with meander, pebble banks.

**5. Water and shoreline rendering.**
- Where: `A` and crop `C` (horizontal sine-stripe ripples aliasing at grazing angles, hairline dark seam where water meets sand, glowing orange sand-slab lips); `01`/`02` (concentric moire rings and diagonal hatching on far sea, stamped oval discs in the shallows, dotted foam); `08`/`E` (near-white glitch slivers where the stream cuts the bank).
- Why non-AAA: ACNH shores have a crisp animated foam/wave line plus wet-sand fade and soft caustics; DQB2 water is glossy with bright foam; shader-pack Minecraft has distorted SSR reflections. Ours aliases and exposes the water/terrain join.
- Fix: depth-based foam band 0.4-0.8 m wide with an animated noise threshold and a 2-3 s advance/retreat cycle; mip/roughness-aware (Toksvig) normal filtering, wavelength 1.5-3 m, 2 octaves, amplitude -> 0 beyond ~120 m; drop the water surface 0.06-0.1 m below the shore block tops (or overlap) to remove the hairline; clamp sun glitter/specular <= ~1.2 to stop white-hot slivers; replace circular bathymetry with noise-warped contours and a continuous `#6EE7D8` -> `#2BB8D9` -> `#2563C7` gradient.

## What is already good
- Roof tiles, cobble base, window glass and the terrace grass-lip / lavender strata silhouettes (`04`, `13`, crop `D`) are genuinely diorama-grade; the painted cloud sky is the best-looking element in the frame.
- Soft cast shadows from trees and cottages on the lawn plus gentle DOF make the 08:00 build-cam frame (`B`) read pleasantly; blocky tree reflections in the water (`A`) are a good start.
- Performance headroom is huge (<= 216 draws, <= 0.71 M tris, <= 7 ms GPU at 1080p): spend it on shadows, texture resolution and the lighting pass.

## Plateau?
Not plateauing yet: r1 -> r2 removed the slab edge, added clouds, fixed lawn seams, lightened cliffs and added water depth. But the three defect families (tiling/texture, haze/lighting, maroon dirt/palette) are the same ones the orchestrator listed in r1; if they are still top-3 in round 3, escalate to an authored/generated atlas and a dedicated lighting pass instead of more procedural-noise tuning.
