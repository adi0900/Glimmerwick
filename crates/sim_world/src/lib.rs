//! # sim_world - the island
//!
//! Reference slice: a seeded 128 x 128 m island (fbm hills + domain-warped falloff, sea level 0, six
//! biomes) published through
//! * channel `world.height` (`f32`, `size_x * size_z`, row-major, metres) and `world.biome` (`u8`),
//! * channel `world.dirty` (`u32` chunk indices edited since the last step; always empty for now),
//! * channel `flora` (`f32`, stride 8, static),
//! * query `world.info`,
//! * the [`HeightQuery`](sim_core::HeightQuery) resource that every other crate samples.
//!
//! The world owner replaces the internals (bigger / finer island, terraforming, real flora rules)
//! but **must keep the channel names, layouts and `world.info` keys** documented in
//! `docs/BRIDGE_API.md`.

mod flora;
mod heightfield;
mod noise;

pub use flora::{FLORA_STRIDE, KIND_NAMES, MAX_FLORA, kind as flora_kind};
pub use heightfield::{CELL, CHUNK, Heightfield, SIZE, WorldTerrain};

use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::terrain::biome;
use sim_core::{ChannelId, ChannelSpec, Channels, HeightQuery, SimAppExt, SimPublish, SimSet, SpawnPoints};
use std::sync::Arc;

/// The generated world (resource).
#[derive(Resource)]
pub struct WorldData {
    pub field: Arc<Heightfield>,
    /// Packed flora records ([`FLORA_STRIDE`] floats each).
    pub flora: Vec<f32>,
    /// The `u32` noise seed the field was generated from.
    pub seed: u32,
}

/// Typed handles of this crate's channels.
#[derive(Resource, Clone, Copy)]
pub struct WorldChannels {
    pub height: ChannelId<f32>,
    pub biome: ChannelId<u8>,
    pub dirty: ChannelId<u32>,
    pub flora: ChannelId<f32>,
}

pub struct WorldPlugin;

/// Save section payload: the world is regenerated from the seed, so only the seed (to detect a
/// mismatch) and, later, terrain edits are stored.
#[derive(Serialize, Deserialize)]
struct WorldSave {
    seed: u32,
}

impl Plugin for WorldPlugin {
    fn build(&self, app: &mut App) {
        let sim_seed = app.sim_seed();
        let seed = sim_seed.noise_seed("world");
        let field = Arc::new(Heightfield::generate(seed));
        let flora = flora::scatter(&field, sim_seed.noise_seed("flora"));
        let spawn = field.find_spawn();

        // Terrain access for every other crate + the player start.
        app.insert_resource(HeightQuery::new(WorldTerrain { field: field.clone() }));
        app.insert_resource(SpawnPoints { player: spawn });
        app.insert_resource(WorldData { field, flora, seed });

        let n = (SIZE * SIZE) as u32;
        let chunks_per_side = SIZE.div_ceil(CHUNK) as u32;
        let channels = WorldChannels {
            height: app.register_channel::<f32>(
                ChannelSpec::flat::<f32>("world.height", n).doc("ground height (m), row-major z*size_x+x, vertex samples"),
            ),
            biome: app.register_channel::<u8>(ChannelSpec::flat::<u8>("world.biome", n).doc("biome id per height sample")),
            dirty: app.register_channel::<u32>(
                ChannelSpec::flat::<u32>("world.dirty", chunks_per_side * chunks_per_side).doc("chunk indices edited this step"),
            ),
            flora: app.register_channel::<f32>(
                ChannelSpec::records::<f32>("flora", FLORA_STRIDE as u32, MAX_FLORA as u32)
                    .doc("kind,x,y,z,yaw,scale,variant,state (static; version bumps on change)"),
            ),
        };
        app.insert_resource(channels);

        app.add_systems(Update, clear_dirty.in_set(SimSet::Env));
        app.add_systems(SimPublish, publish_world);

        app.register_query("world.info", |w: &World, _: Value| Ok(world_info(w)));
        app.register_save_section(
            "world",
            1,
            |w: &World| WorldSave { seed: w.resource::<WorldData>().seed },
            |w: &mut World, s: WorldSave| {
                let have = w.resource::<WorldData>().seed;
                if s.seed != have {
                    return Err(format!("save was made on a different world (seed {} != {have})", s.seed));
                }
                Ok(())
            },
        );
    }
}

/// `world.dirty` is per-step: empty unless something edited terrain this step.
fn clear_dirty(mut channels: ResMut<Channels>, ids: Res<WorldChannels>) {
    channels.writer(ids.dirty).clear();
}

/// Copies the (static) terrain into the channels whenever `WorldData` changed; the first run after
/// start-up / load always publishes. Bumps `version` so JS rebuilds meshes.
fn publish_world(data: Res<WorldData>, ids: Res<WorldChannels>, mut channels: ResMut<Channels>) {
    if !data.is_changed() {
        return;
    }
    channels.writer(ids.height).replace_with(&data.field.heights);
    channels.writer(ids.biome).replace_with(&data.field.biomes);
    channels.writer(ids.flora).replace_with(&data.flora);
    channels.bump_version(ids.height);
    channels.bump_version(ids.biome);
    channels.bump_version(ids.flora);
}

fn world_info(w: &World) -> Value {
    let data = w.resource::<WorldData>();
    let hf = &data.field;
    let b = hf.playable_bounds();
    let spawn = w.resource::<SpawnPoints>().player;
    let ids = w.resource::<WorldChannels>();
    json!({
        "size_x": hf.size,
        "size_z": hf.size,
        "cell": hf.cell,
        "origin_x": hf.origin_x,
        "origin_z": hf.origin_z,
        "sample": "vertex",
        "sea_level": hf.sea_level,
        "chunk": CHUNK,
        "min_height": hf.min_height,
        "max_height": hf.max_height,
        "seed": data.seed,
        "spawn": { "x": spawn.x, "y": spawn.y, "z": spawn.z },
        "bounds": { "min_x": b.min_x, "min_z": b.min_z, "max_x": b.max_x, "max_z": b.max_z },
        "biomes": biome::NAMES,
        "flora_kinds": KIND_NAMES,
        "flora_count": data.flora.len() / FLORA_STRIDE,
        "version": w.resource::<Channels>().version(ids.height),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Sim;

    fn sim(seed: u32) -> Sim {
        Sim::build(seed, |app| {
            app.add_plugins(WorldPlugin);
        })
    }

    #[test]
    fn publishes_channels_and_info_at_startup() {
        let s = sim(5);
        let h: Value = serde_json::from_str(&s.channel_info_json("world.height")).unwrap();
        assert_eq!(h["len"], SIZE * SIZE);
        assert_eq!(h["kind"], "f32");
        assert_eq!(h["version"], 1);
        let b: Value = serde_json::from_str(&s.channel_info_json("world.biome")).unwrap();
        assert_eq!((b["len"].as_u64().unwrap() as usize, b["kind"].as_str().unwrap()), (SIZE * SIZE, "u8"));
        let f: Value = serde_json::from_str(&s.channel_info_json("flora")).unwrap();
        assert_eq!(f["stride"], 8);
        assert!(f["len"].as_u64().unwrap() > 0);
        let d: Value = serde_json::from_str(&s.channel_info_json("world.dirty")).unwrap();
        assert_eq!(d["len"], 0);

        let info: Value = serde_json::from_str(&s.query("world.info", "")).unwrap();
        for key in ["size_x", "size_z", "cell", "origin_x", "origin_z", "sea_level", "chunk", "spawn", "bounds", "biomes"] {
            assert!(info.get(key).is_some(), "world.info lacks '{key}'");
        }
        assert_eq!(info["size_x"], 128);
        assert_eq!(info["sea_level"], 0.0);
    }

    #[test]
    fn channel_matches_height_query() {
        let s = sim(11);
        let ch = s.world().resource::<Channels>();
        let ids = s.world().resource::<WorldChannels>();
        let heights = ch.slice(ids.height);
        let q = s.world().resource::<HeightQuery>();
        let info: Value = serde_json::from_str(&s.query("world.info", "")).unwrap();
        let (ox, oz) = (info["origin_x"].as_f64().unwrap() as f32, info["origin_z"].as_f64().unwrap() as f32);
        for &(ix, iz) in &[(0usize, 0usize), (64, 64), (100, 20), (127, 127), (33, 90)] {
            let want = q.height(ox + ix as f32, oz + iz as f32);
            assert_eq!(heights[iz * SIZE + ix], want, "sample ({ix},{iz})");
        }
    }

    #[test]
    fn height_query_is_installed_and_spawn_is_valid() {
        let s = sim(5);
        let q = s.world().resource::<HeightQuery>();
        let spawn = s.world().resource::<SpawnPoints>().player;
        assert!(q.height(spawn.x, spawn.z) > 1.0);
        assert!(q.is_water(-60.0, -60.0));
        assert_eq!(q.sea_level(), 0.0);
    }

    #[test]
    fn same_seed_same_world_different_seed_different_world() {
        assert_eq!(sim(7).digest(), sim(7).digest());
        assert_ne!(sim(7).digest(), sim(8).digest());
    }

    #[test]
    fn static_channels_are_not_republished_every_step() {
        let mut s = sim(5);
        s.step_once();
        s.step_once();
        let v: Value = serde_json::from_str(&s.channel_info_json("world.height")).unwrap();
        assert_eq!(v["version"], 1, "version must only bump when terrain actually changes");
    }

    #[test]
    fn world_save_section_checks_the_seed() {
        let a = sim(5);
        let bytes = a.save().unwrap();
        let file = sim_core::SaveFile::decode(&bytes).unwrap();
        // matching world loads fine
        let mut same = sim(5);
        same.apply_save(&file).unwrap();
        // a different world rejects the save
        let mut other = sim(6);
        let e = other.apply_save(&file).unwrap_err();
        assert!(e.contains("different world"), "{e}");
    }
}
