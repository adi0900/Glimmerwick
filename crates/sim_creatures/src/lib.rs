//! # sim_creatures - Glimmers (reference slice)
//!
//! About a dozen placeholder creatures of three species ([`species::SPECIES`]) that wander inside
//! their habitat, notice the player, react by personality and sleep at night.
//!
//! * channel `creatures` (`f32`, stride 16, interpolated, sorted by id, capacity 4096 records),
//! * commands `debug.spawn_creature`, queries `creature.info` / `creature.species`,
//! * events 300-304, save section `creatures`.
//!
//! The characters owner replaces the species table and the AI internals but **must keep the channel
//! layout** (`docs/BRIDGE_API.md`): new columns go into new, separately documented channels.

mod ai;
mod species;

pub use ai::{AiEvent, Brain, State, anim, emote, flags, on_interact, think};
pub use species::{PUFFBUN, Personality, SPECIES, SPRIGFOX, Species, TIDLER, VARIANTS, name_for, species};

use bevy_app::{App, Plugin, Startup, Update};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::math::{self, Vec3};
use sim_core::rng::Rng;
use sim_core::{
    ChannelId, ChannelSpec, Channels, Environment, EventBus, HeightQuery, Id, IdAllocator, IdIndex, Interact, Interactable, Player,
    Position, SIM_DT, SimAppExt, SimPublish, SimSet, StartupSet, Yaw,
};

/// `f32` elements per creature record.
pub const CREATURE_STRIDE: usize = 16;
/// Channel capacity in records (hard limit on live creatures).
pub const MAX_CREATURES: usize = 4096;
/// Creatures spawned at start-up: `(species, count)`.
pub const INITIAL_CREATURES: [(u8, usize); 3] = [(PUFFBUN, 5), (TIDLER, 4), (SPRIGFOX, 3)];

/// Event kinds of this crate (range 300-399). Payloads: see `docs/BRIDGE_API.md`.
pub mod events {
    use sim_core::EventKind;
    /// A creature noticed the player. `a` = creature id, `b` = species, position = creature.
    pub const NOTICE: EventKind = EventKind::creatures(0);
    /// A creature shows an emote. `a` = creature id, `b` = emote id, `f` = species, position = creature.
    pub const EMOTE: EventKind = EventKind::creatures(1);
    /// A creature was spawned at runtime. `a` = creature id, `b` = species.
    pub const SPAWNED: EventKind = EventKind::creatures(2);
    /// A creature fell asleep. `a` = creature id, `b` = species.
    pub const SLEEP: EventKind = EventKind::creatures(3);
    /// A creature woke up. `a` = creature id, `b` = species.
    pub const WAKE: EventKind = EventKind::creatures(4);
}

/// Identity of a creature.
#[derive(Component, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Creature {
    pub species: u8,
    /// Colour variant `0..VARIANTS`.
    pub variant: u8,
    /// Visual scale (channel column 7).
    pub scale: f32,
}

/// Centre of a creature's wander range.
#[derive(Component, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Home(pub Vec3);

/// Per-creature random stream (so behaviour is independent of iteration / spawn order).
#[derive(Component, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreatureRng(pub Rng);

/// Random streams used when spawning (resource, saved).
#[derive(Resource, Clone, Debug, Serialize, Deserialize)]
pub struct CreatureSpawner {
    /// Advances: positions, variants, species picks.
    place: Rng,
    /// Never advances: root for `split_u64(creature_id)`.
    streams: Rng,
}

/// Typed handle of the `creatures` channel.
#[derive(Resource, Clone, Copy)]
pub struct CreatureChannels {
    pub creatures: ChannelId<f32>,
}

pub struct CreaturesPlugin;

impl Plugin for CreaturesPlugin {
    fn build(&self, app: &mut App) {
        let seed = app.sim_seed();
        let creatures = app.register_channel::<f32>(
            ChannelSpec::records::<f32>("creatures", CREATURE_STRIDE as u32, MAX_CREATURES as u32)
                .interpolated()
                .doc("id,species,variant,pos xyz,yaw,scale,anim_state,anim_t,mood,emote,flags,target_id,-,- (sorted by id)"),
        );
        app.insert_resource(CreatureChannels { creatures }).insert_resource(CreatureSpawner {
            place: seed.rng("creatures.place"),
            streams: seed.rng("creatures.streams"),
        });

        app.add_systems(Startup, spawn_initial.in_set(StartupSet::Population));
        app.add_systems(Update, (creature_messages, creature_ai).chain().in_set(SimSet::Decide));
        app.add_systems(SimPublish, publish_creatures);

        register_api(app);
    }
}

// --- spawning ----------------------------------------------------------------------------------------

/// Picks a valid spot for `species_id`: in its habitat biomes, walkable, optionally near `around`.
fn find_spot(world: &mut World, species_id: u8, around: Option<(Vec3, f32)>) -> Option<Vec3> {
    let sp = species(species_id);
    world.resource_scope(|world, mut spawner: Mut<CreatureSpawner>| {
        let terrain = world.resource::<HeightQuery>();
        let b = terrain.bounds();
        for _ in 0..400 {
            let (x, z) = match around {
                Some((c, r)) => {
                    let d = spawner.place.in_disc(r);
                    (c.x + d.x, c.z + d.y)
                }
                None => (spawner.place.range_f32(b.min_x, b.max_x), spawner.place.range_f32(b.min_z, b.max_z)),
            };
            if !terrain.contains(x, z) || !sp.habitat.contains(&terrain.biome(x, z)) || !ai::walkable(sp, terrain, x, z) {
                continue;
            }
            let (y, _) = ai::stand_height(sp, terrain, x, z);
            return Some(Vec3::new(x, y, z));
        }
        None
    })
}

/// Spawns one creature at `pos`; returns its id.
fn spawn_creature(world: &mut World, species_id: u8, variant: u8, pos: Vec3) -> u32 {
    let id = world.resource_mut::<IdAllocator>().alloc();
    let mut rng = world.resource::<CreatureSpawner>().streams.split_u64(u64::from(id.0));
    let sp = species(species_id);
    let creature = Creature { species: species_id, variant: variant % VARIANTS, scale: sp.base_scale * rng.range_f32(0.9, 1.1) };
    let yaw = rng.range_f32(-math::PI, math::PI);
    let brain = Brain::new(&mut rng);
    world.spawn((
        creature,
        id,
        Home(pos),
        Position(pos),
        Yaw(yaw),
        Interactable { radius: 6.0 },
        brain,
        CreatureRng(rng),
    ));
    id.0
}

fn live_count(world: &mut World) -> usize {
    world.query::<&Creature>().iter(world).count()
}

fn spawn_initial(world: &mut World) {
    for (species_id, count) in INITIAL_CREATURES {
        for _ in 0..count {
            if let Some(pos) = find_spot(world, species_id, None) {
                let variant = world.resource_mut::<CreatureSpawner>().place.below(u32::from(VARIANTS)) as u8;
                spawn_creature(world, species_id, variant, pos);
            }
        }
    }
}

// --- systems -------------------------------------------------------------------------------------------

/// Applies `Interact` messages from the player to the targeted creature.
fn creature_messages(
    mut messages: MessageReader<Interact>,
    index: Res<IdIndex>,
    mut creatures: Query<(&Creature, &Position, &mut Brain)>,
    mut bus: ResMut<EventBus>,
    mut scratch: Local<Vec<AiEvent>>,
) {
    for msg in messages.read() {
        let Some(entity) = index.get(msg.target) else { continue };
        let Ok((c, pos, mut brain)) = creatures.get_mut(entity) else { continue };
        scratch.clear();
        on_interact(&mut brain, &mut scratch);
        for ev in scratch.drain(..) {
            if let AiEvent::Emoted(e) = ev {
                bus.emit(events::EMOTE, msg.target as f32, f32::from(e), pos.0, f32::from(c.species));
            }
        }
    }
}

type CreatureAiQuery<'w, 's> = Query<
    'w,
    's,
    (&'static Id, &'static Creature, &'static Home, &'static mut Position, &'static mut Yaw, &'static mut Brain, &'static mut CreatureRng),
    Without<Player>,
>;

fn creature_ai(
    mut creatures: CreatureAiQuery,
    player: Option<Single<(&Id, &Position), With<Player>>>,
    env: Res<Environment>,
    terrain: Res<HeightQuery>,
    mut bus: ResMut<EventBus>,
    mut scratch: Local<Vec<AiEvent>>,
) {
    let surroundings = ai::Surroundings {
        terrain: &terrain,
        player: player.map(|p| {
            let (id, pos) = p.into_inner();
            (id.0, pos.0)
        }),
        night: env.is_night(),
        daylight: env.daylight(),
        k_turn: math::damp_factor(6.0, SIM_DT),
    };
    for (id, c, home, mut pos, mut yaw, mut brain, mut rng) in &mut creatures {
        scratch.clear();
        think(species(c.species), home.0, &mut pos.0, &mut yaw.0, &mut brain, &mut rng.0, &surroundings, &mut scratch);
        for ev in scratch.iter() {
            let (kind, b) = match *ev {
                AiEvent::Noticed => (events::NOTICE, f32::from(c.species)),
                AiEvent::Emoted(e) => (events::EMOTE, f32::from(e)),
                AiEvent::Slept => (events::SLEEP, f32::from(c.species)),
                AiEvent::Woke => (events::WAKE, f32::from(c.species)),
            };
            bus.emit(kind, id.0 as f32, b, pos.0, f32::from(c.species));
        }
    }
}

fn publish_creatures(
    creatures: Query<(&Id, &Creature, &Position, &Yaw, &Brain)>,
    ids: Res<CreatureChannels>,
    mut channels: ResMut<Channels>,
    mut rows: Local<Vec<(u32, [f32; CREATURE_STRIDE])>>,
) {
    rows.clear();
    for (id, c, pos, yaw, b) in &creatures {
        if rows.len() >= MAX_CREATURES {
            break;
        }
        rows.push((
            id.0,
            [
                id.0 as f32,
                f32::from(c.species),
                f32::from(c.variant),
                pos.x,
                pos.y,
                pos.z,
                yaw.0,
                c.scale,
                f32::from(b.anim_state()),
                b.anim_t,
                b.mood,
                f32::from(b.emote),
                b.flag_bits(),
                b.focus as f32,
                0.0,
                0.0,
            ],
        ));
    }
    // Stable order independent of archetype layout: ascending id (JS matches prev/cur by index).
    if !rows.is_sorted_by_key(|r| r.0) {
        rows.sort_unstable_by_key(|r| r.0);
    }
    let mut w = channels.writer(ids.creatures);
    w.clear();
    for (_, rec) in rows.iter() {
        w.extend_from_slice(rec);
    }
}

// --- commands / queries / save ------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(untagged)]
enum SpeciesArg {
    Id(u8),
    Name(String),
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SpawnArgs {
    species: Option<SpeciesArg>,
    x: Option<f32>,
    z: Option<f32>,
    variant: Option<u8>,
    count: Option<u32>,
}

#[derive(Deserialize)]
struct InfoArgs {
    id: u32,
}

fn resolve_species(arg: &SpeciesArg) -> Result<u8, String> {
    match arg {
        SpeciesArg::Id(i) if usize::from(*i) < SPECIES.len() => Ok(*i),
        SpeciesArg::Id(i) => Err(format!("species {i} out of range 0..={}", SPECIES.len() - 1)),
        SpeciesArg::Name(n) => SPECIES
            .iter()
            .position(|s| s.name.eq_ignore_ascii_case(n))
            .map(|i| i as u8)
            .ok_or_else(|| format!("unknown species '{n}'")),
    }
}

fn spawn_command(world: &mut World, a: SpawnArgs) -> Result<Value, String> {
    let count = a.count.unwrap_or(1).clamp(1, 1000) as usize;
    let fixed_species = a.species.as_ref().map(resolve_species).transpose()?;
    if a.x.is_some_and(|x| !x.is_finite()) || a.z.is_some_and(|z| !z.is_finite()) {
        return Err("x and z must be finite numbers".to_string());
    }
    let live = live_count(world);
    if live + count > MAX_CREATURES {
        return Err(format!("creature limit {MAX_CREATURES} reached ({live} alive, {count} requested)"));
    }
    let player_pos = {
        let mut q = world.query_filtered::<&Position, With<Player>>();
        q.iter(world).next().map(|p| p.0)
    };

    let mut ids = Vec::with_capacity(count);
    for _ in 0..count {
        let species_id = match fixed_species {
            Some(s) => s,
            None => world.resource_mut::<CreatureSpawner>().place.below(SPECIES.len() as u32) as u8,
        };
        let spot = match (a.x, a.z) {
            (Some(x), Some(z)) => {
                let (x, z) = {
                    let terrain = world.resource::<HeightQuery>();
                    terrain.clamp(x, z)
                };
                // an explicit position is honoured (debug tool); extra creatures scatter around it
                let (x, z) = if ids.is_empty() {
                    (x, z)
                } else {
                    let d = world.resource_mut::<CreatureSpawner>().place.in_disc(2.5);
                    world.resource::<HeightQuery>().clamp(x + d.x, z + d.y)
                };
                let terrain = world.resource::<HeightQuery>();
                let (y, _) = ai::stand_height(species(species_id), terrain, x, z);
                Some(Vec3::new(x, y, z))
            }
            _ => find_spot(world, species_id, player_pos.map(|p| (p, 14.0))).or_else(|| find_spot(world, species_id, None)),
        };
        let Some(pos) = spot else { continue };
        let variant = match a.variant {
            Some(v) => v,
            None => world.resource_mut::<CreatureSpawner>().place.below(u32::from(VARIANTS)) as u8,
        };
        let id = spawn_creature(world, species_id, variant, pos);
        let mut bus = world.resource_mut::<EventBus>();
        bus.emit(events::SPAWNED, id as f32, f32::from(species_id), pos, 0.0);
        ids.push(id);
    }
    if ids.is_empty() {
        return Err("no valid spot found for the creature (habitat not available)".to_string());
    }
    Ok(json!({ "id": ids[0], "ids": ids }))
}

fn creature_info(world: &World, a: InfoArgs) -> Result<Value, String> {
    let entity = world.resource::<IdIndex>().get(a.id).ok_or_else(|| format!("no entity with id {}", a.id))?;
    let c = world.get::<Creature>(entity).ok_or_else(|| format!("entity {} is not a creature", a.id))?;
    let pos = world.get::<Position>(entity).map(|p| p.0).unwrap_or_default();
    let brain = world.get::<Brain>(entity).ok_or("creature has no brain")?;
    let sp = species(c.species);
    Ok(json!({
        "id": a.id,
        "name": name_for(a.id),
        "species": c.species,
        "species_name": sp.name,
        "personality": sp.personality.name(),
        "variant": c.variant,
        "state": brain.state.name(),
        "mood": brain.mood,
        "emote": brain.emote,
        "pos": [pos.x, pos.y, pos.z],
        "asleep": brain.state == State::Sleep,
    }))
}

#[derive(Serialize, Deserialize)]
struct CreatureSave {
    id: u32,
    creature: Creature,
    home: Vec3,
    pos: Vec3,
    yaw: f32,
    brain: Brain,
    rng: Rng,
}

#[derive(Serialize, Deserialize)]
struct CreaturesSave {
    spawner: CreatureSpawner,
    creatures: Vec<CreatureSave>,
}

fn capture(world: &World) -> CreaturesSave {
    let mut rows: Vec<CreatureSave> = Vec::new();
    if let Some(mut q) = world.try_query::<(&Id, &Creature, &Home, &Position, &Yaw, &Brain, &CreatureRng)>() {
        for (id, c, home, pos, yaw, brain, rng) in q.iter(world) {
            rows.push(CreatureSave {
                id: id.0,
                creature: *c,
                home: home.0,
                pos: pos.0,
                yaw: yaw.0,
                brain: brain.clone(),
                rng: rng.0.clone(),
            });
        }
    }
    rows.sort_unstable_by_key(|r| r.id);
    CreaturesSave { spawner: world.resource::<CreatureSpawner>().clone(), creatures: rows }
}

fn restore(world: &mut World, save: CreaturesSave) -> Result<(), String> {
    if save.creatures.len() > MAX_CREATURES {
        return Err("too many creatures in save".to_string());
    }
    for r in &save.creatures {
        let finite = r.pos.is_finite() && r.home.is_finite() && r.yaw.is_finite() && r.creature.scale.is_finite();
        if !finite || usize::from(r.creature.species) >= SPECIES.len() || r.id == 0 {
            return Err(format!("corrupt creature record (id {})", r.id));
        }
    }
    // replace every existing creature with the saved ones
    let existing: Vec<Entity> = world.query_filtered::<Entity, With<Creature>>().iter(world).collect();
    for e in existing {
        world.despawn(e);
    }
    *world.resource_mut::<CreatureSpawner>() = save.spawner;
    for r in save.creatures {
        world.spawn((
            r.creature,
            Id(r.id),
            Home(r.home),
            Position(r.pos),
            Yaw(r.yaw),
            Interactable { radius: 6.0 },
            r.brain,
            CreatureRng(r.rng),
        ));
    }
    Ok(())
}

fn register_api(app: &mut App) {
    app.register_command("debug.spawn_creature", spawn_command);
    app.register_query("creature.info", creature_info);
    app.register_query("creature.species", |_: &World, _: Value| {
        let list: Vec<Value> = SPECIES
            .iter()
            .enumerate()
            .map(|(i, s)| {
                json!({
                    "id": i, "name": s.name, "personality": s.personality.name(), "habitat": s.habitat,
                    "swims": s.swims, "base_scale": s.base_scale, "variants": VARIANTS,
                })
            })
            .collect();
        Ok(json!(list))
    });

    app.register_event(events::NOTICE, "creature.notice", "a = creature id, b = species, pos = creature")
        .register_event(events::EMOTE, "creature.emote", "a = creature id, b = emote id, f = species, pos = creature")
        .register_event(events::SPAWNED, "creature.spawned", "a = creature id, b = species")
        .register_event(events::SLEEP, "creature.sleep", "a = creature id, b = species")
        .register_event(events::WAKE, "creature.wake", "a = creature id, b = species");

    app.register_save_section("creatures", 1, capture, restore);
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::terrain::{Terrain, TerrainBounds, biome};
    use sim_core::{Sim, SpawnPoints};

    /// Three vertical stripes of habitat with water on the west: x < -30 shallow sea (sea level 0),
    /// [-30,-10] beach, [-10,10] meadow, [10,40] forest.
    struct Patch;
    impl Terrain for Patch {
        fn height(&self, x: f32, _z: f32) -> f32 {
            if x < -30.0 { -0.6 } else { 0.8 }
        }
        fn normal(&self, _x: f32, _z: f32) -> Vec3 {
            Vec3::Y
        }
        fn biome(&self, x: f32, _z: f32) -> u8 {
            match x {
                x if x < -30.0 => biome::SHALLOW_WATER,
                x if x < -10.0 => biome::BEACH,
                x if x < 10.0 => biome::MEADOW,
                _ => biome::FOREST,
            }
        }
        fn sea_level(&self) -> f32 {
            0.0
        }
        fn bounds(&self) -> TerrainBounds {
            TerrainBounds { min_x: -45.0, min_z: -30.0, max_x: 40.0, max_z: 30.0 }
        }
    }

    fn sim(seed: u32) -> Sim {
        Sim::build(seed, |app| {
            app.insert_resource(HeightQuery::new(Patch));
            app.insert_resource(SpawnPoints { player: Vec3::new(0.0, 0.8, 0.0) });
            app.add_plugins(CreaturesPlugin);
        })
    }

    fn records(s: &Sim) -> Vec<[f32; CREATURE_STRIDE]> {
        let ch = s.world().resource::<Channels>();
        let id = s.world().resource::<CreatureChannels>().creatures;
        ch.slice(id).chunks_exact(CREATURE_STRIDE).map(|c| c.try_into().unwrap()).collect()
    }

    #[test]
    fn spawns_twelve_creatures_in_their_habitats() {
        let s = sim(1);
        let rec = records(&s);
        assert_eq!(rec.len(), 12);
        let mut per_species = [0usize; 3];
        for r in &rec {
            per_species[r[1] as usize] += 1;
            let sp = species(r[1] as u8);
            let b = Patch.biome(r[3], r[5]);
            assert!(sp.habitat.contains(&b), "{} spawned in biome {b}", sp.name);
            assert!(r[0] >= 1.0, "ids start at 1, got {}", r[0]);
            assert!(r[7] > 0.5 && r[7] < 1.2, "scale {}", r[7]);
            assert!((0.0..VARIANTS as f32).contains(&r[2]));
        }
        assert_eq!(per_species, [5, 4, 3]);
        // sorted by id, unique
        assert!(rec.windows(2).all(|w| w[0][0] < w[1][0]));
        let info: Value = serde_json::from_str(&s.channel_info_json("creatures")).unwrap();
        assert_eq!((info["stride"].as_u64(), info["cap"].as_u64(), info["len"].as_u64()), (Some(16), Some(4096 * 16), Some(12 * 16)));
        assert_ne!(info["prev_ptr"], 0);
    }

    #[test]
    fn simulation_runs_and_creatures_stay_valid() {
        let mut s = sim(2);
        let start = records(&s);
        for _ in 0..1800 {
            s.step_once();
        }
        let end = records(&s);
        assert_eq!(end.len(), 12);
        let moved = start.iter().zip(&end).filter(|(a, b)| (a[3] - b[3]).abs() + (a[5] - b[5]).abs() > 0.5).count();
        assert!(moved >= 6, "only {moved} of 12 creatures moved in 30 s");
        for r in &end {
            let sp = species(r[1] as u8);
            assert!(r.iter().all(|v| v.is_finite()), "{r:?}");
            let depth = (0.0 - Patch.height(r[3], r[5])).max(0.0);
            assert!(depth < if sp.swims { 1.2 } else { 0.25 }, "{} in water depth {depth}", sp.name);
            assert!(Patch.bounds().contains(r[3], r[5]));
        }
    }

    #[test]
    fn same_seed_same_creatures_different_seed_different() {
        let run = |seed| {
            let mut s = sim(seed);
            for _ in 0..600 {
                s.step_once();
            }
            s.digest()
        };
        assert_eq!(run(5), run(5));
        assert_ne!(run(5), run(6));
    }

    #[test]
    fn debug_spawn_command_and_limits() {
        let mut s = sim(3);
        s.drain_events();
        let r: Value = serde_json::from_str(&s.command("debug.spawn_creature", r#"{"species":"Sprigfox","x":20.0,"z":3.0}"#)).unwrap();
        let id = r["id"].as_u64().unwrap() as u32;
        let rec = records(&s);
        assert_eq!(rec.len(), 13);
        let new = rec.iter().find(|c| c[0] == id as f32).unwrap();
        assert_eq!((new[1], new[3], new[5]), (2.0, 20.0, 3.0));
        let ch = s.world().resource::<Channels>();
        let prev = ch.prev_slice(s.world().resource::<CreatureChannels>().creatures);
        assert_eq!(prev.len(), 13 * 16, "new creature must not interpolate from zero");
        assert!(s.drain_events().chunks(7).any(|e| e[0] == f32::from(events::SPAWNED.0) && e[1] == id as f32));

        // bulk spawn, bad args, names
        let r: Value = serde_json::from_str(&s.command("debug.spawn_creature", r#"{"count":40}"#)).unwrap();
        assert_eq!(r["ids"].as_array().unwrap().len(), 40);
        assert_eq!(records(&s).len(), 53);
        assert!(s.command("debug.spawn_creature", r#"{"species":"Dragon"}"#).contains("unknown species"));
        assert!(s.command("debug.spawn_creature", r#"{"species":9}"#).contains("out of range"));
        let info: Value = serde_json::from_str(&s.query("creature.info", &format!("{{\"id\":{id}}}"))).unwrap();
        assert_eq!(info["species_name"], "Sprigfox");
        assert_eq!(info["personality"], "shy");
        assert!(s.query("creature.info", r#"{"id":99999}"#).contains("no entity"));
        let sp: Value = serde_json::from_str(&s.query("creature.species", "")).unwrap();
        assert_eq!(sp.as_array().unwrap().len(), 3);
    }

    #[test]
    fn creature_cap_is_enforced() {
        let mut s = sim(4);
        let r = s.command("debug.spawn_creature", r#"{"count":1000}"#);
        assert!(r.contains("ids"), "{r}");
        s.command("debug.spawn_creature", r#"{"count":1000}"#);
        s.command("debug.spawn_creature", r#"{"count":1000}"#);
        s.command("debug.spawn_creature", r#"{"count":1000}"#);
        let n = records(&s).len();
        assert!(n <= MAX_CREATURES);
        let r = s.command("debug.spawn_creature", r#"{"count":1000}"#);
        assert!(r.contains("limit"), "expected a limit error at {n} creatures: {r}");
    }

    #[test]
    fn interact_message_delights_a_creature() {
        let mut s = sim(7);
        let rec = records(&s);
        let id = rec[0][0] as u32;
        s.world_mut().write_message(Interact { target: id, tool: 0 });
        s.drain_events();
        s.step_once();
        let events: Vec<f32> = s.drain_events();
        assert!(events.chunks(7).any(|e| e[0] == f32::from(events::EMOTE.0) && e[1] == id as f32 && e[2] == f32::from(emote::HEART)));
        let r = records(&s).into_iter().find(|c| c[0] == id as f32).unwrap();
        assert_eq!(r[8], f32::from(anim::HAPPY));
        assert!(r[10] > 0.9 && r[11] == f32::from(emote::HEART));
    }

    #[test]
    fn night_puts_creatures_to_sleep() {
        let mut s = sim(8);
        {
            let mut env = s.world_mut().resource_mut::<Environment>();
            env.sun_dir = Vec3::new(0.0, -1.0, 0.0);
        }
        for _ in 0..(60 * 40) {
            s.step_once();
        }
        let asleep = records(&s).iter().filter(|r| (r[12] as u32) & 1 == 1).count();
        assert!(asleep >= 10, "only {asleep} of 12 are asleep after 40 s of night");
    }

    #[test]
    fn save_load_continues_identically() {
        let mut a = sim(9);
        for _ in 0..400 {
            a.step_once();
        }
        a.command("debug.spawn_creature", r#"{"count":5}"#);
        let bytes = a.save().unwrap();
        for _ in 0..400 {
            a.step_once();
        }
        let want = a.digest();

        let file = sim_core::SaveFile::decode(&bytes).unwrap();
        let mut b = sim(file.seed);
        b.apply_save(&file).unwrap();
        assert_eq!(records(&b).len(), 17);
        for _ in 0..400 {
            b.step_once();
        }
        assert_eq!(b.digest(), want, "loaded world diverged");
    }

    #[test]
    fn corrupt_creature_saves_are_rejected_without_damage() {
        let mut a = sim(10);
        let before = a.digest();
        let mut save = capture(a.world());
        save.creatures[0].pos = Vec3::new(f32::NAN, 0.0, 0.0);
        assert!(restore(a.world_mut(), save).is_err());
        assert_eq!(a.digest(), before, "failed restore must not touch the world");
        let mut save = capture(a.world());
        save.creatures[1].creature.species = 99;
        assert!(restore(a.world_mut(), save).is_err());
    }

    /// Dev aid: `cargo test -p sim_creatures --release bench -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark"]
    fn bench_two_thousand_creatures() {
        let mut s = sim(11);
        s.command("debug.spawn_creature", r#"{"count":1000}"#);
        s.command("debug.spawn_creature", r#"{"count":988}"#);
        assert_eq!(records(&s).len(), 2000);
        for _ in 0..60 {
            s.step_once();
        }
        let t = std::time::Instant::now();
        for _ in 0..600 {
            s.step_once();
        }
        println!("2000 creatures: {:.3} ms/step (native)", t.elapsed().as_secs_f64() * 1000.0 / 600.0);
    }
}
