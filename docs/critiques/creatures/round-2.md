# Critique — `creatures` (Puffbun / Tidler / Sprigfox + voxel avatar) — Round 2

**Verdict: FAIL.** 0 of 9 axes reach 9 (best 7, perf 8). Blind A/B skipped: `reference/` is empty (rubric only). Scored from scratch from captures I made myself.

| # | Axis | Score | Reason (one line) |
|---|---|---|---|
| 1 | Art direction & cohesion | 7 | One micro-voxel language and one eye template across all four; Puffbun is on-model, but Tidler and Sprigfox are still the "other game" next to it and the palette (orange fox + teal + pink + red roofs) is loud |
| 2 | Lighting & colour | 7 | Cast shadows now ground everything and the warm key reads; head-top mauve is gone; but no rim, night bodies are still saturated ultramarine, and no light spill from glow |
| 3 | Materials & texture | 6 | Clean bevelled blocks, no more checkerboards; still plain painted cubes (no fur / felt / scale cue), Sprigfox muzzle and Tidler mouth are muddy clusters |
| 4 | Shape & modelling | 6 | Puffbun ~8; avatar 6 (ragged chin/jaw, brown eye sockets); Tidler 6 (face inside a dark visor frame, black shouting mouth, long rigid tail); Sprigfox 5-6 (angry brow lids, cluttered crown + ears + muzzle) |
| 5 | Animation & motion | 7 | Real walk/run leg cycles, hop with anticipation and stretch, ear/head follow-through, sprint alternates legs (strips below); still small amplitude, no dust / landing VFX, Tidler tail stays a rigid plank |
| 6 | Rendering polish | 7 | Crisp, shadowed, 0 console/page errors; shadow edges hard and aliased, bloom timid, glow caps are flat cyan blocks |
| 7 | Composition & readability | 6 | Face sheet and portraits now work; but pack `10` and `13` still use far cameras, 64 px crop shows faces as 3-4 px blobs, red roofs still outrank creatures, the live game creature is a tiny teal blob hidden behind trunks |
| 8 | Delight & juice | 6 | Puffbun is lovable; Tidler/Sprigfox still read grumpy or startled; no emote bubbles, dust, sparkle or visible glow pulse |
| 9 | Performance | 8 | 0 errors, 213-303 draw calls, 0.47-0.99M tris in the lab, 144 fps; ~24k tris per ~12-voxel creature and no LOD still cap crowd size |

## Evidence (all under `shots/creatures/`)
- `r13/` pack: 21 shots, all read (face sheet 17, faces 18-21, portraits 03-06, variants 07, turnaround 08, states 10, night 13, 64 px crop 14, turntable 16). Stats: 0 console / page errors, 213-303 DC, 402k-993k tris.
- `critic-r2/`: `walk_strip`, `hop_strip`, `run_strip`, `accel_strip` (`--cam tread`; note `--cam` is required, without it the lab shows the island), `avatar_strip.png` (walk 4.3 m/s, sprint 5.6 m/s, stop in ~200 ms, jump apex 1.25 m, 0 errors), `live.png` (12 creatures alive, nearest 21.9 m).
- Not captured: blind A/B (no refs); 5 / 7 treadmill frames cannot show ground travel (fixed positions); glow pulse over time.

## Status of round-1 defects
| Round-1 defect | Status | Evidence |
|---|---|---|
| 1. Faces hostile / dead / tearful | **Partly fixed.** Puffbun and avatar are friendly now (highlights, smile, blush). Tidler: eyes now round with highlights but sit inside a black visor frame with a black slot mouth = shouting. Sprigfox: dark upper lids make it glare; muzzle is a cluster of maroon voxels. Avatar: eyes huge in brown sockets (startled), lower-left face in shadow, ragged chin | 17, 19, 20, 21, 06 |
| 2. No grounding / lighting | **Mostly fixed.** Long sun shadows under everything, warm key, no mauve tops. Missing: rim light, violet shade tint on bodies, night still ultramarine | 02, 08, 11, 13 |
| 3. Colour speckle / contour noise | **Mostly fixed.** Checkerboard ears gone, markings are shapes. Remaining: Puffbun flank has grey-purple voxel clumps (`03`, `04` background), Sprigfox muzzle/chest noise | 03, 20 |
| 4. Tidler / Sprigfox silhouettes | **Partly fixed.** Tidler head is a dome, fins fused, tail shorter; Sprigfox has two ears and one sprout + a separate green tail plume. At 64 px (`14` crop, `07`) Puffbun is unmistakable, Sprigfox is OK (ears), Tidler is still a teal blob with red fin dots | 07, 14, 08 |
| 5. Glow does not glow | **Partly fixed.** Night Puffbun ear caps and sprigfox motes visible (`13`) but flat, no ground spill, no pulse seen, night bodies still saturated | 13 |
| Pack evidence broken (14, 16, 10) | **Partly fixed.** 16 now shows the trio turning; 17-21 are good. 10 still far and low-res; 14 shows the creatures at last but faces are unreadable at 64 px | 10, 14 |
| Avatar back view ring-banded dome + pale chevron | **Not fixed** (live sprint strip: concentric hair rings + pale V on the nape) | avatar_strip |

## Top 5 remaining defects (ranked by visual impact)

### 1. Tidler and Sprigfox faces still read grumpy / shouting; avatar reads startled
- **Where:** `19_face_tidler` (eyes enclosed by a black rectangular frame; wide black-slot mouth with a cream lip row = yelling frog), `20_face_sprigfox` (dark brow voxels slice the top of each eye, green iris, a maroon nose/mouth cluster), `21_face_avatar` + `06` (eyes 4x4 white + brown socket, no pupils visible, rest of face half in shadow; brown ring around the eyes looks like fatigue).
- **Why:** Sprigatito / Quaxly / Fuecoco and Animal Crossing faces are soft: round dark pupil with 2 highlights, no hard frame, a small "w" or upturned smile. Ours keep the earlier "visor" language and 5 colours per face.
- **Fix:** Tidler: delete the dark frame (keep a 1-voxel top lash only on the outer edge), mouth = 4-5 voxel smile curve 1 voxel high, in `#2B1B3F` with a 1-voxel pink tongue only on "happy". Sprigfox: remove the dark top row, iris 3x4 in one green, 2x2 highlight, nose = single 2x1 dark voxel, mouth "w" of 3 voxels under it, cream muzzle in 2 tones. Avatar: iris 2 wide x 3 tall in dark brown + highlight, drop the brown ring (use skin x 0.9), 4-voxel smile in skin x 0.7, make jaw 1 voxel wider and square the chin row.

### 2. Tidler body language and silhouette (the weakest species)
- **Where:** `08_turnaround` (long horizontal tail with red edge rim reads like a stuck-on plank; side view is a crocodile, front a frog), `07` and `14` crop at 64 px (teal blob + red dots), `hop_strip` #3-#4 (whole body goes horizontal and flies, tail rigid).
- **Why:** each Pokémon starter has ONE iconic read at 64 px (leaf bulb, flame tail, water curl). Tidler has no equivalent; fins and cyan tips are confetti.
- **Fix:** pick one idea (e.g. a single tall tapering red crest + fat round tail fin curling up). Merge the three red fin clusters into one; make the tail 3-part with sway lag (phase 0.25 s per segment, ±12 deg), and add a 1-voxel dark outline row where body meets belly. Gate with black silhouettes at 32/64 px (still not in the pack).

### 3. Sprigfox clutter and voxel muddiness
- **Where:** `05`, `20` (ear inner stripes, head-top green sprout, dark ear tips, brown mane band, muzzle cluster, chest leaf: ~8 colours on the head), `02` tail plume = separate green bush detached from the body.
- **Why:** AAA characters keep head to 3-4 tones. Round 1 asked for one sprout and 2 clean ears; the ears are clean now but extras were added elsewhere.
- **Fix:** limit head to orange, cream muzzle, dark ear tips, one sprout; delete the chest leaf and mane band; attach tail plume to the tail root with an orange base voxel row; keep its sway but reduce amplitude ±8 deg.

### 4. Night and glow still flat; rim / shade tint missing
- **Where:** `13_night_glow` (Puffbun saturated blue-violet vs desaturated teal ground; no coloured ground light under ear caps; Tidler/Sprigfox are brown-grey mud), `03`/`04` (no rim or violet shade on the shadow side).
- **Why:** Scarlet/Violet creatures carry a cool rim and coloured bounce; ours are one value per face block.
- **Fix:** shade ramp x0.78/x0.55 mixed 25 % toward `#5B4B8A`; fresnel rim pow 3 at 0.2-0.3 sun-tinted; glow markings emissive x3 + bloom threshold ~0.9, strength 0.6; ground decal or point light radius 1.2-2 m intensity 0.25-0.4 in marking colour; pulse 0.85-1.15 at 0.5 Hz; night body ramp toward `#8FB0FF` moonlight with face value separation.

### 5. Motion polish and in-game readability
- **Where:** `walk_strip` / `run_strip` (legs alternate, but body bob ~1 voxel, no dust, ears barely move in run), `hop_strip` (stretch present at apex, but no dust or landing squash read, no shadow shrink with height), `avatar_strip` (sprint alternates legs, arms swing, no dust; nape pattern of concentric rings with pale V), `live.png` (a creature is a 40 px blob behind trunks; nothing in the real game frames it).
- **Why:** Legends: Arceus gives every gait a body weave, ear / tail overlap and dust puffs; AC villagers have squash on every step. Ours are correct but timid, and readability in the game scene is untested.
- **Fix:** body bob 1.5-2 voxels at walk, 3 at run; ear / tail lag 2-3 frames; landing squash 0.85 y for 80 ms + 6-8 dust voxels (scale 0.3, life 0.4 s); shadow scale 1.0 -> 0.7 at hop apex; avatar hair: remove the rings and pale chevron (flat 2-tone hair with a clear parting); add a gameplay-camera pack shot at 6-8 m framing a creature at ~250 px height; add 32/64 px silhouette gate.

## Already good
- The shared eye template, cast shadows and warm key transformed Puffbun and the lineup (`17`, `02`); Puffbun's face, ears and chest are close to Pokémon-level appeal.
- Locomotion is genuinely animated now (walk/run gait cycles, hop stretch, tail/ear follow-through); 0 errors and 144 fps.

**Plateau:** no (clear gains in faces, grounding and motion; Tidler / Sprigfox design and glow still have large headroom). **Per-species gap:** Puffbun ~8, avatar 6-7, Sprigfox 5-6, Tidler 5-6; the module cannot pass until the two weaker species and the avatar reach Puffbun's level.
