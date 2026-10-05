# Creature locomotion & animation — design notes (concepts only)

Analyst B · 2026-10-06 · binding protocol: `docs/CLEANROOM.md`

**Source studied:** the open-source Cobblemon mod (Kotlin) — https://gitlab.com/cable-mc/cobblemon, site https://cobblemon.com. Code is MPL-2.0; its assets and data are non-commercial and Pokémon-derived IP.
**How it was used:** *concepts only — nothing copied.* Only entity / AI / client-animation Kotlin was read (names in §8). No model, animation, texture, sound, species or data file was opened; battle, species and game-rule logic was ignored. Everything below is re-expressed in our own words; names, formulas, numbers and test vectors are ours. A sparse clone outside the project was used and then deleted.
**Audience:** implementers of Rust creature steering (`crates/sim_creatures`) and the JS part-hierarchy animator (`web/src/modules/creatures`). Read this plus `docs/briefs/creatures.md` and `voxel-creatures.md`; nothing from the reference is needed.
**Conventions:** sim = 60 Hz fixed step with prev/cur interpolation (BRIDGE_API §3); creatures are micro-voxel, roughly 0.6–0.9 m long, so lengths are given in metres and in body lengths (`BL`). Numbers in §3–§4 are *starting values* to be tuned by eye in the creature lab. The "ref." column only shows what the reference does, for calibration.

---

## 1. The twelve ideas that make creatures feel alive (ranked by payoff per effort)

1. **Never snap.** Pose changes are weighted cross-fades. (The reference waits for a fade to finish before retargeting; we retarget instantly from the current blend.)
2. **Gait phase comes from distance covered, amplitude from smoothed speed.** Feet plant, nothing moonwalks, limbs settle when the creature stops, cadence rises with speed.
3. **Everything is additive over a rest pose that is rebuilt every frame**, each contribution multiplied by a weight. Blending becomes trivial and nothing drifts.
4. **Head leads, body follows.** Look targets (destination, player, random glances) drive a clamped, smoothed head turn; beyond the clamp the body turns in place.
5. **An always-on idle layer** (breathing plus slow sways with unrelated periods) so a "standing" creature is never frozen.
6. **Timer-driven idle quirks** (blink, ear flick, tail swish, sniff…) with random intervals, per-creature state, desynchronised, paused during one-shots.
7. **One-shots** (notice, happy, graze, hop…) fade out the continuous layers with a weight — except whitelisted channels (look, breathing, springs).
8. **Each movement medium has its own signature:** walk (gait), swim (travelling wave plus buoyancy), fly (flap, bank, pitch), hover (bob plus drift), glide (wings out, no flap).
9. **Rotations are rate-limited and counter-rotated:** body pitch for fliers/swimmers is slew-limited and the head cancels it so the gaze stays put.
10. **Arrival easing, dead-zones and stop-snap** prevent orbiting and dithering; randomised re-plan timers stagger cost and de-synchronise creatures.
11. **Social and daily life:** followers hold a distance band behind a leader and copy its sleep; drowsiness is a slow random hazard, then "walk to a resting spot, lie down".
12. **Rare spice events** (graze, leap from water, stretch, shake off) with cooldowns and preconditions.

---

## 2. What the reference does (observed design, in our words)

### 2.1 Two clocks, two layers
- **Logic** ticks at 20 Hz and owns movement. From a few state flags it derives one coarse *pose type* and syncs that (plus a couple of bit flags such as "moving", "flying") to the presentation side as plain data.
- **Presentation** keeps a per-creature animation state: an age counter bumped once per logic tick, plus a fractional part set every rendered frame. Animation seconds = (age + fraction) / 20. All continuous animation reads this one clock.
- **Event keyframes** (sounds, particles) fire when the clock crosses their timestamp between two consecutive evaluations, i.e. the half-open interval (previous, now]. Nothing is skipped or doubled regardless of frame rate.
- Every frame the model is **reset to rest, then layers are applied additively**, and attachment points are refreshed last. There is no per-bone state carried between frames.
- Body yaw and head yaw are separate quantities; angles are interpolated along the shortest arc between the previous and current tick values.

### 2.2 Pose types and how one is chosen
- Types: stand, walk, sleep, hover, fly, float (idle in liquid), swim, glide, plus UI-only and carried variants (irrelevant to us). Useful groupings: *moving* {walk, swim, fly}; *stationary* {stand, float, hover}; *no-gravity* {fly, hover, swim}.
- Logic precedence, recomputed whenever relevant data changes: carried > sleeping > (underwater: swim if moving else float) > (flying flag: fly if moving else hover) > walk if moving > stand.
- "Moving" is simply *distance covered in the last tick above a tiny threshold* (about 0.1 blocks/s). There is no hysteresis; the long cross-fade hides any flicker.
- The model owns an **ordered list of poses**. Each declares which pose types it serves and an optional condition (variant, aspect, state). Selection is *first pose whose type matches and whose condition passes*, so variants are just earlier entries with conditions.
- The check runs every frame. If the current pose no longer fits, the animator moves to the best one — but **skips the check while a one-shot (including a transition) is running**.

### 2.3 What a pose contains
Static per-part offsets (position, rotation, scale — scale blended multiplicatively toward its target); a list of continuous animations, each with tags, a condition and a weight; a list of quirks; a fade length in ticks with an optional override per destination pose; optional dedicated transition builders for specific from→to pairs; an on-enter hook.

### 2.4 Transitions
- Default: a cross-fade as long as the source pose's fade length (**20 ticks = 1 s** default). Weight follows a cosine ease: w(u) = 0.5 − 0.5·cos(πu), u = elapsed / duration.
- During the fade **both poses are evaluated at once**, old with (1 − w) and new with w. Static offsets and animations are scaled by their pose's weight, so walk amplitude fades out while idle breathing fades in.
- The fade runs *as a one-shot* (flat weight 1), so quirks and other one-shots cannot interrupt it, and new pose requests are deferred until it ends.
- A dedicated transition (lie down, stand up, take off) can replace the generic fade for a given pair.

### 2.5 Layering and one-shots
Order each frame: (1) reset to rest; (2) permanent per-model offsets; (3) the current pose's static offsets; (4) quirks, only if no one-shot runs; (5) the one-shot, if any; (6) active overlay animations (removed when finished); (7) the pose's continuous animations; (8) refresh attachment points.
- While a one-shot runs, **pose weight = 1 − envelope(progress)** and the one-shot's weight is the envelope. Default envelope: linear ramp over the first 10 % of its duration, then hold at 1; presets exist for ramp-in/ramp-out (10 % linear, or 20 % sine-eased).
- A pose animation tagged on the one-shot's *exemption list* keeps full weight (the canonical example is "look").
- Starting a one-shot clears running quirks and overlays that don't survive it, and ends when start + duration has passed (an after-callback follows).

### 2.6 Quirks
A quirk is a recurring idle micro-animation: a (min, max) seconds range between occurrences, an optional condition, a loop-count range and a factory for overlay or one-shot animations. State lives **per creature instance** (next-due time, loops remaining). Scheduling: if nothing is scheduled, due = now + uniform(min, max); at the due time roll the loop count and start; wait for the run to finish, then clear and re-schedule. Quirks belong to poses, run only when no one-shot is active, and vanish with their pose.

### 2.7 Gait sync (speed to animation)
- **Phase advances with distance moved**, not with time; **amplitude is a smoothed speed fraction (0…1+)** times a per-limb gain times the weight. Limbs go quiet at rest and cadence tracks speed.
- Quadruped = a trot: each diagonal pair in phase, the other pair half a cycle later. Biped: legs half a cycle apart. Arms swing at the same cadence about another axis.
- Leg swing reaches roughly ±80° at full amplitude.
- Arms also get an **idle sway built from two slow sinusoids with different periods** (≈ 0.29 Hz and ≈ 0.21 Hz, ≈ 3° amplitude): unrelated periods mean the loop is never visible.
- Individuals with a different size factor move at speed ∝ √size, which limits foot slide.
- **Rig roles:** animations are written against *roles* (head, fore/hind left/right leg, left/right arm, left/right wing). A model says which bones fill which roles; generic animation modules do the rest.

### 2.8 Tilt and look
- **Body pitch tilt:** target = angle of the velocity vector (vertical vs horizontal speed), clamped ±45°, **slew-limited to 1° per tick (20°/s)**, applied to the body bone. The applied angle is stored; the head-look animation subtracts it (and subtracts whatever was already corrected during a transition) so the gaze stays on target.
- **Head look:** relative yaw/pitch clamped (yaw ±45°; pitch −45…+70° in the reference's sign convention), times a per-bone gain (invertible), times weight; tag "look" is exempt from one-shot suppression.
- **Look targets are written by logic:** when a wander starts, the target is the destination (a little above ground); nearby players/creatures within 8 blocks are glanced at at random 1.5–3 s intervals; a "look around" task runs 2.25–4.5 s; both are off while asleep; a per-species "can look" flag exists.
- Mount-style animations take **normalised, spring-smoothed kinematic signals** (pitch, yaw, rates, local forward/right/up velocity, each divided by a reference maximum and clamped to −1…1, optionally averaged over a short window) as inputs. Authoring against a signal bus is the idea worth keeping.

### 2.9 Curve toolkit and undulation
- Scalar functions of time: sine, cosine, triangle, parabola (a hop arc), linear — each with amplitude / period / phase / offset. Combinators: sum, product, shift, time-dilate, window (play within [a, b]), clamp, compose. Envelope presets (10 % ramps, 20 % sine ramps, constant 1).
- Uses: wing flaps (left +angle, right −angle), bobs, arcs, fade curves.
- **Travelling wave along a chain** (snake, fish, tail): each segment's rotation comes from the slope of the wave at that segment's position, time-shifted in proportion to its distance from the head; rotations are applied as differences between consecutive segments; the head can also translate sideways.

### 2.10 Movement control by medium (logic side)
- Base speed is chosen by medium (flying poses → fly speed; eye in liquid → swim speed; else walk speed), times a global modifier, times √size.
- **Facing:** approach the wanted position with a capped yaw step, cap ∝ the medium speed (fast movers turn faster); no turning when horizontally within ~5 cm.
- **Ground:** forward speed = min(cap, max(distance²/2, small floor)) — it eases off over the last stretch. Hop up a ledge when the goal is higher than the step height and the way ahead is blocked; no steering until landing.
- **Fluid / air:** velocity = unit direction × min(speed, remaining distance), so it can never overshoot. Tiny vertical errors are zeroed to stop dithering, with a small upward bias so swimmers climb out over a lip. Within ~5 cm of the goal velocity is zeroed (stop-snap).
- **Landing:** when a flier is idle on solid ground and could walk, the flying flag clears; the hover→stand fade *is* the landing.
- **Banking:** a scripted circling mode (constant forward speed, constant yaw rate, for N ticks). Followers copy it.
- Fliers have almost no vertical damping, so idle fliers get explicit vertical damping. Gravity is off in fly / hover / swim.

### 2.11 Wander and dithering
- **Gate:** each tick, when there is no destination and the creature is awake, pass with probability 1/120 → mean 6 s at 20 Hz; tunable per species.
- **Land:** random reachable spot within 10 blocks horizontally / 5 vertically; stroll at ≈ 0.33× speed; arrival radius 1 block; look target set to the destination.
- **Flight:** random hover spot biased into a ±90° cone around the current facing. **Water:** random swimmable spot.
- **Idle dithering** is a weighted pick: stroll (2), walk toward whatever it was just looking at (2), do nothing for 1.5–3 s (1).

### 2.12 Path-following hygiene
- Re-plan cooldown randomised 20–39 ticks (1–2 s) — staggers cost and de-synchronises creatures.
- Unreachable goal → fall back to a random nearby point toward it; remember "can't reach since"; re-plan if the goal moved more than 2 blocks; "reached" = within the completion range.
- **Waypoint capture radius depends on body width** (wide bodies: half the width; narrow: about 0.75 minus half the width); vertical tolerance is tightened only for fliers and swimmers.
- No path updates unless grounded, flying or in liquid (i.e. never mid-hop). Destination filters stop a walker's wander from ending on an unsuitable cell type.

### 2.13 Followers and herds
- Leader/follower with a **distance band (default 4–8 blocks)**. Beyond the far limit: destination near the leader at ≈ 0.4× speed, with a random annulus offset (radius uniform in [near, far − near/2], random angle; ± half-radius vertical spread for fliers/swimmers).
- Leader flying and follower not: follow into the air if able, otherwise give up the leader. Copy the leader's banking.
- Mimic the leader's destination with probability 1/60 per tick (≈ 0.33/s), unless already nearer to it than the leader.
- **Sleep sync:** leader asleep and follower drowsy → fall asleep with p = 1/40 per tick; leader awake → wake with p = 1/15 per tick.

### 2.14 Sleep cycle
A sensor runs once per second. Only inside the sleep time window (night), and not recently hurt or angry: p(drowsy) = 1/30 per second; once drowsy, p(rouse) = 1/240 per second; leaving the window clears drowsiness. Drowsy + a valid resting spot (search radius 16 horizontally / 8 vertically) → walk there, stop, enter the sleeping activity (sleep pose). Waking = drowsiness cleared. The nearest player within 16 blocks is recorded as a "disturbance".

### 2.15 Spice behaviours
- **Graze:** a ≈ 2 s timer that starts a one-shot, holds the creature in place for the duration, then applies a cooldown.
- **Leap from water:** 1-in-10 check; needs a clear straight corridor (six sample cells ahead all water, two air cells above each); impulse ≈ 0.6 forward and ≈ 0.7 up (blocks/tick); body pitch follows the velocity vector; once vertical speed is small, pitch relaxes toward level by 20 % per tick; lasts at most 4 s.

### 2.16 Behaviour as data
Per species: can walk / swim / fly, a speed per medium, step height 0.6, wander rate 120, wander speed 1.0, can look; rest (time window, light range, allowed blocks/biomes, drowsy and rouse chances); herd (tolerated leaders, band 4–8, max size). The "brain" is a set of *activities* (always-on core, idle, fight, avoid, sleeping): low-frequency **sensors** write memories, **tasks** read them and have min/max run times, and swap-activity tasks move between activities.

---

## 3. Our design (original)

### 3.1 Architecture and data flow
```
Rust 60 Hz (fixed)                         JS (render rate)
 sensors 1 Hz  ─┐                           bridge: prev/cur rows + alpha()
 decisions 5 Hz ├─ brain → goal, gait mode  Animator per creature:
 steering 60 Hz ┘   → pos, yaw, flags         kinematics → pose weights → clocks
 publishes `creatures` channel (stride 16)     → layered additive evaluation → springs
 + events (notice, emote, sleep, wake)         → write part transforms
```
- **No contract change is needed for v1.** JS derives: rendered velocity ((cur − prev) / SIM_DT, low-passed), speed fraction against the species' top speed, vertical speed, yaw rate (shortest-arc difference), medium (flag bit 2 "in water" now; a flight flag later), and the pose from `anim_state` + `flags`.
- **Append-only additions worth proposing** (never change existing offsets): new `anim_state` codes 8 float, 9 hover, 10 fly, 11 glide, 12 graze, 13 shake-off, 14 stretch/yawn; a small `creature.motion` channel (or spare columns 14–15) with look target (relative yaw/pitch or a world point), look weight, and a medium code.
- **Interpolation rules:** discrete columns (id, species, variant, anim_state, flags, emote, target_id) are read from `cur`, never lerped. `anim_t` is not lerped either: the animator restarts its own timer when it sees a state change (error ≤ one sim step) and, if a creature first appears already asleep with `anim_t` > 1 s, starts fully asleep (no lie-down). **Yaw is lerped along the shortest arc.** Position, scale and mood lerp linearly.
- **Events (kinds 300–304) trigger one-shots at the exact step** instead of waiting for `anim_state` to change.
- Animators take `dt` from `ctx.clock.dt` (0 when frozen — deterministic screenshots), never the wall clock; RNG is seeded from (world seed, creature id, purpose) so shots reproduce; no per-frame allocations (typed arrays).

### 3.2 Pose FSM in Rust
Priority order, first match wins (this decides `anim_state` + flags):

| prio | pose | guard | notes |
|---|---|---|---|
| 1 | SLEEP | asleep flag | entered only through the rest sequence (§3.4) |
| 2 | SWIM / FLOAT | submerged ≥ 0.4 BL | SWIM if moving, else FLOAT |
| 3 | FLY / HOVER | creature is flying (fliers only) | FLY if moving, else HOVER; GLIDE when descending without flapping |
| 4 | RUN / WALK | moving | WALK vs RUN by speed band with hysteresis |
| 5 | STAND | default | |

NOTICE, HAPPY, GRAZE, SHAKE, STRETCH and the take-off/landing flares are **one-shot events**, not states.

**Hysteresis and dwell** (speed01 = horizontal speed / species top speed; the reference has none and leans on its slow fade): stand→walk when speed01 > 0.10 and leave below 0.05; walk→run enter 0.60, leave 0.48; swim↔float enter 0.12, leave 0.06; **minimum dwell 0.2 s** in any moving/stationary state. JS still blends gait continuously, so the discrete walk/run code is only a hint.

### 3.3 Steering (Rust)
One step per 60 Hz tick. The unit of length below is metres, scaled by body length where noted.

**Ground**
```
to     = goal.xz - pos.xz ;  dist = |to|
err    = wrap_pi(atan2(to.x, to.z) - yaw)
// turn: gain, rate cap that shrinks with speed, then an acceleration cap
rate_cap  = lerp(YAW_SLOW, YAW_FAST, speed01)          // 480 -> 280 deg/s
rate_goal = clamp(YAW_GAIN * err, -rate_cap, rate_cap) // YAW_GAIN ~ 8 /s
yaw_rate += clamp(rate_goal - yaw_rate, -YAW_ACC*dt, YAW_ACC*dt)   // ~2400 deg/s^2
yaw      += yaw_rate * dt
// speed: kinematic braking curve, slowed when badly misaligned, never stalls short of the goal
brake_v = sqrt(2 * A_BRAKE * max(dist - R_STOP, 0))
align   = lerp(1.0, 0.25, smoothstep(30deg, 90deg, |err|))
v_goal  = dist > R_STOP ? max(min(V_CAP, brake_v) * align, V_CREEP) : 0
speed  += clamp(v_goal - speed, -A_BRAKE*dt, A_ACC*dt)
pos    += heading(yaw) * speed * dt
arrived when dist <= R_STOP and speed < 0.05
```
- Ledges: if the goal is higher than the step limit (≈ 0.3 BL) **and** the way is blocked, start a hop (§3.11); **no steering and no re-planning while airborne**.
- Size variants: speed ∝ √scale, stride ∝ scale, hence cadence ∝ 1/√scale (the pendulum-leg rule; it keeps big creatures from running with tiny quick steps).

**Fluid / air (3-D)**
```
to = goal - pos ;  dist = |to|
dead-zone: |to.y| < 0.04 -> 0         // stops vertical dithering
leaving water over a lip: to.y += 0.05
v_goal = (to/|to|) * min(V_CAP, dist / T_ARRIVE)   // T_ARRIVE ~ 0.35 s: cannot overshoot, eases out
vel    = approach(vel, v_goal, A_FLUID * dt)       // ~5 m/s^2 (3-D)
if dist < R_STOP_FLUID: vel *= exp(-dt / 0.08)      // stop-snap
facing = |vel.xz| > 0.1 ? atan2(vel.x, vel.z) : yaw // turn-rate capped, as above
```
- Fliers add a minimum turn radius R_min = v² / a_lat with a_lat ≈ 4 m/s², plus soft altitude control (§3.12). Idle fliers get explicit vertical damping.

**Banking / circling** (idle fliers and swimmers, flock copies): constant forward speed v and constant yaw rate ω = v / R for T = 3–8 s.

**Starting values** (ground, small creature): V_CAP = species top speed (typically 1.0–2.2 m/s); stroll = 0.35 × top; A_ACC = 8, A_BRAKE = 6 m/s²; R_STOP = 0.4 BL (≥ 0.15 m); V_CREEP = 0.1 × top.

### 3.4 Brain cadence, wander, rest, herds (Rust)
**Cadences:** sensors 1 Hz (staggered by id), decisions 5 Hz, steering 60 Hz, path re-plan every U(1.0, 2.0) s or when the goal moves > 3 BL.

**Wander** — a Poisson gate, not a fixed timer: p_step = 1 − exp(−dt / T_WANDER), T_WANDER = 6 s (4–10 by temperament), plus a minimum idle of 1 s after anything ends. Only when there is no goal and the creature is awake.
- Radius 6–12 BL horizontally (≈ 3 BL vertically for fliers/swimmers); stroll at 0.35× top speed; arrival radius 0.4 BL. Fliers choose inside a ±90° cone ahead; swimmers pick swimmable cells.
- **Dithering table** (weights): stroll 2, curiosity-approach (walk toward whatever it last glanced at) 2, pause 1 (pause 1.5–3 s).
- **Set the look target to the destination (≈ 1.2 m ahead along the path at eye height) the moment a goal is chosen** — the head leads the body.

**Glances:** every U(1.5, 3.0) s, if an awake player or creature is within 8 m, look at it for U(0.8, 1.5) s; after noticing the player, 40 % chance to approach (curiosity). Off while asleep.

**Rest cycle:** inside the night window (world night ± 30 min; from `time.hours`), not hurt/afraid: drowsy hazard 1/30 per s, rouse hazard 1/240 per s. Drowsy → find a den spot within 16 m → walk there → stretch/yawn one-shot (1.2 s) → lie-down transition (0.9 s) → SLEEP. Wake when drowsiness clears, or when a player stays within `wake_radius` (default 5 m; × 0.5 if sneaking, × 1.6 if sprinting) for > 0.5 s.

**Herds:** follow band 4–8 m (≈ 6–12 BL). Beyond the far edge: goal near the leader at 0.5× speed, random annulus offset (radius U[near, far − near/2], ± half-radius vertical for fliers/swimmers). Copy the leader's goal at ≈ 0.33 events/s unless already nearer; sleep-sync: fall asleep at ≈ 0.5/s when the leader sleeps and the follower is drowsy, wake at ≈ 1.3/s when the leader is awake.

### 3.5 JS animator: per-frame evaluation order
```
per creature, per rendered frame (dt = ctx.clock.dt, alpha = bridge alpha):
 1 sample      pos, yaw (shortest arc), scale, mood from prev/cur; discrete cols from cur
 2 kinematics  v_vis, speed, vert_speed, yaw_rate, accel_local  (low-pass tau ~0.06 s)
 3 pose        target pose from anim_state + flags -> pose weights (§3.6)
 4 clocks      gait_phase += speed/stride*dt ; breath, sway, wave phases ; quirk timers ; one-shot clock
 5 evaluate    offsets[] = 0   (flat typed array: pos3, rot3, scale3 per part)
     L0  rest transforms are the baseline
     L1  static offsets of each pose  x weight_i
     L2  continuous animations of each pose  x weight_i  x oneshot_suppression(tag)
     L3  active one-shot  (envelope)                       -> offsets
     L4  look (head/eyes) — exempt from suppression
     L5  quirk overlays, only if no one-shot
     L6  root effects: bob, lean, squash/stretch, body tilt (+ head counter-rotation)
     L7  secondary springs (ears, tail chain, leaf plume, fluff) added last, never suppressed
 6 write       part.local = rest + offsets
 7 events      foot strikes, splash, dust: fire when a phase crosses its mark between frames
```
**Part hierarchy (rig roles):** root (ground contact) → body → {neck/head → {ears, eyes, jaw}, tail chain, leg/arm pivots, wings, glow nodes}. Pivots sit at joints (hip, shoulder, neck, tail base): bake part meshes offset around their pivot. Small angles may be added as Euler (order YXZ); big static poses (sleep curl) should compose as quaternions.

### 3.6 Pose weights and transitions
Replace fixed-duration fades with **weight springs** — retargetable at any time, never stalls:
```
for each pose i:  w_i += (target_i - w_i) * (1 - exp(-dt / tau_i))   // target is one-hot
normalise so  sum(w_i) = 1
```
| change | tau (s) | ≈ 95 % in |
|---|---|---|
| stand ↔ walk | 0.07 | 0.21 s |
| walk ↔ run | none: continuous gait blend, smoothstep over speed01 0.45–0.65 | — |
| ground ↔ water | 0.10 | 0.30 s |
| swim ↔ float | 0.12 | 0.36 s |
| fly ↔ hover | 0.12 | 0.36 s |
| → sleep | dedicated lie-down one-shot 0.9 s (anticipation, settle) | — |
| sleep → | dedicated get-up one-shot 0.7 s | — |
| hover → ground | landing-flare one-shot 0.5 s, then the weight spring | — |

Use a fixed-duration cosine ease (w = 0.5 − 0.5·cos πu) only for dedicated one-shot transitions where the duration must be exact. The reference's 1 s default is far too floaty for everyday walk/stand changes in a close-up camera.

### 3.7 Gait
Parameters per species: leg length `L` (m), archetype (quadruped trot, biped, hopper, swimmer-paddler).
```
stride  = c_s * L              // c_s = 2.4 walk .. 3.6 run  (blend with gait_blend)
cadence = clamp(speed / stride, 0.8, 3.2) Hz   // outside the band, switch gait or blend to idle shuffle
gait_phase += speed / stride * dt              // cycles; continuous across frames and pose changes
a = smooth(clamp(speed / v_ref, 0, 1.25), tau = 0.08 s)      // gait amplitude
leg_angle(i) = A_LEG * a * sin(2*pi*(gait_phase + offset_i))  // A_LEG ~ 0.9 rad (~50 deg) max
body_bob     = B * a * sin^2(2*pi*gait_phase)                 // two rises per cycle, lowest at foot strikes; B ~ 0.04 BL
forward_lean = 4deg * speed01 ;  hip/shoulder counter-roll ~ 2-3 deg at cadence
```
Offsets: **quadruped trot** FL 0, HR 0, FR 0.5, HL 0.5; **biped** L 0, R 0.5; **hopper** rear pair together, front pair +0.1. The gait amplitude also scales ear bounce, tail sway and arm swing. When `a` < 0.05 and speed starts rising, snap phase to the nearest foot-strike (0 or 0.5) so the first step starts planted. A **foot-strike event** fires at phase 0 and 0.5 (dust, tiny squash, soft sound), exactly once each regardless of frame rate. Turn-in-place: add `a_turn = 0.6 * clamp(|yaw_rate| / 200 deg/s, 0, 1)` to the amplitude so legs shuffle when the body pivots. **Turn lean:** ground roll = clamp(0.03 · yaw_rate[°/s] · speed[m/s], ±10°).

### 3.8 Springs and secondary motion
The reference has no physical secondary motion (its ears and tails are only functions of time). Springs are our upgrade:
```
spring_step(x, v, target, f_hz, zeta, dt):
    w = 2*pi*f_hz ;  n = ceil(dt / (1/120)) ;  h = dt / n      // sub-step for stability; clamp dt <= 0.05 s, n <= 6
    repeat n:  a = w*w*(target - x) - 2*zeta*w*v ;  v += a*h ;  x += v*h
    return (x, v)
```
**Drive:** each secondary bone's target = rest + pose-weighted rest offsets (mood droop etc.) − g_a · a_local (low-passed local acceleration) − g_w · yaw_rate (+ a small wind term from `uWind`). Clamp |x − target| ≤ 0.8 rad. State is per bone and **never reset on pose change**.

| bone | f (Hz) | ζ | notes |
|---|---|---|---|
| ear | 3.2 | 0.32 | g_a ≈ 0.04 rad per m/s², clamp ±0.5 rad |
| tail base / tip | 2.0 / 2.8 | 0.35 / 0.30 | chain of 3–5 segments, each following its parent → follow-through |
| leaf plume, antenna | 2.4 | 0.28 | |
| head follow | 4.5 | 0.70 | the head spring in §3.9 |
| body squash | 6.0 | 0.35 | hop landings, notice start |
| fluff / belly jiggle | 5.5 | 0.25 | small amplitude only |
| eye-highlight shift | 9.0 | 0.90 | fast saccade |

### 3.9 Look-at and eyes
- **Target priority:** (1) `target_id` when the creature is aware of the player → player's head; (2) glance target (§3.4); (3) destination lookahead; (4) idle look-around — random yaw ±70°, pitch ±15°, hold U(0.8, 2.0) s every U(2.5, 5) s; (5) none when asleep.
- **Head:** e = wrap(bearing − body_yaw). Head target = clamp(e, ±55°) in yaw and [−30°, +35°] in pitch, per-species neck gain; driven through the head spring (f 4.5 Hz, ζ 0.75). Weight stays 1 during one-shots except sleep and graze.
- **Body follows:** if |e| > 55° for more than 0.3 s, request a body turn (Rust) at up to 220°/s until |e| < 20°; play turn-in-place stepping meanwhile (§3.7).
- **Counter-rotation:** head pitch −= 0.85 × (body pitch applied this frame), so a climbing flier keeps looking where it is going.
- **Eyes:** eye-highlight voxels shift up to ±0.5 voxel toward the gaze through the fast spring; blink is a quirk (§3.10). During NOTICE the eyes go wide and blinking is blocked for 0.6 s.

### 3.10 Idle life and quirks
- **Breathing:** chest/body scale y,z ±1.5 % at 0.28 Hz × (0.8 + 0.6·mood); head bob ±0.5°; random per-creature phase; sleep: amplitude × 1.6, rate × 0.7.
- **Idle sway:** sum of three sinusoids at ≈ 0.21 / 0.31 / 0.47 Hz (each ±15 % per creature), 2–3° on ears, tail and arms. Unrelated periods → no visible loop.
- **Quirk scheduler** (per creature, seeded RNG): `due = now + U(min, max)`; at `due` roll the loop count, start the overlay/one-shot, wait for completion, clear and re-schedule. Skipped while a one-shot runs or while another quirk holds the same part tags. Expressive quirks scale their interval by lerp(1.4, 0.7, mood).

| quirk | poses | interval (s) | loops | duration | parts | condition |
|---|---|---|---|---|---|---|
| blink | stand, walk, hover, float | 2.5–6.0 | 1 (15 % → 2) | 0.22 (close 0.07, hold 0.04, open 0.11) | eyelids / eye scale | not asleep; blocked 0.6 s after NOTICE |
| ear flick | stand, walk | 4–11 | 1–2 | 0.18 | one random ear, ±25° | — |
| tail swish | stand, walk | 3–8 | 1–3 | 0.5 / loop | tail chain | has a tail |
| sniff | stand | 6–15 | 1–3 | 0.45 | head pitch −8°, nose scale | not aware of player |
| curious head tilt | stand | 8–20 | 1 | 0.9 | head roll 12° toward look target | aware or curious |
| groom / scratch | stand | 20–60 | 1 | 1.5 | hind limb + head | mood > 0.3, no player within 4 m |
| stretch | stand | 25–70 (forced before sleep) | 1 | 1.4 | spine pitch, forelegs forward | — |
| shake off | event: left water | — | 2–3 shakes | 0.9 | body roll ±12° at 8 Hz, decaying | — |
| sleep twitch | sleep | 10–25 | 1 | 0.3 | one ear or paw | — |

**Mood modulation** (m = `mood` 0…1): breath rate × (0.8 + 0.6 m); tail gain 0.3 + 0.9 m; ear rest angle lerp(−12°, +6°, m); stroll speed × (0.85 + 0.3 m); step bounce × (0.7 + 0.6 m).

### 3.11 One-shots, hops, squash and stretch
- **Envelope:** smoothstep ramp-in 80–120 ms, hold, ramp-out 120–200 ms (the reference's default only ramps in). While a one-shot runs, continuous layers are multiplied by (1 − envelope), except the exempt tags look, breath and springs.
- **Anticipation and follow-through:** hop = crouch 0.10 s (scale y 0.85) → launch stretch (y 1.12) → apex neutral → landing squash (y 0.82, xz × 1/√y ≈ 1.10) → settle on the squash spring. Keep volume: sx = sz = 1/√sy.
- **Ballistic hop:** apex height h = 0.3–0.6 BL, airtime T = 2·√(2h/g), height y(u) = 4h·u(1 − u), u = t/T. Hop travel = repeated hops with a contact dwell of 0.08–0.2 s; steer only at contact (turn ≤ 60° per hop); size the final hop so the creature lands inside R_STOP.
- **NOTICE** (event 300): head snaps up, ears up, 0.04 m micro-hop, freeze 0.6 s, look target = player. **HAPPY:** bounce + tail gain up + emote bubble at the event.

### 3.12 Medium-specific signatures
**Swim** — surface float: vertical spring toward `surface − 0.55·BH` (BH = body height) with a ±0.03 m bob at 0.6 Hz; swimming: **travelling wave** along the spine, `angle_i = A_i · sin(2π (f_u·t − s_i/λ))`, s_i ∈ [0,1] head→tail, `A_i = A_max · s_i^1.4`, `A_max` 18°, λ ≈ 1.1 BL, `f_u = 0.6 + 1.1·speed01` Hz. Neighbouring-segment phase lag = Δs/λ × 360°. Paddle legs at ≈ 1.5 × f_u, half a cycle apart. Pitch from vertical speed, slew limit 60°/s. Ripple events on entry/exit and every 0.4 s while moving at the surface.
**Fly** — flap frequency 3.0 + 2.0·speed01 + 1.5·climb01 Hz (up to 8 Hz for butterfly-sized); amplitude full when hovering/climbing, 35 % in cruise, 0 in glide (wings spread, slight dihedral). Bank roll = clamp(0.07 · yaw_rate[°/s] · speed[m/s], ±35°) through a spring (f 2.5, ζ 0.7). Pitch from the climb angle, clamp ±40°, slew 60°/s. Cruise altitude spring toward 1.5–3 m above ground with a slow ±0.4 m wander (0.08 Hz). Take-off: crouch 0.15 s → two strong flaps → 45° climb. Landing: 20° glide slope to a point 0.6 BL before the perch → flare (+20° pitch, full flaps, 0.3 s) → touchdown → hover→walk weight spring.
**Hover** — bob ±0.05 m at 0.7 Hz (+ 0.02 m at 1.9 Hz), lissajous drift ±0.15 m (0.11 / 0.17 Hz), roll sway ±3°, explicit vertical damping.
**Leap from water** (rare spice) — check every 2 s with p = 0.1 only if the corridor ahead is clear (water, air above); impulse ≈ 3 BL/s forward and ≈ 5 BL/s up (apex ≈ 1 BL, since apex = v²/2g); body pitch follows the velocity vector and relaxes to level with a time constant ≈ 0.22 s once vertical speed is small; splash event on exit and re-entry; ≤ 4 s.
**Graze** (spice) — only on grass, p per check low, ≈ 2 s one-shot, creature frozen, then a cooldown of 60–180 s.

### 3.13 LOD and budget (cap is 4096 creatures)
- LOD0 (< 20 m): full stack incl. springs and quirks. LOD1 (20–50 m): gait + breathing + look; springs at 30 Hz staggered. LOD2 (50–100 m): pose weights + gait at 15 Hz, no quirks. LOD3 (> 100 m or off-screen): advance phases analytically, write no transforms. Stagger LOD refresh by creature id.

### 3.14 Lab aids
Overlays for gait phase, pose weights, spring states, look cone, steering goal + arrival radius, wander/rest state; a time-scale slider (to judge fades); "force pose" and "force one-shot" buttons; deterministic seeds. Judge by filmstrips of walk cycles, stop/start, turns, sleep, swim, fly.

### 3.15 Suggested build order
(1) kinematics + gait phase/amplitude + weight-spring cross-fade + breathing + blink; (2) springs for ears/tail + head look with body follow; (3) one-shots + quirks + hop squash; (4) swim/float, then fly/hover/glide; (5) Rust wander dithering, rest cycle, herds; (6) spice events and LOD.

---

## 4. Parameter sheet (starting values)

| parameter | start | range | ref. (observed) |
|---|---|---|---|
| ground pose cross-fade tau | 0.07 s | 0.05–0.12 | 1 s fixed |
| moving threshold (enter / leave) | 0.10 / 0.05 × top speed | ±30 % | ~0.1 blocks/s, no hysteresis |
| min dwell in a moving state | 0.2 s | 0.1–0.4 | none |
| stride / leg length (walk, run) | 2.4 L, 3.6 L | 2.0–4.5 | fixed phase constant |
| cadence band | 0.8–3.2 Hz | | — |
| leg swing at full amplitude | ≈ 50° | 35–65° | up to ≈ 80° |
| gait amplitude smoothing | 0.08 s | 0.05–0.15 | — |
| idle sway periods / amplitude | 0.21 / 0.31 / 0.47 Hz, 2–3° | | 0.29 / 0.21 Hz, ≈ 3° |
| breathing | 0.28 Hz, ±1.5 % | 0.2–0.4 Hz | — |
| head yaw clamp | ±55° | 40–75° | ±45° |
| head pitch clamp | −30°…+35° | | −45°…+70° |
| head spring | 4.5 Hz, ζ 0.75 | | — |
| body-turn trigger / release | 55° for 0.3 s / 20° | | — |
| body turn rate (look-driven) | 220°/s | 150–300 | — |
| pitch slew (fliers/swimmers) | 60°/s | 30–120 | 20°/s |
| pitch clamp | ±40° | | ±45° |
| bank gain / clamp | 0.07 per (°/s · m/s), ±35° | | — |
| yaw rate cap (slow→fast) | 480→280°/s | | speed-proportional cap (generous) |
| accel / brake (ground) | 8 / 6 m/s² | 5–14 | — |
| arrival | braking curve + creep, R_STOP 0.4 BL | | slows in the last ≈ 1 block |
| fluid arrival time T_ARRIVE | 0.35 s | 0.2–0.6 | min(speed, remaining distance) |
| stroll speed multiplier | 0.35 | 0.3–0.5 | 0.33–0.4 |
| wander mean wait | 6 s (+1 s min idle) | 4–10 | 6 s |
| wander radius | 6–12 BL | | 10 blocks h / 5 v |
| dithering weights stroll : curiosity : pause | 2 : 2 : 1 | | 2 : 2 : 1 |
| pause length | 1.5–3 s | | 1.5–3 s |
| glance interval / radius | U(1.5, 3) s / 8 m | | 1.5–3 s / 8 blocks |
| path re-plan | U(1, 2) s | | 1–2 s |
| drowsy / rouse hazard | 1/30 s⁻¹ / 1/240 s⁻¹ (night only) | | same |
| den search radius | 16 m | | 16 h / 8 v blocks |
| herd band | 4–8 m (6–12 BL) | | 4–8 blocks |
| herd follow speed | 0.5 × top | | 0.3–0.4 |
| herd goal-copy / sleep-sync / wake-sync | 0.33 / 0.5 / 1.3 per s | | 1/60, 1/40, 1/15 per tick |
| speed vs scale | ∝ √scale (stride ∝ scale) | | ∝ √scale |
| spring step | 1/120 s, dt ≤ 0.05 s | | — |
| velocity / yaw-rate filter | 0.06 s / 0.10 s | | — |

---

## 5. Test vectors (turn these into unit tests)

Unless noted, tolerances are absolute.

1. **Gait phase integral.** Stride 0.60 m, constant 1.2 m/s for 5.0 s, simulated at 30, 60 and 144 fps → gait_phase = 10.00 ± 0.02 cycles at every frame rate. Foot-strike events over that run: exactly 20 (two per cycle), none duplicated or missing.
2. **Cosine ease.** u = 0, 0.25, 0.5, 0.75, 1 → w = 0, 0.1464, 0.5, 0.8536, 1 (± 1e-4).
3. **Weight spring + retarget.** tau = 0.07 s, from (1, 0) to target (0, 1): after 0.07 s the new weight = 0.632 ± 0.005; after 0.21 s = 0.950 ± 0.005; weights sum to 1 ± 1e-6 every frame. Retarget back at 0.10 s (new weight 0.760): no jump; 0.07 s later the new weight = 0.280 ± 0.005.
4. **Spring step response.** f = 3 Hz, ζ = 0.4, step 0 → 1: peak = 1.254 (± 3 %) at t = 0.182 s (± 0.01). ζ = 1 never exceeds 1.001.
5. **Shortest-arc yaw.** prev = 170°, cur = −170°: alpha 0.25 / 0.5 / 0.75 → 175° / 180° / −175° (185°). Never passes through 0°.
6. **Ground arrival.** V_CAP 1.2, A_ACC 8, A_BRAKE 6, R_STOP 0.10 m, V_CREEP 0.15 m/s; 5 m dead ahead from rest: arrives (speed < 0.05) in 4.1–4.6 s; overshoot past the goal radius ≤ 0.03 m; after the cruise phase speed never increases.
7. **Hysteresis.** speed01 = 0.08 + 0.028·sin(2π·3t) for 5 s → exactly one transition (stand→walk), not ~30. speed01 = 0.075 + 0.02·sin(2π·3t) → zero transitions.
8. **Wander hazard.** p_step = 1 − exp(−(1/60)/6): P(no trigger within 6 s = 360 steps) = 0.368 ± 0.012 over 10 000 seeded trials.
9. **Rest hazards.** From awake in the night window: P(drowsy within 60 s) = 0.869 ± 0.02; once drowsy, P(still drowsy after 240 s) = 0.367 ± 0.02 (5 000 trials each, 1 Hz sensor).
10. **Head clamp + body follow.** Body yaw 0°, look target at bearing +120°: head yaw saturates at 55°; the body starts turning after 0.3–0.4 s at ≤ 220°/s; by t = 1.2 s |e| ≤ 25°; the head never exceeds the clamp.
11. **Pitch slew.** Target 40°, rate limit 60°/s: pitch = 15° ± 1° at 0.25 s; reaches 40° at 0.67 s ± 0.03; never overshoots. Head counter-rotation: head pitch = look pitch − 0.85 × body pitch.
12. **Travelling-wave lag.** Segment centres s = 0.1, 0.3, 0.5, 0.7, 0.9, λ = 1.2 BL → phase lag between neighbours = 60° ± 0.5°.
13. **Squash volume.** sy = 0.82 → sx = sz = 1.104; product sx·sy·sz = 1.000 ± 0.001.
14. **Hop arc.** h = 0.25 m, g = 9.8 → T = 0.452 s ± 0.002; y(T/2) = 0.25 ± 0.002; symmetric about T/2.
15. **Scale rule.** scale 1.0 → 1.44: speed ×1.2, stride ×1.44, cadence ×0.833 (e.g. 1.2 m/s with 0.60 m stride = 2.0 Hz becomes 1.44 m/s with 0.864 m stride = 1.667 Hz).
16. **Quirk desync and determinism.** First-blink times for creature ids 1…100 with one world seed: all in [2.5, 6.0] s, standard deviation in [0.8, 1.2] s, identical on a re-run with the same seed.

---

## 6. What NOT to copy

- **Code, comments, identifiers, class/file decomposition** of the reference. Our module layout, names and comments are our own; Rust and TS are written from this document alone. Porting any code needs the user's explicit approval and MPL-2.0 headers (CLEANROOM.md).
- **Assets and data:** models, animations, textures, particles, sounds (including any vanilla-game sound events the reference references), species / form / behaviour datasets, and any authored per-species timing curves.
- **Its formats and scripting layer:** the embedded expression language and the Bedrock/Blockbench model and animation formats. Our creatures are procedural voxel part hierarchies.
- **All Pokémon-flavoured logic and vocabulary:** battles, status-induced sleep, party/storage rules, ownership, capture, send-out/recall visuals (ball, beam, scale tween), riding.
- **Vanilla-game constants and behaviours** that the reference inherits; our movement feel comes from `docs/specs/MOVEMENT_SPEC.md`, not from this study.
- **Its numbers as sacred values.** They are tuned for 1 m blocks, a 20 Hz tick and human-sized creatures. Re-tune by eye.

**Weaknesses of the reference to avoid:** a 1 s default cross-fade for everyday transitions; no retargeting mid-fade (new pose requests wait); a hard moving/not-moving threshold without hysteresis; a one-shot envelope that only ramps in; no physical secondary motion; a body-tilt rate (20°/s) that is sluggish for small, agile fliers; no turn-in-place feedback when the head hits its clamp.

---

## 7. Open questions (for the orchestrator, if the owners agree)

1. Is `yaw` in the `creatures` channel continuous or wrapped? JS must lerp it along the shortest arc either way (§3.1, TV5) — please confirm and document in BRIDGE_API.
2. Approve the append-only additions in §3.1 (new `anim_state` codes, `creature.motion` channel) or confirm JS-only derivation for v1.
3. Do the three hero species need flying or swimming locomotion now, or only walk / hop / swim? That sets priority for §3.12 (fly/hover can follow later).
4. Per-species rig-role declarations (which bones are head, ears, legs, tail chain, wings) are needed from the voxel-sculptor owner before the animator can be generic.
5. Night window and den spots: confirm which `time.hours` range counts as night and where dens are defined (world or species data).

---

## 8. Repo paths studied (names only)

Repository: https://gitlab.com/cable-mc/cobblemon (shallow, sparse, Kotlin source only; deleted after use). Paths below are relative to `common/src/main/kotlin/com/cobblemon/mod/common/`.

- `entity/PoseType.kt`
- `entity/pokemon/PokemonServerDelegate.kt`, `PokemonEntity.kt` (movement and pose-flag sections only), `PokemonBehaviourFlag.kt`
- `entity/pokemon/ai/PokemonMoveControl.kt`
- `entity/pokemon/ai/sensors/DrowsySensor.kt`, `PokemonDisturbancesSensor.kt`
- `entity/pokemon/ai/tasks/ChooseFlightWanderTargetTask.kt`, `ChooseWaterWanderTargetTask.kt`, `GoToSleepTask.kt`, `WakeUpTask.kt`, `JumpOutOfWaterTask.kt`, `EatGrassTask.kt`
- `entity/ai/ChooseLandWanderTargetTask.kt`, `FollowWalkTargetTask.kt`, `FollowHerdLeaderTask.kt`, `LookInDirectionTask.kt`, `LookAroundTaskWrapper.kt`, `StayAfloatTask.kt`, `OmniPathNavigation.kt` (key lines only)
- `pokemon/ai/PokemonBrain.kt` (activity layout only), `WalkBehaviour.kt`, `SwimBehaviour.kt`, `FlyBehaviour.kt`, `MoveBehaviour.kt`, `IdleBehaviour.kt`, `RestBehaviour.kt`, `HerdBehaviour.kt`
- `client/entity/PokemonClientDelegate.kt`, `client/render/pokemon/PokemonRenderer.kt` (timing, scale and rotation interpolation parts only)
- `client/render/models/blockbench/PosableState.kt`, `PosableModel.kt`, `FloatingState.kt`
- `client/render/models/blockbench/pose/Pose.kt`, `ModelPartTransformation.kt`
- `client/render/models/blockbench/quirk/ModelQuirk.kt`, `SimpleQuirk.kt`, `QuirkData.kt`, `SimpleQuirkData.kt`
- `client/render/models/blockbench/animation/ActiveAnimation.kt`, `PoseAnimation.kt`, `PoseTransitionAnimation.kt`, `PrimaryAnimation.kt`, `QuadrupedWalkAnimation.kt`, `BipedWalkAnimation.kt`, `BimanualSwingAnimation.kt`, `SingleBoneLookAnimation.kt`, `PitchTiltAnimation.kt`, `WingFlapIdleAnimation.kt`, `WaveAnimation.kt`, `RotationFunctionPoseAnimation.kt`, `TranslationFunctionPoseAnimation.kt`
- `client/render/models/blockbench/wavefunction/WaveFunction.kt`
- Directory listings only (file names, role names used by constructors): `client/render/models/blockbench/frame/`

Not opened: anything under `resources/` (assets, data, species, animations), battle and species code, the per-generation model directories, and riding/mounting logic beyond noticing its existence.
