//! The player's kinematic character controller as a **pure function** over plain data ([`step`]), so it can be
//! unit-tested natively against synthetic block worlds and reused (e.g. for a companion that mimics the player).
//! The ECS systems in `lib.rs` only copy data in and out.
//!
//! # Model (docs/specs/MOVEMENT_SPEC.md, clean-room; re-expressed at our 60 Hz step per spec section 8.1)
//! * The movement model runs at its native **20 Hz "tick"**: acceleration / friction / gravity / jump / sprint / water
//!   exactly as in the spec (constants in blocks per tick; 1 block = 1 m, so 20x for m/s). One 60 Hz simulation step is a
//!   third of a tick: the tick pipeline runs on every third step, its displacement is applied as three equal,
//!   collision-checked sub-moves, damping runs after the third. Spec test vectors therefore hold at every third step.
//! * Collision is voxel AABB (`sim_core::blocks::aabb_sweep`, axis by axis: Y, then the larger horizontal axis first),
//!   with step-up (retry raised by `step_height`, keep the result when it covers more ground, lower back down).
//! * Hitbox: our chibi avatar is ~1.15 m tall, so the box is 0.5 x 1.15 x 0.5 (spec: 0.6 x 1.8). The *motion* constants
//!   are NOT scaled (a 1 m terrace must stay jumpable: apex 1.25 m); only the box is. `PlayerTuning::spec()` restores the
//!   spec box for the test vectors.
//! * Polish on top (all tunable, all off in `spec()`): coyote time, jump buffer (+ a latch so a tap shorter than a tick is
//!   never lost, + an immediate tick restart when starting from rest so the first step of movement has no 20 Hz wait),
//!   landing recovery (briefly weaker ground acceleration after a hard landing), buoyancy (floats up to the surface), and a
//!   **render-facing step-up offset** (`step_dy`): the physical body pops up in one tick, the published `player` position
//!   eases up (see `Body::visual_pos`).
//! * Sprint is "key held and pushing forward"; a head-on wall hit cancels it for one tick (glancing contact does not).
//! * Not modelled (no such blocks / inputs yet): sneak, ladders, ice / slime slipperiness, status effects, lava.

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};
use sim_core::SIM_DT;
use sim_core::blocks::{self, BlockSource, aabb_sweep};
use sim_core::math::{self, Vec2, Vec3};

/// Rate of the movement model (the spec's "tick"). One 60 Hz simulation step is a third of a tick.
pub const TICK_HZ: f32 = 20.0;
const SUBSTEPS: u8 = 3;
/// Carried vertical velocity (blocks per tick) of a body at rest on the ground: `(0 - g) * drag`.
pub const REST_VY: f32 = -0.0784;
const SKIN: f32 = 1e-3;
/// How long the LAND animation state lasts (s).
const LAND_ANIM_TIME: f32 = 0.18;

macro_rules! tuning {
    ($( $key:ident : $def:expr, $min:expr, $max:expr, $step:expr; )*) => {
        /// Tunable constants (a resource; defaults are the shipped feel). Spec-model constants are per 20 Hz tick
        /// (blocks per tick); times are seconds; `jump_cooldown` is in ticks. Every `f32` field is live-tunable through
        /// the `player.tune` command and listed by the `player.tuning` query (F4 panel).
        #[derive(Resource, Clone, Debug, PartialEq)]
        pub struct PlayerTuning {
            $( pub $key: f32, )*
            /// Number of selectable tools (net, rod, shovel, axe, watering can).
            pub tool_count: u8,
        }

        impl Default for PlayerTuning {
            fn default() -> Self {
                Self { $( $key: $def, )* tool_count: 5 }
            }
        }

        impl PlayerTuning {
            /// `(key, min, max, step)` of every live-tunable constant.
            pub const FIELDS: &'static [(&'static str, f32, f32, f32)] = &[ $( (stringify!($key), $min, $max, $step), )* ];

            pub fn get(&self, key: &str) -> Option<f32> {
                $( if key == stringify!($key) { return Some(self.$key); } )*
                None
            }

            /// Sets a field by name; false = unknown key.
            pub fn set(&mut self, key: &str, value: f32) -> bool {
                $( if key == stringify!($key) { self.$key = value; return true; } )*
                false
            }
        }
    };
}

tuning! {
    // hitbox (feet-centred, axis aligned)
    box_width: 0.5, 0.3, 0.9, 0.01;
    box_height: 1.15, 0.8, 2.0, 0.01;
    // ground / air (spec 3.2): M0, Ksp, Kin, S * 0.91, 0.91, 0.02, g, Dv, J0, SJ, CD, eps_v, step-up
    base_accel: 0.1, 0.03, 0.3, 0.005;
    sprint_mul: 1.3, 1.0, 2.0, 0.01;
    input_scale: 0.98, 0.5, 1.0, 0.01;
    ground_damp: 0.546, 0.2, 0.9, 0.005;
    air_damp: 0.91, 0.5, 0.99, 0.005;
    air_accel: 0.02, 0.0, 0.1, 0.001;
    gravity: 0.08, 0.03, 0.2, 0.001;
    drag_v: 0.98, 0.9, 1.0, 0.001;
    jump_impulse: 0.42, 0.2, 0.7, 0.005;
    sprint_jump_boost: 0.2, 0.0, 0.5, 0.005;
    jump_cooldown: 10.0, 0.0, 20.0, 1.0;
    rest_threshold: 0.003, 0.0, 0.02, 0.0005;
    step_height: 1.0, 0.0, 1.2, 0.05;
    // fluids (spec 4): acceleration, damping (also vertical), sprint-swim damping, sink (spec 0.02; floatier here),
    // jump-in-water push, buoyancy (+ the immersion at which it balances), exit kick
    water_accel: 0.02, 0.005, 0.1, 0.001;
    water_damp: 0.8, 0.3, 0.98, 0.01;
    swim_sprint_damp: 0.9, 0.3, 0.98, 0.01;
    water_sink: 0.006, 0.0, 0.05, 0.001;
    water_jump: 0.04, 0.0, 0.1, 0.002;
    buoyancy: 0.05, 0.0, 0.2, 0.005;
    swim_float: 0.8, 0.2, 1.1, 0.05;
    exit_kick: 0.3, 0.0, 0.6, 0.01;
    // polish
    coyote_time: 0.1, 0.0, 0.3, 0.01;
    jump_buffer_time: 0.1, 0.0, 0.3, 0.01;
    land_recovery_time: 0.2, 0.0, 0.6, 0.01;
    land_recovery_speed: 0.55, 0.2, 1.5, 0.01;
    land_accel_scale: 0.55, 0.1, 1.0, 0.01;
    step_smooth_rate: 14.0, 2.0, 40.0, 0.5;
    // presentation
    turn_rate: 14.0, 2.0, 40.0, 0.5;
    land_event_speed: 3.0, 0.0, 15.0, 0.5;
}

impl PlayerTuning {
    /// Steady walking speed on flat ground (m/s): `M0 * Kin / (1 - F) * 20` = 4.317 with the defaults.
    pub fn walk_speed(&self) -> f32 {
        self.base_accel * self.input_scale / (1.0 - self.ground_damp) * TICK_HZ
    }

    /// Steady sprinting speed on flat ground (m/s): 5.612 with the defaults.
    pub fn sprint_speed(&self) -> f32 {
        self.walk_speed() * self.sprint_mul
    }

    /// The spec's reference setup: 0.6 x 1.8 box, 0.6 step-up, spec water sink, no polish. Used by the test vectors.
    pub fn spec() -> Self {
        Self {
            box_width: 0.6,
            box_height: 1.8,
            step_height: 0.6,
            water_sink: 0.02,
            buoyancy: 0.0,
            coyote_time: 0.0,
            jump_buffer_time: 0.0,
            land_accel_scale: 1.0,
            ..Self::default()
        }
    }
}

/// Animation state ids (channel `player` column 7). The characters/web side maps them to clips.
pub mod anim {
    pub const IDLE: u8 = 0;
    pub const WALK: u8 = 1;
    pub const RUN: u8 = 2;
    /// Rising part of a jump.
    pub const JUMP: u8 = 3;
    pub const FALL: u8 = 4;
    /// Short squash after landing from a real fall.
    pub const LAND: u8 = 5;
    pub const SWIM_IDLE: u8 = 6;
    pub const SWIM: u8 = 7;
    /// Reserved (the voxel controller never slides).
    pub const SLIDE: u8 = 8;
}

/// Everything the controller integrates (also the save payload of the player body).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Body {
    /// Feet centre (physical position).
    pub pos: Vec3,
    /// Visible velocity (m/s): displacement of the latest 60 Hz step, step-ups excluded from the vertical part.
    pub vel: Vec3,
    pub yaw: f32,
    /// Standing on something this step (render / animation flag; the physics flag is `on_ground`).
    pub grounded: bool,
    pub swimming: bool,
    /// Always false in the voxel controller (kept for save / API compatibility).
    pub sliding: bool,
    pub coyote: f32,
    pub jump_buffer: f32,
    pub land_timer: f32,
    /// Distance walked since the last footstep event.
    pub stride: f32,
    pub anim_state: u8,
    pub anim_t: f32,
    /// Water above the feet (m), 0 when dry.
    pub water_depth: f32,
    pub speed01: f32,
    // --- movement model state ------------------------------------------------------------------------
    /// Carried velocity of the model, blocks per tick.
    pub v: Vec3,
    /// The spec's `onGround`: set by the previous tick's move (true if the downward move was cut short).
    pub on_ground: bool,
    pub cooldown: u8,
    /// Sub-step inside the current tick (0, 1, 2).
    pub sub: u8,
    pub sprinting: bool,
    pub sprint_cancel: bool,
    pub press_latch: bool,
    // latched at the start of the current tick
    pub tick_water: bool,
    pub tick_ground0: bool,
    pub tick_idle: bool,
    pub tick_speed_in: f32,
    // collected during the current tick
    pub tick_hit: [bool; 3],
    pub tick_ground: bool,
    /// Seconds of landing recovery left.
    pub recover: f32,
    /// Render-facing vertical offset (<= 0 after a step-up, decays to 0): published y = `pos.y + step_dy`.
    pub step_dy: f32,
}

impl Body {
    pub fn new(pos: Vec3, yaw: f32) -> Self {
        Self {
            pos,
            vel: Vec3::ZERO,
            yaw,
            grounded: true,
            swimming: false,
            sliding: false,
            coyote: 0.0,
            jump_buffer: 0.0,
            land_timer: 0.0,
            stride: 0.0,
            anim_state: anim::IDLE,
            anim_t: 0.0,
            water_depth: 0.0,
            speed01: 0.0,
            v: Vec3::new(0.0, REST_VY, 0.0),
            on_ground: true,
            cooldown: 0,
            sub: 0,
            sprinting: false,
            sprint_cancel: false,
            press_latch: false,
            tick_water: false,
            tick_ground0: true,
            tick_idle: false,
            tick_speed_in: 0.0,
            tick_hit: [false; 3],
            tick_ground: false,
            recover: 0.0,
            step_dy: 0.0,
        }
    }

    /// Position the renderer should use (physical position plus the step-up easing offset).
    pub fn visual_pos(&self) -> Vec3 {
        Vec3::new(self.pos.x, self.pos.y + self.step_dy, self.pos.z)
    }

    /// Forget all motion (teleport / respawn): the caller sets `pos`, `on_ground`, `grounded`, `swimming` afterwards.
    pub fn reset_motion(&mut self) {
        self.v = Vec3::new(0.0, REST_VY, 0.0);
        self.vel = Vec3::ZERO;
        self.cooldown = 0;
        self.sub = 0;
        self.sprinting = false;
        self.sprint_cancel = false;
        self.press_latch = false;
        self.tick_idle = false;
        self.tick_hit = [false; 3];
        self.tick_ground = false;
        self.recover = 0.0;
        self.step_dy = 0.0;
        self.coyote = 0.0;
        self.jump_buffer = 0.0;
        self.land_timer = 0.0;
        self.stride = 0.0;
        self.sliding = false;
    }
}

/// One step of player intent (derived from `Input`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Intent {
    /// Stick/keys: `x` strafe (right +), `y` forward (+), length <= 1.
    pub move_vec: Vec2,
    pub camera_yaw: f32,
    /// Sprint key held.
    pub sprint: bool,
    /// Jump key held (holding jumps again as soon as the cooldown allows).
    pub jump_held: bool,
    /// Jump went down since the previous step (latched edge).
    pub jump_pressed: bool,
}

/// Playable area (feet centre must keep the box inside).
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

impl Bounds {
    pub const UNBOUNDED: Bounds = Bounds { min_x: -1.0e9, min_z: -1.0e9, max_x: 1.0e9, max_z: 1.0e9 };
}

/// Things that happened during a step (turned into `EventBus` events by the system).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Happened {
    Jump,
    Land { impact: f32 },
    Splash { impact: f32 },
    /// `biome` is filled in by the system (the controller knows blocks, not biomes).
    Footstep { biome: u8 },
}

// --- box helpers -----------------------------------------------------------------------------------------

#[inline]
fn half(t: &PlayerTuning) -> f32 {
    t.box_width * 0.5
}

#[inline]
fn bmin(p: Vec3, t: &PlayerTuning) -> [f32; 3] {
    [p.x - half(t), p.y, p.z - half(t)]
}

#[inline]
fn bsize(t: &PlayerTuning) -> [f32; 3] {
    [t.box_width, t.box_height, t.box_width]
}

/// True if any block cell overlapped by the box (shrunk by `SKIN`) satisfies `pred`.
fn any_cell(world: &dyn BlockSource, min: [f32; 3], size: [f32; 3], pred: fn(blocks::BlockId) -> bool) -> bool {
    let lo = [(min[0] + SKIN).floor() as i32, (min[1] + SKIN).floor() as i32, (min[2] + SKIN).floor() as i32];
    let hi = [(min[0] + size[0] - SKIN).floor() as i32, (min[1] + size[1] - SKIN).floor() as i32, (min[2] + size[2] - SKIN).floor() as i32];
    for y in lo[1]..=hi[1] {
        for z in lo[2]..=hi[2] {
            for x in lo[0]..=hi[0] {
                if pred(world.block(x, y, z)) {
                    return true;
                }
            }
        }
    }
    false
}

/// Sweeps the box along one axis; returns the new feet position and whether a block stopped it.
fn sweep1(world: &dyn BlockSource, p: Vec3, axis: usize, delta: f32, t: &PlayerTuning) -> (Vec3, bool) {
    if delta == 0.0 {
        return (p, false);
    }
    let mut d = [0.0f32; 3];
    d[axis] = delta;
    let r = aabb_sweep(world, bmin(p, t), bsize(t), d);
    let mut out = p;
    out[axis] = if axis == 1 { r.pos[1] } else { r.pos[axis] + half(t) };
    (out, r.hit[axis])
}

/// Y first, then the horizontal axis with the larger |delta| first (spec 3.5).
fn slide(world: &dyn BlockSource, p: Vec3, d: Vec3, t: &PlayerTuning) -> (Vec3, [bool; 3]) {
    let mut p = p;
    let mut hit = [false; 3];
    let (np, h) = sweep1(world, p, 1, d.y, t);
    p = np;
    hit[1] = h;
    let order = if d.x.abs() >= d.z.abs() { [0usize, 2] } else { [2usize, 0] };
    for axis in order {
        let (np, h) = sweep1(world, p, axis, d[axis], t);
        p = np;
        hit[axis] = h;
    }
    (p, hit)
}

struct Moved {
    pos: Vec3,
    hit: [bool; 3],
    /// Height gained by a step-up in this move (0 = none).
    stepped: f32,
}

/// One collision-checked move with step-up: if a horizontal axis is blocked and the body was standing, retry from
/// the start raised by up to `step_height`, move horizontally, lower back to the first support, and keep that result
/// when it covers more horizontal distance than the plain slide (spec 3.5).
fn move_box(world: &dyn BlockSource, p0: Vec3, d: Vec3, can_step: bool, t: &PlayerTuning) -> Moved {
    let (p1, hit1) = slide(world, p0, d, t);
    if can_step && t.step_height > 0.0 && d.y <= 0.0 && (hit1[0] || hit1[2]) {
        let (pu, _) = sweep1(world, p0, 1, t.step_height, t);
        let raised = pu.y - p0.y;
        if raised > 1e-4 {
            let (ph, hith) = slide(world, pu, Vec3::new(d.x, 0.0, d.z), t);
            let (pd, hitd) = sweep1(world, ph, 1, -(raised - d.y), t);
            let moved_plain = (p1.x - p0.x) * (p1.x - p0.x) + (p1.z - p0.z) * (p1.z - p0.z);
            let moved_step = (pd.x - p0.x) * (pd.x - p0.x) + (pd.z - p0.z) * (pd.z - p0.z);
            if hitd && moved_step > moved_plain + 1e-8 && pd.y > p0.y + 1e-4 {
                return Moved { pos: pd, hit: [hith[0], true, hith[2]], stepped: pd.y - p0.y };
            }
        }
    }
    Moved { pos: p1, hit: hit1, stepped: 0.0 }
}

struct Fluid {
    in_water: bool,
    /// Water above the feet (m): surface height minus feet height.
    immersion: f32,
}

fn fluid_state(world: &dyn BlockSource, pos: Vec3, t: &PlayerTuning) -> Fluid {
    if !any_cell(world, bmin(pos, t), bsize(t), blocks::is_liquid) {
        return Fluid { in_water: false, immersion: 0.0 };
    }
    let xi = pos.x.floor() as i32;
    let zi = pos.z.floor() as i32;
    let lo = (pos.y + SKIN).floor() as i32;
    let hi = (pos.y + t.box_height - SKIN).floor() as i32;
    let mut found = None;
    for cy in lo..=hi {
        if blocks::is_liquid(world.block(xi, cy, zi)) {
            found = Some(cy);
            break;
        }
    }
    let Some(mut cy) = found else {
        return Fluid { in_water: true, immersion: 0.0 };
    };
    let cap = cy + 64;
    while cy < cap && blocks::is_liquid(world.block(xi, cy + 1, zi)) {
        cy += 1;
    }
    Fluid { in_water: true, immersion: ((cy + 1) as f32 - pos.y).max(0.0) }
}

// --- the step --------------------------------------------------------------------------------------------

/// Advances `b` by one 60 Hz simulation step.
pub fn step(b: &mut Body, i: &Intent, world: &dyn BlockSource, bounds: &Bounds, t: &PlayerTuning, out: &mut Vec<Happened>) {
    let dt = SIM_DT;

    // input latches and timers (60 Hz)
    b.press_latch |= i.jump_pressed;
    b.jump_buffer = if i.jump_pressed { t.jump_buffer_time } else { (b.jump_buffer - dt).max(0.0) };
    b.coyote = if b.on_ground { t.coyote_time } else { (b.coyote - dt).max(0.0) };
    b.recover = (b.recover - dt).max(0.0);

    // starting from rest: restart the 20 Hz phase now instead of waiting up to two steps for the next boundary
    let wants = i.move_vec.length_squared() > 0.0025 || i.jump_held || i.jump_pressed;
    if b.sub != 0 && wants && b.tick_idle && b.on_ground && b.v.x == 0.0 && b.v.z == 0.0 {
        b.v.y = REST_VY;
        b.sub = 0;
    }
    if b.sub == 0 {
        begin_tick(b, i, world, t, out);
    }
    sub_move(b, world, bounds, t, out);
    b.sub += 1;
    if b.sub >= SUBSTEPS {
        end_tick(b, world, t);
        b.sub = 0;
    }
    presentation(b, i, t, out);
}

/// Spec 3.3 steps 1-6: cooldown, rest threshold, jump, intent, acceleration.
fn begin_tick(b: &mut Body, i: &Intent, world: &dyn BlockSource, t: &PlayerTuning, out: &mut Vec<Happened>) {
    // a block appeared on the player (edit) or a spawn inside foliage: rise until free
    if any_cell(world, bmin(b.pos, t), bsize(t), blocks::is_solid) {
        for _ in 0..16 {
            b.pos.y += 0.25;
            if !any_cell(world, bmin(b.pos, t), bsize(t), blocks::is_solid) {
                break;
            }
        }
        b.v.y = 0.0;
    }

    b.cooldown = b.cooldown.saturating_sub(1);
    for c in [&mut b.v.x, &mut b.v.y, &mut b.v.z] {
        if c.abs() < t.rest_threshold {
            *c = 0.0;
        }
    }

    let fl = fluid_state(world, b.pos, t);
    let was_water = b.tick_water;
    b.tick_water = fl.in_water;
    if fl.in_water && !was_water && b.v.y < -0.1 {
        out.push(Happened::Splash { impact: -b.v.y * TICK_HZ });
    }
    b.water_depth = fl.immersion;
    let g0 = b.on_ground;
    b.tick_ground0 = g0;
    b.tick_hit = [false; 3];
    b.tick_ground = false;

    b.sprinting = i.sprint && i.move_vec.y > 0.05 && !b.sprint_cancel;
    b.sprint_cancel = false;

    // intent vector (camera relative): length <= 1, diagonal pairs are not faster
    let fwd = math::camera_forward(i.camera_yaw);
    let right = math::camera_right(i.camera_yaw);
    let sx = i.move_vec.x * t.input_scale;
    let fz = i.move_vec.y * t.input_scale;
    let m = (sx * sx + fz * fz).sqrt();
    let (sx, fz) = if m < 1e-4 {
        (0.0, 0.0)
    } else if m > 1.0 {
        (sx / m, fz / m)
    } else {
        (sx, fz)
    };

    // jump (spec step 3 + coyote time + buffer)
    let held = i.jump_held || b.press_latch;
    b.press_latch = false;
    if !held {
        b.cooldown = 0;
    }
    let want = held || b.jump_buffer > 0.0;
    b.tick_idle = sx == 0.0 && fz == 0.0 && !want && g0 && !fl.in_water;
    if fl.in_water {
        if held {
            b.v.y += t.water_jump;
        } else if fl.immersion > t.swim_float {
            b.v.y += t.buoyancy * (fl.immersion - t.swim_float).min(1.0);
        }
    } else if want && (g0 || b.coyote > 0.0) && b.cooldown == 0 {
        b.v.y = t.jump_impulse;
        if b.sprinting {
            b.v.x += fwd.x * t.sprint_jump_boost;
            b.v.z += fwd.z * t.sprint_jump_boost;
        }
        b.cooldown = t.jump_cooldown as u8;
        b.jump_buffer = 0.0;
        b.coyote = 0.0;
        b.grounded = false;
        out.push(Happened::Jump);
    }

    // acceleration (spec step 5)
    let sprint_k = if b.sprinting { t.sprint_mul } else { 1.0 };
    let mut a = if fl.in_water {
        t.water_accel
    } else if g0 {
        t.base_accel * sprint_k
    } else {
        t.air_accel * sprint_k
    };
    if g0 && !fl.in_water && t.land_recovery_time > 0.0 {
        let r = (b.recover / t.land_recovery_time).clamp(0.0, 1.0);
        a *= 1.0 - (1.0 - t.land_accel_scale) * r;
    }
    b.v.x += a * (right.x * sx + fwd.x * fz);
    b.v.z += a * (right.z * sx + fwd.z * fz);
    b.tick_speed_in = (b.v.x * b.v.x + b.v.z * b.v.z).sqrt();
}

/// Spec step 7, one third of the tick's displacement.
fn sub_move(b: &mut Body, world: &dyn BlockSource, bounds: &Bounds, t: &PlayerTuning, out: &mut Vec<Happened>) {
    let k = 1.0 / f32::from(SUBSTEPS);
    let d = Vec3::new(b.v.x * k, b.v.y * k, b.v.z * k);
    let before = b.pos;
    let can_step = b.tick_ground0 && !b.tick_water;
    let m = move_box(world, before, d, can_step, t);
    b.pos = m.pos;

    let fall = -b.v.y; // blocks per tick, > 0 while falling
    for a in 0..3 {
        if m.hit[a] {
            b.tick_hit[a] = true;
            b.v[a] = 0.0;
        }
    }
    if m.hit[1] && d.y < 0.0 {
        b.tick_ground = true;
        if !b.grounded {
            let impact = fall * TICK_HZ;
            if impact > t.land_event_speed {
                out.push(Happened::Land { impact });
                b.land_timer = LAND_ANIM_TIME;
            }
            if fall > t.land_recovery_speed {
                b.recover = t.land_recovery_time * ((fall - t.land_recovery_speed) / 0.6).clamp(0.3, 1.0);
            }
        }
        b.grounded = true;
    } else if d.y.abs() > 1e-6 {
        b.grounded = false;
    }
    if m.stepped > 0.0 {
        b.step_dy = (b.step_dy - m.stepped).max(-1.5);
    }

    // the world edge is a wall
    let hw = half(t);
    let lo_x = bounds.min_x + hw;
    let hi_x = (bounds.max_x - hw).max(lo_x);
    let lo_z = bounds.min_z + hw;
    let hi_z = (bounds.max_z - hw).max(lo_z);
    if b.pos.x < lo_x {
        b.pos.x = lo_x;
        b.v.x = 0.0;
    } else if b.pos.x > hi_x {
        b.pos.x = hi_x;
        b.v.x = 0.0;
    }
    if b.pos.z < lo_z {
        b.pos.z = lo_z;
        b.v.z = 0.0;
    } else if b.pos.z > hi_z {
        b.pos.z = hi_z;
        b.v.z = 0.0;
    }

    let inv = 1.0 / SIM_DT;
    b.vel = Vec3::new((b.pos.x - before.x) * inv, if m.stepped > 0.0 { 0.0 } else { (b.pos.y - before.y) * inv }, (b.pos.z - before.z) * inv);
}

/// Spec steps 9-11: damping, fluid exit kick, ground flag.
fn end_tick(b: &mut Body, world: &dyn BlockSource, t: &PlayerTuning) {
    let hs_after = (b.v.x * b.v.x + b.v.z * b.v.z).sqrt();
    let hit_h = b.tick_hit[0] || b.tick_hit[2];
    // head-on wall hit cancels the sprint for the next tick; glancing contact (most speed kept) does not
    if b.sprinting && hit_h && b.tick_speed_in > 1e-4 && hs_after < 0.9 * b.tick_speed_in {
        b.sprint_cancel = true;
    }

    if b.tick_water {
        b.v.y = t.water_damp * b.v.y - t.water_sink;
        let d = if b.sprinting { t.swim_sprint_damp } else { t.water_damp };
        b.v.x *= d;
        b.v.z *= d;
    } else {
        b.v.y = (b.v.y - t.gravity) * t.drag_v;
        let d = if b.tick_ground0 { t.ground_damp } else { t.air_damp };
        b.v.x *= d;
        b.v.z *= d;
    }

    // pushing into a block while the body could clear the water by rising ~0.6: kick up out of the water
    if b.tick_water && hit_h {
        let probe = Vec3::new(b.pos.x + b.v.x, b.pos.y + 0.6, b.pos.z + b.v.z);
        if !any_cell(world, bmin(probe, t), bsize(t), blocks::is_solid) && !any_cell(world, bmin(probe, t), bsize(t), blocks::is_liquid) {
            b.v.y = t.exit_kick;
        }
    }
    b.on_ground = b.tick_ground;
}

/// Per 60 Hz step: step-up easing, footsteps, facing, animation state.
fn presentation(b: &mut Body, i: &Intent, t: &PlayerTuning, out: &mut Vec<Happened>) {
    let dt = SIM_DT;
    b.step_dy -= b.step_dy * math::damp_factor(t.step_smooth_rate, dt);
    if b.step_dy.abs() < 1e-4 {
        b.step_dy = 0.0;
    }
    let hs = (b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt();
    b.swimming = b.tick_water && b.water_depth > 0.55;

    if b.grounded && !b.tick_water && hs > 0.5 {
        b.stride += hs * dt;
        let len = if b.sprinting { 2.1 } else { 1.4 };
        if b.stride >= len {
            b.stride -= len;
            out.push(Happened::Footstep { biome: 0 });
        }
    } else {
        b.stride = 0.0;
    }

    // avatar facing: toward the intended direction, else along the motion
    let wish = math::camera_right(i.camera_yaw) * i.move_vec.x + math::camera_forward(i.camera_yaw) * i.move_vec.y;
    let wl = (wish.x * wish.x + wish.z * wish.z).sqrt();
    let face = if wl > 0.05 {
        Some(Vec3::new(wish.x / wl, 0.0, wish.z / wl))
    } else if hs > 0.5 {
        Some(Vec3::new(b.vel.x / hs, 0.0, b.vel.z / hs))
    } else {
        None
    };
    if let Some(d) = face {
        let want = math::dir_to_yaw(d);
        b.yaw = math::wrap_pi(b.yaw + math::angle_diff(b.yaw, want) * math::damp_factor(t.turn_rate, dt));
    }

    b.land_timer = (b.land_timer - dt).max(0.0);
    let state = if b.swimming {
        if hs > 0.3 { anim::SWIM } else { anim::SWIM_IDLE }
    } else if !b.grounded {
        if b.v.y > 0.0 { anim::JUMP } else { anim::FALL }
    } else if b.land_timer > 0.0 {
        anim::LAND
    } else if hs > t.walk_speed() * 1.15 {
        anim::RUN
    } else if hs > 0.3 {
        anim::WALK
    } else {
        anim::IDLE
    };
    if state != b.anim_state {
        b.anim_state = state;
        b.anim_t = 0.0;
    } else {
        b.anim_t += dt;
    }
    b.speed01 = math::clamp01(hs / t.sprint_speed());
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::blocks::{BlockId, id};

    struct W<F: Fn(i32, i32, i32) -> BlockId + Send + Sync>(F);
    impl<F: Fn(i32, i32, i32) -> BlockId + Send + Sync> BlockSource for W<F> {
        fn block(&self, x: i32, y: i32, z: i32) -> BlockId {
            (self.0)(x, y, z)
        }
    }

    /// Infinite floor, top at y = 0.
    fn floor() -> impl BlockSource {
        W(|_, y, _| if y < 0 { id::STONE } else { id::AIR })
    }

    /// The spec's frame: forward = +Z (camera yaw PI), strafe +1 = left = +X.
    const YAW: f32 = math::PI;

    #[derive(Clone, Copy, Default)]
    struct K {
        fwd: f32,
        strafe: f32,
        sprint: bool,
        jump: bool,
    }
    const FWD: K = K { fwd: 1.0, strafe: 0.0, sprint: false, jump: false };
    const SPR: K = K { fwd: 1.0, strafe: 0.0, sprint: true, jump: false };
    const NONE: K = K { fwd: 0.0, strafe: 0.0, sprint: false, jump: false };

    /// Spec-model test rig: one `tick` = three 60 Hz steps with the same keys.
    struct Rig {
        b: Body,
        t: PlayerTuning,
        prev_jump: bool,
        ev: Vec<Happened>,
        bounds: Bounds,
    }

    impl Rig {
        fn new(x: f32, y: f32, z: f32) -> Self {
            Rig { b: Body::new(Vec3::new(x, y, z), 0.0), t: PlayerTuning::spec(), prev_jump: false, ev: Vec::new(), bounds: Bounds::UNBOUNDED }
        }
        fn air(mut self) -> Self {
            self.b.on_ground = false;
            self.b.grounded = false;
            self.b.v = Vec3::ZERO;
            self
        }
        fn tick(&mut self, w: &dyn BlockSource, k: K) -> Vec3 {
            let start = self.b.pos;
            for _ in 0..3 {
                let i = Intent { move_vec: Vec2::new(-k.strafe, k.fwd), camera_yaw: YAW, sprint: k.sprint, jump_held: k.jump, jump_pressed: k.jump && !self.prev_jump };
                self.prev_jump = k.jump;
                step(&mut self.b, &i, w, &self.bounds, &self.t, &mut self.ev);
            }
            self.b.pos - start
        }
        fn jumps(&self) -> usize {
            self.ev.iter().filter(|e| matches!(e, Happened::Jump)).count()
        }
    }

    fn near(got: f32, want: f32, tol: f32, what: &str) {
        assert!((got - want).abs() <= tol, "{what}: got {got}, want {want} (tol {tol})");
    }

    fn dz_series(k: K, n: usize) -> Vec<(f32, f32)> {
        let w = floor();
        let mut r = Rig::new(0.0, 0.0, 0.0);
        (0..n)
            .map(|_| {
                let d = r.tick(&w, k);
                (d.z, r.b.v.z)
            })
            .collect()
    }

    // --- spec test vectors -------------------------------------------------------------------------------

    #[test]
    fn tv01_free_fall() {
        let w = W(|_, _, _| id::AIR);
        let mut r = Rig::new(0.0, 10.0, 0.0).air();
        let want = [(1, 10.0, -0.0784), (2, 9.9216, -0.155232), (3, 9.766368, -0.230527), (4, 9.535841, -0.304317), (5, 9.231524, -0.376630), (6, 8.854893, -0.447498), (10, 6.653730, -0.717075), (20, -3.251162, -1.302977)];
        let mut t = 0;
        for (tick, y, vy) in want {
            while t < tick {
                r.tick(&w, NONE);
                t += 1;
            }
            near(r.b.pos.y, y, 5e-5, &format!("y@{tick}"));
            near(r.b.v.y, vy, 5e-5, &format!("vy@{tick}"));
        }
    }

    #[test]
    fn tv02_jump_from_rest() {
        let w = floor();
        let mut r = Rig::new(0.0, 0.0, 0.0);
        let want = [(0.42, 0.3332), (0.7532, 0.248136), (1.001336, 0.164773), (1.166109, 0.083078), (1.249187, 0.003016), (1.252203, -0.075444), (1.176759, -0.152335), (1.024424, -0.227688), (0.796736, -0.301535), (0.495201, -0.373904), (0.121297, -0.444826)];
        for (n, (y, vy)) in want.iter().enumerate() {
            r.tick(&w, K { jump: n == 0, ..NONE });
            near(r.b.pos.y, *y, 5e-5, &format!("y@{}", n + 1));
            near(r.b.v.y, *vy, 5e-5, &format!("vy@{}", n + 1));
            assert!(!r.b.on_ground, "airborne at tick {}", n + 1);
        }
        r.tick(&w, NONE);
        near(r.b.pos.y, 0.0, 3e-3, "landed");
        near(r.b.v.y, REST_VY, 1e-4, "vy after landing");
        assert!(r.b.on_ground, "landing on tick 12");
        assert_eq!(r.jumps(), 1);
    }

    #[test]
    fn tv03_walk() {
        let want = [(0.098, 0.053508), (0.151508, 0.082723), (0.180723, 0.098675), (0.196675, 0.107385), (0.205385, 0.112140), (0.210140, 0.114736), (0.212736, 0.116154), (0.214154, 0.116928)];
        for (n, (dz, vz)) in dz_series(FWD, 8).iter().enumerate() {
            near(*dz, want[n].0, 3e-5, &format!("walk dz@{}", n + 1));
            near(*vz, want[n].1, 3e-5, &format!("walk vz@{}", n + 1));
        }
    }

    #[test]
    fn tv04_sprint() {
        let want = [(0.127400, 0.069560), (0.196960, 0.107540), (0.234940, 0.128277), (0.255677, 0.139600), (0.267000, 0.145782), (0.273182, 0.149157), (0.276557, 0.151000), (0.278400, 0.152007)];
        for (n, (dz, vz)) in dz_series(SPR, 8).iter().enumerate() {
            near(*dz, want[n].0, 3e-5, &format!("sprint dz@{}", n + 1));
            near(*vz, want[n].1, 3e-5, &format!("sprint vz@{}", n + 1));
        }
    }

    #[test]
    fn tv06_diagonal() {
        let w = floor();
        let walk = [0.070711, 0.109319, 0.130399, 0.141908, 0.148193, 0.151624, 0.153497, 0.154520];
        let sprint = [0.091924, 0.142114, 0.169518, 0.184481, 0.192650, 0.197111, 0.199546, 0.200876];
        for (k, want) in [(K { fwd: 1.0, strafe: 1.0, ..NONE }, walk), (K { fwd: 1.0, strafe: 1.0, sprint: true, jump: false }, sprint)] {
            let mut r = Rig::new(0.0, 0.0, 0.0);
            for (n, w_) in want.iter().enumerate() {
                let d = r.tick(&w, k);
                near(d.x, *w_, 3e-5, &format!("diag dx@{}", n + 1));
                near(d.z, *w_, 3e-5, &format!("diag dz@{}", n + 1));
            }
        }
    }

    #[test]
    fn tv07_steady_displacements() {
        let w = floor();
        let steady = |k: K| {
            let mut r = Rig::new(0.0, 0.0, 0.0);
            let mut d = Vec3::ZERO;
            for _ in 0..400 {
                d = r.tick(&w, k);
            }
            (d.x * d.x + d.z * d.z).sqrt()
        };
        near(steady(FWD), 0.2158590, 2e-5, "walk");
        near(steady(SPR), 0.2806167, 2e-5, "sprint");
        near(steady(K { fwd: 1.0, strafe: 1.0, ..NONE }), 0.2202643, 2e-5, "walk diag");
        near(steady(K { fwd: 1.0, strafe: 1.0, sprint: true, jump: false }), 0.2863436, 2e-5, "sprint diag");
        let sky = W(|_, _, _| id::AIR);
        for (k, want, name) in [(FWD, 0.2177778, "air walk"), (SPR, 0.2831111, "air sprint")] {
            let mut r = Rig::new(0.0, 5000.0, 0.0).air();
            let mut d = Vec3::ZERO;
            for _ in 0..400 {
                d = r.tick(&sky, k);
            }
            near(d.z, want, 2e-5, name);
        }
    }

    #[test]
    fn tv08_release_decay() {
        let w = floor();
        let mut r = Rig::new(0.0, 0.0, 0.0);
        for _ in 0..400 {
            r.tick(&w, SPR);
        }
        let want = [0.153217, 0.083656, 0.045676, 0.024939, 0.013617, 0.007435, 0.004059, 0.0];
        let mut total = 0.0;
        for (n, w_) in want.iter().enumerate() {
            let d = r.tick(&w, NONE);
            near(d.z, *w_, 3e-5, &format!("release dz@{}", n + 1));
            total += d.z;
        }
        near(total, 0.3326, 1e-4, "stop distance");
    }

    #[test]
    fn tv09_sprint_jump() {
        let w = floor();
        let cases: [(usize, [f32; 14], f32); 2] = [
            (200, [0.480617, 0.287897, 0.287466, 0.287074, 0.286717, 0.286393, 0.286097, 0.285829, 0.285584, 0.285362, 0.285159, 0.284975, 0.386727, 0.338553], 3.629170),
            (0, [0.327400, 0.204240, 0.211339, 0.217798, 0.223676, 0.229026, 0.233893, 0.238323, 0.242354, 0.246022, 0.249360, 0.252398, 0.357082, 0.322367], 2.875829),
        ];
        for (warm, want, dist) in cases {
            let mut r = Rig::new(0.0, 0.0, 0.0);
            for _ in 0..warm {
                r.tick(&w, SPR);
            }
            let mut total = 0.0;
            for (n, w_) in want.iter().enumerate() {
                let d = r.tick(&w, K { jump: n == 0, ..SPR });
                near(d.z, *w_, 1e-4, &format!("sprint-jump (warm {warm}) dz@{}", n + 1));
                if n < 12 {
                    total += d.z;
                }
                if n == 11 {
                    assert!(r.b.on_ground, "landed on tick 12");
                }
            }
            near(total, dist, 3e-4, "sprint-jump distance");
        }
    }

    #[test]
    fn tv10_bunny_hop() {
        let w = floor();
        let mut r = Rig::new(0.0, 0.0, 0.0);
        let mut dz = Vec::new();
        for _ in 0..200 {
            dz.push(r.tick(&w, K { jump: true, ..SPR }).z);
        }
        assert_eq!(r.jumps(), 17, "jumps on ticks 1, 13, 25, ... 193");
        let avg: f32 = dz[96..144].iter().sum::<f32>() / 48.0;
        near(avg, 0.3563383, 1e-4, "average per tick (7.127 m/s)");
        let cycle = [0.612183, 0.359732, 0.352836, 0.346561, 0.340850, 0.335654, 0.330925, 0.326622, 0.322706, 0.319142, 0.315899, 0.312949];
        for (n, c) in cycle.iter().enumerate() {
            near(dz[96 + n], *c, 1e-4, &format!("hop cycle dz@{n}"));
        }
    }

    fn jump_ticks(w: &dyn BlockSource, ticks: usize, keys: impl Fn(usize) -> K) -> Vec<usize> {
        let mut r = Rig::new(0.0, 0.0, 0.0);
        let mut at = Vec::new();
        for t in 1..=ticks {
            let before = r.jumps();
            r.tick(w, keys(t));
            if r.jumps() > before {
                at.push(t);
            }
        }
        at
    }

    #[test]
    fn tv11_jump_cooldown() {
        let flat = floor();
        assert_eq!(jump_ticks(&flat, 60, |_| K { jump: true, ..NONE }), vec![1, 13, 25, 37, 49]);
        let low = W(|_, y, _| if y < 0 || y == 2 { id::STONE } else { id::AIR });
        assert_eq!(jump_ticks(&low, 60, |_| K { jump: true, ..NONE }), vec![1, 11, 21, 31, 41, 51]);
        assert_eq!(jump_ticks(&flat, 30, |t| K { jump: matches!(t, 1..=3 | 5 | 6), ..NONE }), vec![1]);
        assert_eq!(jump_ticks(&flat, 30, |t| K { jump: matches!(t, 1 | 13 | 14), ..NONE }), vec![1, 13]);
    }

    #[test]
    fn tv12_head_bump() {
        let w = W(|_, y, _| if y < 0 || y == 2 { id::STONE } else { id::AIR });
        let mut r = Rig::new(0.0, 0.0, 0.0);
        r.tick(&w, K { jump: true, ..NONE });
        near(r.b.pos.y, 0.2, 3e-3, "y@1");
        near(r.b.v.y, -0.0784, 1e-4, "vy@1");
        assert!(!r.b.on_ground);
        r.tick(&w, NONE);
        near(r.b.pos.y, 0.1216, 3e-3, "y@2");
        near(r.b.v.y, -0.155232, 1e-4, "vy@2");
        r.tick(&w, NONE);
        near(r.b.pos.y, 0.0, 3e-3, "y@3");
        assert!(r.b.on_ground, "g@3");
    }

    /// TV-13 adapted: blocks are full cubes, so the obstacle is 1.0 high (spec: "h = 1.0: never steps, z stops at 0.7").
    #[test]
    fn tv13_step_up_and_walls() {
        let w = W(|_, y, z| if y < 0 || (y == 0 && (1..5).contains(&z)) { id::STONE } else { id::AIR });
        // spec step height 0.6: the 1 m block is a wall
        let mut r = Rig::new(0.0, 0.0, 0.0);
        for _ in 0..12 {
            r.tick(&w, FWD);
        }
        near(r.b.pos.z, 0.7, 3e-3, "wall stop (face 1.0 minus half-width 0.3)");
        near(r.b.pos.y, 0.0, 3e-3, "no step");
        near(r.b.v.z, 0.0, 1e-4, "vz zeroed");
        // our default step height 1.0 climbs it in the same tick without losing horizontal speed
        let mut r = Rig::new(0.0, 0.0, 0.0);
        r.t.step_height = 1.0;
        for _ in 0..8 {
            r.tick(&w, FWD);
        }
        near(r.b.pos.z, 1.469321, 1e-3, "free-walk z after 8 ticks (no speed lost)");
        near(r.b.pos.y, 1.0, 3e-3, "stepped onto the block");
        assert!(r.b.on_ground);
    }

    #[test]
    fn tv15_coyote_tick() {
        let w = W(|_, y, z| if y < 0 && z < 0 { id::STONE } else { id::AIR });
        let mut r = Rig::new(0.0, 0.0, 0.25);
        r.b.v.z = 0.2;
        r.tick(&w, NONE);
        near(r.b.pos.z, 0.45, 1e-4, "z@1");
        near(r.b.pos.y, 0.0, 3e-3, "y@1");
        near(r.b.v.y, -0.0784, 1e-4, "vy@1");
        assert!(r.b.on_ground, "still grounded for the tick after walking off");
        let mut c = Rig { b: r.b.clone(), ..Rig::new(0.0, 0.0, 0.0) };
        r.tick(&w, K { jump: true, ..NONE });
        near(r.b.pos.z, 0.5592, 1e-4, "z@2");
        near(r.b.pos.y, 0.42, 1e-4, "y@2");
        near(r.b.v.y, 0.3332, 1e-4, "vy@2");
        assert!(!r.b.on_ground);
        c.tick(&w, NONE);
        near(c.b.pos.y, -0.0784, 1e-4, "control y@2");
        near(c.b.v.y, -0.155232, 1e-4, "control vy@2");
    }

    #[test]
    fn tv16_water_horizontal() {
        let w = W(|_, _, _| id::WATER);
        let cases: [(K, [(f32, f32); 5], f32); 2] = [
            (FWD, [(0.0196, 0.01568), (0.03528, 0.028224), (0.047824, 0.038259), (0.057859, 0.046287), (0.065887, 0.052710)], 0.098),
            (SPR, [(0.0196, 0.01764), (0.03724, 0.033516), (0.053116, 0.047804), (0.067404, 0.060664), (0.080264, 0.072238)], 0.196),
        ];
        for (k, want, steady) in cases {
            let mut r = Rig::new(0.0, 50.0, 0.0).air();
            for (n, (dz, vz)) in want.iter().enumerate() {
                let d = r.tick(&w, k);
                near(d.z, *dz, 3e-5, &format!("water dz@{}", n + 1));
                near(r.b.v.z, *vz, 3e-5, &format!("water vz@{}", n + 1));
            }
            let mut d = Vec3::ZERO;
            for _ in 0..300 {
                d = r.tick(&w, k);
            }
            near(d.z, steady, 3e-5, "water steady");
        }
    }

    #[test]
    fn tv17_water_vertical() {
        let w = W(|_, _, _| id::WATER);
        let mut sink = Rig::new(0.0, 50.0, 0.0).air();
        let dy_want = [0.0, -0.02, -0.056, -0.1048, -0.16384];
        let vy_want = [-0.02, -0.036, -0.0488, -0.05904, -0.067232];
        for n in 0..5 {
            sink.tick(&w, NONE);
            near(sink.b.pos.y - 50.0, dy_want[n], 3e-5, &format!("sink y@{}", n + 1));
            near(sink.b.v.y, vy_want[n], 3e-5, &format!("sink vy@{}", n + 1));
        }
        let mut up = Rig::new(0.0, 50.0, 0.0).air();
        let y_want = [0.04, 0.092, 0.1536, 0.22288, 0.298304];
        let v_want = [0.012, 0.0216, 0.02928, 0.035424, 0.040339];
        for n in 0..5 {
            up.tick(&w, K { jump: true, ..NONE });
            near(up.b.pos.y - 50.0, y_want[n], 3e-5, &format!("rise y@{}", n + 1));
            near(up.b.v.y, v_want[n], 3e-5, &format!("rise vy@{}", n + 1));
        }
        assert_eq!(up.jumps(), 0, "no ground jump in water");
    }

    /// TV-18 adapted to whole blocks: surface at y = 0, wall face at z = 1.0, start 0.05 from the wall.
    #[test]
    fn tv18_fluid_exit_kick() {
        let w = W(|_, y, z| if z >= 1 { id::STONE } else if y == -1 { id::WATER } else { id::AIR });
        let mut r = Rig::new(0.0, -0.5, 0.65).air();
        r.tick(&w, FWD);
        near(r.b.pos.z, 0.6696, 1e-4, "z@1");
        near(r.b.v.y, -0.02, 1e-5, "vy@1");
        assert!(!r.b.tick_hit[2]);
        r.tick(&w, FWD);
        near(r.b.pos.z, 0.7, 3e-3, "z@2 (blocked by the wall)");
        near(r.b.pos.y, -0.52, 1e-4, "y@2");
        near(r.b.v.y, 0.3, 1e-5, "kick vy@2");
        assert!(r.b.tick_hit[2]);
        r.tick(&w, FWD);
        near(r.b.pos.y, -0.22, 1e-4, "y@3 (rises 0.3 per tick while pushing)");
    }

    #[test]
    fn tv21_fall_times() {
        let w = floor();
        for (h, want) in [(1.0, 6), (2.0, 8), (3.0, 10), (4.0, 11), (5.0, 13), (10.0, 18), (20.0, 25), (50.0, 41)] {
            let mut r = Rig::new(0.0, h, 0.0).air();
            let mut ticks = 0;
            while !r.b.on_ground && ticks < 100 {
                r.tick(&w, NONE);
                ticks += 1;
            }
            assert_eq!(ticks, want, "landing tick from {h} m");
        }
    }

    #[test]
    fn tv22_threshold_sensitivity() {
        let w = floor();
        for (eps, want) in [(0.003, 1.252203), (0.005, 1.249187)] {
            let mut r = Rig::new(0.0, 0.0, 0.0);
            r.t.rest_threshold = eps;
            let mut apex = 0.0f32;
            for n in 0..12 {
                r.tick(&w, K { jump: n == 0, ..NONE });
                apex = apex.max(r.b.pos.y);
            }
            near(apex, want, 5e-5, &format!("apex with threshold {eps}"));
        }
    }

    // --- behaviour with the shipped tuning ---------------------------------------------------------------------

    fn go(b: &mut Body, w: &dyn BlockSource, t: &PlayerTuning, i: Intent, steps: usize, out: &mut Vec<Happened>) {
        for _ in 0..steps {
            step(b, &i, w, &Bounds::UNBOUNDED, t, out);
        }
    }

    fn walk(x: f32, y: f32, yaw: f32) -> Intent {
        Intent { move_vec: Vec2::new(x, y), camera_yaw: yaw, ..Default::default() }
    }

    #[test]
    fn standing_still_stays_put_and_idle() {
        let w = floor();
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::new(1.0, 0.0, 2.0), 0.0);
        let mut out = Vec::new();
        go(&mut b, &w, &t, Intent::default(), 120, &mut out);
        assert!(out.is_empty());
        near(b.pos.x, 1.0, 1e-6, "x");
        near(b.pos.y, 0.0, 1e-6, "y");
        near(b.pos.z, 2.0, 1e-6, "z");
        assert_eq!(b.anim_state, anim::IDLE);
        assert!(b.grounded && b.on_ground && !b.swimming);
    }

    #[test]
    fn movement_is_camera_relative() {
        let w = floor();
        let t = PlayerTuning::default();
        let mut out = Vec::new();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, walk(0.0, 1.0, 0.0), 90, &mut out);
        assert!(b.pos.z < -3.0 && b.pos.x.abs() < 1e-3, "{:?}", b.pos);
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, walk(1.0, 0.0, 0.0), 90, &mut out);
        assert!(b.pos.x > 3.0 && b.pos.z.abs() < 1e-3, "{:?}", b.pos);
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, walk(0.0, 1.0, math::PI / 2.0), 90, &mut out);
        assert!(b.pos.x < -3.0 && b.pos.z.abs() < 1e-2, "{:?}", b.pos);
        // facing follows the motion: walking right (+X) => yaw +PI/2
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, walk(1.0, 0.0, 0.0), 90, &mut out);
        near(b.yaw, math::PI / 2.0, 0.05, "yaw");
    }

    #[test]
    fn shipped_walk_and_sprint_speeds_match_the_spec_numbers() {
        let w = floor();
        let t = PlayerTuning::default();
        near(t.walk_speed(), 4.317, 0.002, "walk_speed()");
        near(t.sprint_speed(), 5.612, 0.002, "sprint_speed()");
        let mut out = Vec::new();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, walk(0.0, 1.0, 0.0), 180, &mut out);
        near((b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt(), 4.317, 0.02, "walk m/s");
        assert_eq!(b.anim_state, anim::WALK);
        let mut i = walk(0.0, 1.0, 0.0);
        i.sprint = true;
        go(&mut b, &w, &t, i, 180, &mut out);
        near((b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt(), 5.612, 0.02, "sprint m/s");
        assert_eq!(b.anim_state, anim::RUN);
        assert!(b.speed01 > 0.99);
    }

    #[test]
    fn a_tap_shorter_than_a_tick_still_jumps_and_rest_starts_without_waiting() {
        let w = floor();
        let t = PlayerTuning::default();
        let mut out = Vec::new();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        go(&mut b, &w, &t, Intent::default(), 1, &mut out); // now mid-tick (sub = 1)
        assert_eq!(b.sub, 1);
        go(&mut b, &w, &t, Intent { jump_pressed: true, ..Default::default() }, 1, &mut out);
        assert_eq!(out, vec![Happened::Jump], "restarted from rest: the jump is immediate");
        // while walking the tap is latched until the next boundary
        let mut b = Body::new(Vec3::ZERO, 0.0);
        out.clear();
        go(&mut b, &w, &t, walk(0.0, 1.0, 0.0), 31, &mut out); // mid-tick, walking
        go(&mut b, &w, &t, Intent { move_vec: Vec2::new(0.0, 1.0), jump_pressed: true, ..Default::default() }, 1, &mut out);
        go(&mut b, &w, &t, walk(0.0, 1.0, 0.0), 3, &mut out);
        assert!(out.contains(&Happened::Jump), "latched tap lost: {out:?}");
    }

    #[test]
    fn coyote_time_and_jump_buffer_are_forgiving() {
        let t = PlayerTuning::default();
        // walking off a ledge: a press 2 steps (33 ms) after leaving works, 15 steps (250 ms) later does not
        let ledge = W(|x, y, _| if y < 0 && x < 10 { id::STONE } else { id::AIR });
        for (press_at, expect) in [(2usize, true), (15, false)] {
            let mut b = Body::new(Vec3::new(9.0, 0.0, 0.0), 0.0);
            let mut out = Vec::new();
            let i = walk(0.0, 1.0, -math::PI / 2.0); // +X
            let mut air = None;
            for _ in 0..400 {
                if air.is_none() && !b.on_ground {
                    air = Some(0usize);
                }
                let mut s = i;
                if let Some(a) = air.as_mut() {
                    if *a == press_at {
                        s.jump_pressed = true;
                        s.jump_held = true;
                    }
                    *a += 1;
                }
                step(&mut b, &s, &ledge, &Bounds::UNBOUNDED, &t, &mut out);
                if air.is_some_and(|a| a > 40) {
                    break;
                }
            }
            assert_eq!(out.contains(&Happened::Jump), expect, "press {press_at} steps after leaving: {out:?}");
        }
        // a press shortly before landing jumps on landing; without the buffer it is swallowed
        let w = floor();
        for (buffer, expect) in [(0.1, true), (0.0, false)] {
            let mut tt = t.clone();
            tt.jump_buffer_time = buffer;
            let mut b = Body::new(Vec3::new(0.0, 1.0, 0.0), 0.0);
            b.on_ground = false;
            b.grounded = false;
            b.v = Vec3::ZERO;
            let mut out = Vec::new();
            let mut pressed = false;
            for _ in 0..120 {
                let press = !pressed && b.pos.y < 0.3;
                pressed |= press;
                let i = Intent { jump_pressed: press, jump_held: press, ..Default::default() };
                step(&mut b, &i, &w, &Bounds::UNBOUNDED, &tt, &mut out);
            }
            assert!(pressed);
            assert_eq!(out.contains(&Happened::Jump), expect, "buffer {buffer}: {out:?}");
        }
    }

    #[test]
    fn landing_emits_one_event_and_a_short_recovery() {
        let w = floor();
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::new(0.0, 3.0, 0.0), 0.0);
        b.on_ground = false;
        b.grounded = false;
        b.v = Vec3::ZERO;
        let mut out = Vec::new();
        let mut recovered = false;
        for _ in 0..120 {
            step(&mut b, &Intent::default(), &w, &Bounds::UNBOUNDED, &t, &mut out);
            recovered |= b.recover > 0.0;
        }
        let lands: Vec<_> = out.iter().filter(|e| matches!(e, Happened::Land { impact } if *impact > 8.0)).collect();
        assert_eq!(lands.len(), 1, "{out:?}");
        assert_eq!(out.len(), 1);
        assert!(recovered, "a 3 m fall should leave a landing recovery");
        assert!(b.grounded && b.on_ground && b.recover == 0.0);
    }

    #[test]
    fn step_up_is_visually_smoothed() {
        let w = W(|_, y, z| if y < 0 || (y == 0 && (1..5).contains(&z)) { id::STONE } else { id::AIR });
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let mut out = Vec::new();
        let i = walk(0.0, 1.0, math::PI); // +Z
        let mut last = b.visual_pos().y;
        let mut worst = 0.0f32;
        let mut min_off = 0.0f32;
        for _ in 0..60 {
            step(&mut b, &i, &w, &Bounds::UNBOUNDED, &t, &mut out);
            let y = b.visual_pos().y;
            worst = worst.max((y - last).abs());
            last = y;
            min_off = min_off.min(b.step_dy);
        }
        near(b.pos.y, 1.0, 3e-3, "stepped up onto the block");
        assert!(min_off < -0.4, "the physical pop must be hidden in step_dy ({min_off})");
        assert!(worst < 0.3, "published height changed by {worst} m in one step (a pop)");
        go(&mut b, &w, &t, Intent::default(), 120, &mut out);
        assert!(b.step_dy.abs() < 1e-3, "offset must decay: {}", b.step_dy);
        near(b.visual_pos().y, 1.0, 5e-3, "settled");
    }

    #[test]
    fn swimming_floats_up_and_idles_at_the_surface() {
        // water from y = -3 to the surface at y = 0, stone below
        let w = W(|_, y, _| if y < -3 { id::STONE } else if y < 0 { id::WATER } else { id::AIR });
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::new(0.0, -3.0, 0.0), 0.0);
        let mut out = Vec::new();
        go(&mut b, &w, &t, Intent::default(), 600, &mut out);
        assert!(b.tick_water && b.swimming, "should be swimming");
        assert!(b.pos.y > -1.25 && b.pos.y < -0.7, "floats with the head above the surface: y = {}", b.pos.y);
        assert_eq!(b.anim_state, anim::SWIM_IDLE);
        // swimming forward is slower than walking
        let mut i = walk(0.0, 1.0, math::PI);
        i.move_vec.y = 1.0;
        go(&mut b, &w, &t, i, 200, &mut out);
        let hs = (b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt();
        assert!(hs > 1.5 && hs < 2.2, "swim speed {hs}");
        assert_eq!(b.anim_state, anim::SWIM);
    }

    #[test]
    fn world_edge_is_a_wall() {
        let w = floor();
        let t = PlayerTuning::default();
        let bounds = Bounds { min_x: -3.0, min_z: -3.0, max_x: 3.0, max_z: 3.0 };
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let mut out = Vec::new();
        for _ in 0..300 {
            step(&mut b, &walk(1.0, 0.0, 0.0), &w, &bounds, &t, &mut out);
        }
        assert!(b.pos.x <= 3.0 - 0.25 + 1e-3, "x = {}", b.pos.x);
    }

    #[test]
    fn footsteps_follow_distance() {
        let w = floor();
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let mut out = Vec::new();
        go(&mut b, &w, &t, walk(0.0, 1.0, 0.0), 600, &mut out);
        let steps = out.iter().filter(|e| matches!(e, Happened::Footstep { .. })).count();
        // 10 s at 4.3 m/s = ~43 m, 1.4 m per step => ~30 footsteps
        assert!((26..=34).contains(&steps), "{steps} footsteps");
    }

    #[test]
    fn controller_is_deterministic() {
        let w = W(|x, y, z| {
            if y < 0 && !(x > 4 && z > 4) {
                id::STONE
            } else if y == 0 && x % 7 == 3 {
                id::STONE
            } else if y < 0 || (y > -3 && y < 0) {
                id::WATER
            } else {
                id::AIR
            }
        });
        let t = PlayerTuning::default();
        let run_once = || {
            let mut b = Body::new(Vec3::new(1.0, 0.0, 1.0), 0.0);
            let mut out = Vec::new();
            for n in 0..1500usize {
                let i = Intent {
                    move_vec: Vec2::new(((n / 40) % 3) as f32 - 1.0, ((n / 70) % 3) as f32 - 1.0),
                    camera_yaw: n as f32 * 0.003,
                    sprint: n % 300 > 150,
                    jump_held: n % 97 < 3,
                    jump_pressed: n % 97 == 0,
                };
                step(&mut b, &i, &w, &Bounds::UNBOUNDED, &t, &mut out);
            }
            (b, out)
        };
        let (a, ea) = run_once();
        let (b, eb) = run_once();
        assert_eq!(a, b);
        assert_eq!(ea, eb);
    }

    #[test]
    fn tuning_fields_roundtrip() {
        let mut t = PlayerTuning::default();
        for (key, min, max, _) in PlayerTuning::FIELDS {
            let v = t.get(key).expect(key);
            assert!(v >= *min - 1e-6 && v <= *max + 1e-6, "{key} default {v} outside {min}..{max}");
        }
        assert!(t.set("gravity", 0.1) && t.gravity == 0.1);
        assert!(!t.set("nope", 1.0) && t.get("nope").is_none());
    }
}
