# World / flora shared contract (world + flora + look + creatures agents all read this)

Owner of this file: orchestrator. Change requests → `docs/REQUESTS.md`.

## Biome ids (`world.biome`, u8 per cell)
0 ocean-deep · 1 shallows · 2 sand · 3 meadow · 4 forest-floor · 5 highland-grass · 6 cliff-rock · 7 dirt-path · 8 pond-bank/mud · 9 flower-meadow · 10 village-clearing (packed earth/grass) · 11 snow (seasonal overlay, optional)
`world.info` JSON must include: `size_x,size_z` (m), `cell` (m), `origin_x,origin_z`, `sea_level`, `chunk` (cells), `spawn:{player:[x,z],village:[x,z]}`, `habitats:{biome→[[x,z,r],…]}`.

## Flora kinds (`flora` channel, stride 8: kind · x · y · z · yaw · scale · variant(0-255 seed) · state(0-1 growth/season hint))
| range | kinds |
|---|---|
| Trees 0-15 | 0 oak-puff (round puffy broadleaf) · 1 tall-puff · 2 pine-tier · 3 blossom (pink) · 4 palm (beach) · 5 willow (waterside) · 6 birch · 7 maple (autumn reds) · 8 giant-glowcap (mushroom tree, night glow) · 9 dead-tree (rare) · 10 apple (fruit) · 11 orange (fruit) |
| Bushes 16-31 | 16 round-bush · 17 berry-bush · 18 fern · 19 hydrangea · 20 shrub-flowering |
| Flowers 32-47 | 32 daisy · 33 tulip · 34 lavender · 35 sunflower · 36 bluebell · 37 poppy · 38 lily · 39 clover-patch |
| Mushrooms 48-55 | 48 red-cap · 49 glowcap (night glow) · 50 brown-cluster |
| Rocks 64-79 | 64 boulder · 65 flat-rock · 66 pebbles · 67 mossy-rock · 68 crystal-cluster (glow) · 69 sea-stack (coastal) |
| Water plants 80-95 | 80 reeds · 81 lily-pad · 82 cattail |
| Beach 96-111 | 96 shell · 97 starfish · 98 driftwood · 99 beach-grass tuft |
| Natural props 112-127 | 112 stump · 113 log · 114 mossy-log |

**Grass is NOT in this channel.** The flora module renders millions of blades itself from `world.biome` + slope + noise (density rules below).
Density rules (world owner implements placement; flora owner may request tuning): forest-floor 0.045 trees/m² mixed 0/1/2/6/7 with ferns+mushrooms underneath; meadow sparse single trees (0.003/m²) + flower clumps (Poisson clusters of 6-30);
flower-meadow dense flowers; sand: palms (0.0015/m²), shells/starfish/driftwood; pond-bank: reeds, willows, lily-pads on water; highland: boulders, mossy rocks, pine; cliff-rock: sea-stacks/boulders at base only.
No flora in water (except 80-82), on slopes > 35°, or within 2 m of the village clearing's paths.

## Shared shader uniforms (`ctx.uniforms`, owner look; everyone samples, nobody redefines)
`uTime, uSunDir, uSunColor, uSkyZenith, uSkyHorizon, uHemiSky, uHemiGround, uFogColor, uFogDensity, uWind(vec2 dir*strength), uWindTime, uPlayerPos(vec3), uTimeOfDay(0-24), uSeason(0-3), uSeasonT, uRain(0-1), uSnow(0-1), uCloudShadowTex, uCloudShadowParams, uWorldSize, uWetness`.
Creature positions for grass bending: look/flora agree on `ctx.uniforms.uBenders` (vec4 array xyz + radius, ≤ 16 nearest) filled by the creatures/player modules.
