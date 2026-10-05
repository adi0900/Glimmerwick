//! [`GameCore`]: the whole game as plain Rust (no wasm-bindgen types), so it is testable and
//! benchmarkable natively. `lib.rs` wraps it 1:1 in the `Game` class exported to JS.

use sim_build::BuildPlugin;
use sim_core::{SaveFile, Sim};
use sim_creatures::CreaturesPlugin;
use sim_player::PlayerPlugin;
use sim_systems::SystemsPlugin;
use sim_world::WorldPlugin;

/// Builds the fully assembled simulation. Plugin order = save-section load order = dependency
/// order: world (terrain, spawn point) -> systems (clock / weather) -> player -> creatures -> build.
pub fn build_sim(seed: u32) -> Sim {
    Sim::build(seed, |app| {
        app.add_plugins((WorldPlugin, SystemsPlugin, PlayerPlugin, CreaturesPlugin, BuildPlugin));
    })
}

/// The simulation behind a `Game` handle.
pub struct GameCore {
    sim: Sim,
}

impl GameCore {
    pub fn new(seed: u32) -> Self {
        Self { sim: build_sim(seed) }
    }

    /// Runs `0..=5` fixed steps for a frame of `dt` seconds.
    pub fn tick(&mut self, dt: f32) {
        self.sim.tick(dt);
    }

    pub fn alpha(&self) -> f32 {
        self.sim.alpha()
    }

    pub fn set_input(&mut self, input: &[f32]) {
        self.sim.set_input(input);
    }

    pub fn command(&mut self, name: &str, json: &str) -> String {
        self.sim.command(name, json)
    }

    pub fn query(&self, name: &str, json: &str) -> String {
        self.sim.query(name, json)
    }

    pub fn channel_names(&self) -> String {
        self.sim.channel_names_json()
    }

    pub fn channel_info(&self, name: &str) -> String {
        self.sim.channel_info_json(name)
    }

    pub fn drain_events(&mut self) -> Vec<f32> {
        self.sim.drain_events()
    }

    /// Serialises the game. An empty vector means "could not save" (the error is logged).
    pub fn save(&mut self) -> Vec<u8> {
        match self.sim.save() {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!("save failed: {e}");
                Vec::new()
            }
        }
    }

    /// Loads a save atomically: the bytes are validated, a fresh simulation for the saved seed is
    /// built and restored, and only if everything succeeded does it replace the running one.
    /// On any failure the running game is untouched and `false` is returned.
    ///
    /// Channel pointers change on success - JS must re-read `channel_info` afterwards.
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        let file = match SaveFile::decode(bytes) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("load rejected: {e}");
                return false;
            }
        };
        let mut fresh = build_sim(file.seed);
        if let Err(e) = fresh.apply_save(&file) {
            log::warn!("load failed: {e}");
            return false;
        }
        self.sim = fresh;
        true
    }

    /// The underlying simulation (tests, benches, tools).
    pub fn sim(&self) -> &Sim {
        &self.sim
    }

    pub fn sim_mut(&mut self) -> &mut Sim {
        &mut self.sim
    }
}
