//! # sim_world - the island
//!
//! A seeded 576 m world (1153 x 1153 samples @ 0.5 m): a ~300 m main island with beaches, rolling hills, a
//! 3-tier terraced highland (rounded cliff lips), a pond fed by a stream that runs to the sea, two beach coves,
//! a flattened village clearing with paths, and three offshore islets. Published through
//! * channel `world.height` (`f32`, `size * size`, row-major, metres) and `world.biome` (`u8`, ids 0-11 per
//!   `docs/WORLD_CONTRACT.md`),
//! * channel `world.dirty` (`u32` chunk indices edited since the last step; always empty until `world.edit`),
//! * channel `flora` (`f32`, stride 8, static, kinds 0-127 per the contract),
//! * query `world.info` (contract keys + pond / stream / path / islet metadata for the water meshes),
//! * the [`HeightQuery`](sim_core::HeightQuery) resource that every other crate samples.
//!
//! Layout of the generator: `worldgen.rs` (terrain, biomes, water, paths), `flora.rs` (placement), `biome.rs`.

pub mod biome;
mod flora;
mod heightfield;
mod noise;
mod worldgen;

pub use flora::{FLORA_STRIDE, MAX_FLORA, kind as flora_kind, kind_names};
pub use heightfield::{CELL, CELLS, CHUNK, HALF, Heightfield, SIZE, WorldTerrain};
pub use worldgen::{Features, Generated, Pond, Stream, generate};

use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sim_core::{ChannelId, ChannelSpec, Channels, HeightQuery, SimAppExt, SimPublish, SimSet, SpawnPoints};
use std::sync::Arc;

/// The generated world (resource).
#[derive(Resource)]
pub struct WorldData {
    pub field: Arc<Heightfield>,
    pub features: Arc<Features>,
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
        let generated = generate(seed);
        let flora = flora::scatter(&generated, sim_seed.noise_seed("flora"));
        let Generated { field, features } = generated;
        let field = Arc::new(field);
        let spawn_xz = features.spawn;
        let spawn = sim_core::math::Vec3::new(spawn_xz[0], field.sample(spawn_xz[0], spawn_xz[1]), spawn_xz[1]);

        // Terrain access for every other crate + the player start.
        app.insert_resource(HeightQuery::new(WorldTerrain { field: field.clone() }));
        app.insert_resource(SpawnPoints { player: spawn });
        app.insert_resource(WorldData { field, features: Arc::new(features), flora, seed });

        let n = (SIZE * SIZE) as u32;
        let chunks_per_side = SIZE.div_ceil(CHUNK) as u32;
        let channels = WorldChannels {
            height: app.register_channel::<f32>(
                ChannelSpec::flat::<f32>("world.height", n).doc("ground height (m), row-major z*size+x, vertex samples @ world.info.cell"),
            ),
            biome: app.register_channel::<u8>(ChannelSpec::flat::<u8>("world.biome", n).doc("biome id 0-11 per height sample (WORLD_CONTRACT.md)")),
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
    let f = &data.features;
    let b = hf.playable_bounds();
    let spawn = w.resource::<SpawnPoints>().player;
    let ids = w.resource::<WorldChannels>();
    let mut habitats = Map::new();
    for (id, circles) in &f.habitats {
        habitats.insert(biome::name(*id).to_string(), json!(circles));
    }
    let extent = (hf.size - 1) as f32 * hf.cell;
    let streams: Vec<Value> = f.streams.iter().map(|s| json!({ "pts": s.pts })).collect();
    json!({
        // metres spanned by the samples (vertex sampling: nx = size_x / cell + 1)
        "size_x": extent,
        "size_z": extent,
        "nx": hf.size,
        "nz": hf.size,
        "cell": hf.cell,
        "origin_x": hf.origin_x,
        "origin_z": hf.origin_z,
        "sample": "vertex",
        "sea_level": hf.sea_level,
        // cells per chunk edge (32 m chunks)
        "chunk": CHUNK,
        "min_height": hf.min_height,
        "max_height": hf.max_height,
        "seed": data.seed,
        "spawn": { "player": f.spawn, "village": f.village, "x": spawn.x, "y": spawn.y, "z": spawn.z },
        "habitats": Value::Object(habitats),
        "bounds": { "min_x": b.min_x, "min_z": b.min_z, "max_x": b.max_x, "max_z": b.max_z },
        "biomes": biome::NAMES,
        "flora_kinds": kind_names(),
        "flora_count": data.flora.len() / FLORA_STRIDE,
        "water": {
            "sea": hf.sea_level,
            "pond": { "x": f.pond.x, "z": f.pond.z, "rx": f.pond.rx, "rz": f.pond.rz, "rot": f.pond.rot, "level": f.pond.level },
            "streams": streams,
        },
        "village": { "x": f.village[0], "z": f.village[1], "r": f.village_r, "h": f.village_h },
        "paths": f.paths,
        "islets": f.islets,
        "highland": f.highland,
        "version": w.resource::<Channels>().version(ids.height),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Sim;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Mutex, OnceLock};

    fn sim(seed: u32) -> Sim {
        Sim::build(seed, |app| {
            app.add_plugins(WorldPlugin);
        })
    }

    /// Generated worlds are expensive in debug builds: share them between tests.
    fn shared(seed: u32) -> &'static Generated {
        static CACHE: OnceLock<Mutex<HashMap<u32, &'static Generated>>> = OnceLock::new();
        let mut map = CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        *map.entry(seed).or_insert_with(|| Box::leak(Box::new(generate(seed))))
    }

    fn count_biomes(hf: &Heightfield) -> [usize; biome::COUNT] {
        let mut c = [0usize; biome::COUNT];
        for &b in &hf.biomes {
            c[usize::from(b)] += 1;
        }
        c
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
        assert!(f["len"].as_u64().unwrap() > 1000);
        let d: Value = serde_json::from_str(&s.channel_info_json("world.dirty")).unwrap();
        assert_eq!(d["len"], 0);

        let info: Value = serde_json::from_str(&s.query("world.info", "")).unwrap();
        for key in ["size_x", "size_z", "cell", "origin_x", "origin_z", "sea_level", "chunk", "spawn", "habitats", "bounds", "biomes", "water", "flora_kinds"] {
            assert!(info.get(key).is_some(), "world.info lacks '{key}'");
        }
        // contract: size_* in metres, spawn.{player,village} = [x, z], habitats biome -> [[x, z, r], ...]
        assert_eq!(info["size_x"].as_f64().unwrap(), 576.0);
        assert_eq!(info["cell"].as_f64().unwrap(), 0.5);
        assert_eq!(info["nx"], SIZE);
        assert_eq!(info["chunk"], 64);
        assert_eq!(info["sea_level"], 0.0);
        assert_eq!(info["spawn"]["player"].as_array().unwrap().len(), 2);
        assert_eq!(info["spawn"]["village"].as_array().unwrap().len(), 2);
        let hab = info["habitats"].as_object().unwrap();
        for name in ["meadow", "forest_floor", "sand", "shallows"] {
            let circles = hab.get(name).unwrap_or_else(|| panic!("no habitat '{name}'")).as_array().unwrap();
            assert!(!circles.is_empty() && circles[0].as_array().unwrap().len() == 3);
        }
        assert_eq!(info["biomes"].as_array().unwrap().len(), 12);
        assert_eq!(info["flora_kinds"].as_array().unwrap().len(), 128);
        assert_eq!(info["flora_kinds"][0], "oak_puff");
        assert_eq!(info["water"]["streams"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn channel_matches_height_query() {
        let s = sim(11);
        let ch = s.world().resource::<Channels>();
        let ids = s.world().resource::<WorldChannels>();
        let heights = ch.slice(ids.height);
        let q = s.world().resource::<HeightQuery>();
        for &(ix, iz) in &[(0usize, 0usize), (576, 576), (900, 200), (1152, 1152), (333, 777)] {
            let want = q.height(-HALF + ix as f32 * CELL, -HALF + iz as f32 * CELL);
            assert_eq!(heights[iz * SIZE + ix], want, "sample ({ix},{iz})");
        }
        let spawn = s.world().resource::<SpawnPoints>().player;
        assert!(q.height(spawn.x, spawn.z) > 1.0);
        assert!(q.is_water(-280.0, -280.0));
        assert_eq!(q.sea_level(), 0.0);
    }

    #[test]
    fn same_seed_same_world_different_seed_different_world() {
        assert_eq!(sim(7).digest(), sim(7).digest());
        assert_ne!(sim(7).digest(), sim(8).digest());
    }

    #[test]
    fn generation_is_deterministic_and_reports_time() {
        let t = std::time::Instant::now();
        let again = generate(1);
        let secs = t.elapsed().as_secs_f32();
        eprintln!("generate(1): {secs:.2} s (native test profile)");
        let a = shared(1);
        assert_eq!(a.field.heights, again.field.heights);
        assert_eq!(a.field.biomes, again.field.biomes);
        assert_eq!(a.features.spawn, again.features.spawn);
        assert_eq!(flora::scatter(a, 9), flora::scatter(&again, 9));
        assert_ne!(flora::scatter(a, 9), flora::scatter(a, 10));
        assert_ne!(a.field.heights, shared(2).field.heights);
        assert!(secs < 20.0);
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
        let mut same = sim(5);
        same.apply_save(&file).unwrap();
        let mut other = sim(6);
        let e = other.apply_save(&file).unwrap_err();
        assert!(e.contains("different world"), "{e}");
    }

    #[test]
    fn island_has_the_designed_topography() {
        for seed in [1u32, 2, 3] {
            let g = shared(seed);
            let hf = &g.field;
            let c = count_biomes(hf);
            for id in 0..=10 {
                assert!(c[id] > 150, "seed {seed}: biome {} ({}) has only {} cells", id, biome::NAMES[id], c[id]);
            }
            assert_eq!(c[usize::from(biome::SNOW)], 0);
            let land: usize = (2..=10).map(|i| c[i]).sum();
            let frac = land as f32 / (SIZE * SIZE) as f32;
            assert!((0.12..0.45).contains(&frac), "seed {seed}: land fraction {frac}");
            let forest = c[usize::from(biome::FOREST_FLOOR)] as f32 / land as f32;
            assert!((0.07..0.45).contains(&forest), "seed {seed}: forest share {forest}");
            assert!(hf.max_height > 13.0 && hf.max_height < 32.0, "seed {seed}: max {}", hf.max_height);
            assert!(hf.min_height > -14.5, "seed {seed}: min {}", hf.min_height);
            // world corners / edges are deep sea
            for &(x, z) in &[(-280.0, -280.0), (280.0, -280.0), (-280.0, 280.0), (280.0, 280.0), (0.0, 280.0), (280.0, 0.0)] {
                assert!(hf.sample(x, z) < -6.0, "seed {seed}: ({x},{z}) = {}", hf.sample(x, z));
            }
            // land components on a 2 m lattice: the main island + at least the 3 islets
            let n = (2.0 * HALF / 2.0) as usize + 1;
            let mut seen = vec![false; n * n];
            let mut comps: Vec<(usize, f32, f32, f32, f32)> = Vec::new();
            for j in 0..n {
                for i in 0..n {
                    let (x, z) = (-HALF + i as f32 * 2.0, -HALF + j as f32 * 2.0);
                    if seen[j * n + i] || hf.sample(x, z) < 0.2 {
                        continue;
                    }
                    let mut q = VecDeque::from([(i, j)]);
                    seen[j * n + i] = true;
                    let (mut cnt, mut x0, mut x1, mut z0, mut z1) = (0usize, f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                    while let Some((a, b)) = q.pop_front() {
                        let (wx, wz) = (-HALF + a as f32 * 2.0, -HALF + b as f32 * 2.0);
                        cnt += 1;
                        x0 = x0.min(wx);
                        x1 = x1.max(wx);
                        z0 = z0.min(wz);
                        z1 = z1.max(wz);
                        for (da, db) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                            let (na, nb) = (a as i32 + da, b as i32 + db);
                            if na < 0 || nb < 0 || na as usize >= n || nb as usize >= n {
                                continue;
                            }
                            let k = nb as usize * n + na as usize;
                            let (nx, nz) = (-HALF + na as f32 * 2.0, -HALF + nb as f32 * 2.0);
                            if !seen[k] && hf.sample(nx, nz) >= 0.2 {
                                seen[k] = true;
                                q.push_back((na as usize, nb as usize));
                            }
                        }
                    }
                    comps.push((cnt, x0, x1, z0, z1));
                }
            }
            comps.sort_by(|a, b| b.0.cmp(&a.0));
            let big: Vec<_> = comps.iter().filter(|c| c.0 > 40).collect();
            assert!(big.len() >= 4, "seed {seed}: main island + 3 islets expected, got {} land components", big.len());
            let main = big[0];
            let w = (main.2 - main.1).max(main.4 - main.3);
            assert!((240.0..360.0).contains(&w), "seed {seed}: main island spans {w} m");
            // the village + pond sit on the main island
            let (v, p) = (g.features.village, &g.features.pond);
            assert!(v[0] > main.1 && v[0] < main.2 && v[1] > main.3 && v[1] < main.4);
            assert!(hf.sample(p.x, p.z) < p.level - 0.5, "seed {seed}: pond basin");
            assert!(p.level > 1.0 && p.level < 9.0, "seed {seed}: pond level {}", p.level);
            // islets are real islands: land above sea at their centres
            for il in &g.features.islets {
                assert!(hf.sample(il[0], il[1]) > 1.0, "seed {seed}: islet at ({}, {})", il[0], il[1]);
            }
        }
    }

    #[test]
    fn stream_runs_from_the_highland_foot_through_the_pond_to_the_sea() {
        for seed in [1u32, 2, 3] {
            let g = shared(seed);
            let hf = &g.field;
            let s = &g.features.streams;
            assert_eq!(s.len(), 2);
            for st in s {
                assert!(st.pts.len() > 12);
                for w in st.pts.windows(2) {
                    assert!(w[1][3] <= w[0][3] + 1e-4, "seed {seed}: stream level rises {} -> {}", w[0][3], w[1][3]);
                }
            }
            let out = &s[1].pts;
            let last = out.last().unwrap();
            assert!(last[3] <= 0.05, "seed {seed}: stream mouth level {}", last[3]);
            assert!(hf.sample(last[0], last[1]) < 0.4, "seed {seed}: stream must end in the sea, ground {}", hf.sample(last[0], last[1]));
            // channel floor is below the water surface along the whole course
            for st in s {
                for q in st.pts.iter().skip(2) {
                    assert!(hf.sample(q[0], q[1]) < q[3] + 0.06, "seed {seed}: dry stream bed at ({}, {}): ground {} level {}", q[0], q[1], hf.sample(q[0], q[1]), q[3]);
                }
            }
            let c = count_biomes(hf);
            assert!(c[usize::from(biome::POND_BANK)] > 800, "seed {seed}: pond/stream bank cells {}", c[8]);
        }
    }

    #[test]
    fn spawn_is_walkable_and_reaches_everything() {
        for seed in [1u32, 2, 3] {
            let g = shared(seed);
            let hf = &g.field;
            let sp = g.features.spawn;
            let b = hf.biome_at(sp[0], sp[1]);
            assert!(b == biome::MEADOW || b == biome::FLOWER_MEADOW || b == biome::VILLAGE, "seed {seed}: spawn biome {b}");
            assert!(hf.sample(sp[0], sp[1]) > 1.5 && hf.steepness(sp[0], sp[1]) < 0.12, "seed {seed}: spawn terrain");
            // BFS over a 2 m lattice using the player's 46 degree limit with some margin
            let n = (2.0 * HALF / 2.0) as usize + 1;
            let ix = |v: f32| ((v + HALF) / 2.0).round() as usize;
            let mut seen = vec![false; n * n];
            let mut q = VecDeque::from([(ix(sp[0]), ix(sp[1]))]);
            seen[ix(sp[1]) * n + ix(sp[0])] = true;
            while let Some((a, bb)) = q.pop_front() {
                for (da, db) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                    let (na, nb) = (a as i32 + da, bb as i32 + db);
                    if na < 3 || nb < 3 || na as usize >= n - 3 || nb as usize >= n - 3 {
                        continue;
                    }
                    let k = nb as usize * n + na as usize;
                    let (x, z) = (-HALF + na as f32 * 2.0, -HALF + nb as f32 * 2.0);
                    if seen[k] || hf.sample(x, z) < 0.05 || hf.steepness(x, z) > 0.95 {
                        continue;
                    }
                    seen[k] = true;
                    q.push_back((na as usize, nb as usize));
                }
            }
            let reach = |x: f32, z: f32| seen[ix(z) * n + ix(x)];
            let v = g.features.village;
            assert!(reach(v[0], v[1]), "seed {seed}: village unreachable");
            let mut found = [false; 4]; // sand, pond bank, highland top, cliff-top tread
            for j in (0..n).step_by(2) {
                for i in (0..n).step_by(2) {
                    if !seen[j * n + i] {
                        continue;
                    }
                    let (x, z) = (-HALF + i as f32 * 2.0, -HALF + j as f32 * 2.0);
                    match hf.biome_at(x, z) {
                        biome::SAND => found[0] = true,
                        biome::POND_BANK => found[1] = true,
                        biome::HIGHLAND => {
                            found[2] = true;
                            if hf.sample(x, z) > 15.0 {
                                found[3] = true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            assert!(found.iter().all(|&f| f), "seed {seed}: unreachable regions (sand, pond, highland, plateau): {found:?}");
        }
    }

    #[test]
    fn flora_follows_the_contract_rules() {
        for seed in [1u32, 2] {
            let g = shared(seed);
            let hf = &g.field;
            let flora = flora::scatter(g, 42);
            assert_eq!(flora.len() % FLORA_STRIDE, 0);
            let n = flora.len() / FLORA_STRIDE;
            assert!((2200..MAX_FLORA * 8 / 10).contains(&n), "seed {seed}: {n} instances");
            let names = kind_names();
            let mut per_kind = [0usize; 128];
            let mut forest_trees = 0usize;
            for r in flora.chunks_exact(FLORA_STRIDE) {
                let k = r[0] as usize;
                assert!(k < 128 && !names[k].is_empty(), "unknown kind {k}");
                per_kind[k] += 1;
                let (x, y, z) = (r[1], r[2], r[3]);
                assert!(r[5] > 0.0 && (0.0..=255.0).contains(&r[6]) && (0.0..=1.0).contains(&r[7]));
                if (80..=82).contains(&k) {
                    continue; // reeds / lily pads / cattails may stand in water
                }
                assert!((y - hf.sample(x, z)).abs() < 1e-3, "kind {k} floats at ({x},{z})");
                assert!(y >= 0.04, "kind {} in water at ({x},{z}) y={y}", names[k]);
                let p = &g.features.pond;
                assert!(p.e(x, z) > 1.0, "kind {} inside the pond", names[k]);
                assert!(hf.steepness(x, z) <= 0.70, "kind {} on a {:.0} deg slope", names[k], hf.steepness(x, z).atan().to_degrees());
                // not within 2 m of paths / the clearing (probe 8 directions + centre)
                for (dx, dz) in [(0.0f32, 0.0f32), (1.9, 0.0), (-1.9, 0.0), (0.0, 1.9), (0.0, -1.9), (1.35, 1.35), (-1.35, 1.35), (1.35, -1.35), (-1.35, -1.35)] {
                    let b = hf.biome_at(x + dx, z + dz);
                    assert!(b != biome::DIRT_PATH && b != biome::VILLAGE, "kind {} within 2 m of a path / the clearing at ({x},{z})", names[k]);
                }
                if matches!(k, 0 | 1 | 2 | 6 | 7) && hf.biome_at(x, z) == biome::FOREST_FLOOR {
                    forest_trees += 1;
                }
            }
            let c = count_biomes(hf);
            let forest_area = c[usize::from(biome::FOREST_FLOOR)] as f32 * CELL * CELL;
            let density = forest_trees as f32 / forest_area;
            assert!((0.025..0.07).contains(&density), "seed {seed}: forest tree density {density}/m2");
            for (k, what) in [(4, "palms"), (96, "shells"), (99, "beach grass"), (32, "daisies"), (80, "reeds"), (81, "lily pads"), (5, "willows"), (64, "boulders"), (2, "pines"), (18, "ferns"), (48, "mushrooms")] {
                assert!(per_kind[k] > 0, "seed {seed}: no {what}");
            }
        }
    }

    /// Dev aid: `cargo test -p sim_world preview -- --ignored --nocapture` writes `shots/world/r1/map_seedN.png`.
    #[test]
    #[ignore = "writes a top-down preview PNG of the island"]
    fn preview() {
        let seed = std::env::var("SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1u32);
        let g = shared(seed);
        let hf = &g.field;
        let w = 576usize;
        let mut rgb = vec![0u8; w * w * 3];
        let pal: [[f32; 3]; 12] = [
            [20.0, 60.0, 130.0],
            [70.0, 200.0, 210.0],
            [240.0, 222.0, 170.0],
            [110.0, 200.0, 90.0],
            [50.0, 130.0, 80.0],
            [170.0, 210.0, 100.0],
            [150.0, 130.0, 150.0],
            [200.0, 160.0, 110.0],
            [120.0, 110.0, 70.0],
            [240.0, 150.0, 190.0],
            [220.0, 200.0, 130.0],
            [250.0, 250.0, 255.0],
        ];
        for pz in 0..w {
            for px in 0..w {
                let (x, z) = (-HALF + px as f32 + 0.5, -HALF + pz as f32 + 0.5);
                let b = hf.biome_at(x, z);
                let h = hf.sample(x, z);
                let (gx, gz) = hf.gradient(x, z);
                let shade = (0.75 + (-gx * 0.6 - gz * 0.8) * 0.45).clamp(0.45, 1.25);
                let mut c = pal[usize::from(b)];
                if h < 0.0 {
                    let t = (-h / 10.0).clamp(0.0, 1.0);
                    c = [70.0 - 50.0 * t, 200.0 - 140.0 * t, 210.0 - 80.0 * t];
                }
                let s = if h < 0.0 { 1.0 } else { shade * (0.9 + 0.012 * h) };
                let o = (pz * w + px) * 3;
                for k in 0..3 {
                    rgb[o + k] = (c[k] * s).clamp(0.0, 255.0) as u8;
                }
            }
        }
        let mut dot = |x: f32, z: f32, col: [u8; 3]| {
            let (cx, cz) = ((x + HALF) as i32, (z + HALF) as i32);
            for dz in -3i32..=3 {
                for dx in -3i32..=3 {
                    let (a, b) = (cx + dx, cz + dz);
                    if a >= 0 && b >= 0 && (a as usize) < w && (b as usize) < w {
                        let o = (b as usize * w + a as usize) * 3;
                        rgb[o..o + 3].copy_from_slice(&col);
                    }
                }
            }
        };
        dot(g.features.spawn[0], g.features.spawn[1], [255, 30, 30]);
        dot(g.features.village[0], g.features.village[1], [255, 255, 255]);
        let flora = flora::scatter(g, 42);
        for r in flora.chunks_exact(FLORA_STRIDE) {
            let k = r[0] as usize;
            let col = if k < 16 { [20u8, 70, 30] } else if (32..48).contains(&k) { [250, 120, 200] } else if k >= 64 && k < 80 { [90, 80, 90] } else { [200, 200, 60] };
            let (cx, cz) = ((r[1] + HALF) as usize, (r[3] + HALF) as usize);
            if cx < w && cz < w {
                let o = (cz * w + cx) * 3;
                rgb[o..o + 3].copy_from_slice(&col);
            }
        }
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../shots/world/r1");
        std::fs::create_dir_all(dir).unwrap();
        let path = format!("{dir}/map_seed{seed}.png");
        write_png(&path, w, w, &rgb);
        let c = count_biomes(hf);
        eprintln!("seed {seed}: height {:.1}..{:.1}, flora {}, biome counts {:?}, spawn {:?}, village {:?}", hf.min_height, hf.max_height, flora.len() / 8, c, g.features.spawn, g.features.village);
        eprintln!("pond {:?}", g.features.pond);
        eprintln!("wrote {path}");
    }

    fn write_png(path: &str, w: usize, h: usize, rgb: &[u8]) {
        let mut raw = Vec::with_capacity((w * 3 + 1) * h);
        for y in 0..h {
            raw.push(0u8);
            raw.extend_from_slice(&rgb[y * w * 3..(y + 1) * w * 3]);
        }
        let mut z = vec![0x78u8, 0x01];
        let nblocks = raw.len().div_ceil(65535);
        for (i, chunk) in raw.chunks(65535).enumerate() {
            z.push(u8::from(i + 1 == nblocks));
            let len = chunk.len() as u16;
            z.extend_from_slice(&len.to_le_bytes());
            z.extend_from_slice(&(!len).to_le_bytes());
            z.extend_from_slice(chunk);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for &v in &raw {
            a = (a + u32::from(v)) % 65521;
            b = (b + a) % 65521;
        }
        z.extend_from_slice(&((b << 16) | a).to_be_bytes());
        let mut table = [0u32; 256];
        for (n, t) in table.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *t = c;
        }
        let crc = |data: &[u8]| -> u32 {
            let mut c = 0xFFFF_FFFFu32;
            for &v in data {
                c = table[((c ^ u32::from(v)) & 0xFF) as usize] ^ (c >> 8);
            }
            c ^ 0xFFFF_FFFF
        };
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            png.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let mut body = kind.to_vec();
            body.extend_from_slice(data);
            png.extend_from_slice(&body);
            png.extend_from_slice(&crc(&body).to_be_bytes());
        };
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&(w as u32).to_be_bytes());
        ihdr.extend_from_slice(&(h as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(b"IHDR", &ihdr);
        chunk(b"IDAT", &z);
        chunk(b"IEND", &[]);
        std::fs::write(path, png).unwrap();
    }
}
