# Art Bible — "sunlit toy diorama"

**North star:** a sunlit toy diorama come to life — soft clay / felt / lacquered-wood materials, warm golden light with
cool tinted shadows, saturated-but-harmonised colour, gentle miniature-style depth of field, and hand-painted
micro-detail on every surface. Reads instantly, feels delicious, looks lovingly crafted.

Touchstones (study the *qualities*, never copy assets): Pokémon Legends: Arceus / Scarlet-Violet (charismatic creature
design, painterly landscapes), Animal Crossing: New Horizons (toy-like materials, warm light, tilt-shift cosiness),
Breath of the Wild (atmospheric depth, skies), Minecraft (chunky readable shapes, satisfying building),
Kirby / Mario Wonder (squash-and-stretch juice), Ghibli backgrounds (painterly clouds, light).

## 1. Colour
| token | hex | token | hex |
|---|---|---|---|
| meadow-light | `#9BE564` | water-shallow | `#6EE7D8` |
| meadow-mid | `#5CC95A` | water-mid | `#2BB8D9` |
| meadow-shadow | `#2E9E6B` (hue-shift to teal) | water-deep | `#2563C7` |
| dry-grass | `#D6E063` | foam | `#F4FFFB` |
| forest-floor | `#3E8E5A` | sand | `#F6E2B3` |
| wet-sand | `#D9B98A` | rock-lavender | `#B8A9C9` |
| cliff-warm | `#C9A98C` | rock-crevice | `#6C5B7B` |
| wood | `#B9783F` | wood-dark | `#7A4A2B` |
| terracotta | `#E2674A` | whitewash | `#FFF3E0` |
| ui-cream | `#FFF7E8` | ui-ink | `#4A3B52` |
| ui-coral | `#FF7A6B` | ui-mint | `#5FD3B0` |
| ui-sun | `#FFC94D` | ui-sky | `#6AB8FF` |

Rules:
- Never pure black or pure white. Darkest shadow >= 12 % luminance, hue-shifted toward blue-violet (~`#5B4B8A`);
  brightest highlight warm (~`#FFF4D6`). **Shadows cool & saturated, lights warm** — the biggest "first-party Nintendo" tell.
- Derive shades by *hue-shifting* (darker = cooler/more saturated, lighter = warmer), not by mixing with black/white.
- Saturation 55-85 % on hero elements, 30-55 % on backgrounds; distance shifts toward sky colour (aerial perspective).
- Every frame has a clear 3-value structure (dark / mid / light); the focal point carries the highest contrast.
- Characters, creatures, UI are exempt from background desaturation.

## 2. Light — time-of-day colour script (start values; Look agent refines)
| hour | name | sun colour | sun I | sky zenith | sky horizon | hemi sky | hemi ground | fog | fog density |
|---|---|---|---|---|---|---|---|---|---|
| 05:30 | dawn | `#FFB48A` | 1.4 | `#6E7FD8` | `#FFC7A8` | `#8FA6E8` | `#6B5B7B` | `#F2B9A5` | 0.012 |
| 08:00 | morning | `#FFE9C2` | 2.6 | `#62B0F5` | `#D5EEFF` | `#A7D2FF` | `#8CB07A` | `#CFE8FF` | 0.008 |
| 12:00 | noon | `#FFF6E0` | 3.2 | `#4FA3F0` | `#CFEAFF` | `#9CCBFF` | `#9BC27E` | `#C8E6FF` | 0.006 |
| 16:30 | golden | `#FFD08A` | 2.8 | `#5B9CE6` | `#FFE2B8` | `#9FB9F0` | `#A5A06A` | `#FFE0B5` | 0.009 |
| 18:30 | sunset | `#FF9A5A` | 1.8 | `#6A5FD0` | `#FFA97A` | `#8A74C8` | `#7C5A6A` | `#FFB08A` | 0.014 |
| 20:00 | dusk | `#C98AE6` | 0.7 | `#3B3F9C` | `#E58AB0` | `#5B5FB8` | `#4A4A7A` | `#8C6AA0` | 0.016 |
| 23:00 | night (moon) | `#8FB0FF` | 0.55 | `#141A48` | `#2C3478` | `#3A4590` | `#20254F` | `#2A3470` | 0.014 |
Default hero look = **16:30 golden hour**. Night is *beautiful*, not dark: blue-violet moonlight, warm lanterns, fireflies, glowing Glimmers.
Shadows: one directional sun, fitted/cascaded soft shadows (no acne, no peter-panning, no jaggies), cool ambient fill so
shadows are never black, contact AO on top, soft character shadows.

## 3. Materials (shared library `web/src/engine/Materials.ts`, owned by the **look** module)
All opaque surfaces use `ToonLit`: soft 3-4 band ramp (band edges smoothstepped over 8-12 % of N·L), cool-tinted shadows,
warm rim light (Fresnel pow 2.5-3.5, strength 0.15-0.35), tiny stylised specular on lacquer/water/eyes, plus a procedural
*hand-painted* albedo layer (low-frequency hue/value drift ±6 %, brush-stroke noise at 2 scales, crevice/edge tinting,
macro variation that kills tiling). Never flat unlit-looking plastic, never default `MeshStandardMaterial` grey.
Classes: clay (characters, creatures), felt/fur (fuzzy rim), lacquer (glossy toys, eyes), foliage (back-lit translucency,
wind), stone, wood, water, glow. Subtle coloured outlines (hue-shifted darker, not black): ~1.5 px characters, ~1 px environment, distance-faded.

## 4. Shape language
- Rounded, chunky, bevelled. Every hard edge has a bevel (>= 0.04 m). No razor-thin or needle geometry. Silhouettes read at thumbnail size.
- Characters: chibi, 2.5-3 heads tall, head ≈ 40 % of height, large eyes (≈ 30 % of face width) with >= 2 highlights,
  simple hands, chunky layered clothing.
- Glimmers: one strong silhouette idea per species, 1-2 body colours + 1 accent, a signature feature (ears/tail/crest/glow
  organ), expressive eyes, readable at 64 px; soft bioluminescent markings that pulse with mood.
- Scale: 1 unit = 1 m. Player 1.15 m, Glimmers 0.3-1.4 m, grid cell 1 m (half-steps for furniture), trees 3-9 m, island ≈ 250-400 m.
- Architecture: cottage-core — warm plaster, timber frames, terracotta tiles, round windows, mossy stone.

## 5. Terrain, water, foliage, sky
- **Terrain:** gentle sculpted forms, tiered cliffs with rounded lips, beaches with wet-sand darkening, worn paths. Triplanar
  painted textures with macro variation, grass tufts bleeding over edges, AO-ish darkening at cliff bases and under trees.
- **Water:** depth-based gradient (shallow → deep), animated foam bands tracing the shoreline (depth-based), soft sun glitter,
  refraction/caustics on seabed, gentle waves, ripples + splashes on interaction, sparkles. Never a flat transparent plane.
- **Grass:** instanced blades (>= 200k visible via LOD/chunk culling), root→tip gradient, wind waves + gusts, bends away from
  player/creatures, flowers with clumping noise, distance fade into painted ground.
- **Trees:** layered puffy canopies with lobed silhouettes, back-lit leaf translucency, trunks with roots + bark detail,
  falling leaves; >= 6 distinct shapes; seasonal variants.
- **Sky:** gradient + painterly volumetric-looking clouds (lit edges, soft cloud shadows drifting over terrain), sun halo,
  stars + moon at night, distant islands/clouds for depth. Subtle god rays at low sun.

## 6. Motion
Squash & stretch (volume-preserving), anticipation → action → overshoot → settle; arcs; secondary motion on ears/tails/hair/cloth via
springs (stiffness 80-200, damping 6-14); everything eases (never linear); idles are never static (breathing, blink every 2-6 s,
glances, fidgets). Must feel good at 60 fps.

## 7. VFX
Sparkles, soft round particles (soft-edged, additive/premultiplied), dust puffs on land/run, leaf bits, splash rings, heart/note/zzz emotes,
collect pops with rising numbers, bloom on emissives. Short and punchy (150-600 ms), eased scale in/out. No hard-edged quads.

## 8. UI (DOM overlay)
Chunky rounded "paper-craft" panels (cream fill, ink text, 3-layer soft shadow, 2 px inner highlight). Fonts: Fredoka (display/numbers) +
Nunito (body) via @fontsource (offline). Buttons squash on press and spring back; hover/click always make a sound; panels bounce in
(0.92→1.02→1, ~220 ms). Icons rendered from the real 3D items. >= 44 px touch targets, >= 4.5:1 contrast, gamepad-navigable, short text (kids!).

## 9. Audio direction
Warm, wooden, bubbly: marimba / kalimba / music-box / soft pads / plucked bass, pentatonic & lydian colours; adaptive layers by
time-of-day, biome and activity; footsteps vary by surface; ambience beds (waves, wind, birds, crickets); UI blips pitched to the
scale; each Glimmer species has an expressive formant-synth voice. Master limiter, ducking, never harsh.

## 10. Camera
Third-person follow, FOV 50-55°, pitch 18-30°, distance 5-9 m, critically-damped follow with look-ahead, collision-safe, subtle
tilt-shift DOF, photo mode with free camera.

## 11. Never
Flat grey/brown mud · default three.js look · hard black shadows · razor-edged polys · z-fighting · shimmering/aliased grass ·
texture stretching · visible tiling · floating or clipping objects · pop-in without fade · T-pose · static idle · harsh clipping audio ·
walls of text · anything that reads as a "tech demo".
