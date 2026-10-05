//! # sim_core - plumbing shared by every Glimmerwick simulation crate
//!
//! The simulation is a headless Bevy ECS `App` compiled to WASM. `sim_core` provides everything the
//! module crates (`sim_world`, `sim_player`, `sim_creatures`, `sim_build`, `sim_systems`) and the
//! `bridge` need so that they stay independent of each other:
//!
//! | piece | module |
//! |---|---|
//! | 60 Hz fixed-step driver (`alpha`, max 5 steps) + [`Sim`] wrapper | [`step`], [`sim`] |
//! | seeded, splittable, platform-independent RNG | [`rng`] |
//! | decoded + latched player input | [`input`] |
//! | one-shot events with reserved kind ranges | [`events`] |
//! | zero-copy typed-array channels (double-buffered when interpolated) | [`channels`] |
//! | command / query registries (JSON in, JSON out) | [`registry`] |
//! | save container + per-module sections | [`save`] |
//! | terrain access without depending on `sim_world` | [`terrain`] |
//! | shared components, ids, schedule sets, deterministic math | [`components`], [`ids`], [`sets`], [`math`] |
//!
//! Module crates register what they expose through [`SimAppExt`] (one call per channel / command /
//! query / event / save section). See `docs/BRIDGE_API.md` for the authoritative contract.
//!
//! Determinism rules for every crate: randomness only through [`Rng`]; transcendental math only via
//! [`math`] (libm); no `HashMap` iteration in sim logic; no `std::time`; iterate entities in a
//! stable order (sort by [`Id`]) whenever order is observable.

pub mod app_ext;
pub mod blocks; // voxel-world owner (docs/ARCHITECTURE.md 4b): block registry + raycast / aabb_sweep
pub mod channels;
pub mod components;
pub mod environment;
pub mod events;
pub mod ids;
pub mod input;
pub mod math;
pub mod messages;
pub mod registry;
pub mod rng;
pub mod save;
pub mod sets;
pub mod sim;
pub mod step;
pub mod terrain;

// Re-exports so module crates can name the underlying engine crates through sim_core
// (they still list `bevy_ecs` / `bevy_app` in their own Cargo.toml for the derive macros).
pub use bevy_app;
pub use bevy_ecs;
pub use glam;
pub use serde_json;

pub use app_ext::SimAppExt;
pub use channels::{ChannelElem, ChannelId, ChannelInfo, ChannelKind, ChannelSpec, ChannelWriter, Channels};
pub use components::{Interactable, Player, Position, Velocity, Yaw};
pub use environment::{Environment, weather};
pub use events::{EventBus, EventDomain, EventKind, EventRegistry, core_events};
pub use ids::{Id, IdAllocator, IdIndex};
pub use input::{Input, buttons};
pub use math::{Vec2, Vec3};
pub use messages::Interact;
pub use registry::{CommandRegistry, QueryRegistry};
pub use rng::{Rng, SimSeed};
pub use save::{SaveFile, SaveSections};
pub use sets::{SimPublish, SimSet, StartupSet};
pub use sim::Sim;
pub use step::{FixedStep, MAX_STEPS_PER_TICK, SIM_DT, STEP_HZ, SimClock};
pub use terrain::{HeightQuery, SpawnPoints, Terrain, TerrainBounds, biome};

use bevy_app::{App, MainScheduleOrder, Plugin, PostUpdate, Update};
use bevy_ecs::prelude::*;
use bevy_ecs::schedule::Schedule;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Installs the core resources, schedules, bookkeeping systems and the `core.*` queries.
/// Added automatically by [`Sim::build`]; must be the first plugin.
pub struct CorePlugin;

/// The `core` save section: global counters that are not owned by a module.
#[derive(Serialize, Deserialize)]
struct CoreSave {
    next_id: u32,
}

impl Plugin for CorePlugin {
    fn build(&self, app: &mut App) {
        assert!(app.world().contains_resource::<SimSeed>(), "insert SimSeed before CorePlugin (use Sim::build)");

        app.init_resource::<SimClock>()
            .init_resource::<Input>()
            .init_resource::<Channels>()
            .init_resource::<EventBus>()
            .init_resource::<EventRegistry>()
            .init_resource::<CommandRegistry>()
            .init_resource::<QueryRegistry>()
            .init_resource::<SaveSections>()
            .init_resource::<IdAllocator>()
            .init_resource::<IdIndex>()
            .init_resource::<SpawnPoints>()
            .init_resource::<Environment>()
            .insert_resource(HeightQuery::default())
            .add_message::<Interact>();

        // Publishing runs after PostUpdate (and before the `Last` schedule's bookkeeping).
        app.add_schedule(Schedule::new(SimPublish));
        app.world_mut().resource_mut::<MainScheduleOrder>().insert_after(PostUpdate, SimPublish);

        app.configure_sets(
            Update,
            (SimSet::First, SimSet::Env, SimSet::Decide, SimSet::Move, SimSet::React, SimSet::Last).chain(),
        );
        app.configure_sets(bevy_app::Startup, (StartupSet::World, StartupSet::Actors, StartupSet::Population).chain());
        app.add_systems(Update, (tick_clock, begin_step).in_set(SimSet::First));
        app.add_systems(bevy_app::Last, (end_step, consume_input));

        register_core_api(app);
    }
}

fn tick_clock(mut clock: ResMut<SimClock>) {
    clock.tick += 1;
}

/// `prev := cur` for interpolated channels.
fn begin_step(mut channels: ResMut<Channels>) {
    channels.begin_step();
}

/// Mirror new records into `prev`, apply snaps (runs after `SimPublish`).
fn end_step(mut channels: ResMut<Channels>) {
    channels.end_step();
}

fn consume_input(mut input: ResMut<Input>) {
    input.consume_latches();
}

fn register_core_api(app: &mut App) {
    app.register_save_section(
        "core",
        1,
        |w: &World| CoreSave { next_id: w.resource::<IdAllocator>().peek() },
        |w: &mut World, s: CoreSave| {
            w.resource_mut::<IdAllocator>().set_next(s.next_id);
            Ok(())
        },
    );

    // core.digest -> determinism fingerprint of every channel (tests, smoke script, replays)
    app.register_query("core.digest", |w: &World, _: Value| {
        Ok(json!({
            "digest": format!("{:016x}", w.resource::<Channels>().digest()),
            "tick": w.resource::<SimClock>().tick,
        }))
    });

    // core.stats -> overview for debugging tools
    app.register_query("core.stats", |w: &World, _: Value| {
        let channels = w.resource::<Channels>();
        let chans: Vec<Value> = channels
            .specs()
            .map(|s| {
                let info = channels.info(s.name);
                json!({
                    "name": s.name, "kind": s.kind.as_str(), "stride": s.stride, "cap": s.cap,
                    "interpolated": s.interpolated, "len": info.as_ref().map(|i| i.len), "version": info.as_ref().map(|i| i.version),
                    "doc": s.doc,
                })
            })
            .collect();
        Ok(json!({
            "tick": w.resource::<SimClock>().tick,
            "entities": w.entities().count_spawned(),
            "channels": chans,
            "channels_overflowed": channels.overflowed(),
            "events_dropped": w.resource::<EventBus>().dropped(),
            "commands": w.resource::<CommandRegistry>().names(),
            "queries": w.resource::<QueryRegistry>().names(),
            "save_sections": w.resource::<SaveSections>().names(),
        }))
    });

    // core.events -> table of documented event kinds
    app.register_query("core.events", |w: &World, _: Value| {
        let list: Vec<Value> = w
            .resource::<EventRegistry>()
            .entries
            .iter()
            .map(|e| {
                json!({ "kind": e.kind.0, "name": e.name, "doc": e.doc, "domain": e.kind.domain().map(|d| d.name()) })
            })
            .collect();
        Ok(json!(list))
    });

    app.register_event(core_events::LOADED, "core.loaded", "a = restored tick (low 24 bits); JS should re-read channel_info");
    app.register_event(core_events::FRAME_DROP, "core.frame_drop", "a = seconds of simulation time dropped (sim fell behind)");
}
