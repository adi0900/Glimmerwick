# Critique — `creatures` (micro-voxel Puffbun / Tidler / Sprigfox + voxel avatar) — Round 1

**Verdict: FAIL.** 8 of 9 axes are below 9. The brief's own acceptance (>= 9 on axes 3 and 4 in close-ups, each species readable at 64 px) is not met.
Blind A/B: `reference/` is empty, so it was skipped (rubric only). Everything below is scored from captures I made myself.

| # | Axis | Score | Reason (one line) |
|---|---|---|---|
| 1 | Art direction & cohesion | 6 | One micro-voxel language across 4 characters, but 2 of 3 species wear hostile faces, variants go dusty-pastel, and the clean-clay creatures sit apart from the painterly world |
| 2 | Lighting & colour | 5 | No cast or contact shadows, no warm/cool split, no rim; head-top faces read mauve and darker than the fronts; night collapses to flat ultramarine |
| 3 | Materials & texture | 6 | Bevel + AO toy-block surface is clean at macro (`15`, `c1`) but has no fur/felt/clay richness; off-colour voxels and grainy grey voxels read as speckle |
| 4 | Shape & modelling | 6 | Puffbun ~8 (iconic ears, cute head); Tidler 5-6 (helmet cap, glued-on fins, rigid paddle tail); Sprigfox 5 (boxy, stilt legs, cluttered crown + checker ears); avatar 6 (no readable mouth, ragged chin) |
| 5 | Animation & motion | 6 | Puffbun idle is alive (ear splay, head glances, narrowing eyes) and the avatar sprint alternates legs, but amplitude is small and no squash/stretch, anticipation, overshoot or VFX appears in anything captured |
| 6 | Rendering polish | 6 | Crisp AA, clean bevels, no acne/shimmer in stills, 0 console/page errors; but no shadows, timid bloom, flat sprite-like glow halos |
| 7 | Composition & readability | 5 | 3 of 16 pack shots do not show what they claim (`10`, `14`, `16`); saturated red roofs outrank the creatures; 64 px readability is not demonstrated by the builder |
| 8 | Delight & juice | 5 | Puffbun is pokeable; Tidler/Sprigfox glare; no emote, dust, sparkle or visible glow pulse in any shot |
| 9 | Performance | 9 | Meets ARCHITECTURE s7 in every measured scene (see stats); watch the ~24k tris per creature |

## Evidence I captured myself (all under `shots/creatures/`)
- `r10/` pack: 16 shots + the 64 px crop, every PNG read. Pack stats: 0 console errors, 0 page errors, 214-303 draw calls, 473k-989k tris, 144 fps (capped), GPU <= 6.8 ms.
- `critic-r1/`: `avatar_strip.png` (real key presses; walk 4.3 m/s, sprint 5.6 m/s, jump apex 1.25 m, 0 errors), `states_strip_strip.png` (set=states, 8 x 120 ms), `puffbun_idle_strip.png` (8 x 400 ms), `live.png` (photo cam on a sim creature, 12 alive), `game_day.png` / `game_night.png` (`--view game`: 374 / 344 draw calls, 1.86M / 1.72M tris, heap ~110 MB, 0 errors), crops `c1_tidler_face_crop`, `c2_sprigfox_head_crop`, `c3_avatar_face_crop`, `c4_night_glow_crop`, `c5_contact_crop`.
- Triangle cost by differencing pack stats: 514k tris (3 creatures + avatar, `01`) -> 731k (12 creatures, `10`) ~ 24k tris per creature.

## Top 5 defects (ranked by visual impact)

### 1. Faces: two of three species and the avatar read hostile, dead or tearful
- **Where:** `04_tidler_portrait` + `c1_tidler_face_crop` (one black visor band across both eyes with a white slit, orange "beak", black frown). `05_sprigfox_portrait` + `c2_sprigfox_head_crop` (eyes are black plus/slash shapes with no highlight at all: the brief's "dead eyes" trap). `06_avatar_portrait` + `c3_avatar_face_crop` (white bar over a big blue block reads as a tear pool; the mouth is three isolated maroon voxels with skin voxels between them; ragged chin). `c4_night_glow_crop` (orange Tidler variant shows blue drips under both eyes). Only Puffbun (`03`, `15`, idle strip) has a friendly face.
- **Why it reads non-AAA:** Scarlet/Violet starters (Sprigatito, Fuecoco, Quaxly), Animal Crossing villagers and even Minecraft's axolotl and fox default to big round eyes with 2 highlights and an up-turned mouth, readable at 64 px. Ours is "Angry Birds" glare, KO eyes and crying: the opposite of "kids fall in love at first sight", and the avatar (every portrait, every cutscene) has no mouth.
- **Fix:** one shared eye template, 5x5 voxels (~30 % of face width): iris fills the eye in 2 tones only (base + a 12-15 % lighter bottom row, same hue; never blue/violet under a dark socket), 2x2 white highlight upper-left + 1x1 secondary lower-right, outline ring only on top/outer edge in `#2B1B3F` (not black); lids/mask as body-coloured 1-voxel rows, only for blink/sleep. Tidler: delete the visor, two oval eyes >= 2 voxels apart, orange becomes two 2x2 cheek blushes, 5-voxel upturned mouth. Sprigfox: 3x4 oval eyes + highlight, cream brow dots, 1-voxel "w" mouth under the muzzle. Avatar: iris full height, mouth = 3-4-voxel smile on the symmetry axis in skin x 0.75 (~`#B5654A`), blush max 2 voxels per cheek. Add a face-sheet shot (4 faces x neutral/happy/sleepy/surprised, at 1:1 and at 64 px).

### 2. Nothing is grounded or lit by the scene: no shadows, no warm/cool split, dusty tops
- **Where:** `c5_contact_crop` (Puffbun and Tidler feet: no contact shadow, no AO ring), `01`/`02`/`11`/`12` (golden hour, yet creatures are as flat as at noon), `game_day` (avatar casts nothing on the lawn), `15_macro_eye` (head-top faces are dull mauve and darker than the front faces, the reverse of the world where tops are brightest), `13`/`c4` (night = flat saturated ultramarine bodies).
- **Why:** Legends: Arceus / Scarlet-Violet put a soft shadow under every creature and a warm-key / cool-violet-shade split on the fur; Animal Crossing has a blob shadow under every villager. Without it ours look like stickers on the lawn, the biggest "from a different game" tell once a creature stands next to the world.
- **Fix:** (a) blob decal under each creature, radius ~0.6 x body length, opacity 0.35-0.5, colour `#5B4B8A`, plus enable the creature layer in the sun shadow map (bias 0.0005-0.002, normalBias 0.02-0.05); (b) drive the creature shader from the same sun/hemi uniforms as the world (ART_BIBLE s2): 3-band ramp, edges smoothstepped over 8-12 %: lit x1.0 warm-tinted, mid x0.78, shade x0.55 mixed ~25 % toward `#5B4B8A`; (c) Fresnel rim, pow ~3, strength 0.2-0.3, sun-coloured; (d) top faces must get the highest N.L: find the term that makes them mauve; (e) night: ramp toward `#5B4B8A` with moon `#8FB0FF`, never saturated blue.

### 3. Colour speckle and contour noise (the brief's own trap list)
- **Where:** `05` + `c2_sprigfox_head_crop` (ears and muzzle are grey/orange checkerboards with stray orange voxels inside grey patches; grey voxels carry a visible grain the orange ones do not), `03_puffbun_portrait` (cool-mauve voxels interleaved with pink along the right flank and cheek rim), `15` (head-top rows tinted a different hue from the face), `04` (red fins stuck on as separate cards).
- **Why:** Pokemon/Animal Crossing models are clean 2-3-tone regions with deliberate markings; Minecraft mobs never have random off-colour pixels even at 16 px. Stray single voxels read as sculpting errors and make silhouettes lumpy.
- **Fix:** no per-voxel hue jitter, only +/- 2-3 % lightness; markings only as designed shapes >= 2 voxels; orphan-voxel cleanup pass (a voxel whose 6 neighbours all differ is recoloured unless flagged `detail`); ears = tapering 3-wide columns with a 1-2-wide cream inner stripe; fluff only at defined places (cheek tufts, tail; 1-2 voxels), not along the whole outline; one grain treatment shared by every voxel colour.

### 4. Tidler and Sprigfox silhouettes lack Puffbun's iconic punch
- **Where:** `07_variants_grid` at ~55-75 px (Tidler = teal lump with spikes; Sprigfox = orange stilt-legged shape with a green tuft), `04` (flat helmet cap of stacked rectangles; fins like glued cards), `08_turnaround` + `states_strip_strip` frames #2-#6 (profile reveals a rigid horizontal tail ending in a flat red disc, "lizard dragging a frying pan"; front and profile read as two animals), `05` (boxy head, long legs, leaf crown + two checker ears = cluttered).
- **Why:** Game Freak's silhouette test: each species must be identifiable as a black shape at 64 px with ONE strong idea. Puffbun has it (ears); the other two carry 3-4 competing ideas.
- **Fix:** Tidler: head as a ~7x6x6-voxel ellipsoid with 1-voxel chamfers (no flat cap), body +15 % wide, fins as one tapering 3-step crest fused to the back, tail ~40 % shorter ending in a round fin, +/- 5 deg idle sway. Sprigfox: head ~38-40 % of body length, legs -20 %, ears = 2 clean cones, ONE sprout instead of the crown, tail plume as a clear S-curve with 3 leaf tiers. Gate: render all species as black silhouettes at 32 and 64 px in the pack and check they are pairwise distinct.

### 5. Glow markings do not glow, and night does not feel like night
- **Where:** `13_night_glow` + `c4_night_glow_crop` (cyan ear caps are flat bright blocks with a faint halo; yellow fin glows are flat petals; no light falls on the ground or neighbours; bodies collapse to saturated ultramarine), `02`/`03` by day (yellow ear tips are simply yellow blocks; no pulse visible).
- **Why:** Scarlet/Violet Tera crystals and Legends' glowing creatures bloom, throw coloured light on the floor and shed particles; night is meant to be beautiful (ART_BIBLE s2), here it is a hue-swap.
- **Fix:** emissive 3-4 x body luminance with HDR bloom (strength 0.6-0.9, radius ~0.4, threshold ~0.9); soft ground light decal / point light under glow organs (radius 1.2-2 m, intensity 0.25-0.4, marking colour); pulse 0.85 <-> 1.15 at 0.4-0.8 Hz keyed to mood, 2-4 slow motes per creature at night; keep the night body ramp violet-blue with value separation at the face.

## Also wrong (not in the top 5)
- **Pack evidence is broken:** `14_readability_64px` (+ crop) shows only two ear tips over a grass hump, so "readable at 64 px" is unproven (my own check on `07`: silhouettes differ but faces are 3-4 px blobs, Tidler weakest). `16_turntable_filmstrip` is the whole island from above, 8 identical frames, no creature (the pack's filmstrip entry probably drops `view=creatures`; my `--view creatures` strips work). `10_states` uses the far `variants` camera so sleep/happy are unreadable blobs. `09_size_lineup` clips the large Sprigfox at the frame edge.
- **Avatar back view** (what a third-person player mostly sees): concentric dark rings on the hair dome plus a pale chevron that reads like a glitch/skull mark at ~120 px (`game_day`, `avatar_strip`). Sprint shows alternating legs and small arm swing, but no dust puffs and no shadow.
- **Value structure:** saturated red roofs and dark trunk columns outrank the creatures (`01`-`06`, `09`, `11`); window frame and trunk tangents sit behind ears (`03`, `05`). Calmer backdrop or stronger DOF/desaturation needed.
- **Cost:** ~24k tris per creature is high for ~12-voxel animals; fine now (game view 1.86M of 2.5M) but ~30 creatures would break the cap; no LOD visible.

## Already good
- Three distinct silhouette families with three colourways each; clean bevelled micro-voxels with soft AO and no aliasing at macro (`15`, `c1`).
- Puffbun is genuinely charming and its idle is alive (ear splay, head glances, narrowing eyes: `puffbun_idle_strip` e.g. #2, #3, #5); budgets met (303 DC lab, 1.86M tris in game, 0 errors).

**Plateau:** no (round 1; no previous critique for this module). **Not captured:** blind A/B (no refs), creature hop squash-and-stretch and walk cycle (not triggered by the lab sets), glow pulse over time (stills only).
