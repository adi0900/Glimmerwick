//! # bridge - the Rust <-> JS boundary
//!
//! Exports the wasm-bindgen class [`Game`] exactly as specified in `docs/BRIDGE_API.md` (contract
//! v1): `new, tick, alpha, set_input, command, query, channel_names, channel_info, drain_events,
//! save, load`, plus the free function [`build_info`].
//!
//! Everything reachable from JS is panic-free by construction: bad names / JSON become
//! `{"error": ...}` strings, `load` returns `false` for any corrupt save, `set_input` sanitises
//! NaN/Inf, `tick` clamps `dt`. A panic that still happens (a bug) is logged to the JS console by
//! the panic hook; after it the wasm instance must be considered dead (wasm cannot unwind).
//!
//! The logic lives in [`GameCore`] (plain Rust) so it can be tested natively; this file is only
//! the thin wasm-bindgen wrapper, the panic hook and a `log` -> `console` bridge.

mod game;

pub use game::{GameCore, build_sim};

use wasm_bindgen::prelude::*;

/// Version of the JS contract (bumped on breaking changes to `Game`, channel layouts or events).
pub const CONTRACT_VERSION: u32 = 1;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(msg: &str);
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(msg: &str);
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(msg: &str);
}

/// `log` facade -> `console.*` (Bevy and our crates log through `log`).
#[cfg(target_arch = "wasm32")]
struct ConsoleLogger;

#[cfg(target_arch = "wasm32")]
impl log::Log for ConsoleLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!("[{}] {}", record.target(), record.args());
        match record.level() {
            log::Level::Error => console_error(&line),
            log::Level::Warn => console_warn(&line),
            _ => console_log(&line),
        }
    }

    fn flush(&self) {}
}

/// Runs automatically when the wasm module is instantiated (wasm `start` function); not exported
/// to JS.
#[wasm_bindgen(start)]
fn start() {
    #[cfg(target_arch = "wasm32")]
    {
        static LOGGER: ConsoleLogger = ConsoleLogger;
        // Panics: log to the console with the source location. (wasm cannot unwind, so the
        // instance is dead afterwards; the message is what makes the failure debuggable.)
        std::panic::set_hook(Box::new(|info| console_error(&format!("[glimmerwick-sim] PANIC: {info}"))));
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
    }
}

/// JSON describing this build: `{"contract":1,"bridge":"0.1.0","bevy_ecs":"0.19.1","debug_assertions":false}`.
#[wasm_bindgen]
pub fn build_info() -> String {
    format!(
        "{{\"contract\":{CONTRACT_VERSION},\"bridge\":\"{}\",\"bevy_ecs\":\"0.19.1\",\"debug_assertions\":{}}}",
        env!("CARGO_PKG_VERSION"),
        cfg!(debug_assertions)
    )
}

/// The simulation handle used by the web side (one per page).
#[wasm_bindgen]
pub struct Game {
    core: GameCore,
}

#[wasm_bindgen]
impl Game {
    /// Creates a world from a seed (generates the island, spawns the player and creatures).
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> Game {
        Game { core: GameCore::new(seed) }
    }

    /// Once per rendered frame with the real frame time in seconds: runs 0..=5 fixed 60 Hz steps
    /// (`dt` is clamped to 0.1 s; NaN / negative values count as 0).
    pub fn tick(&mut self, dt: f32) {
        self.core.tick(dt);
    }

    /// Progress `0..1` between the last two fixed steps, for render interpolation.
    pub fn alpha(&self) -> f32 {
        self.core.alpha()
    }

    /// Sets the input for the following steps; layout: see `docs/BRIDGE_API.md` (16 floats).
    pub fn set_input(&mut self, input: &[f32]) {
        self.core.set_input(input);
    }

    /// Mutates the simulation. Returns JSON: `{}` / a result object, or `{"error":"..."}`.
    pub fn command(&mut self, name: &str, json: &str) -> String {
        self.core.command(name, json)
    }

    /// Read-only JSON for UI/HUD. Returns a result object or `{"error":"..."}`.
    pub fn query(&self, name: &str, json: &str) -> String {
        self.core.query(name, json)
    }

    /// JSON array of channel names.
    pub fn channel_names(&self) -> String {
        self.core.channel_names()
    }

    /// JSON `{"ptr","prev_ptr","len","cap","stride","kind","version"}` (or `{"error"}`).
    pub fn channel_info(&self, name: &str) -> String {
        self.core.channel_info(name)
    }

    /// Packed events, stride 7: `[kind,a,b,x,y,z,f]*n`; clears the queue.
    pub fn drain_events(&mut self) -> Vec<f32> {
        self.core.drain_events()
    }

    /// Serialised game (versioned, checksummed). Empty array = failure (logged).
    pub fn save(&mut self) -> Vec<u8> {
        self.core.save()
    }

    /// Restores a save atomically. `false` = rejected, nothing changed. After `true` re-read
    /// `channel_info` (pointers changed).
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        self.core.load(bytes)
    }
}
