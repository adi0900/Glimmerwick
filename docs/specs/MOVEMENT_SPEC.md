# Player movement behavioural spec (Minecraft Java-style feel)

Analyst A, clean-room (`docs/CLEANROOM.md`), written 2026-10-06. Inputs: PUBLIC community documentation only (section 10). No game code, decompiled code, snippets or assets were read; all prose is original (facts, numbers and formulas only). The test vectors in section 9 come from the analyst's own re-implementation of the formulas below (64-bit floats), not from any game.

Baseline: modern Java Edition behaviour (1.14+ era; the sources list no relevant change up to the newest versions they cover). Version differences are noted where they matter.

Confidence tags: **[H]** two independent sources agree, or the value is reproduced from other published figures; **[M]** one good source or derived; **[L]** weak, unverified, or a design suggestion (free for the implementer to tune).

Out of scope: creative flight, elytra, riding, boats, bubble columns, knockback, fall damage, powder snow, scaffolding.

## 0. Validation: published figures vs this spec's model

The model in section 3 was run and compared with figures published independently of the formulas. All matched.

| published figure | source | model result |
|---|---|---|
| walk 4.317 b/s | S11 S12 | 4.3172 |
| sprint 5.612 b/s | S11 S12 S13 | 5.6123 |
| sneak 1.295 b/s (rounded 1.3) | S11 S12 | 1.2952 |
| walk with 45-degree input 4.405 b/s | S12 | 4.4053 |
| sprint-jump average 7.127 b/s | S12 S13 | 7.1268 |
| max jump height 1.2522 (1.249 before 1.9) | S11 S14 S2 S3 | 1.252203 (1.249187 with the old 0.005 threshold) |
| Jump Boost I / II heights 1.8361 / 2.5168 | S14 | 1.836132 / 2.516794 |
| flat jump 12 ticks, +0.5 jump 10, +1 jump 9 | S2 | 12 / 10 / 9 |
| terminal fall 78.4 b/s | S12 S2 | 3.92 b/tick = 78.4 b/s |
| sprint-swimming 3.918 b/s | S12 S15 | 3.920 |
| swimming underwater 1.97 b/s | S12 S15 | 1.960 |
| ladder up 2.35 / down 3.0 b/s | S12 | 2.352 / 3.000 |

## 1. Conventions

- Simulation tick: 20 Hz = 0.05 s. All constants below are per tick unless stated. Velocity unit: blocks per tick (multiply by 20 for blocks per second). 1 block = 1 m = 1 world unit.
- Reference axes: +X east, +Y up, +Z south; yaw 0 faces +Z. forward(yaw) = (-sin yaw, 0, cos yaw); left(yaw) = (cos yaw, 0, sin yaw). Strafe input +1 = left. Our game may use different axes; only the relative geometry matters. Pitch does not affect ground or air movement.
- Position = centre of the feet. The hitbox is an axis-aligned box centred on (x, z) and standing on y.
- Inputs per tick: `forward` in {-1,0,1}, `strafe` in {-1,0,1}, `jump` (held), `sprint` (resolved state flag, section 3.7), `sneak`, `use_item` (resolved flags), `swim` (resolved sprint-swim flag, section 4).
- Vectors use doubles; with f32 allow a tolerance of 1e-5.
- Nothing caps horizontal speed except damping versus acceleration, and falling speed is limited only by the damping fixed point.

## 2. Player hitbox

| pose | width (x and z) | height | eye height | tag / note |
|---|---|---|---|---|
| standing | 0.6 | 1.8 | 1.62 | [H] S11 |
| sneaking | 0.6 | 1.5 | 1.27 | [H] 1.14+; it was 1.65 in 1.9-1.13 and no change in 1.8 (S7 S10 S11) |
| swimming / crawling / gliding | 0.6 | 0.6 | 0.4 | [H] swim 1.13+, crawl 1.14+ (S11 S5) |
| sleeping | 0.2 | 0.2 | - | irrelevant here |

- Leaving a low pose needs headroom for the taller box (stay low otherwise) [M, not verified in this pass].
- The test for "is in water/lava" uses a slightly shrunken box (lava needs deeper contact); exact margins unverified [L].
- Step-up height 0.6 (3.5). Sneak-edge safety limit 0.6 (3.6).

## 3. Per-tick model

### 3.1 State
position, velocity (v, "carried" velocity left after the previous tick's damping), `onGround` (set by the previous tick's move), `jumpCooldown` (ticks), pose flags.

### 3.2 Constants

| name | value | meaning | tag | src |
|---|---|---|---|---|
| g | 0.08 | gravity per tick (applied after the move) | H | S2 |
| Dv | 0.98 | vertical damping, multiplies (vy - g) | H | S2 |
| v_term | -3.92 | falling-speed limit = fixed point of vy = (vy - g) * Dv (78.4 b/s) | H | S2 S12 |
| J0 | 0.42 | jump impulse (assigned to vy) | H | S2 S3 |
| Jb | +0.1 per Jump Boost level | added to the impulse | H | S2 S3 S14 |
| SJ | 0.2 | sprint-jump horizontal boost along facing | H | S1 S3 S5 |
| CD | 10 ticks | jump cooldown | H | S3 S14 |
| eps_v | 0.003 | velocity components below this are zeroed (0.005 before 1.9) | H | S1 S2 S10 |
| M0 | 0.1 | base movement speed, ground acceleration unit | H | S1 S12 |
| Ksp | 1.3 | sprint multiplier (ground and air) | H | S1 S5 S13 |
| Ksn | 0.3 | sneak input multiplier | H | S1 S7 |
| Kin | 0.98 | scale on each digital input axis | H | S1 |
| Kuse | 0.2 | input multiplier while using an item (eat, draw bow, block) | L | common knowledge, not cross-checked |
| Ke | Speed +20% per level, Slowness -15% per level, multiplicative | on ground acceleration only | M | S1 |
| S | slipperiness: 0.6 default, slime 0.8, ice and packed ice 0.98, blue ice 0.989 | per support block | H | S4 S10 |
| Fair | 0.91 | horizontal damping base | H | S1 S3 S4 |
| Aair | 0.02 (x1.3 sprinting) | air acceleration unit | H | S1 S3 |

### 3.3 Order of operations inside one tick

Snapshot first: `g0` = onGround left by the previous tick; `S` = slipperiness of the support block (3.4), used only if g0.

1. Cooldown: jumpCooldown = max(jumpCooldown - 1, 0).
2. Rest threshold: each of vx, vy, vz with magnitude below 0.003 becomes 0.
3. Jump:
   - jump not held: jumpCooldown = 0 (a release re-arms the jump).
   - held and in water or lava: vy += 0.04 every tick (no cooldown).
   - held, not in fluid, g0 true, jumpCooldown == 0: vy = 0.42 + 0.1 * level (assignment); if sprinting add 0.2 * forward(yaw) to (vx, vz); jumpCooldown = 10.
4. Intent vector: (sx, fz) = (strafe, forward) * 0.98; if sneaking multiply both by 0.3; if using an item multiply both by 0.2; m = length. If m < 1e-4 the intent is zero; if m > 1 divide by m (so length <= 1; a diagonal key pair gives length 1, not 1.386).
5. Accelerate: (vx, vz) += a * (sx * left(yaw) + fz * forward(yaw)), where
   - in water/lava: a = 0.02 (no sprint, speed-effect or slipperiness scaling);
   - else if g0: a = 0.1 * (1.3 if sprinting) * effects * (0.6 / S)^3;
   - else (air): a = 0.02 * (1.3 if sprinting).
6. On a climbable block (5.1): clamp |vx|, |vz| <= 0.15; vy = max(vy, -0.15); if sneaking and vy < 0 then vy = 0.
7. Move with collisions (3.5, 3.6) using the post-acceleration velocity. Displacement of the tick = carried velocity + this tick's acceleration. After the move, any velocity component that was blocked is zeroed and onGround' = "blocked while moving down".
8. Climb: on a climbable block and (horizontally blocked or jump held): vy = 0.2.
9. Damping (uses g0 and S from the start of the tick):
   - normal: vy = (vy - 0.08) * 0.98; (vx, vz) *= (g0 ? S * 0.91 : 0.91).
   - water: vy = 0.8 * vy - 0.02; (vx, vz) *= 0.8 (0.9 in the sprint-swim state).
   - lava: vy = 0.5 * vy - 0.02; (vx, vz) *= 0.5.
10. Fluid exit kick (4.5): vy = 0.3 if the condition holds.
11. onGround = onGround'.

Consequences worth testing: a standing player starts every tick with vy = -0.0784; the jump tick still uses ground damping (S * 0.91) for its horizontal velocity, and the first airborne tick uses air acceleration with 0.91 damping; the sprint-jump boost is added before acceleration and displaces in the same tick.

### 3.4 Support block and slipperiness
S comes from the block whose cell contains the point just under 0.5 below the feet centre (1.15+; before 1.15 it was 1.0 below). A slab on ice therefore still counts as ice; a bed on ice no longer does [M, S4]. Only the single point under the feet centre is used. Air, fluids, soul sand and cobweb count as 0.6. Ground acceleration scales with (0.6 / S)^3 and the damping with S * 0.91: on ice you accelerate slowly, keep momentum, and the walking top speed is actually a little below normal ground (see TV-07). Air ignores slipperiness for both.

### 3.5 Collision resolution
- Axis order [M, sources partly disagree, section 10]: Y first, then the horizontal axis with the larger |velocity| first (1.14+: |vx| >= |vz| gives X then Z, otherwise Z then X); before 1.14 the order was always Y, X, Z. Impact is limited to corner cases.
- onGround' is true only when the downward vertical move was cut short by a surface. Blocked axes zero that velocity component. Head contact zeroes vy.
- Step-up (0.6) [M, S6]: if the player was on the ground (or landed in this move) and a horizontal component was blocked, retry the move with the box raised by up to 0.6 (limited by ceilings), move horizontally, then lower the box back down to the first support; keep the stepped result when it covers more horizontal distance. Obstacles up to 0.6 high (inclusive) are climbed in the same tick without losing horizontal speed; 0.625 and 1.0 block the player (TV-13). Slabs, carpets, soul sand (0.875 top is a 0.125 step), snow layers and stairs steps are climbed without a jump.
- "Coyote tick": because Y resolves before X/Z, a player who walks off an edge keeps onGround = true for that tick and may still jump on the next tick (TV-15) [H, S3 headhitter timing].
- Walls do not stop sliding along them (the other axis continues).

### 3.6 Sneaking at ledges [M, S7 S10]
While sneaking, on the ground (flag) and not in fluid, shorten the intended horizontal move before collision so the box, shifted by that move and lowered by 0.6, still overlaps a solid. Test X alone, then Z alone, then both together (when both are non-zero); on a failed test reduce the offending move by 0.05 toward zero (anything at or under 0.05 becomes 0) and test again. Velocity is not zeroed by this trimming, only the move is shortened, so the player just stops at the edge and speed is conserved. The limit was 1.0 before 1.11 and is 0.6 since. Result in the reference: the player can hang with its centre about 0.29 beyond the support edge, with only a sliver of the box above the block (TV-14). No trimming in the air.

### 3.7 Sprint state machine (input layer) [H unless noted]
- Start: sprint key, or double-tap forward within 7 ticks (on the ground); needs food above 6 of 20 (our game may replace this with its own gate); not while blind or using an item.
- Effect: x1.3 on ground and air acceleration, the 0.2 sprint-jump boost, widened camera (6), swim pose in water (4.5).
- Cancel: forward released; sneaking before 1.14 (allowed together from 1.14); using an item or blocking; food drops to 6 or below; attacking an entity [M]; hitting a wall head-on (glancing contact within about 8 degrees of parallel does not cancel since 1.18, it was 5.5 before; interpretation [M, S13]).
- A sprint begun by double-tap lasts at most 600 ticks unless the key is held [M, S5].
- The air acceleration multiplier reacts one tick late to sprint toggles in the air [L, S5]; optional detail.
- Sprint-jump boost points along facing, not along movement; sideways or backward sprint-jumps therefore drift off-line [S5]. Whether a backward key can start a sprint is version-dependent; recommend: sprint needs forward > 0 [L].

### 3.8 Effects
Speed/Slowness scale ground acceleration only: effects = (1 + 0.2 * speed_level) * (1 - 0.15 * slowness_level) [M]; Jump Boost adds 0.1 per level to the impulse [H]; the 0.2 sprint-jump boost and air acceleration are not scaled.

## 4. Fluids

Fluid regime applies while the hitbox is in water or lava; ground contact is then irrelevant to acceleration and damping, only the jump key matters [S8].

### 4.1 Water, horizontal [M-H]
Acceleration 0.02 * intent (no sprint multiplier); damping 0.8 per tick, or 0.9 in the sprint-swim state. Steady speed: 0.098 b/tick = 1.96 b/s walking or swimming (published 1.97), and 0.196 b/tick = 3.92 b/s sprint-swimming (published 3.918, S12 S15). Depth Strider, Dolphin's Grace and the published 2.20 b/s surface-swim and 2.00 b/s walking-in-water figures are not modelled [L].

### 4.2 Water, vertical [M-L]
After the move vy = 0.8 * vy - 0.02; holding jump adds 0.04 at the start of each tick (S8, a work-in-progress page based on the older physics). Steady sink speed -0.1 b/tick (2 b/s), steady rise with jump held 0.1 b/tick of displacement. The sink constant for current versions was not confirmed (a smaller value would feel floatier): treat -0.02 as a tunable default.

### 4.3 Lava [M]
Horizontal damping 0.5, vertical vy = 0.5 * vy - 0.02, jump +0.04, acceleration 0.02. Steady horizontal 0.0392 b/tick, sink -0.04, rise with jump 0.04 per tick of displacement.

### 4.4 Sprint-swimming (1.13+) [M]
Sprint input while in water puts the player in the swim pose: hitbox 0.6 x 0.6 (fits one-block gaps), horizontal damping 0.9, same 0.02 acceleration. The swim direction follows the camera pitch (look up + jump is the fastest ascent, look down + sneak the fastest descent, S15). The published numbers do not give the pitch easing: free design [L]. Sprinting at the surface keeps the player at the surface (18w15a).

### 4.5 Exiting water onto a ledge [M]
When in fluid, pushing horizontally into a block, and the spot reached by rising about 0.6 (and moving along) holds no block and no fluid, vy is set to 0.3 (carried to the next tick) (S8). The reference sets it every tick while the condition holds.

### 4.6 Flowing water [L]
Flow adds a push of about 0.014 per tick (after normalising the flow direction) (S8). Published speeds (S12): downstream 1.81, upstream 0.39 b/s underwater.

## 5. Climbing and special blocks (brief)

### 5.1 Ladders and vines [M]
Climb by holding jump (1.14+) or by pushing into the wall; the net rise is 0.1176 b/tick (2.352 b/s; published 2.35). Descent without input is limited to 0.15 b/tick (3.0 b/s; published 3.0). Sneaking holds the position (no descent inside the block; climbing up still works) (S7). Horizontal speed on the climbable is clamped to 0.15 [L, derived from the model].

### 5.2 Others [L unless noted]
- Ice 0.98 / blue ice 0.989 [H].
- Slime: landing bounces the player back up in proportion to the downward speed; sneaking suppresses it [M]. Walking on slime slows a bit.
- Soul sand and honey: horizontal speed multiplied by about 0.4 each tick while standing on them; soul sand top is 0.875 high. Honey also cuts jumps sharply (the wiki states a jump of about 3/16 of a block) and makes you slide slowly down walls. A single secondary source gave the 0.4 figure.
- Cobweb: about a quarter of normal horizontal speed (weak source).

## 6. Camera and FOV
- Eye heights in section 2; the eye drops to 1.27 when sneaking and to 0.4 when swimming. Transition smoothing is not documented [L]: suggest a short ease (0.05-0.1 s).
- Sprinting widens the field of view smoothly and narrows it when sprint ends; the "FOV Effects" option scales the effect. Published magnitudes are vague (community threads: about +10 to +20 degrees depending on base FOV) [L]. Design default (own choice): target FOV scale about 1.12 while sprinting (speed effects add more), ease with a time constant of roughly 0.1-0.2 s, plus a user slider 0-100%.

## 7. Sanity numbers (reference model, flat ground)

| quantity | value |
|---|---|
| walk / sprint / sneak | 4.317 / 5.612 / 1.295 b/s |
| diagonal walk / diagonal sprint | 4.405 / 5.727 b/s |
| Speed I walk, Speed II sprint | 5.181 / 7.857 b/s |
| use-item walk (x0.2) | 0.863 b/s |
| air-only (no ground) walk / sprint | 4.356 / 5.662 b/s |
| ice walk / sprint, slime walk, blue-ice walk | 4.157 / 5.404, 3.040, 4.376 b/s |
| jump apex | 1.2522 blocks (Jump Boost I 1.8361, II 2.5168) |
| jump airtime | 12 ticks (0.6 s) flat, 10 ticks for +0.5, 9 ticks for +1 |
| sprint-jump distance take-off to landing | 3.629 blocks from steady sprint, 2.876 from standstill |
| bunny-hop (hold forward+sprint+jump) | cycle 12 ticks, average 7.127 b/s |
| hold jump flat / under a 2.0 ceiling | one jump per 12 ticks / one per 10 ticks |
| terminal fall | 3.92 b/tick = 78.4 b/s |
| fall time from rest (ticks until landing tick) | 1 block 6, 2 blocks 8, 3 blocks 10, 4 blocks 11, 5 blocks 13, 10 blocks 18, 20 blocks 25, 50 blocks 41 |
| stop after releasing sprint: ground / ice | 0.333 blocks in 7 ticks / 2.20 blocks in 40 ticks |
| ladder up / down | 2.35 / 3.0 b/s |
| water walk, sprint-swim, lava walk | 1.96, 3.92, 0.784 b/s |
| max gap crossed by a sprint-jump | about 4 blocks (take-off distance + 0.6 hitbox overlap) |

## 8. Conversion to a 60 Hz fixed step

Let n = dt / 0.05 (n = 1/3 for 60 Hz).

### 8.1 Recommended: tick-rate physics, sub-stepped motion (exact)
Keep every constant of section 3 unchanged. Run the full pipeline of 3.3 once every third 60 Hz step, apply the intended displacement of step 7 as three equal sub-moves (each collision-checked), run damping (steps 8-10) after the third sub-move, and render the sub-step positions. TV-01..TV-22 then hold at every third step (collision corner cases may differ by sub-tick ordering only). Cost: inputs are sampled at 20 Hz boundaries (up to 33 ms of extra latency, hide it with input buffering).

### 8.2 True 60 Hz re-derivation (approximate; exponent form)
For any regime written as "damp, plus a per-tick additive term" v <- F * v + B:
- damping per step: F' = F^n (60 Hz: F' = F^(1/3));
- additive term per step: B' = B * (1 - F') / (1 - F) (limit n * B if F = 1). This keeps the steady speed per second identical; after exactly 3 steps the velocity update equals one 20 Hz update;
- displacement per step: velocity * n (in b/tick units).
Table (60 Hz): ground F = 0.546 gives F' = 0.817330, B scale 0.402356; air 0.91 gives 0.969052, 0.343865; vertical 0.98 gives 0.993288, 0.335581; water 0.8 gives 0.928318, 0.358411; sprint-swim 0.9 gives 0.965489, 0.345106; lava 0.5 gives 0.793701, 0.412599; ice 0.8918 gives 0.962548, 0.346135; slime 0.728 gives 0.899588, 0.369161. Vertical in the same step: vy = 0.993288 * vy - 0.0263095 (gravity and drag together).
Scheme C used for TV-23, per 60 Hz step k:
- at k mod 3 == 0 only: cooldown tick (decrement, reset on release); jump decision from onGround as left by the last step; latch the regime: g0, F = g0 ? S * 0.91 : 0.91, A = g0 ? 0.1 * (1.3 if sprint) * (0.6 / S)^3 : 0.02 * (1.3 if sprint);
- every step: intent as in 3.3 step 4; v_h += A' * (...); move by v / 3 with collisions; v_h *= F'; vy = D' * vy + B'.
Latching the regime on 20 Hz boundaries is essential: with per-step ground detection the jump tick would be damped for a third of a tick, not a whole tick, and sprint-jumps would travel about 40% farther.
Calibrations measured for C (a plain explicit scheme loses about 11% of jump height): jump impulse 0.447809 (was 0.42), sprint-jump boost 0.179166 (was 0.2) - these restore apex 1.2522, a 12-tick hop cycle and 7.127 b/s average. Known residual deviations of C: slower start-up (about 0.07 blocks behind at tick 3-6), release stop distance about 26% longer (0.4185 vs 0.3326 blocks), landing detected up to a third of a tick earlier.
Prefer 8.1 unless per-step input response is mandatory.

### 8.3 Other dt
Use F' = F^n and B' = B * (1 - F') / (1 - F); timers (cooldown, 7-tick sprint window) count ticks of 0.05 s; re-calibrate the impulses for the new dt.

## 9. Test vectors

Common set-up R0 (resting, unless stated): position (0,0,0), velocity (0, -0.0784, 0), onGround = true, jumpCooldown = 0, yaw 0 (forward = +Z, left = +X), infinite floor with its top at y = 0 and slipperiness 0.6, hitbox 0.6 x 1.8, no effects. "After tick t" means the whole pipeline of 3.3 has run. dz = z displacement during the tick, vz / vy = carried velocity after the tick, g = onGround. Tolerance 2e-6 (doubles).

**TV-01 free fall** (no floor; start y = 10, v = 0, airborne, no input). After tick t: y, vy
```
t1 10.000000 -0.078400 | t2 9.921600 -0.155232 | t3 9.766368 -0.230527 | t4 9.535841 -0.304317
t5 9.231524 -0.376630 | t6 8.854893 -0.447498 | t10 6.653730 -0.717075 | t20 -3.251162 -1.302977
t50 -61.377257 -2.492455 | t100 -211.993433 -3.400131 | t200 -581.447238 -3.851055   (limit vy -> -3.92)
```

**TV-02 jump from rest** (R0, jump held on tick 1 only). After tick t: y, vy, g
```
t1 0.420000 0.333200 0 | t2 0.753200 0.248136 0 | t3 1.001336 0.164773 0 | t4 1.166109 0.083078 0
t5 1.249187 0.003016 0 | t6 1.252203 -0.075444 0 | t7 1.176759 -0.152335 0 | t8 1.024424 -0.227688 0
t9 0.796736 -0.301535 0 | t10 0.495201 -0.373904 0 | t11 0.121297 -0.444826 0 | t12 0.000000 -0.078400 1
```
Apex 1.252203 on tick 6; landing on tick 12.

**TV-03 walk** (R0, forward = 1). After tick t: dz, vz
```
t1 0.098000 0.053508 | t2 0.151508 0.082723 | t3 0.180723 0.098675 | t4 0.196675 0.107385
t5 0.205385 0.112140 | t6 0.210140 0.114736 | t7 0.212736 0.116154 | t8 0.214154 0.116928
steady dz = 0.2158590 (= 0.098 / 0.454)
```

**TV-04 sprint** (R0, forward = 1, sprint). dz, vz
```
t1 0.127400 0.069560 | t2 0.196960 0.107540 | t3 0.234940 0.128277 | t4 0.255677 0.139600
t5 0.267000 0.145782 | t6 0.273182 0.149157 | t7 0.276557 0.151000 | t8 0.278400 0.152007
steady dz = 0.2806167
```

**TV-05 sneak** (R0, forward = 1, sneak, floor everywhere). dz, vz
```
t1 0.029400 0.016052 | t2 0.045452 0.024817 | t3 0.054217 0.029602 | t4 0.059002 0.032215
t5 0.061615 0.033642 | t6 0.063042 0.034421 | t7 0.063821 0.034846 | t8 0.064246 0.035078
steady dz = 0.0647577
```

**TV-06 diagonal** (R0, forward = 1 and strafe = +1). dx = dz each tick (x is left)
```
walk:   t1 0.070711 | t2 0.109319 | t3 0.130399 | t4 0.141908 | t5 0.148193 | t6 0.151624 | t7 0.153497 | t8 0.154520
sprint: t1 0.091924 | t2 0.142114 | t3 0.169518 | t4 0.184481 | t5 0.192650 | t6 0.197111 | t7 0.199546 | t8 0.200876
steady speed (hypot): walk 0.2202643, sprint 0.2863436
```

**TV-07 steady displacement per tick** (R0, constant input for 800 ticks, then measure the last tick)
```
walk 0.2158590 | sprint 0.2806167 | sneak 0.0647577 | use-item walk (x0.2) 0.0431718
walk diag 0.2202643 | sprint diag 0.2863436 | walk Speed I 0.2590308 | sprint Speed II 0.3928634
walk Slowness I 0.1834802 | walk ice(0.98) 0.2078616 | sprint ice 0.2702201
walk slime(0.8) 0.1519991 | walk blue-ice(0.989) 0.2188001
air only (no support, start y high) walk 0.2177778 | sprint 0.2831111
```

**TV-08 release decay** (R0 after 800 ticks of forward + sprint, then no input). dz, vz after tick t
```
ground: t1 0.153217 0.083656 | t2 0.083656 0.045676 | t3 0.045676 0.024939 | t4 0.024939 0.013617
        t5 0.013617 0.007435 | t6 0.007435 0.004059 | t7 0.004059 0.002216 | t8 0 0 (threshold)  total 0.332600
ice 0.98: t1 0.240982 0.214908 | t2 0.214908 0.191655 | t3 0.191655 0.170918 | t4 0.170918 0.152425
          t5 0.152425 0.135932 | t6 0.135932 0.121224 | ... first vz == 0 on tick 40, total 2.201596
```

**TV-09 sprint-jump** (jump held on tick 1 only, forward + sprint held throughout). dz per tick, y, g
```
from steady sprint (200 ticks of sprint first):
t1 0.480617 | t2 0.287897 | t3 0.287466 | t4 0.287074 | t5 0.286717 | t6 0.286393 | t7 0.286097 | t8 0.285829
t9 0.285584 | t10 0.285362 | t11 0.285159 | t12 0.284975 (landing, y=0 g=1) | t13 0.386727 | t14 0.338553
distance ticks 1-12 = 3.629170; y by tick equals TV-02.
from rest:
t1 0.327400 | t2 0.204240 | t3 0.211339 | t4 0.217798 | t5 0.223676 | t6 0.229026 | t7 0.233893 | t8 0.238323
t9 0.242354 | t10 0.246022 | t11 0.249360 | t12 0.252398 (landing) | t13 0.357082 | t14 0.322367
distance ticks 1-12 = 2.875829
```

**TV-10 bunny hop** (R0, forward + sprint + jump all held for 200 ticks)
- Jump ticks: 1, 13, 25, 37, 49, 61, ... (period 12). Average over any 4 steady cycles: 0.3563383 b/tick = 7.1268 b/s.
- One steady cycle dz (starting on a jump tick): 0.612183, 0.359732, 0.352836, 0.346561, 0.340850, 0.335654, 0.330925, 0.326622, 0.322706, 0.319142, 0.315899, 0.312949 (sum 4.276059).

**TV-11 jump cooldown** (R0, inputs per tick). Jumps happen at:
```
jump held 60 ticks, flat floor:            ticks 1, 13, 25, 37, 49
jump held 60 ticks, solid ceiling at y=2.0: ticks 1, 11, 21, 31, 41, 51   (period 10)
jump held ticks 1-3, released tick 4, pressed ticks 5-6 (airborne): tick 1 only
jump pressed ticks 1, 13, 14:                ticks 1 and 13
```

**TV-12 head bump** (R0 with a solid ceiling at y = 2.0, jump on tick 1). y, vy, g
```
t1 0.200000 -0.078400 0 | t2 0.121600 -0.155232 0 | t3 0.000000 -0.078400 1 | t4.. rest
```

**TV-13 step-up and walls** (R0, forward = 1, no sprint; a solid block covers x = all, z in [1, 5], from y = 0 up to height h; front face at z = 1)
```
h = 0.5:   t4 z 0.626906 y 0 | t5 z 0.832291 y 0.5 vz 0.112140 g 1 (stepped in that tick) | t6 z 1.042431 y 0.5 | t7 z 1.255167 y 0.5
h = 0.6:   same as 0.5 but y = 0.6 (boundary case, steps)
h = 0.625: never steps; z stops at 0.700000 (face 1.0 minus half-width 0.3), vz = 0
h = 1.0:   same as 0.625
```

**TV-14 sneak ledge** (platform solid for z <= 0 with top y = 0, nothing else; start z = -0.5, sneak + forward = 1, 40 ticks). z after tick t
```
-0.470600 -0.425148 -0.370931 -0.311928 -0.250313 -0.187271 -0.123450 -0.059204 0.005275 0.069880
0.134555 0.199267 0.264000 0.278744 0.293494 then 0.293494 for all later ticks (never reaches 0.3), y stays 0, g = 1
control (same start, forward only, no sneak): t4 z 0.126906 y 0 g 1 | t5 z 0.332291 y 0 g 1 | t6 z 0.542431 y -0.078400 g 0 (falls)
```

**TV-15 coyote tick** (same platform; start z = 0.25, vz = 0.2, no inputs on tick 1, jump held on tick 2)
```
t1 z 0.450000 y 0.000000 vy -0.078400 g 1      (box already past the edge, still grounded)
t2 z 0.559200 y 0.420000 vy 0.333200 g 0       (jump succeeds)
control without jump: t2 z 0.559200 y -0.078400 vy -0.155232 g 0
```

**TV-16 fluids, horizontal** (start y = 50, airborne, submerged, no floor, forward = 1; water unless stated). dz, vz
```
water:      t1 0.019600 0.015680 | t2 0.035280 0.028224 | t3 0.047824 0.038259 | t4 0.057859 0.046287 | t5 0.065887 0.052710 | steady 0.098000
sprint-swim (damping 0.9): t1 0.019600 0.017640 | t2 0.037240 0.033516 | t3 0.053116 0.047804 | t4 0.067404 0.060664 | t5 0.080264 0.072238 | steady 0.196000
lava:       t1 0.019600 0.009800 | t2 0.029400 0.014700 | t3 0.034300 0.017150 | t4 0.036750 0.018375 | t5 0.037975 0.018987 | steady 0.039200
```

**TV-17 fluids, vertical** (submerged, no horizontal input, from rest). y offset from start, vy
```
water, no input:  t1 0 -0.020000 | t2 -0.020000 -0.036000 | t3 -0.056000 -0.048800 | t4 -0.104800 -0.059040 | t5 -0.163840 -0.067232 | steady vy -0.100000
water, jump held: t1 0.040000 0.012000 | t2 0.092000 0.021600 | t3 0.153600 0.029280 | t4 0.222880 0.035424 | t5 0.298304 0.040339 | steady vy 0.060000 (displacement 0.1 per tick)
lava, no input:   t1 0 -0.020000 | t2 -0.020000 -0.030000 | t3 -0.050000 -0.035000 | t4 -0.085000 -0.037500 | t5 -0.122500 -0.038750 | steady vy -0.040000
lava, jump held:  t1 0.040000 0 | t2 0.080000 0 | ... rises 0.04 per tick
```

**TV-18 fluid exit kick** (water, solid wall face at z = 0.5 across the whole height, free space above; start z = 0.15, y = 0, forward = 1)
```
t1 z 0.169600 y 0 vy -0.020000 blocked 0 | t2 z 0.200000 y -0.020000 vy 0.300000 blocked 1 | t3 y 0.280000 (rises 0.3 per tick while the condition holds)
```

**TV-19 ladder** (climbable, airborne start y = 5, v = 0; ticks 1-6 jump held, ticks 7-12 sneak, ticks 13-18 no input). dy, vy
```
t1 0 0.117600 | t2-t6 0.117600 0.117600 | t7 0.117600 0.036848 | t8 0.036848 -0.042289 | t9-t12 0 -0.078400 (holds)
t13 -0.078400 -0.155232 | t14-t18 -0.150000 -0.225400
```

**TV-20 jump boost and durations** (R0, jump on tick 1)
```
Jump Boost 0: apex 1.252203 landing tick 12 | level I: apex 1.836132 landing tick 14 | level II: apex 2.516794 landing tick 16
unconstrained jump y by tick: 0.420000 0.753200 1.001336 1.166109 1.249187 1.252203 1.176759 1.024424 0.796736 0.495201 0.121297 -0.323529 -0.837858
first tick at or below y = 0 / 0.5 / 1.0 / -1.0 on the way down: 12 / 10 / 9 / 14
```

**TV-21 fall times** (start airborne at height h above the floor, v = 0, no input): landing tick for h = 1,2,3,4,5,10,20,50 is 6,8,10,11,13,18,25,41.

**TV-22 threshold sensitivity** (guards the 1.9+ value): TV-02 with threshold 0.003 gives apex 1.252203; with the old 0.005 the carried vy of tick 5 (0.003016) is zeroed, so the apex is 1.249187.

**TV-23 60 Hz scheme C** (8.2; R0, steps counted from 0)
```
sprint from rest, z after steps 1-6: 0.017087 0.048139 0.090606 0.142402 0.201823 0.267476
z after steps 9, 12, 15, 18: 0.491448 0.741136 1.004866 1.276262   (20 Hz model after ticks 3-6: 0.559301 0.814978 1.081978 1.355160)
steady sprint speed 5.6123 b/s (exact match); release stop distance 0.418527 (20 Hz model 0.332600)
jump with the plain impulse 0.42: apex 1.110574, landing detected in step 32; calibrated impulse 0.447809: apex 1.252203, landing in step 34 (11.33 ticks)
bunny-hop average: plain constants 7.4410 b/s and cycle 11 ticks; impulse 0.447809 with boost 0.2: 7.3259 b/s; impulse 0.447809 with boost 0.179166: 7.1268 b/s, cycle 12 ticks
```

## 10. Sources, cross-checks, disagreements

Independent communities: the Minecraft Parkour Wiki (MCPK) and the Minecraft Wiki. All facts re-expressed; no text copied.

- S1 https://www.mcpk.wiki/wiki/Horizontal_Movement_Formulas
- S2 https://www.mcpk.wiki/wiki/Vertical_Movement_Formulas
- S3 https://www.mcpk.wiki/wiki/Jumping/en
- S4 https://www.mcpk.wiki/wiki/Slipperiness
- S5 https://www.mcpk.wiki/wiki/Sprinting
- S6 https://www.mcpk.wiki/wiki/Collisions
- S7 https://www.mcpk.wiki/wiki/Sneaking/en
- S8 https://www.mcpk.wiki/wiki/Water_and_Lava (work in progress page)
- S9 https://www.mcpk.wiki/wiki/Blocks
- S10 https://www.mcpk.wiki/wiki/Version_Differences
- S11 https://minecraft.wiki/w/Player
- S12 https://minecraft.wiki/w/Transportation
- S13 https://minecraft.wiki/w/Sprinting
- S14 https://minecraft.wiki/w/Jumping
- S15 https://minecraft.wiki/w/Swimming
- Search-result snippets only (pages not opened): MCPK Stepping/en, Momentum_Threshold, Nonrecursive_Movement_Formulas, 45_Strafe; minecraft.wiki Slime_Block; Forge forum thread on a soul-sand-like block; minecraft.how honey-block article; craftdex cobweb article; Badlion and Minecraft Forum FOV threads. A PrismarineJS physics pull request showed up in results and was not opened; its slime-bounce formula was deliberately NOT used.

Disagreements and gaps:
1. Jump Boost heights: S14 gives 1.8361 / 2.5168 (matches the model); S12 gives 1.9375 / 2.5 - model values used.
2. 1.14+ collision axis order: S10 says X-first when |vx| >= |vz|; S6 as read says the reverse. S10 followed; effect is limited to corners. Request an extra source if exactness is needed.
3. Sneak-edge limit 1.0 -> 0.6 at 1.11 comes from MCPK only [M].
4. Sprint-jump in a 2-block-high passage: S12 lists 9.73 b/s; the model cannot reproduce anything near it (a low ceiling gives period-10 hops with mostly ground time). Not used.
5. Creative flying speed: S11 10.79 vs S12 11.0 b/s (out of scope).
6. Water sink and swim constants for current versions: only the older-style formula (S8, WIP) was found; swim pitch easing unknown. FOV magnitudes, soul sand / honey / cobweb factors, item-use factor 0.2, sprint air-delay and pose transition smoothing are [L].
7. Step-up boundary (exactly 0.6 high) and the tie-break of the axis order are [M].
Suggested amendment requests for a later analyst pass: (a) current water gravity and swim-pitch easing; (b) fluid contact boxes; (c) sneak/pose camera smoothing; (d) numeric sprint FOV; (e) item-use factor; (f) low-ceiling sprint-jump speed; (g) soul sand/honey/cobweb exact factors.
