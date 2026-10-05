//! The player's kinematic character controller as a **pure function** over plain data
//! ([`step`]), so it can be unit-tested natively against synthetic terrains and reused (e.g. for a
//! companion that mimics the player). The ECS systems in `lib.rs` only copy data in and out.
//!
//! Model (60 Hz, `dt = SIM_DT`):
//! * camera-relative movement with exponential velocity smoothing (ground / air / swim rates);
//! * gravity, jump with *coyote time* and *jump buffering*;
//! * the ground is the heightfield: landing, ground snapping on descents, slope limiting - on a
//!   slope steeper than `max_walk_slope` the uphill velocity is removed and the body slides down;
//! * swimming when the water column is deeper than `swim_depth`: a damped spring floats the feet at
//!   `sea_level - swim_depth`; wading in shallow water slows movement;
//! * the world edge is a hard clamp (`HeightQuery::clamp`).

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};
use sim_core::math::{self, Vec2, Vec3};
use sim_core::{HeightQuery, SIM_DT};

/// Tunable constants (a resource; defaults are the shipped feel).
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct PlayerTuning {
    pub walk_speed: f32,
    pub sprint_speed: f32,
    pub swim_speed: f32,
    /// Velocity smoothing rates (1/s) on the ground, in the air, in water.
    pub ground_accel: f32,
    pub air_accel: f32,
    pub swim_accel: f32,
    pub gravity: f32,
    pub terminal_velocity: f32,
    pub jump_speed: f32,
    /// Upward speed of the hop out of the water.
    pub swim_hop: f32,
    pub coyote_time: f32,
    pub jump_buffer_time: f32,
    /// Slopes steeper than this (radians from horizontal) cannot be climbed and make the body slide.
    pub max_walk_slope: f32,
    pub slide_max_speed: f32,
    /// Water column depth (m) above which the player swims; also the float depth of the feet.
    pub swim_depth: f32,
    pub buoyancy_k: f32,
    pub buoyancy_c: f32,
    /// How far (m) the body follows the ground down a slope instead of becoming airborne.
    pub snap_distance: f32,
    /// Facing smoothing rate (1/s).
    pub turn_rate: f32,
    /// Minimum impact speed (m/s) that raises a Land event.
    pub land_event_speed: f32,
    /// Number of selectable tools (net, rod, shovel, axe, watering can).
    pub tool_count: u8,
}

impl Default for PlayerTuning {
    fn default() -> Self {
        Self {
            walk_speed: 4.2,
            sprint_speed: 7.0,
            swim_speed: 2.4,
            ground_accel: 14.0,
            air_accel: 3.5,
            swim_accel: 6.0,
            gravity: 22.0,
            terminal_velocity: 38.0,
            jump_speed: 8.0,
            swim_hop: 4.5,
            coyote_time: 0.12,
            jump_buffer_time: 0.12,
            max_walk_slope: 0.80, // ~46 degrees
            slide_max_speed: 9.0,
            swim_depth: 1.0,
            buoyancy_k: 30.0,
            buoyancy_c: 7.0,
            snap_distance: 0.4,
            turn_rate: 14.0,
            land_event_speed: 3.0,
            tool_count: 5,
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
    /// Sliding down a slope too steep to stand on.
    pub const SLIDE: u8 = 8;
}

/// How long the LAND animation state lasts (s).
const LAND_ANIM_TIME: f32 = 0.18;

/// Everything the controller integrates (also the save payload of the player body).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Body {
    pub pos: Vec3,
    pub vel: Vec3,
    pub yaw: f32,
    pub grounded: bool,
    pub swimming: bool,
    pub sliding: bool,
    pub coyote: f32,
    pub jump_buffer: f32,
    pub land_timer: f32,
    /// Distance walked since the last footstep event.
    pub stride: f32,
    pub anim_state: u8,
    pub anim_t: f32,
    /// Depth of water above the ground at the feet (0 on dry land).
    pub water_depth: f32,
    pub speed01: f32,
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
        }
    }
}

/// One step of player intent (derived from `Input`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Intent {
    /// Stick/keys: `x` strafe (right +), `y` forward (+), length <= 1.
    pub move_vec: Vec2,
    pub camera_yaw: f32,
    pub sprint: bool,
    /// Jump went down since the previous step.
    pub jump_pressed: bool,
}

/// Things that happened during a step (turned into `EventBus` events by the system).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Happened {
    Jump,
    Land { impact: f32 },
    Splash { impact: f32 },
    Footstep { biome: u8 },
}

/// Advances `body` by one fixed step.
pub fn step(b: &mut Body, i: &Intent, terrain: &HeightQuery, t: &PlayerTuning, out: &mut Vec<Happened>) {
    let dt = SIM_DT;
    let sea = terrain.sea_level();

    // --- water state (with hysteresis) ---------------------------------------------------------
    let ground_here = terrain.height(b.pos.x, b.pos.z);
    let depth_here = (sea - ground_here).max(0.0);
    let was_swimming = b.swimming;
    let swimming = if was_swimming {
        depth_here > t.swim_depth - 0.08
    } else {
        depth_here > t.swim_depth + 0.08 && b.pos.y < sea - 0.3
    };
    if swimming && !was_swimming {
        out.push(Happened::Splash { impact: (-b.vel.y).max(0.0) });
        b.vel.y *= 0.25;
    }
    b.swimming = swimming;

    // --- wish velocity -------------------------------------------------------------------------
    let mag = i.move_vec.length().min(1.0);
    let wish_dir = if mag > 1e-4 {
        (math::camera_right(i.camera_yaw) * i.move_vec.x + math::camera_forward(i.camera_yaw) * i.move_vec.y) / i.move_vec.length()
    } else {
        Vec3::ZERO
    };
    let top = if swimming {
        t.swim_speed
    } else if i.sprint {
        t.sprint_speed
    } else {
        t.walk_speed
    };
    let wade = if swimming { 1.0 } else { 1.0 - 0.35 * math::clamp01(depth_here / t.swim_depth) };
    let rate = if swimming {
        t.swim_accel
    } else if b.grounded {
        t.ground_accel
    } else {
        t.air_accel
    };
    let k = math::damp_factor(rate, dt);
    let target = wish_dir * (mag * top * wade);
    b.vel.x += (target.x - b.vel.x) * k;
    b.vel.z += (target.z - b.vel.z) * k;

    // --- slopes: can't climb steep ground, slide down it ---------------------------------------
    b.sliding = false;
    if b.grounded && !swimming {
        let n = terrain.normal(b.pos.x, b.pos.z);
        let slope = math::acos(n.y.clamp(-1.0, 1.0));
        if slope > t.max_walk_slope {
            let h = Vec2::new(n.x, n.z);
            if h.length_squared() > 1e-8 {
                let downhill = h.normalize();
                let along = b.vel.x * downhill.x + b.vel.z * downhill.y;
                if along < 0.0 {
                    // moving uphill: cancel that component
                    b.vel.x -= along * downhill.x;
                    b.vel.z -= along * downhill.y;
                }
                let sin_a = (1.0 - n.y * n.y).max(0.0).sqrt();
                let a = t.gravity * 0.8 * sin_a * n.y;
                b.vel.x += downhill.x * a * dt;
                b.vel.z += downhill.y * a * dt;
                let hs = (b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt();
                if hs > t.slide_max_speed {
                    let s = t.slide_max_speed / hs;
                    b.vel.x *= s;
                    b.vel.z *= s;
                }
                b.sliding = true;
            }
        }
    }

    // --- jumping (coyote time + buffer) ----------------------------------------------------------
    b.jump_buffer = if i.jump_pressed { t.jump_buffer_time } else { (b.jump_buffer - dt).max(0.0) };
    b.coyote = if b.grounded { t.coyote_time } else { (b.coyote - dt).max(0.0) };
    if b.jump_buffer > 0.0 && !b.sliding {
        if swimming {
            b.vel.y = t.swim_hop;
            b.jump_buffer = 0.0;
        } else if b.coyote > 0.0 {
            b.vel.y = t.jump_speed;
            b.grounded = false;
            b.coyote = 0.0;
            b.jump_buffer = 0.0;
            b.land_timer = 0.0;
            out.push(Happened::Jump);
        }
    }

    // --- vertical dynamics -------------------------------------------------------------------------
    if swimming {
        let float_y = sea - t.swim_depth;
        let acc = (float_y - b.pos.y) * t.buoyancy_k - b.vel.y * t.buoyancy_c;
        b.vel.y += acc * dt;
    } else if !b.grounded {
        b.vel.y = (b.vel.y - t.gravity * dt).max(-t.terminal_velocity);
    } else {
        b.vel.y = 0.0;
    }

    // --- integrate (world edge is a wall) ----------------------------------------------------------
    let nx = b.pos.x + b.vel.x * dt;
    let nz = b.pos.z + b.vel.z * dt;
    let (cx, cz) = terrain.clamp(nx, nz);
    if cx != nx {
        b.vel.x = 0.0;
    }
    if cz != nz {
        b.vel.z = 0.0;
    }
    b.pos.x = cx;
    b.pos.z = cz;
    b.pos.y += b.vel.y * dt;

    // --- ground resolution ----------------------------------------------------------------------------
    let g = terrain.height(b.pos.x, b.pos.z);
    let was_grounded = b.grounded;
    if swimming {
        if b.pos.y < g {
            b.pos.y = g;
            b.vel.y = b.vel.y.max(0.0);
        }
        b.grounded = false;
    } else if b.pos.y <= g {
        let impact = (-b.vel.y).max(0.0);
        b.pos.y = g;
        b.vel.y = 0.0;
        b.grounded = true;
        if !was_grounded && impact > t.land_event_speed {
            out.push(Happened::Land { impact });
            b.land_timer = LAND_ANIM_TIME;
        }
    } else if was_grounded && b.vel.y <= 0.0 && b.pos.y - g <= t.snap_distance {
        b.pos.y = g;
        b.grounded = true;
    } else {
        b.grounded = false;
    }
    b.water_depth = (sea - g).max(0.0);

    // --- footsteps -------------------------------------------------------------------------------------
    let hs = (b.vel.x * b.vel.x + b.vel.z * b.vel.z).sqrt();
    if b.grounded && !swimming && hs > 0.5 {
        b.stride += hs * dt;
        let len = if hs > t.walk_speed * 1.3 { 2.1 } else { 1.4 };
        if b.stride >= len {
            b.stride -= len;
            out.push(Happened::Footstep { biome: terrain.biome(b.pos.x, b.pos.z) });
        }
    } else {
        b.stride = 0.0;
    }

    // --- facing --------------------------------------------------------------------------------------------
    let face = if mag > 0.05 {
        Some(wish_dir)
    } else if hs > 0.5 {
        Some(Vec3::new(b.vel.x, 0.0, b.vel.z) / hs)
    } else {
        None
    };
    if let Some(d) = face {
        let want = math::dir_to_yaw(d);
        b.yaw = math::wrap_pi(b.yaw + math::angle_diff(b.yaw, want) * math::damp_factor(t.turn_rate, dt));
    }

    // --- animation state ---------------------------------------------------------------------------------------
    b.land_timer = (b.land_timer - dt).max(0.0);
    let state = if swimming {
        if hs > 0.3 { anim::SWIM } else { anim::SWIM_IDLE }
    } else if !b.grounded {
        if b.vel.y > 0.0 { anim::JUMP } else { anim::FALL }
    } else if b.land_timer > 0.0 {
        anim::LAND
    } else if b.sliding {
        anim::SLIDE
    } else if hs > t.walk_speed * 1.25 {
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
    b.speed01 = math::clamp01(hs / t.sprint_speed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::terrain::{FlatTerrain, Terrain, TerrainBounds, biome};

    // --- synthetic terrains -----------------------------------------------------------------

    /// Height = slope * x for x > 0 (a ramp rising toward +X), flat for x <= 0.
    struct Ramp {
        slope: f32,
    }
    impl Terrain for Ramp {
        fn height(&self, x: f32, _z: f32) -> f32 {
            self.slope * x.max(0.0)
        }
        fn normal(&self, x: f32, _z: f32) -> Vec3 {
            if x > 0.0 { Vec3::new(-self.slope, 1.0, 0.0).normalize() } else { Vec3::Y }
        }
        fn biome(&self, _x: f32, _z: f32) -> u8 {
            biome::MEADOW
        }
        fn sea_level(&self) -> f32 {
            -1000.0
        }
        fn bounds(&self) -> TerrainBounds {
            TerrainBounds { min_x: -100.0, min_z: -100.0, max_x: 100.0, max_z: 100.0 }
        }
    }

    /// Dry plateau (height 2) for x < 10, then drops by 6 m: a ledge.
    struct Ledge;
    impl Terrain for Ledge {
        fn height(&self, x: f32, _z: f32) -> f32 {
            if x < 10.0 { 2.0 } else { -4.0 }
        }
        fn normal(&self, _x: f32, _z: f32) -> Vec3 {
            Vec3::Y
        }
        fn biome(&self, _x: f32, _z: f32) -> u8 {
            biome::MEADOW
        }
        fn sea_level(&self) -> f32 {
            -1000.0
        }
        fn bounds(&self) -> TerrainBounds {
            TerrainBounds { min_x: -100.0, min_z: -100.0, max_x: 100.0, max_z: 100.0 }
        }
    }

    /// Beach: ground height falls linearly from +1 at x = -10 to -6 at x = +20; sea level 0.
    struct Beach;
    impl Terrain for Beach {
        fn height(&self, x: f32, _z: f32) -> f32 {
            (1.0 - (x + 10.0) * (7.0 / 30.0)).clamp(-6.0, 1.0)
        }
        fn normal(&self, x: f32, _z: f32) -> Vec3 {
            if (-10.0..20.0).contains(&x) { Vec3::new(7.0 / 30.0, 1.0, 0.0).normalize() } else { Vec3::Y }
        }
        fn biome(&self, x: f32, _z: f32) -> u8 {
            if self.height(x, 0.0) < 0.0 { biome::SHALLOW_WATER } else { biome::BEACH }
        }
        fn sea_level(&self) -> f32 {
            0.0
        }
        fn bounds(&self) -> TerrainBounds {
            TerrainBounds { min_x: -50.0, min_z: -50.0, max_x: 40.0, max_z: 50.0 }
        }
    }

    fn q(t: impl Terrain) -> HeightQuery {
        HeightQuery::new(t)
    }

    fn run(body: &mut Body, terrain: &HeightQuery, intent: Intent, steps: usize) -> Vec<Happened> {
        let t = PlayerTuning::default();
        let mut out = Vec::new();
        for _ in 0..steps {
            step(body, &intent, terrain, &t, &mut out);
        }
        out
    }

    fn walk(dir: Vec2) -> Intent {
        Intent { move_vec: dir, ..Default::default() }
    }

    // --- tests --------------------------------------------------------------------------------

    #[test]
    fn standing_still_stays_put_and_idle() {
        let terrain = HeightQuery::default();
        let mut b = Body::new(Vec3::new(1.0, 0.0, 2.0), 0.0);
        let ev = run(&mut b, &terrain, Intent::default(), 120);
        assert!(ev.is_empty());
        assert_eq!(b.pos, Vec3::new(1.0, 0.0, 2.0));
        assert_eq!(b.anim_state, anim::IDLE);
        assert!(b.grounded && !b.swimming);
    }

    #[test]
    fn movement_is_camera_relative() {
        let terrain = HeightQuery::default();
        // camera yaw 0: forward is -Z
        let mut b = Body::new(Vec3::ZERO, 0.0);
        run(&mut b, &terrain, walk(Vec2::new(0.0, 1.0)), 90);
        assert!(b.pos.z < -3.0 && b.pos.x.abs() < 1e-4, "{:?}", b.pos);
        // strafing right is +X
        let mut b = Body::new(Vec3::ZERO, 0.0);
        run(&mut b, &terrain, walk(Vec2::new(1.0, 0.0)), 90);
        assert!(b.pos.x > 3.0 && b.pos.z.abs() < 1e-4, "{:?}", b.pos);
        // camera turned 90 degrees (looking toward -X): forward is -X
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let mut i = walk(Vec2::new(0.0, 1.0));
        i.camera_yaw = math::PI / 2.0;
        run(&mut b, &terrain, i, 90);
        assert!(b.pos.x < -3.0 && b.pos.z.abs() < 1e-3, "{:?}", b.pos);
    }

    #[test]
    fn speeds_and_diagonals() {
        let terrain = HeightQuery::default();
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        run(&mut b, &terrain, walk(Vec2::new(0.0, 1.0)), 120);
        let walk_speed = Vec2::new(b.vel.x, b.vel.z).length();
        assert!((walk_speed - t.walk_speed).abs() < 0.05, "{walk_speed}");
        assert_eq!(b.anim_state, anim::WALK);

        let mut i = walk(Vec2::new(0.0, 1.0));
        i.sprint = true;
        run(&mut b, &terrain, i, 120);
        let run_speed = Vec2::new(b.vel.x, b.vel.z).length();
        assert!((run_speed - t.sprint_speed).abs() < 0.05, "{run_speed}");
        assert_eq!(b.anim_state, anim::RUN);
        assert!(b.speed01 > 0.99);

        // diagonal input is not faster than straight input
        let mut d = Body::new(Vec3::ZERO, 0.0);
        run(&mut d, &terrain, walk(Vec2::new(1.0, 1.0)), 120);
        assert!((Vec2::new(d.vel.x, d.vel.z).length() - t.walk_speed).abs() < 0.05);
        // half stick = half speed
        let mut h = Body::new(Vec3::ZERO, 0.0);
        run(&mut h, &terrain, walk(Vec2::new(0.0, 0.5)), 120);
        assert!((Vec2::new(h.vel.x, h.vel.z).length() - t.walk_speed * 0.5).abs() < 0.05);
    }

    #[test]
    fn facing_turns_toward_movement() {
        let terrain = HeightQuery::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        // walking right (+X): facing vector (sin yaw, 0, cos yaw) -> yaw = +PI/2
        run(&mut b, &terrain, walk(Vec2::new(1.0, 0.0)), 90);
        assert!((b.yaw - math::PI / 2.0).abs() < 0.05, "{}", b.yaw);
    }

    #[test]
    fn jump_height_and_events() {
        let terrain = HeightQuery::default();
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let mut out = Vec::new();
        let press = Intent { jump_pressed: true, ..Default::default() };
        step(&mut b, &press, &terrain, &t, &mut out);
        assert_eq!(out, vec![Happened::Jump]);
        assert!(!b.grounded);
        let mut apex = b.pos.y;
        let mut steps = 1;
        out.clear();
        while !b.grounded && steps < 400 {
            step(&mut b, &Intent::default(), &terrain, &t, &mut out);
            apex = apex.max(b.pos.y);
            steps += 1;
        }
        let expected = t.jump_speed * t.jump_speed / (2.0 * t.gravity);
        assert!((apex - expected).abs() < 0.12, "apex {apex} vs {expected}");
        assert!(b.grounded && b.pos.y == 0.0);
        assert!(matches!(out.as_slice(), [Happened::Land { impact }] if *impact > 7.0), "{out:?}");
        // airtime ~ 2 v / g
        let airtime = steps as f32 * SIM_DT;
        assert!((airtime - 2.0 * t.jump_speed / t.gravity).abs() < 0.1, "{airtime}");
    }

    #[test]
    fn jump_buffer_and_coyote_time_feel_forgiving() {
        let terrain = HeightQuery::default();
        let t = PlayerTuning::default();
        // buffered press just before landing jumps on landing
        let mut b = Body::new(Vec3::new(0.0, 1.0, 0.0), 0.0);
        b.grounded = false;
        let mut out = Vec::new();
        let mut jumped = false;
        let mut pressed = false;
        for _ in 0..200 {
            // press once, while still ~0.1 s above the ground
            let press = !pressed && b.pos.y < 0.45;
            pressed |= press;
            step(&mut b, &Intent { jump_pressed: press, ..Default::default() }, &terrain, &t, &mut out);
            jumped |= out.contains(&Happened::Jump);
            out.clear();
        }
        assert!(pressed && jumped, "buffered jump was swallowed");

        // walking off a ledge then pressing jump within the coyote window still jumps
        let ledge = q(Ledge);
        let mut b = Body::new(Vec3::new(9.9, 2.0, 0.0), 0.0);
        b.yaw = math::PI / 2.0;
        let mut out = Vec::new();
        let mut walked_off = false;
        let mut jumped = false;
        let mut airborne_steps = 0;
        for _ in 0..90 {
            let off = b.pos.x > 10.0 && !b.grounded;
            walked_off |= off;
            airborne_steps += i32::from(off);
            // press jump three steps (50 ms) after leaving the ledge: inside the 120 ms window
            let press = airborne_steps == 3;
            step(&mut b, &Intent { move_vec: Vec2::new(1.0, 0.0), jump_pressed: press, ..Default::default() }, &ledge, &t, &mut out);
            jumped |= out.contains(&Happened::Jump);
            out.clear();
        }
        assert!(walked_off, "never left the ledge");
        assert!(jumped, "coyote jump failed");
    }

    #[test]
    fn walkable_slope_is_climbed_and_followed() {
        let terrain = q(Ramp { slope: 0.4 }); // ~21.8 degrees
        let mut b = Body::new(Vec3::new(-2.0, 0.0, 0.0), 0.0);
        let mut i = walk(Vec2::new(1.0, 0.0));
        i.camera_yaw = 0.0; // right = +X
        run(&mut b, &terrain, i, 240);
        assert!(b.pos.x > 5.0, "should have climbed, x = {}", b.pos.x);
        assert!((b.pos.y - 0.4 * b.pos.x).abs() < 1e-3, "feet must stay on the slope");
        assert!(b.grounded && !b.sliding);
        // walking back down keeps contact (no bouncing into FALL)
        let mut i = walk(Vec2::new(-1.0, 0.0));
        i.camera_yaw = 0.0;
        let mut out = Vec::new();
        let t = PlayerTuning::default();
        for _ in 0..200 {
            step(&mut b, &i, &terrain, &t, &mut out);
            assert!(b.grounded, "left the ground while walking downhill at x = {}", b.pos.x);
        }
    }

    #[test]
    fn steep_slope_blocks_and_slides() {
        let terrain = q(Ramp { slope: 2.0 }); // ~63 degrees
        let mut b = Body::new(Vec3::new(-1.0, 0.0, 0.0), 0.0);
        let mut i = walk(Vec2::new(1.0, 0.0));
        i.camera_yaw = 0.0;
        run(&mut b, &terrain, i, 200);
        assert!(b.pos.x < 1.5, "must not climb a 63 degree wall, x = {}", b.pos.x);
        // standing on the steep part slides downhill
        let mut b = Body::new(Vec3::new(3.0, 6.0, 0.0), 0.0);
        run(&mut b, &terrain, Intent::default(), 60);
        assert!(b.pos.x < 3.0 - 0.5, "should have slid down, x = {}", b.pos.x);
        assert!(b.sliding && b.anim_state == anim::SLIDE);
        assert!(Vec2::new(b.vel.x, b.vel.z).length() <= PlayerTuning::default().slide_max_speed + 1e-3);
    }

    #[test]
    fn falling_off_a_ledge_lands_with_an_event() {
        let ledge = q(Ledge);
        let mut b = Body::new(Vec3::new(9.0, 2.0, 0.0), 0.0);
        let i = walk(Vec2::new(1.0, 0.0));
        let out = run(&mut b, &ledge, i, 180);
        assert!(b.pos.y == -4.0 && b.grounded);
        assert!(out.iter().any(|e| matches!(e, Happened::Land { impact } if *impact > 8.0)), "{out:?}");
        assert_eq!(out.iter().filter(|e| matches!(e, Happened::Land { .. })).count(), 1);
    }

    #[test]
    fn swimming_floats_at_the_surface_and_is_slower() {
        let beach = q(Beach);
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::new(-8.0, beach.height(-8.0, 0.0), 0.0), 0.0);
        let i = walk(Vec2::new(1.0, 0.0)); // toward the sea (+X)
        let mut out = Vec::new();
        let mut was_swimming = false;
        for _ in 0..600 {
            step(&mut b, &i, &beach, &t, &mut out);
            was_swimming |= b.swimming;
        }
        assert!(was_swimming, "never started swimming; x = {}", b.pos.x);
        assert!(b.swimming);
        assert!(out.iter().any(|e| matches!(e, Happened::Splash { .. })), "no splash event");
        // feet float at sea level - swim_depth
        assert!((b.pos.y - (0.0 - t.swim_depth)).abs() < 0.05, "y = {}", b.pos.y);
        assert!(b.water_depth > t.swim_depth);
        let hs = Vec2::new(b.vel.x, b.vel.z).length();
        assert!((hs - t.swim_speed).abs() < 0.1, "swim speed {hs}");
        assert!(matches!(b.anim_state, anim::SWIM | anim::SWIM_IDLE));
        assert!(!b.grounded);
    }

    #[test]
    fn can_swim_back_and_walk_out() {
        let beach = q(Beach);
        let t = PlayerTuning::default();
        let mut b = Body::new(Vec3::new(14.0, -1.0, 0.0), 0.0);
        b.swimming = true;
        b.grounded = false;
        let i = walk(Vec2::new(-1.0, 0.0)); // toward land (-X)
        let mut out = Vec::new();
        for _ in 0..900 {
            step(&mut b, &i, &beach, &t, &mut out);
        }
        assert!(!b.swimming && b.grounded, "should be walking again; x = {}", b.pos.x);
        assert!(b.pos.x < 0.0, "x = {}", b.pos.x);
        assert!((b.pos.y - beach.height(b.pos.x, 0.0)).abs() < 1e-3);
    }

    #[test]
    fn world_edge_is_a_wall() {
        let beach = q(Beach);
        let mut b = Body::new(Vec3::new(30.0, -6.0, 0.0), 0.0);
        let mut i = walk(Vec2::new(0.0, -1.0)); // -Z
        i.camera_yaw = 0.0;
        for _ in 0..2000 {
            step(&mut b, &i, &beach, &PlayerTuning::default(), &mut Vec::new());
        }
        assert!(b.pos.z >= -50.0 - 1e-3, "z = {}", b.pos.z);
    }

    #[test]
    fn footsteps_follow_distance_and_biome() {
        let terrain = HeightQuery::default();
        let mut b = Body::new(Vec3::ZERO, 0.0);
        let out = run(&mut b, &terrain, walk(Vec2::new(0.0, 1.0)), 600);
        let steps: Vec<_> = out.iter().filter(|e| matches!(e, Happened::Footstep { .. })).collect();
        // 10 s at 4.2 m/s = ~42 m, 1.4 m per step => ~30 footsteps
        assert!((24..=34).contains(&steps.len()), "{} footsteps", steps.len());
        assert!(steps.iter().all(|e| matches!(e, Happened::Footstep { biome } if *biome == biome::MEADOW)));
    }

    #[test]
    fn controller_is_deterministic() {
        let beach = q(Beach);
        let run_once = || {
            let mut b = Body::new(Vec3::new(-8.0, 0.0, 0.0), 0.0);
            let mut out = Vec::new();
            let t = PlayerTuning::default();
            for n in 0..1500 {
                let i = Intent {
                    move_vec: Vec2::new(((n / 40) % 3) as f32 - 1.0, ((n / 70) % 3) as f32 - 1.0),
                    camera_yaw: n as f32 * 0.003,
                    sprint: n % 300 > 150,
                    jump_pressed: n % 97 == 0,
                };
                step(&mut b, &i, &beach, &t, &mut out);
            }
            (b, out)
        };
        let (a, ea) = run_once();
        let (b, eb) = run_once();
        assert_eq!(a, b);
        assert_eq!(ea, eb);
    }

    #[test]
    fn flat_terrain_default_query_is_dry() {
        let t = FlatTerrain::default();
        assert!(t.sea_level() < -100.0);
    }
}
