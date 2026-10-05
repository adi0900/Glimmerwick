//! Schedule vocabulary of the simulation.
//!
//! Every `App::update()` is exactly **one 60 Hz fixed step** (the driver in [`crate::Sim`] calls it
//! 0..=5 times per `Game::tick`). Gameplay systems therefore live in Bevy's ordinary `Update`
//! schedule - **not** `FixedUpdate` (no `TimePlugin` / wall clock exists in this sim; adding systems
//! to the `Fixed*` schedules is detected at start-up and panics) - and are ordered with [`SimSet`]:
//!
//! ```text
//! First -> Env -> Decide -> Move -> React -> Last          (all inside `Update`, in this order)
//! then PostUpdate, SimPublish (channel writers), Last schedule (core bookkeeping)
//! ```
//! Use `Res<SimClock>` / [`SimClock::DT`](crate::SimClock::DT) for time.
//!
//! * `First`   - core bookkeeping that must precede everything (clock tick, channel `prev := cur`).
//! * `Env`     - environment state others read: time of day, weather, terrain edits/regrowth.
//! * `Decide`  - intent: player input -> desired velocity, creature AI decisions.
//! * `Move`    - integrate movement / physics against the terrain.
//! * `React`   - consequences of the new positions: noticing, interaction targets, emotes, events.
//! * `Last`    - late per-step bookkeeping inside `Update`.
//!
//! Channel *publishing* (reading ECS state and writing [`Channels`](crate::Channels)) goes into the
//! [`SimPublish`] schedule so it also runs after `load` without advancing time.

use bevy_ecs::schedule::{ScheduleLabel, SystemSet};

/// Ordered phases inside `Update`; see the module docs.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimSet {
    First,
    Env,
    Decide,
    Move,
    React,
    Last,
}

/// Ordered phases of the `Startup` schedule (which `Sim::build` runs once, before the first tick).
/// Ids are allocated in this order: the player always gets id 1, creatures follow.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StartupSet {
    /// Terrain / world data exists (normally already built inside `Plugin::build`).
    World,
    /// Singleton actors: the player.
    Actors,
    /// Everything that is placed on the terrain: creatures, villagers, props.
    Population,
}

/// Schedule that runs after `PostUpdate` every step, and once after start-up / `load`.
/// Put systems here that copy ECS state into channels.
#[derive(ScheduleLabel, Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct SimPublish;
