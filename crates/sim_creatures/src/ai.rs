//! Placeholder creature AI as a pure function over plain data ([`think`]).
//!
//! States: `Idle -> Wander -> Idle ...`; when the player comes within notice range a creature goes
//! `Notice` (stops, faces the player, "!") and then, by personality, `Approach` (curious), `Flee`
//! (shy) or `Play` (playful). A friendly poke ([`on_interact`]) makes it `Happy`. At night idle
//! creatures fall `Sleep` and wake at dawn.
//!
//! Every creature is updated from **its own state + read-only inputs only** (own RNG stream, the
//! player, the terrain, the clock), never from other creatures, so the result does not depend on
//! query iteration order - a requirement for byte-identical channels and for save/load.

use crate::species::{Personality, Species};
use bevy_ecs::prelude::Component;
use serde::{Deserialize, Serialize};
use sim_core::math::{self, Vec2, Vec3};
use sim_core::rng::Rng;
use sim_core::{HeightQuery, SIM_DT};

/// Behaviour state (the numeric value is stable; it is part of the save format).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum State {
    Idle = 0,
    Wander = 1,
    Notice = 2,
    Approach = 3,
    Flee = 4,
    Play = 5,
    Sleep = 6,
    Happy = 7,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Wander => "wander",
            State::Notice => "notice",
            State::Approach => "approach",
            State::Flee => "flee",
            State::Play => "play",
            State::Sleep => "sleep",
            State::Happy => "happy",
        }
    }
}

/// Animation state ids (channel `creatures` column 8).
pub mod anim {
    pub const IDLE: u8 = 0;
    pub const WALK: u8 = 1;
    pub const RUN: u8 = 2;
    pub const NOTICE: u8 = 3;
    pub const SLEEP: u8 = 4;
    pub const HAPPY: u8 = 5;
    pub const HOP: u8 = 6;
    pub const SWIM: u8 = 7;
}

/// Emote ids (channel `creatures` column 11).
pub mod emote {
    pub const NONE: u8 = 0;
    pub const EXCLAIM: u8 = 1;
    pub const HEART: u8 = 2;
    pub const ZZZ: u8 = 3;
    pub const NOTE: u8 = 4;
    pub const QUESTION: u8 = 5;
    pub const SPARKLE: u8 = 6;
}

/// Bits of channel `creatures` column 12.
pub mod flags {
    pub const ASLEEP: f32 = 1.0;
    pub const IN_WATER: f32 = 2.0;
    pub const AWARE: f32 = 4.0;
    pub const FLEEING: f32 = 8.0;
}

/// Mutable per-creature AI state (component; saved).
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Brain {
    pub state: State,
    /// Seconds left in the current state.
    pub timer: f32,
    /// XZ goal of walking states.
    pub target: Vec2,
    /// `0` sad .. `0.5` neutral .. `1` delighted.
    pub mood: f32,
    pub emote: u8,
    pub emote_timer: f32,
    /// Seconds until the creature may notice the player again.
    pub aware_cooldown: f32,
    /// Seconds spent in the current state.
    pub anim_t: f32,
    /// [`Id`](sim_core::Id) of what it is looking at (the player), 0 = nothing.
    pub focus: u32,
    /// Moved during the last step (drives walk/idle animation).
    pub moving: bool,
    /// Floating in water during the last step.
    pub swimming: bool,
}

impl Brain {
    pub fn new(rng: &mut Rng) -> Self {
        Self {
            state: State::Idle,
            timer: rng.range_f32(0.2, 3.0),
            target: Vec2::ZERO,
            mood: 0.5,
            emote: emote::NONE,
            emote_timer: 0.0,
            aware_cooldown: rng.range_f32(0.0, 4.0),
            anim_t: 0.0,
            focus: 0,
            moving: false,
            swimming: false,
        }
    }

    /// Animation id for the channel.
    pub fn anim_state(&self) -> u8 {
        match self.state {
            State::Sleep => anim::SLEEP,
            State::Happy => anim::HAPPY,
            State::Notice => anim::NOTICE,
            State::Play => anim::HOP,
            State::Flee => anim::RUN,
            State::Idle => anim::IDLE,
            State::Wander | State::Approach => {
                if !self.moving {
                    anim::IDLE
                } else if self.swimming {
                    anim::SWIM
                } else {
                    anim::WALK
                }
            }
        }
    }

    /// Flag bits for the channel.
    pub fn flag_bits(&self) -> f32 {
        let mut f = 0.0;
        if self.state == State::Sleep {
            f += flags::ASLEEP;
        }
        if self.swimming {
            f += flags::IN_WATER;
        }
        if self.focus != 0 && matches!(self.state, State::Notice | State::Approach | State::Flee | State::Play | State::Happy) {
            f += flags::AWARE;
        }
        if self.state == State::Flee {
            f += flags::FLEEING;
        }
        f
    }

    fn enter(&mut self, state: State, timer: f32) {
        self.state = state;
        self.timer = timer;
        self.anim_t = 0.0;
    }

    fn show(&mut self, e: u8, seconds: f32, out: &mut Vec<AiEvent>) {
        self.emote = e;
        self.emote_timer = seconds;
        out.push(AiEvent::Emoted(e));
    }
}

/// Things the system should announce to JS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiEvent {
    Noticed,
    Slept,
    Woke,
    Emoted(u8),
}

/// Read-only inputs of one AI step.
pub struct Surroundings<'a> {
    pub terrain: &'a HeightQuery,
    /// `(id, position)` of the player if there is one.
    pub player: Option<(u32, Vec3)>,
    pub night: bool,
    /// `0..1`, see `Environment::daylight`.
    pub daylight: f32,
    /// Precomputed turn smoothing factor for this step.
    pub k_turn: f32,
}

/// Can `sp` stand at `(x, z)`?
pub fn walkable(sp: &Species, terrain: &HeightQuery, x: f32, z: f32) -> bool {
    if !terrain.contains(x, z) {
        return false;
    }
    let max_water = if sp.swims { 1.2 } else { 0.25 };
    terrain.water_depth(x, z) < max_water && terrain.normal(x, z).y > 0.76
}

/// Height at which a creature stands / floats at `(x, z)`; second value = floating.
pub fn stand_height(sp: &Species, terrain: &HeightQuery, x: f32, z: f32) -> (f32, bool) {
    let g = terrain.height(x, z);
    if sp.swims && terrain.sea_level() - g > 0.15 { (terrain.sea_level() - 0.12, true) } else { (g, false) }
}

enum Move {
    Moving,
    Arrived,
    Blocked,
}

struct Agent<'a> {
    sp: &'a Species,
    pos: &'a mut Vec3,
    yaw: &'a mut f32,
    brain: &'a mut Brain,
}

fn turn_toward(yaw: &mut f32, dir_x: f32, dir_z: f32, k: f32) {
    if dir_x * dir_x + dir_z * dir_z > 1e-8 {
        let want = math::atan2(dir_x, dir_z);
        *yaw = math::wrap_pi(*yaw + math::angle_diff(*yaw, want) * k);
    }
}

fn step_toward(a: &mut Agent, target: Vec2, speed: f32, s: &Surroundings) -> Move {
    let dx = target.x - a.pos.x;
    let dz = target.y - a.pos.z;
    let d = (dx * dx + dz * dz).sqrt();
    if d < 0.35 {
        a.brain.moving = false;
        return Move::Arrived;
    }
    let (ux, uz) = (dx / d, dz / d);
    let step = (speed * SIM_DT).min(d);
    let (nx, nz) = (a.pos.x + ux * step, a.pos.z + uz * step);

    // One height sample decides everything: bounds, water depth and steepness along the move.
    let t = s.terrain;
    let g = t.height(nx, nz);
    let max_water = if a.sp.swims { 1.2 } else { 0.25 };
    let here = if a.brain.swimming { t.height(a.pos.x, a.pos.z) } else { a.pos.y };
    let rise = g - here;
    let s_len = step.max(1e-4);
    if !t.contains(nx, nz) || (t.sea_level() - g).max(0.0) >= max_water || rise > 0.9 * s_len || rise < -1.3 * s_len {
        a.brain.moving = false;
        return Move::Blocked;
    }
    let (y, swimming) = if a.sp.swims && t.sea_level() - g > 0.15 { (t.sea_level() - 0.12, true) } else { (g, false) };
    *a.pos = Vec3::new(nx, y, nz);
    a.brain.moving = true;
    a.brain.swimming = swimming;
    turn_toward(a.yaw, ux, uz, s.k_turn);
    Move::Moving
}

fn face(a: &mut Agent, toward: Vec3, s: &Surroundings) {
    turn_toward(a.yaw, toward.x - a.pos.x, toward.z - a.pos.z, s.k_turn);
}

/// A random walkable point within the wander radius of `home` (falls back to `home`).
pub fn pick_wander_target(sp: &Species, home: Vec3, rng: &mut Rng, terrain: &HeightQuery) -> Vec2 {
    for _ in 0..8 {
        let p = Vec2::new(home.x, home.z) + rng.in_disc(sp.wander_radius);
        if walkable(sp, terrain, p.x, p.y) {
            return p;
        }
    }
    Vec2::new(home.x, home.z)
}

/// Runs one 60 Hz AI step for one creature.
pub fn think(
    sp: &Species,
    home: Vec3,
    pos: &mut Vec3,
    yaw: &mut f32,
    brain: &mut Brain,
    rng: &mut Rng,
    s: &Surroundings,
    out: &mut Vec<AiEvent>,
) {
    let mut a = Agent { sp, pos, yaw, brain };
    a.brain.anim_t += SIM_DT;
    a.brain.aware_cooldown = (a.brain.aware_cooldown - SIM_DT).max(0.0);
    a.brain.mood += (0.5 - a.brain.mood) * 0.003;
    if a.brain.emote != emote::NONE {
        a.brain.emote_timer -= SIM_DT;
        if a.brain.emote_timer <= 0.0 && a.brain.state != State::Sleep {
            a.brain.emote = emote::NONE;
        }
    }
    a.brain.moving = false;

    let player = s.player;
    let player_d2 = player.map(|(_, p)| math::dist2_xz(p, *a.pos));

    // --- sleep / wake -------------------------------------------------------------------------
    if a.brain.state == State::Sleep {
        if !s.night && s.daylight > 0.4 {
            a.brain.enter(State::Idle, rng.range_f32(0.5, 4.0));
            a.brain.emote = emote::NONE;
            out.push(AiEvent::Woke);
        }
        return;
    }
    if s.night && matches!(a.brain.state, State::Idle | State::Wander) && rng.chance(1.0 / 150.0) {
        a.brain.enter(State::Sleep, f32::MAX);
        a.brain.focus = 0;
        a.brain.show(emote::ZZZ, f32::MAX, out);
        out.push(AiEvent::Slept);
        return;
    }

    // --- noticing the player ------------------------------------------------------------------
    if matches!(a.brain.state, State::Idle | State::Wander)
        && !s.night
        && a.brain.aware_cooldown <= 0.0
        && let (Some((pid, _)), Some(d2)) = (player, player_d2)
    {
        let r = sp.notice_radius * (0.55 + 0.45 * s.daylight);
        if d2 <= r * r {
            a.brain.enter(State::Notice, rng.range_f32(0.9, 1.4));
            a.brain.focus = pid;
            a.brain.aware_cooldown = rng.range_f32(12.0, 25.0);
            a.brain.mood = (a.brain.mood + 0.1).min(1.0);
            a.brain.show(emote::EXCLAIM, 1.2, out);
            out.push(AiEvent::Noticed);
            return;
        }
    }

    // --- state behaviour ----------------------------------------------------------------------
    match a.brain.state {
        State::Idle => {
            a.brain.timer -= SIM_DT;
            if a.brain.timer <= 0.0 {
                a.brain.target = pick_wander_target(sp, home, rng, s.terrain);
                a.brain.enter(State::Wander, 9.0);
            }
        }
        State::Wander => {
            a.brain.timer -= SIM_DT;
            let target = a.brain.target;
            match step_toward(&mut a, target, sp.walk_speed, s) {
                Move::Moving if a.brain.timer > 0.0 => {}
                _ => a.brain.enter(State::Idle, rng.range_f32(1.5, 4.5)),
            }
        }
        State::Notice => {
            if let Some((_, p)) = player {
                face(&mut a, p, s);
            }
            a.brain.timer -= SIM_DT;
            if a.brain.timer <= 0.0 {
                match sp.personality {
                    Personality::Curious => a.brain.enter(State::Approach, 7.0),
                    Personality::Shy => {
                        a.brain.mood = (a.brain.mood - 0.15).max(0.0);
                        a.brain.enter(State::Flee, rng.range_f32(2.0, 3.5));
                    }
                    Personality::Playful => {
                        a.brain.target = Vec2::ZERO; // forces a fresh hop target below
                        a.brain.enter(State::Play, rng.range_f32(3.0, 4.5));
                    }
                }
            }
        }
        State::Approach => {
            a.brain.timer -= SIM_DT;
            match player {
                Some((_, p)) if a.brain.timer > 0.0 => {
                    if player_d2.is_some_and(|d2| d2 <= sp.stop_distance * sp.stop_distance) {
                        face(&mut a, p, s);
                        a.brain.mood = (a.brain.mood + 0.25).min(1.0);
                        a.brain.show(emote::NOTE, 1.5, out);
                        a.brain.enter(State::Idle, rng.range_f32(3.0, 6.0));
                    } else if let Move::Blocked = step_toward(&mut a, Vec2::new(p.x, p.z), sp.walk_speed * 1.15, s) {
                        a.brain.enter(State::Idle, rng.range_f32(1.0, 2.5));
                    }
                }
                _ => a.brain.enter(State::Idle, rng.range_f32(1.0, 3.0)),
            }
        }
        State::Flee => {
            a.brain.timer -= SIM_DT;
            let safe = sp.notice_radius * 1.5;
            match player {
                Some((_, p)) if a.brain.timer > 0.0 && player_d2.is_some_and(|d2| d2 < safe * safe) => {
                    let away = Vec2::new(a.pos.x - p.x, a.pos.z - p.z);
                    let dir = if away.length_squared() > 1e-6 { away.normalize() } else { Vec2::X };
                    let mut goal = Vec2::new(a.pos.x, a.pos.z) + dir * 6.0;
                    let mut res = step_toward(&mut a, goal, sp.run_speed, s);
                    if let Move::Blocked = res {
                        // slide along the obstacle: try both perpendiculars
                        for side in [Vec2::new(-dir.y, dir.x), Vec2::new(dir.y, -dir.x)] {
                            goal = Vec2::new(a.pos.x, a.pos.z) + side * 6.0;
                            res = step_toward(&mut a, goal, sp.run_speed, s);
                            if !matches!(res, Move::Blocked) {
                                break;
                            }
                        }
                    }
                    if let Move::Blocked = res {
                        a.brain.enter(State::Idle, 1.0);
                    }
                }
                _ => {
                    a.brain.show(emote::QUESTION, 1.2, out);
                    a.brain.enter(State::Idle, rng.range_f32(2.0, 4.0));
                }
            }
        }
        State::Play => {
            a.brain.timer -= SIM_DT;
            // pick a fresh hop target around the player (or home) about once per second
            if a.brain.anim_t % 1.0 < SIM_DT || a.brain.target == Vec2::ZERO {
                let centre = player.map_or(home, |(_, p)| p);
                let t = Vec2::new(centre.x, centre.z) + rng.in_disc(sp.stop_distance + 1.0);
                if walkable(sp, s.terrain, t.x, t.y) {
                    a.brain.target = t;
                }
            }
            let target = a.brain.target;
            if let Move::Blocked = step_toward(&mut a, target, sp.run_speed * 0.8, s) {
                a.brain.target = Vec2::ZERO;
            }
            if a.brain.timer <= 0.0 {
                a.brain.mood = (a.brain.mood + 0.3).min(1.0);
                a.brain.show(emote::SPARKLE, 1.5, out);
                a.brain.enter(State::Idle, rng.range_f32(2.0, 5.0));
            }
        }
        State::Happy => {
            a.brain.timer -= SIM_DT;
            if a.brain.timer <= 0.0 {
                a.brain.enter(State::Idle, rng.range_f32(1.0, 3.0));
            }
        }
        State::Sleep => {}
    }
}

/// The player poked this creature: delight (unless asleep).
pub fn on_interact(brain: &mut Brain, out: &mut Vec<AiEvent>) {
    if brain.state == State::Sleep {
        return;
    }
    brain.mood = 1.0;
    brain.show(emote::HEART, 2.0, out);
    brain.enter(State::Happy, 1.6);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::species::{PUFFBUN, SPECIES, SPRIGFOX, TIDLER, species};
    use sim_core::terrain::{FlatTerrain, Terrain, TerrainBounds, biome};

    fn flat() -> HeightQuery {
        HeightQuery::new(FlatTerrain { height: 0.0, sea_level: -50.0, half_extent: 100.0 })
    }

    /// A shore running east: land (h = 1) for x <= -2, a gentle ramp down to shallows (h = -0.6) at
    /// x = 4, shallows until x = 10, then a steep fall into deep water (h = -5); sea level 0.
    struct Shore;
    impl Terrain for Shore {
        fn height(&self, x: f32, _z: f32) -> f32 {
            if x <= -2.0 {
                1.0
            } else if x < 4.0 {
                1.0 - (x + 2.0) * (1.6 / 6.0)
            } else if x < 10.0 {
                -0.6
            } else if x < 14.0 {
                -0.6 - (x - 10.0) * (4.4 / 4.0)
            } else {
                -5.0
            }
        }
        fn normal(&self, _x: f32, _z: f32) -> Vec3 {
            Vec3::Y
        }
        fn biome(&self, x: f32, z: f32) -> u8 {
            if self.height(x, z) >= 0.0 { biome::BEACH } else { biome::SHALLOW_WATER }
        }
        fn sea_level(&self) -> f32 {
            0.0
        }
        fn bounds(&self) -> TerrainBounds {
            TerrainBounds { min_x: -50.0, min_z: -50.0, max_x: 50.0, max_z: 50.0 }
        }
    }

    struct Rig {
        sp: &'static Species,
        home: Vec3,
        pos: Vec3,
        yaw: f32,
        brain: Brain,
        rng: Rng,
        events: Vec<AiEvent>,
        all: Vec<AiEvent>,
    }

    impl Rig {
        fn new(species_id: u8, pos: Vec3) -> Self {
            let mut rng = Rng::from_seed(77);
            let brain = Brain::new(&mut rng);
            Rig { sp: species(species_id), home: pos, pos, yaw: 0.0, brain, rng, events: Vec::new(), all: Vec::new() }
        }

        fn run(&mut self, terrain: &HeightQuery, player: Option<(u32, Vec3)>, night: bool, steps: usize) {
            let s = Surroundings { terrain, player, night, daylight: if night { 0.0 } else { 1.0 }, k_turn: math::damp_factor(6.0, SIM_DT) };
            for _ in 0..steps {
                self.events.clear();
                think(self.sp, self.home, &mut self.pos, &mut self.yaw, &mut self.brain, &mut self.rng, &s, &mut self.events);
                self.all.extend_from_slice(&self.events);
            }
        }
    }

    #[test]
    fn idles_then_wanders_around_home_and_stays_in_radius() {
        let t = flat();
        let mut r = Rig::new(PUFFBUN, Vec3::new(5.0, 0.0, 5.0));
        let mut wandered = false;
        let mut max_d = 0.0f32;
        let s = Surroundings { terrain: &t, player: None, night: false, daylight: 1.0, k_turn: math::damp_factor(6.0, SIM_DT) };
        for _ in 0..6000 {
            r.events.clear();
            think(r.sp, r.home, &mut r.pos, &mut r.yaw, &mut r.brain, &mut r.rng, &s, &mut r.events);
            wandered |= r.brain.state == State::Wander && r.brain.moving;
            max_d = max_d.max(math::dist2_xz(r.pos, r.home).sqrt());
        }
        assert!(wandered, "never wandered");
        assert!(max_d > 1.0, "barely moved: {max_d}");
        assert!(max_d <= r.sp.wander_radius + 0.5, "left its range: {max_d}");
    }

    #[test]
    fn speed_matches_the_species_table() {
        let t = flat();
        let mut r = Rig::new(SPRIGFOX, Vec3::ZERO);
        r.brain.enter(State::Wander, 5.0);
        r.brain.target = Vec2::new(40.0, 0.0);
        let before = r.pos;
        r.run(&t, None, false, 60);
        let moved = math::dist2_xz(before, r.pos).sqrt();
        assert!((moved - r.sp.walk_speed).abs() < 0.05, "moved {moved} m in 1 s, expected {}", r.sp.walk_speed);
        assert!(r.brain.moving);
        assert_eq!(r.brain.anim_state(), anim::WALK);
    }

    #[test]
    fn non_swimmers_never_enter_water_swimmers_float() {
        let t = HeightQuery::new(Shore);
        // A Puffbun that wants to walk into the sea stops at the shore.
        let mut r = Rig::new(PUFFBUN, Vec3::new(-3.0, 1.0, 0.0));
        r.brain.enter(State::Wander, 30.0);
        r.brain.target = Vec2::new(20.0, 0.0);
        r.run(&t, None, false, 600);
        // the water is 0.25 m deep at x = 2.69: it must stop on the dry side of that
        assert!(r.pos.x < 2.75 && r.pos.x > 1.0, "Puffbun x = {}", r.pos.x);

        // A Tidler wades through the shallows (floating) but never reaches deep water (depth 1.2 m
        // is at x = 10.55).
        let mut r = Rig::new(TIDLER, Vec3::new(-3.0, 1.0, 0.0));
        r.brain.enter(State::Wander, 60.0);
        r.brain.target = Vec2::new(20.0, 0.0);
        let (mut floated, mut max_x) = (false, f32::MIN);
        let s = Surroundings { terrain: &t, player: None, night: false, daylight: 1.0, k_turn: math::damp_factor(6.0, SIM_DT) };
        for _ in 0..3600 {
            think(r.sp, r.home, &mut r.pos, &mut r.yaw, &mut r.brain, &mut r.rng, &s, &mut Vec::new());
            floated |= r.brain.swimming && (r.pos.y - (-0.12)).abs() < 1e-4;
            max_x = max_x.max(r.pos.x);
        }
        assert!(floated, "Tidler never floated (max x {max_x})");
        assert!(max_x > 6.0, "Tidler should wade well into the shallows, max x {max_x}");
        assert!(max_x < 10.6, "Tidler entered deep water: max x = {max_x}");
    }

    #[test]
    fn nearby_player_is_noticed_once_with_an_event_and_emote() {
        let t = flat();
        let mut r = Rig::new(PUFFBUN, Vec3::ZERO);
        r.brain.aware_cooldown = 0.0;
        r.run(&t, Some((1, Vec3::new(5.0, 0.0, 0.0))), false, 5);
        assert_eq!(r.brain.state, State::Notice);
        assert_eq!(r.brain.focus, 1);
        assert_eq!(r.brain.emote, emote::EXCLAIM);
        assert!(r.all.contains(&AiEvent::Noticed));
        // face the player while noticing
        r.run(&t, Some((1, Vec3::new(5.0, 0.0, 0.0))), false, 40);
        assert!((r.yaw - math::PI / 2.0).abs() < 0.2, "yaw {}", r.yaw);
        assert_eq!(r.all.iter().filter(|e| **e == AiEvent::Noticed).count(), 1);
        // far-away player is ignored
        let mut far = Rig::new(PUFFBUN, Vec3::ZERO);
        far.brain.aware_cooldown = 0.0;
        far.run(&t, Some((1, Vec3::new(50.0, 0.0, 0.0))), false, 600);
        assert!(!far.all.contains(&AiEvent::Noticed));
    }

    #[test]
    fn personalities_diverge_after_noticing() {
        let t = flat();
        let player = Some((1, Vec3::new(6.0, 0.0, 0.0)));

        // curious Puffbun walks toward the player and stops at its stop distance
        let mut c = Rig::new(PUFFBUN, Vec3::ZERO);
        c.brain.aware_cooldown = 0.0;
        let mut closest = f32::MAX;
        for _ in 0..12 {
            c.run(&t, player, false, 60);
            closest = closest.min(math::dist2_xz(c.pos, Vec3::new(6.0, 0.0, 0.0)).sqrt());
        }
        assert!(closest < c.sp.stop_distance + 0.3, "curious creature never came close: {closest}");
        assert!(closest > c.sp.stop_distance - 0.3, "curious creature ignored its stop distance: {closest}");

        // shy Sprigfox runs away
        let mut s = Rig::new(SPRIGFOX, Vec3::ZERO);
        s.brain.aware_cooldown = 0.0;
        let d0 = math::dist2_xz(s.pos, Vec3::new(6.0, 0.0, 0.0)).sqrt();
        s.run(&t, player, false, 60 * 3);
        let d1 = math::dist2_xz(s.pos, Vec3::new(6.0, 0.0, 0.0)).sqrt();
        assert!(d1 > d0 + 2.0, "shy creature did not flee: {d0} -> {d1}");
        assert!(s.brain.mood < 0.5);
        assert_eq!(s.brain.anim_state(), anim::RUN);
        assert!(s.brain.flag_bits() >= flags::FLEEING);

        // playful Tidler hops about near the player
        let mut p = Rig::new(TIDLER, Vec3::new(0.0, 0.0, 0.0));
        p.brain.aware_cooldown = 0.0;
        p.run(&t, player, false, 60 * 3);
        assert!(p.all.contains(&AiEvent::Noticed));
        assert!(matches!(p.brain.state, State::Play | State::Idle));
    }

    #[test]
    fn creatures_sleep_at_night_and_wake_at_dawn() {
        let t = flat();
        let mut r = Rig::new(SPRIGFOX, Vec3::ZERO);
        r.run(&t, None, true, 60 * 30);
        assert_eq!(r.brain.state, State::Sleep, "should be asleep after 30 s of night");
        assert_eq!(r.brain.emote, emote::ZZZ);
        assert_eq!(r.brain.anim_state(), anim::SLEEP);
        assert!(r.brain.flag_bits() >= flags::ASLEEP);
        assert!(r.all.contains(&AiEvent::Slept));
        // night noticing is suppressed even with the player right there
        let before = r.all.iter().filter(|e| **e == AiEvent::Noticed).count();
        r.run(&t, Some((1, Vec3::new(1.0, 0.0, 0.0))), true, 120);
        assert_eq!(r.all.iter().filter(|e| **e == AiEvent::Noticed).count(), before);
        r.run(&t, None, false, 60 * 6);
        assert_ne!(r.brain.state, State::Sleep, "should have woken up");
        assert!(r.all.contains(&AiEvent::Woke));
        assert_eq!(r.brain.emote, emote::NONE);
    }

    #[test]
    fn interact_makes_it_happy_but_does_not_wake_sleepers() {
        let mut b = Brain::new(&mut Rng::from_seed(1));
        let mut out = Vec::new();
        on_interact(&mut b, &mut out);
        assert_eq!((b.state, b.emote, b.mood), (State::Happy, emote::HEART, 1.0));
        assert_eq!(b.anim_state(), anim::HAPPY);
        assert_eq!(out, vec![AiEvent::Emoted(emote::HEART)]);
        let mut sleeper = Brain::new(&mut Rng::from_seed(1));
        sleeper.state = State::Sleep;
        let mut out = Vec::new();
        on_interact(&mut sleeper, &mut out);
        assert_eq!(sleeper.state, State::Sleep);
        assert!(out.is_empty());
    }

    #[test]
    fn think_is_deterministic() {
        let t = flat();
        let run = || {
            let mut r = Rig::new(TIDLER, Vec3::new(2.0, 0.0, -3.0));
            for n in 0..30 {
                let p = Some((1, Vec3::new((n as f32 * 0.7).sin() * 20.0, 0.0, (n as f32 * 0.3).cos() * 20.0)));
                r.run(&t, p, n % 11 == 10, 120);
            }
            (r.pos, r.yaw, r.brain.clone(), r.rng.clone(), r.all.len())
        };
        let a = run();
        let b = run();
        assert_eq!(a.0, b.0);
        assert_eq!(a.1, b.1);
        assert_eq!(a.2, b.2);
        assert_eq!(a.3, b.3);
        assert_eq!(a.4, b.4);
    }

    #[test]
    fn species_table_indexing() {
        assert_eq!(SPECIES.len(), 3);
    }
}
