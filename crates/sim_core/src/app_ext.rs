//! `App` extension used by module plugins to register everything the bridge exposes.
//! Each registration is a single call (the closure body aside), e.g. inside `Plugin::build`:
//!
//! ```ignore
//! let id = app.register_channel::<f32>(ChannelSpec::records::<f32>("player", 16, 1).interpolated());
//! app.register_command("player.set_tool", |w: &mut World, a: ToolArgs| { /* mutate */ Ok(()) })
//!    .register_query("player.info", |w: &World, _: Value| Ok(json!({ "x": 1 })))
//!    .register_event(EV_JUMP, "player.jump", "a=0 b=0 pos=feet f=jump speed")
//!    .register_save_section("player", 1, |w| PlayerSave::capture(w), |w, s| s.restore(w));
//! ```
//! All of these panic with a clear message if `CorePlugin` is missing or a name is registered
//! twice - build-time programmer errors that can never be triggered from JS.

use crate::channels::{ChannelElem, ChannelId, ChannelSpec, Channels};
use crate::events::{EventKind, EventRegistry};
use crate::registry::{CommandRegistry, QueryRegistry};
use crate::rng::SimSeed;
use crate::save::SaveSections;
use bevy_app::App;
use bevy_ecs::prelude::World;
use serde::{Serialize, de::DeserializeOwned};

pub trait SimAppExt {
    /// Registers a channel and returns its typed handle.
    fn register_channel<T: ChannelElem>(&mut self, spec: ChannelSpec) -> ChannelId<T>;

    /// Registers a mutating command (`Game::command`).
    fn register_command<A, R>(
        &mut self,
        name: &'static str,
        handler: impl Fn(&mut World, A) -> Result<R, String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        A: DeserializeOwned,
        R: Serialize;

    /// Registers a read-only query (`Game::query`).
    fn register_query<A, R>(
        &mut self,
        name: &'static str,
        handler: impl Fn(&World, A) -> Result<R, String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        A: DeserializeOwned,
        R: Serialize;

    /// Documents an event kind (name + payload description) in the registry (`core.events`).
    fn register_event(&mut self, kind: EventKind, name: &'static str, doc: &'static str) -> &mut Self;

    /// Registers a serde-encoded save section (see [`crate::save`]).
    fn register_save_section<T>(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> T + Send + Sync + 'static,
        load: impl Fn(&mut World, T) -> Result<(), String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        T: Serialize + DeserializeOwned + 'static;

    /// Registers a raw-bytes save section that can migrate old versions.
    fn register_save_section_raw(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> Result<Vec<u8>, String> + Send + Sync + 'static,
        load: impl Fn(&mut World, u16, &[u8]) -> Result<(), String> + Send + Sync + 'static,
    ) -> &mut Self;

    /// The world seed (root of every random stream).
    fn sim_seed(&self) -> SimSeed;
}

const MISSING_CORE: &str = "sim_core::CorePlugin is missing - build the app with `Sim::build` (or add CorePlugin first)";

impl SimAppExt for App {
    fn register_channel<T: ChannelElem>(&mut self, spec: ChannelSpec) -> ChannelId<T> {
        self.world_mut().get_resource_mut::<Channels>().expect(MISSING_CORE).register::<T>(spec)
    }

    fn register_command<A, R>(
        &mut self,
        name: &'static str,
        handler: impl Fn(&mut World, A) -> Result<R, String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        A: DeserializeOwned,
        R: Serialize,
    {
        self.world_mut().get_resource_mut::<CommandRegistry>().expect(MISSING_CORE).register(name, handler);
        self
    }

    fn register_query<A, R>(
        &mut self,
        name: &'static str,
        handler: impl Fn(&World, A) -> Result<R, String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        A: DeserializeOwned,
        R: Serialize,
    {
        self.world_mut().get_resource_mut::<QueryRegistry>().expect(MISSING_CORE).register(name, handler);
        self
    }

    fn register_event(&mut self, kind: EventKind, name: &'static str, doc: &'static str) -> &mut Self {
        self.world_mut().get_resource_mut::<EventRegistry>().expect(MISSING_CORE).register(kind, name, doc);
        self
    }

    fn register_save_section<T>(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> T + Send + Sync + 'static,
        load: impl Fn(&mut World, T) -> Result<(), String> + Send + Sync + 'static,
    ) -> &mut Self
    where
        T: Serialize + DeserializeOwned + 'static,
    {
        self.world_mut().get_resource_mut::<SaveSections>().expect(MISSING_CORE).register(name, version, save, load);
        self
    }

    fn register_save_section_raw(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> Result<Vec<u8>, String> + Send + Sync + 'static,
        load: impl Fn(&mut World, u16, &[u8]) -> Result<(), String> + Send + Sync + 'static,
    ) -> &mut Self {
        self.world_mut().get_resource_mut::<SaveSections>().expect(MISSING_CORE).register_raw(name, version, save, load);
        self
    }

    fn sim_seed(&self) -> SimSeed {
        *self.world().get_resource::<SimSeed>().expect(MISSING_CORE)
    }
}
