# Critique — `creatures` (Puffbun / Tidler / Sprigfox + voxel avatar) — Round 3

**Verdict: FAIL.** 0 of 9 axes reach 9 (best 8). Blind A/B skipped: `reference/` is empty (rubric only). Scored from scratch from captures I made myself.

| # | Axis | Score | Reason (one line) |
|---|---|---|---|
| 1 | Art direction & cohesion | 7 | One voxel language, one eye template, tidy palette; but Sprigfox (glaring green sockets, clutter) and the avatar (heavy brown sockets, black hair slab) are still a tier below Puffbun / Tidler |
| 2 | Lighting & colour | 8 | Warm key, long cast shadows, cool shade tint and ground glow spill (`30`) all read; Puffbun flank turns muddy mauve in shade, night bodies are still one flat blue-violet and Tidler/Sprigfox go brown-grey mud at night (`13`) |
| 3 | Materials & texture | 6 | Clean bevelled cubes, still just painted cubes: no fur / felt / scale cue, Sprigfox muzzle and Puffbun mouth are noisy voxel clusters, avatar hair is a flat black mass |
| 4 | Shape & modelling | 7 | Puffbun ~8; Tidler 7 (friendly face now, but the lollipop tail bulb on a long neck reads as a periscope); Sprigfox 6 (ear/sprout/plume clutter, odd glare); avatar 6 (heavy jaw, ragged chin, spiky back-hair) |
| 5 | Animation & motion | 7 | Real gait cycles, hop stretch, ear/tail lag, tail sway, dust voxels on landing/run; amplitude still small, torsos stay rigid in walk (no weave / bob), no squash on landing visible in strip, avatar strip shows alternating legs only |
| 6 | Rendering polish | 7 | 0 errors, crisp, shadows grounded; shadow edges still hard, shade tint a bit heavy, bloom subtle, "live" camera shows block-edge seams around the creature |
| 7 | Composition & readability | 7 | Silhouette gates now exist (`24`,`25`): Puffbun and Sprigfox unmistakable at 32 px, avatar fine, Tidler = body + lollipop (readable but not iconic); gameplay camera (`22`) frames them at ~80-100 px so faces are 6-8 px; live game creature is still a 40 px blob (`live.png`) |
| 8 | Delight & juice | 7 | Puffbun and avatar are friendly, night glow spill + pulse is charming; Sprigfox looks suspicious, no emote bubbles, little sparkle |
| 9 | Performance | 8 | 0 errors; 207-299 DC, 0.36-1.03M tris; ~24k tris per creature and no LOD still cap crowd size |

## Evidence (all under `shots/creatures/`)
- `r16/` pack: 30 shots, all key ones read (01, 02, 05, 08, 13, 17-22, 24, 25, 26, 29, 30). Stats: 0 console / page errors.
- `critic-r3/`: `walk`, `hop`, `run`, `accel` strips (`--cam tread`), `avatar_strip.png` (walk 4.3, sprint 5.6 m/s, stop ~200 ms, jump 1.25 m, 0 errors), `live.png` (12 creatures, nearest 21.9 m).
- Not captured: blind A/B (no refs); true travel on the treadmill (fixed positions); pulse over time (single frames only).

## Status of round-2 defects
| Round-2 defect | Status | Evidence |
|---|---|---|
| 1. Tidler face shouting | **Mostly fixed.** Frame removed, round eyes with highlights and cheek blush, cream lower lip. Remaining: pupils drawn at the top-inside corner giving a worried look, mouth is a flat 5-voxel black slot with no corners (deadpan), left/right eye not mirrored | 19, 17 |
| 1. Sprigfox face glaring | **Partly fixed.** Top lid row gone, but each eye is a dark-green ring + white block with no pupil, plus a bright-green lower-lid; reads as wide-eyed/suspicious. Muzzle is still a 3-tone brown noise cluster with a black nose block | 20, 05 |
| 1. Avatar startled | **Partly fixed.** Smile and blush now exist and the front (`01`, `17`) reads friendly at distance; up close (`21`) the dark-maroon sockets, no pupils, heavy jaw and red-voxel mouth still look uncanny | 21, 17 |
| 2. Tidler silhouette + rigid tail | **Partly fixed.** One iconic idea now (red bulb on a curled neck-tail), swaying; reads as a lollipop/periscope, hop strip shows the tail bulb bobbing separately from the body; fins merged | 25, 24, hop |
| 3. Sprigfox clutter | **Partly fixed.** Plume now attached and mane band gone, but head still has ears + inner stripes + sprout + dark tips + muzzle, and the plume is a big detached-looking green bush from the side (`29`) | 05, 29 |
| 4. Rim / shade tint / glow spill / night | **Mostly fixed.** Violet shade ramp, rim, ground-glow pools and pulsing caps are visible (`30`, `13`). Night bodies still flat and desaturated for Tidler/Sprigfox | 13, 30 |
| 5. Dust / squash / shadow shrink | **Partly fixed.** Dust voxels visible in run (#6) and hop; squash/anticipation amplitude is timid; bob still ~1 voxel in walk | run, 29 |
| Avatar back-of-head | **Not fixed** (changed, not fixed): rings are gone, but macro `26` shows a black slab with ragged vertical hair spikes and holes, no parting/highlights; strips show a featureless dark dome | 26, avatar_strip |
| Gameplay-camera shot | **Added.** `22` is honest: creatures are 80-100 px tall and faces are a few pixels; Puffbun/Tidler read, Sprigfox reads as an orange blob with sprout | 22 |
| 32/64 px silhouette gate | **Added.** Four distinct shapes; Tidler weakest | 24, 25 |

## Top 5 remaining defects (ranked by visual impact)

### 1. Avatar: back, hair and close-up face are still the weakest asset
- **Where:** `26_avatar_back` (black slab with ragged hair spikes and gaps, bare brown-skin nape), `avatar_strip` (featureless dark dome while the player stares at it 100 % of the game), `21_face_avatar` (maroon eye sockets, no pupils, big jaw/chin, red-voxel mouth).
- **Why:** AC villagers and Minecraft's Steve have a clean hair cap with 2-3 tones and a read-at-a-glance back view; the player sees the back almost all the time, so this is the highest-impact fault.
- **Fix:** hair = 3 bands (base, highlight crown row, darker lower-fringe) with a clear parting and a solid 1-voxel-thick shell (no holes); remove the single-voxel hair spikes; hair colour lifted to value >= 0.25 so it separates from the dark shade ramp. Face: iris 2x3 dark brown + 1 white highlight, drop the maroon socket (use skin x 0.85 for the lid row), mouth 4-voxel curve in skin x 0.65, chin squared.

### 2. Sprigfox face and head clutter
- **Where:** `20`, `05`, `29`.
- **Why:** green ring + white block eyes have no pupil -> startled/glaring; muzzle is a muddy cluster; ears + inner stripes + sprout + dark ear tips + plume compete. Sprigatito reads in 3 tones.
- **Fix:** eye = 3x4 dark pupil + 2x2 highlight with a 1-voxel lower green rim only; muzzle = cream 4x3 with a single 2x1 nose and a "w" of 3 voxels; delete ear inner stripes (keep one dark tip voxel); plume amplitude +-8 deg and a 2-voxel orange stem.

### 3. Tidler tail and expression polish
- **Where:** `25`, `24`, hop strip (tail bulb floats, reads as a periscope), `19` (pupils top-inside = worried, flat black slot mouth).
- **Why:** the bulb is a good idea but needs a believable curl and a lagging 3-part chain; the face needs corners and symmetry.
- **Fix:** tail = 3 segments tapering toward a fat curled tip (lag 0.15 s per segment, +-12 deg), bulb 25 % smaller; pupils centred-lower in the eyes, 1 highlight; mouth = 5-voxel smile with 1-voxel upturned corners, optional 1-voxel pink tongue on happy.

### 4. Materials: painted cubes, no fur / scale cue, avatar hair flat
- **Where:** all shots, esp. `18` (Puffbun mouth: dark gap-tooth cluster), `05`, `01`.
- **Why:** flagship creatures have texture cues (fluff tufts, scale rows, soft gradients); ours rely on 2-3 flat tones per part.
- **Fix:** per-voxel value jitter +-4 % in a low-frequency noise (not checker), a 1-voxel "tuft" row on Puffbun chest/ears, scale row on Tidler back, fur-tip voxels on fox tail; clean Puffbun mouth to 3 voxels (no teeth block); reduce violet shade strength by ~20 % to stop the mauve mud on the Puffbun flank.

### 5. In-game readability and motion amplitude
- **Where:** `live.png` (creature 40 px, hidden between hedge blocks with block-edge seams), `22` (faces 6-8 px), walk strip (torso almost rigid, bob ~1 voxel), hop (no squash visible).
- **Why:** Legends: Arceus has body weave, ear overlap and visible weight shift on every step; the real game rarely shows the creature larger than 100 px.
- **Fix:** walk bob 1.5-2 voxels, body roll +-4 deg, head counter-rotation; landing squash 0.85 y for 80 ms; shadow scale 1.0 -> 0.7 at hop apex; scale creatures x1.25 in game or add a mild face-priority outline / nameplate; add emote bubbles for notice/happy.

## Already good
- Puffbun is the strongest: clean ears, big readable eyes, cream chest; the faces sheet (`17`) now looks like one friendly family, with Tidler clearly friendlier than round 2.
- Glow spill, rim and violet shade tint finally give the cast a lit, grounded look; silhouette gates and a gameplay-camera shot now exist and are honest.

**Plateau:** no — faces, avatar back and Tidler tail are still moving, and the fixes are concrete. Still, the module cannot pass until avatar, Sprigfox and Tidler reach Puffbun's level and materials/motion amplitude rise to 9. Per-species: Puffbun ~8, Tidler ~7, Sprigfox ~6, avatar ~6.
