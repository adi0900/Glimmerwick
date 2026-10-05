# Brief: look (atmosphere, lighting, materials, post-processing)
Owner of: `web/src/engine/Materials.ts`, `Post.ts`, `Lighting.ts`, `web/src/engine/glsl/**`, `web/src/modules/atmosphere/**` (taken over from foundation-web's first versions).
Goal: the single biggest lever for "this looks AAA". You own the final image: sky, clouds, sun, light, shadows, fog, weather, colour grade, AO, bloom, DOF, outlines, AA, tone mapping and the shared `ToonLit` look.
Judged against Pokémon Legends: Arceus skies/atmosphere, Animal Crossing's warm toy lighting + tilt-shift cosiness, Breath of the Wild depth.

## Deliver
- **Sky & celestial:** painterly gradient dome per ART_BIBLE §2 (smoothly interpolated through the colour script), sun disc + halo, moon with phases, stars + subtle shooting stars/aurora at night, **volumetric-looking clouds** (raymarched shader or layered impostors) with lit edges and silver lining; soft cloud shadows drifting over terrain via a shared texture exposed as `ctx.uniforms.uCloudShadowTex`; distant cloud banks; subtle god rays at low sun; aerial perspective (sky-tinted distance fog, height fog pooling in valleys).
- **Lighting:** sun directional with fitted/cascaded soft shadows (no acne / peter-panning / jaggies, shadow distance fits the camera), hemisphere + coloured bounce, cool shadow fill, night moonlight + warm point-light support (lanterns), emissive handling, smooth time-of-day from the `time` channel.
- **`ToonLit` mastery:** finalise ramp softness, rim, hand-painted albedo, crevice tint, foliage translucency, fur fuzz, lacquer spec, glow; document classes; cheap enough for thousands of instances; cloud-shadow, wind and bender hooks (`docs/WORLD_CONTRACT.md` uniforms are the contract — implement ALL of them).
- **Weather:** clear / cloudy / rain (streaks, ripple hooks, wet surfaces: darker + glossier) / storm (lightning flashes, strong wind) / snow (flakes, accumulation tint) / fog; smooth transitions; wind gusts feeding `uWind`.
- **Post stack:** AA with no shimmer (MSAA / SMAA / TAA — choose & justify), GTAO/N8AO-quality AO, soft bloom on sun/emissives only, tilt-shift DOF (subtle miniature feel, focus follows the player), edge-detected *coloured* outlines (distance-faded, characters stronger), vignette, per-time-of-day colour grade (LUT or analytic), AgX/neutral tone mapping tuned so colours stay saturated and joyful. Quality presets low / med / high / ultra.
- **Night:** beautiful not dark — blue-violet moonlight, warm lantern pools, fireflies, glowing-flora hooks.
## Gallery cams & `shots.json` (≥ 12)
Same hero camera at 05:30 / 08:00 / 12:00 / 16:30 / 18:30 / 20:00 / 23:00 · rain · storm · snow · fog · cloud close-up · sunset sky wide · material close-ups (clay, felt, lacquer, foliage, stone, wood, water).
## Traps
banded/ugly gradients, grey fog, blown highlights, crushed blacks, flat ambient, visible cascade seams, over-bloom, muddy grade, shimmering outlines, DOF that blurs the player, sky that looks like a CSS gradient.
