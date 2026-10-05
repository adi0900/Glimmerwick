//! [`Sim`]: the driver that owns the Bevy `App` and implements every bridge operation in plain
//! Rust (so module crates and tests can use it natively; `bridge::Game` is a thin wasm-bindgen
//! wrapper around it).
//!
//! * `Sim::build(seed, |app| { app.add_plugins(...) })` creates the app with [`CorePlugin`], lets the
//!   caller add module plugins, runs `Startup` once and publishes the initial channels, so the
//!   world is fully usable (channels, queries) before the first `tick`.
//! * `tick(dt)` feeds the [`FixedStep`] accumulator and runs `App::update()` once per fixed step.
//! * `save` / `apply_save` implement the save container; **`apply_save` modifies the sim in
//!   place and can leave it half-restored on error** - to load atomically, build a fresh `Sim`
//!   with the seed from `SaveFile::decode(..).seed`, apply into it and swap on success (this is
//!   what `bridge` does).

use crate::channels::Channels;
use crate::events::{EventBus, core_events};
use crate::input::Input;
use crate::registry::{CommandRegistry, QueryRegistry};
use crate::rng::SimSeed;
use crate::save::{SaveFile, SaveSections};
use crate::sets::SimPublish;
use crate::step::{FixedStep, SimClock};
use crate::{CorePlugin, Vec3};
use bevy_app::{App, FixedFirst, FixedLast, FixedPostUpdate, FixedPreUpdate, FixedUpdate, MainScheduleOrder};
use bevy_ecs::prelude::World;
use bevy_ecs::schedule::ScheduleLabel;
use serde_json::json;

/// Simulation driver (see module docs).
pub struct Sim {
    app: App,
    step: FixedStep,
    seed: u32,
}

/// Systems in the `Fixed*` schedules would silently never run (there is no wall-clock `Time`);
/// fail loudly at build time instead.
fn forbid_fixed_schedules(app: &App) {
    fn check(app: &App, label: impl ScheduleLabel + Clone) {
        assert!(
            app.get_schedule(label.clone()).is_none(),
            "systems were added to {label:?}, which never runs in this sim - add them to `Update` ordered with `SimSet` (see sim_core::sets)"
        );
    }
    check(app, FixedFirst);
    check(app, FixedPreUpdate);
    check(app, FixedUpdate);
    check(app, FixedPostUpdate);
    check(app, FixedLast);
}

impl Sim {
    /// Creates the app, runs `configure` to add module plugins, starts it. See module docs.
    pub fn build(seed: u32, configure: impl FnOnce(&mut App)) -> Sim {
        let mut app = App::new();
        app.insert_resource(SimSeed::from_u32(seed));
        app.add_plugins(CorePlugin);
        configure(&mut app);
        Self::start(app, seed)
    }

    fn start(mut app: App, seed: u32) -> Sim {
        forbid_fixed_schedules(&app);
        app.finish();
        app.cleanup();

        // Run the Startup family exactly once, now, instead of inside the first tick.
        let startup = std::mem::take(&mut app.world_mut().resource_mut::<MainScheduleOrder>().startup_labels);
        for label in startup {
            let _ = app.world_mut().try_run_schedule(label);
        }
        app.world_mut().run_schedule(SimPublish);
        app.world_mut().resource_mut::<Channels>().snap_all();
        Sim { app, step: FixedStep::new(), seed }
    }

    // --- stepping ---------------------------------------------------------------------------

    /// Advances by `dt` real seconds; runs `0..=5` fixed steps. Returns the number of steps run.
    pub fn tick(&mut self, dt: f32) -> u32 {
        let steps = self.step.advance(dt);
        for _ in 0..steps {
            self.app.update();
        }
        let dropped = self.step.take_dropped_secs();
        if dropped > 0.0 {
            self.app.world_mut().resource_mut::<EventBus>().emit(core_events::FRAME_DROP, dropped, 0.0, Vec3::ZERO, 0.0);
        }
        steps
    }

    /// Runs exactly one fixed step (tests, tools). Does not touch the accumulator.
    pub fn step_once(&mut self) {
        self.app.update();
    }

    /// Render interpolation factor `0..1` between the last two steps.
    pub fn alpha(&self) -> f32 {
        self.step.alpha()
    }

    /// Fixed steps executed so far.
    pub fn tick_count(&self) -> u64 {
        self.app.world().resource::<SimClock>().tick
    }

    // --- bridge operations ---------------------------------------------------------------------

    /// `Game::set_input`.
    pub fn set_input(&mut self, raw: &[f32]) {
        self.app.world_mut().resource_mut::<Input>().apply_raw(raw);
    }

    /// `Game::command`. After the handler ran, every channel is re-published (without advancing
    /// time) so JS sees the effect immediately and `prev` stays consistent: a teleported player
    /// does not interpolate across the map, a spawned creature does not pop in from zero.
    pub fn command(&mut self, name: &str, json: &str) -> String {
        let result = CommandRegistry::call(self.app.world_mut(), name, json);
        let world = self.app.world_mut();
        world.run_schedule(SimPublish);
        world.resource_mut::<Channels>().end_step();
        result
    }

    /// `Game::query`.
    pub fn query(&self, name: &str, json: &str) -> String {
        QueryRegistry::call(self.app.world(), name, json)
    }

    /// `Game::channel_names` (JSON array, registration order).
    pub fn channel_names_json(&self) -> String {
        serde_json::to_string(&self.app.world().resource::<Channels>().names()).unwrap_or_else(|_| "[]".to_string())
    }

    /// `Game::channel_info` (JSON object, or `{"error":...}` for an unknown channel).
    pub fn channel_info_json(&self, name: &str) -> String {
        match self.app.world().resource::<Channels>().info(name) {
            Some(info) => serde_json::to_string(&info).unwrap_or_else(|e| json!({ "error": e.to_string() }).to_string()),
            None => json!({ "error": format!("unknown channel '{name}'") }).to_string(),
        }
    }

    /// `Game::drain_events`.
    pub fn drain_events(&mut self) -> Vec<f32> {
        self.app.world_mut().resource_mut::<EventBus>().drain()
    }

    /// Determinism fingerprint of all channels.
    pub fn digest(&self) -> u64 {
        self.app.world().resource::<Channels>().digest()
    }

    // --- save / load -------------------------------------------------------------------------

    /// `Game::save`.
    pub fn save(&self) -> Result<Vec<u8>, String> {
        let world = self.app.world();
        SaveFile {
            seed: self.seed,
            tick: world.resource::<SimClock>().tick,
            acc_ns: self.step.acc_ns(),
            sections: SaveSections::collect(world)?,
        }
        .encode()
    }

    /// Applies a decoded save to this sim (see module docs for atomicity).
    pub fn apply_save(&mut self, file: &SaveFile) -> Result<(), String> {
        SaveSections::apply(self.app.world_mut(), file)?;
        let world = self.app.world_mut();
        world.resource_mut::<SimClock>().tick = file.tick;
        world.resource_mut::<EventBus>().clear();
        world.run_schedule(SimPublish);
        world.resource_mut::<Channels>().snap_all();
        self.step.set_acc_ns(file.acc_ns);
        world.resource_mut::<EventBus>().emit(core_events::LOADED, (file.tick & 0x00FF_FFFF) as f32, 0.0, Vec3::ZERO, 0.0);
        Ok(())
    }

    // --- access ------------------------------------------------------------------------------

    /// The seed this sim was built with.
    pub fn seed(&self) -> u32 {
        self.seed
    }

    pub fn world(&self) -> &World {
        self.app.world()
    }

    pub fn world_mut(&mut self) -> &mut World {
        self.app.world_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_ext::SimAppExt;
    use crate::channels::{ChannelId, ChannelSpec};
    use crate::sets::SimSet;
    use bevy_app::{Plugin, Update};
    use bevy_ecs::prelude::*;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(Resource)]
    struct Chans {
        counter: ChannelId<f32>,
    }

    #[derive(Resource, Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
    struct Counter {
        n: u32,
        speed: f32,
    }

    struct TestPlugin;
    impl Plugin for TestPlugin {
        fn build(&self, app: &mut App) {
            let counter = app.register_channel::<f32>(ChannelSpec::records::<f32>("test.counter", 2, 1).interpolated());
            app.insert_resource(Chans { counter })
                .insert_resource(Counter { n: 0, speed: 1.0 })
                .add_systems(Update, (|mut c: ResMut<Counter>| c.n += 1).in_set(SimSet::Decide))
                .add_systems(SimPublish, |c: Res<Counter>, ids: Res<Chans>, mut ch: ResMut<Channels>| {
                    let mut w = ch.writer(ids.counter);
                    w.clear();
                    w.extend_from_slice(&[c.n as f32, c.speed]);
                })
                .register_command("test.speed", |w: &mut World, a: Value| {
                    w.resource_mut::<Counter>().speed = a["speed"].as_f64().ok_or("speed required")? as f32;
                    Ok(())
                })
                .register_query("test.counter", |w: &World, _: Value| Ok(w.resource::<Counter>().clone()))
                .register_save_section(
                    "test",
                    1,
                    |w: &World| w.resource::<Counter>().clone(),
                    |w: &mut World, c: Counter| {
                        *w.resource_mut::<Counter>() = c;
                        Ok(())
                    },
                );
        }
    }

    fn sim() -> Sim {
        Sim::build(7, |app| {
            app.add_plugins(TestPlugin);
        })
    }

    #[test]
    fn builds_and_publishes_before_first_tick() {
        let s = sim();
        assert_eq!(s.tick_count(), 0);
        assert!(s.channel_names_json().contains("test.counter"));
        let info: Value = serde_json::from_str(&s.channel_info_json("test.counter")).unwrap();
        assert_eq!(info["len"], 2);
        assert_eq!(info["stride"], 2);
        assert!(s.channel_info_json("nope").contains("unknown channel"));
    }

    #[test]
    fn tick_runs_whole_steps_and_double_buffers() {
        let mut s = sim();
        assert_eq!(s.tick(1.0 / 60.0), 1);
        assert_eq!(s.tick(1.0 / 60.0), 1);
        assert_eq!(s.tick_count(), 2);
        let ch = s.world().resource::<Channels>();
        let id = s.world().resource::<Chans>().counter;
        assert_eq!(ch.slice(id), &[2.0, 1.0]);
        assert_eq!(ch.prev_slice(id), &[1.0, 1.0]);
        assert_eq!(s.tick(0.0), 0);
        assert_eq!(s.tick(0.016), 0, "leaves ~0.96 of a step in the accumulator");
        assert_eq!(s.tick(0.5), 5, "0.116 s = 6.96 steps: capped at 5, one step dropped");
        assert_eq!(s.tick_count(), 7);
        assert!((0.0..1.0).contains(&s.alpha()));
        // the overrun produced a FRAME_DROP event
        let ev = s.drain_events();
        assert_eq!(ev[0], f32::from(core_events::FRAME_DROP.0));
    }

    #[test]
    fn commands_and_queries_route_to_handlers() {
        let mut s = sim();
        assert_eq!(s.command("test.speed", r#"{"speed":3.5}"#), "{}");
        assert!(s.command("test.speed", "{}").contains("speed required"));
        s.step_once();
        assert_eq!(s.query("test.counter", ""), r#"{"n":1,"speed":3.5}"#);
        let digest: Value = serde_json::from_str(&s.query("core.digest", "")).unwrap();
        assert_eq!(digest["tick"], 1);
        assert_eq!(digest["digest"].as_str().unwrap().len(), 16);
        let stats: Value = serde_json::from_str(&s.query("core.stats", "")).unwrap();
        assert!(stats["channels"].as_array().unwrap().iter().any(|c| c["name"] == "test.counter"));
        assert!(stats["commands"].as_array().unwrap().iter().any(|c| c == "test.speed"));
    }

    #[test]
    fn save_load_roundtrip_in_fresh_sim() {
        let mut a = sim();
        a.command("test.speed", r#"{"speed":2.0}"#);
        for _ in 0..30 {
            a.tick(1.0 / 60.0);
        }
        let bytes = a.save().unwrap();
        for _ in 0..30 {
            a.tick(1.0 / 60.0);
        }
        let want = a.digest();

        let file = SaveFile::decode(&bytes).unwrap();
        assert_eq!(file.seed, 7);
        assert_eq!(file.tick, 30);
        let mut b = Sim::build(file.seed, |app| {
            app.add_plugins(TestPlugin);
        });
        b.apply_save(&file).unwrap();
        assert_eq!(b.tick_count(), 30);
        for _ in 0..30 {
            b.tick(1.0 / 60.0);
        }
        assert_eq!(b.digest(), want, "loaded sim diverged from the original");
        // LOADED event was queued
        assert!(b.drain_events().chunks(7).any(|e| e[0] == f32::from(core_events::LOADED.0)));
    }

    #[test]
    fn input_reaches_the_resource_with_latching() {
        let mut s = sim();
        s.set_input(&[1.0, 0.0, 4.0, 0.0, 1.0]);
        assert!(s.world().resource::<Input>().just_pressed(crate::buttons::JUMP));
        s.step_once(); // `Last` consumes the latches
        let i = s.world().resource::<Input>();
        assert!(i.held(crate::buttons::JUMP));
        assert!(!i.just_pressed(crate::buttons::JUMP));
        assert_eq!(i.look_dx, 0.0);
        assert_eq!(i.move_x, 1.0);
    }

    #[test]
    #[should_panic(expected = "never runs in this sim")]
    fn fixed_update_systems_are_rejected() {
        Sim::build(1, |app| {
            app.add_systems(FixedUpdate, || {});
        });
    }
}
