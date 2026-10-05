//! # sim_player - the player character
//!
//! Reference slice: kinematic controller ([`controller`]) driven by `Input`, publishing channel
//! `player` (`f32`, stride 16, interpolated), commands `player.set_tool` / `debug.teleport`, query
//! `player.info`, events 200-206, and a `player` save section.
//!
//! The authoritative state is the [`PlayerBody`] component; `Position`, `Velocity` and `Yaw` on the
//! same entity are write-only mirrors so other crates can find the player through `sim_core`
//! components without depending on this crate.

mod controller;

pub use controller::{Body, Happened, Intent, PlayerTuning, anim, step as step_body};

use bevy_app::{App, Plugin, Startup, Update};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::math::{self, Vec3};
use sim_core::{
    ChannelId, ChannelSpec, Channels, EventBus, HeightQuery, Id, IdAllocator, Input, Interact, Interactable, Player, Position,
    SimAppExt, SimPublish, SimSet, SpawnPoints, StartupSet, Velocity, Yaw, buttons,
};

/// Elements per record of channel `player`.
pub const PLAYER_STRIDE: usize = 16;

/// Event kinds of this crate (range 200-299). Payloads: see `docs/BRIDGE_API.md`.
pub mod events {
    use sim_core::EventKind;
    /// Jump started. `f` = take-off speed.
    pub const JUMP: EventKind = EventKind::player(0);
    /// Landed after a fall. `a` = impact speed (m/s).
    pub const LAND: EventKind = EventKind::player(1);
    /// Entered deep water. `a` = impact speed (m/s).
    pub const SPLASH: EventKind = EventKind::player(2);
    /// Footstep. `a` = biome id under the feet, `b` = 1 when sprinting.
    pub const FOOTSTEP: EventKind = EventKind::player(3);
    /// Tool changed. `a` = new tool index.
    pub const TOOL_CHANGED: EventKind = EventKind::player(4);
    /// INTERACT pressed on a target. `a` = target id, `b` = tool, position = target position.
    pub const INTERACT: EventKind = EventKind::player(5);
    /// USE_TOOL pressed. `a` = target id (0 = none), `b` = tool, position = player feet.
    pub const USE_TOOL: EventKind = EventKind::player(6);
}

/// Authoritative controller state (see module docs).
#[derive(Component, Clone, Debug, PartialEq)]
pub struct PlayerBody(pub Body);

/// Non-physical player state.
#[derive(Component, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    /// Selected tool: 0 net, 1 fishing rod, 2 shovel, 3 axe, 4 watering can.
    pub tool: u8,
    /// [`Id`] of the interactable the camera is aimed at, 0 = none.
    pub look_target: u32,
}

/// Typed handle of the `player` channel.
#[derive(Resource, Clone, Copy)]
pub struct PlayerChannels {
    pub player: ChannelId<f32>,
}

pub struct PlayerPlugin;

#[derive(Serialize, Deserialize)]
struct PlayerSave {
    id: u32,
    body: Body,
    tool: u8,
}

impl Plugin for PlayerPlugin {
    fn build(&self, app: &mut App) {
        let player = app.register_channel::<f32>(
            ChannelSpec::records::<f32>("player", PLAYER_STRIDE as u32, 1)
                .interpolated()
                .doc("pos xyz,vel xyz,yaw,anim_state,anim_t,grounded,water_depth,tool,speed01,look_target_id,-,-"),
        );
        app.insert_resource(PlayerChannels { player }).init_resource::<PlayerTuning>();

        app.add_systems(Startup, spawn_player.in_set(StartupSet::Actors));
        app.add_systems(Update, (player_step.in_set(SimSet::Move), player_react.in_set(SimSet::React)));
        app.add_systems(SimPublish, publish_player);

        register_api(app);
    }
}

// --- systems -------------------------------------------------------------------------------------

fn spawn_player(mut commands: Commands, spawn: Res<SpawnPoints>, terrain: Res<HeightQuery>, mut ids: ResMut<IdAllocator>) {
    let mut pos = spawn.player;
    pos.y = terrain.height(pos.x, pos.z);
    let body = Body::new(pos, 0.0);
    commands.spawn((
        Player,
        ids.alloc(),
        Position(pos),
        Velocity(Vec3::ZERO),
        Yaw(0.0),
        PlayerBody(body),
        PlayerState::default(),
    ));
}

type PlayerStepQuery<'w, 's> = Single<'w, 's, (&'static mut PlayerBody, &'static mut Position, &'static mut Velocity, &'static mut Yaw), With<Player>>;

fn player_step(
    player: PlayerStepQuery,
    input: Res<Input>,
    terrain: Res<HeightQuery>,
    tuning: Res<PlayerTuning>,
    mut bus: ResMut<EventBus>,
    mut happened: Local<Vec<Happened>>,
) {
    let (mut body, mut pos, mut vel, mut yaw) = player.into_inner();
    let intent = Intent {
        move_vec: input.move_vec(),
        camera_yaw: input.camera_yaw,
        sprint: input.held(buttons::SPRINT),
        jump_pressed: input.just_pressed(buttons::JUMP),
    };
    happened.clear();
    step_body(&mut body.0, &intent, &terrain, &tuning, &mut happened);

    for ev in happened.iter() {
        let at = body.0.pos;
        match *ev {
            Happened::Jump => bus.emit(events::JUMP, 0.0, 0.0, at, tuning.jump_speed),
            Happened::Land { impact } => bus.emit(events::LAND, impact, 0.0, at, 0.0),
            Happened::Splash { impact } => bus.emit(events::SPLASH, impact, 0.0, at, 0.0),
            Happened::Footstep { biome } => {
                bus.emit(events::FOOTSTEP, f32::from(biome), if intent.sprint { 1.0 } else { 0.0 }, at, 0.0);
            }
        }
    }

    // Mirrors for other crates.
    pos.0 = body.0.pos;
    vel.0 = body.0.vel;
    yaw.0 = body.0.yaw;
}

type TargetQuery<'w, 's> = Query<'w, 's, (&'static Id, &'static Position, &'static Interactable), Without<Player>>;

/// Tool switching, interaction targeting and the INTERACT / USE_TOOL buttons.
fn player_react(
    player: Single<(&PlayerBody, &mut PlayerState), With<Player>>,
    input: Res<Input>,
    tuning: Res<PlayerTuning>,
    targets: TargetQuery,
    mut bus: ResMut<EventBus>,
    mut interact: MessageWriter<Interact>,
) {
    let (body, mut state) = player.into_inner();
    let body = &body.0;

    // tools
    let count = tuning.tool_count.max(1);
    let mut tool = state.tool;
    if input.just_pressed(buttons::TOOL_NEXT) {
        tool = (tool + 1) % count;
    }
    if input.just_pressed(buttons::TOOL_PREV) {
        tool = (tool + count - 1) % count;
    }
    if tool != state.tool {
        state.tool = tool;
        bus.emit(events::TOOL_CHANGED, f32::from(tool), 0.0, body.pos, 0.0);
    }

    // aim: nearest interactable roughly in front of the camera (ties broken by id => order independent)
    let fwd = math::camera_forward(input.camera_yaw);
    let mut best: Option<(f32, u32, Vec3)> = None;
    for (id, pos, inter) in &targets {
        let dx = pos.x - body.pos.x;
        let dz = pos.z - body.pos.z;
        let d2 = dx * dx + dz * dz;
        if d2 > inter.radius * inter.radius {
            continue;
        }
        let d = d2.sqrt();
        let cos = if d < 1e-3 { 1.0 } else { (dx * fwd.x + dz * fwd.z) / d };
        if cos < 0.8 && d > 1.2 {
            continue;
        }
        let score = d * (1.6 - cos);
        let better = match best {
            None => true,
            Some((s, bid, _)) => score < s || (score == s && id.0 < bid),
        };
        if better {
            best = Some((score, id.0, pos.0));
        }
    }
    let target = best.map_or(0, |b| b.1);
    if state.look_target != target {
        state.look_target = target;
    }

    if input.just_pressed(buttons::INTERACT)
        && let Some((_, id, at)) = best
    {
        bus.emit(events::INTERACT, id as f32, f32::from(state.tool), at, 0.0);
        interact.write(Interact { target: id, tool: state.tool });
    }
    if input.just_pressed(buttons::USE_TOOL) {
        bus.emit(events::USE_TOOL, target as f32, f32::from(state.tool), body.pos, 0.0);
    }
}

fn publish_player(
    player: Single<(&PlayerBody, &PlayerState), With<Player>>,
    ids: Res<PlayerChannels>,
    mut channels: ResMut<Channels>,
) {
    let (body, state) = player.into_inner();
    let b = &body.0;
    let mut w = channels.writer(ids.player);
    w.clear();
    w.extend_from_slice(&[
        b.pos.x,
        b.pos.y,
        b.pos.z,
        b.vel.x,
        b.vel.y,
        b.vel.z,
        b.yaw,
        f32::from(b.anim_state),
        b.anim_t,
        if b.grounded { 1.0 } else { 0.0 },
        b.water_depth,
        f32::from(state.tool),
        b.speed01,
        state.look_target as f32,
        0.0,
        0.0,
    ]);
}

// --- commands / queries / save -------------------------------------------------------------------

#[derive(Deserialize)]
struct TeleportArgs {
    x: f32,
    z: f32,
    y: Option<f32>,
}

#[derive(Deserialize)]
struct ToolArgs {
    tool: u8,
}

/// Height at which a body standing / floating at `(x, z)` rests.
fn rest_height(terrain: &HeightQuery, tuning: &PlayerTuning, x: f32, z: f32) -> (f32, bool) {
    let ground = terrain.height(x, z);
    let depth = terrain.sea_level() - ground;
    if depth > tuning.swim_depth + 0.08 { (terrain.sea_level() - tuning.swim_depth, true) } else { (ground, false) }
}

fn register_api(app: &mut App) {
    app.register_command("debug.teleport", |world: &mut World, a: TeleportArgs| {
        if !a.x.is_finite() || !a.z.is_finite() || a.y.is_some_and(|y| !y.is_finite()) {
            return Err("x, y and z must be finite numbers".to_string());
        }
        let tuning = world.resource::<PlayerTuning>().clone();
        let (x, z, ground, rest, swimming) = {
            let terrain = world.resource::<HeightQuery>();
            let (x, z) = terrain.clamp(a.x, a.z);
            let (rest, swimming) = rest_height(terrain, &tuning, x, z);
            (x, z, terrain.height(x, z), rest, swimming)
        };
        // An explicit y above the rest height drops the player from there.
        let y = a.y.map_or(rest, |y| y.max(rest));
        let ids = *world.resource::<PlayerChannels>();
        let mut q = world.query_filtered::<(&mut PlayerBody, &mut Position, &mut Velocity), With<Player>>();
        let Some((mut body, mut pos, mut vel)) = q.iter_mut(world).next() else {
            return Err("no player entity".to_string());
        };
        let b = &mut body.0;
        b.pos = Vec3::new(x, y, z);
        b.vel = Vec3::ZERO;
        b.grounded = y <= ground + 1e-3 && !swimming;
        b.swimming = swimming;
        b.sliding = false;
        b.jump_buffer = 0.0;
        b.coyote = 0.0;
        b.land_timer = 0.0;
        b.stride = 0.0;
        pos.0 = b.pos;
        vel.0 = Vec3::ZERO;
        world.resource_mut::<Channels>().mark_discontinuity(ids.player);
        Ok(json!({ "x": x, "y": y, "z": z }))
    });

    app.register_command("player.set_tool", |world: &mut World, a: ToolArgs| {
        let count = world.resource::<PlayerTuning>().tool_count;
        if a.tool >= count {
            return Err(format!("tool {} out of range 0..{count}", a.tool));
        }
        let mut q = world.query_filtered::<&mut PlayerState, With<Player>>();
        let Some(mut state) = q.iter_mut(world).next() else {
            return Err("no player entity".to_string());
        };
        state.tool = a.tool;
        Ok(json!({ "tool": a.tool }))
    });

    app.register_query("player.info", |world: &World, _: Value| {
        let mut q = world.try_query_filtered::<(&PlayerBody, &PlayerState, &Id), With<Player>>().ok_or("player not spawned yet")?;
        let (body, state, id) = q.iter(world).next().ok_or("no player entity")?;
        let b = &body.0;
        Ok(json!({
            "id": id.0,
            "pos": [b.pos.x, b.pos.y, b.pos.z],
            "vel": [b.vel.x, b.vel.y, b.vel.z],
            "yaw": b.yaw,
            "grounded": b.grounded,
            "swimming": b.swimming,
            "sliding": b.sliding,
            "water_depth": b.water_depth,
            "anim_state": b.anim_state,
            "tool": state.tool,
            "look_target": state.look_target,
        }))
    });

    app.register_event(events::JUMP, "player.jump", "f = take-off speed")
        .register_event(events::LAND, "player.land", "a = impact speed m/s")
        .register_event(events::SPLASH, "player.splash", "a = impact speed m/s (entered deep water)")
        .register_event(events::FOOTSTEP, "player.footstep", "a = biome id, b = 1 if sprinting")
        .register_event(events::TOOL_CHANGED, "player.tool_changed", "a = new tool index")
        .register_event(events::INTERACT, "player.interact", "a = target id, b = tool, pos = target")
        .register_event(events::USE_TOOL, "player.use_tool", "a = target id (0 none), b = tool, pos = feet");

    app.register_save_section(
        "player",
        1,
        |w: &World| {
            let mut q = w.try_query_filtered::<(&PlayerBody, &PlayerState, &Id), With<Player>>();
            match q.as_mut().and_then(|q| q.iter(w).next().map(|(b, s, id)| (b.0.clone(), s.tool, id.0))) {
                Some((body, tool, id)) => PlayerSave { id, body, tool },
                None => PlayerSave { id: 0, body: Body::new(Vec3::ZERO, 0.0), tool: 0 },
            }
        },
        |w: &mut World, s: PlayerSave| {
            if !s.body.pos.is_finite() || !s.body.vel.is_finite() || !s.body.yaw.is_finite() {
                return Err("corrupt player state".to_string());
            }
            let mut q = w.query_filtered::<(Entity, &Id), With<Player>>();
            let Some((entity, id)) = q.iter(w).next().map(|(e, id)| (e, *id)) else {
                return Err("no player entity to restore into".to_string());
            };
            let tool = s.tool.min(w.resource::<PlayerTuning>().tool_count.saturating_sub(1));
            let mut e = w.entity_mut(entity);
            if s.id != 0 && id.0 != s.id {
                e.insert(Id(s.id));
            }
            e.insert((
                Position(s.body.pos),
                Velocity(s.body.vel),
                Yaw(s.body.yaw),
                PlayerBody(s.body),
                PlayerState { tool, look_target: 0 },
            ));
            Ok(())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Sim;

    fn sim() -> Sim {
        Sim::build(1, |app| {
            app.add_plugins(PlayerPlugin);
        })
    }

    fn player_rec(s: &Sim) -> Vec<f32> {
        let ch = s.world().resource::<Channels>();
        ch.slice(s.world().resource::<PlayerChannels>().player).to_vec()
    }

    fn input(move_x: f32, move_y: f32, buttons: u32, yaw: f32) -> [f32; 8] {
        [move_x, move_y, 0.0, 0.0, buttons as f32, yaw, 0.0, 1.0]
    }

    #[test]
    fn spawns_one_player_and_publishes_before_the_first_step() {
        let s = sim();
        let rec = player_rec(&s);
        assert_eq!(rec.len(), PLAYER_STRIDE);
        assert_eq!(rec[9], 1.0, "grounded");
        let info: Value = serde_json::from_str(&s.query("player.info", "")).unwrap();
        assert_eq!(info["id"], 1);
        let id: Value = serde_json::from_str(&s.channel_info_json("player")).unwrap();
        assert_eq!((id["stride"].as_u64(), id["len"].as_u64(), id["kind"].as_str()), (Some(16), Some(16), Some("f32")));
        assert_ne!(id["prev_ptr"], 0, "player is interpolated");
    }

    #[test]
    fn walks_forward_relative_to_the_camera_and_interpolates() {
        let mut s = sim();
        s.set_input(&input(0.0, 1.0, 0, 0.0));
        for _ in 0..60 {
            s.tick(1.0 / 60.0);
        }
        let rec = player_rec(&s);
        assert!(rec[2] < -2.0, "should have moved toward -Z, z = {}", rec[2]);
        assert!(rec[12] > 0.4, "speed01 {}", rec[12]);
        // prev holds the previous step: strictly behind cur in z
        let ch = s.world().resource::<Channels>();
        let prev = ch.prev_slice(s.world().resource::<PlayerChannels>().player);
        assert!(prev[2] > rec[2], "prev z {} cur z {}", prev[2], rec[2]);
    }

    #[test]
    fn jump_button_jumps_once_per_press_and_emits_events() {
        let mut s = sim();
        s.drain_events();
        s.set_input(&input(0.0, 0.0, buttons::JUMP, 0.0));
        s.tick(1.0 / 60.0);
        assert!(player_rec(&s)[1] > s.world().resource::<SpawnPoints>().player.y - 5.0);
        // keep holding jump: no second jump until released and pressed again
        let mut max_y = f32::MIN;
        let mut jumps = 0;
        let mut lands = 0;
        let held = input(0.0, 0.0, buttons::JUMP, 0.0);
        for _ in 0..120 {
            s.set_input(&held);
            s.tick(1.0 / 60.0);
            max_y = max_y.max(player_rec(&s)[1]);
        }
        for e in s.drain_events().chunks(7) {
            jumps += usize::from(e[0] == f32::from(events::JUMP.0));
            lands += usize::from(e[0] == f32::from(events::LAND.0));
        }
        assert_eq!(jumps, 1, "held jump must not retrigger");
        assert_eq!(lands, 1);
        assert!(max_y > 1.0);
    }

    #[test]
    fn tool_buttons_cycle_and_command_validates() {
        let mut s = sim();
        s.set_input(&input(0.0, 0.0, buttons::TOOL_NEXT, 0.0));
        s.tick(1.0 / 60.0);
        assert_eq!(player_rec(&s)[11], 1.0);
        s.set_input(&input(0.0, 0.0, 0, 0.0));
        s.tick(1.0 / 60.0);
        s.set_input(&input(0.0, 0.0, buttons::TOOL_PREV, 0.0));
        s.tick(1.0 / 60.0);
        s.set_input(&input(0.0, 0.0, 0, 0.0));
        s.tick(1.0 / 60.0);
        s.set_input(&input(0.0, 0.0, buttons::TOOL_PREV, 0.0));
        s.tick(1.0 / 60.0);
        assert_eq!(player_rec(&s)[11], 4.0, "wraps below 0");
        assert!(s.command("player.set_tool", r#"{"tool":9}"#).contains("out of range"));
        assert_eq!(s.command("player.set_tool", r#"{"tool":2}"#), r#"{"tool":2}"#);
        assert_eq!(player_rec(&s)[11], 2.0);
    }

    #[test]
    fn teleport_moves_validates_and_snaps_interpolation() {
        let mut s = sim();
        s.tick(1.0 / 60.0);
        let reply = s.command("debug.teleport", r#"{"x":30.0,"z":-12.5}"#);
        let r: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!((r["x"].as_f64(), r["z"].as_f64()), (Some(30.0), Some(-12.5)));
        let rec = player_rec(&s);
        assert_eq!((rec[0], rec[2]), (30.0, -12.5));
        let ch = s.world().resource::<Channels>();
        let prev = ch.prev_slice(s.world().resource::<PlayerChannels>().player);
        assert_eq!(prev[0], 30.0, "teleport must not interpolate across the map");
        assert!(s.command("debug.teleport", r#"{"x":"a","z":1}"#).contains("error"));
        assert!(s.command("debug.teleport", r#"{"z":1}"#).contains("bad arguments"));
        // out-of-bounds positions are clamped to the playable area
        let r: Value = serde_json::from_str(&s.command("debug.teleport", r#"{"x":99999,"z":0}"#)).unwrap();
        assert!(r["x"].as_f64().unwrap() <= 1024.0);
    }

    #[test]
    fn save_roundtrip_restores_the_body() {
        let mut a = sim();
        a.command("debug.teleport", r#"{"x":5,"z":6}"#);
        a.set_input(&input(1.0, 0.5, buttons::SPRINT, 0.7));
        for _ in 0..77 {
            a.tick(1.0 / 60.0);
        }
        a.command("player.set_tool", r#"{"tool":3}"#);
        let bytes = a.save().unwrap();
        for _ in 0..60 {
            a.tick(1.0 / 60.0);
        }
        let file = sim_core::SaveFile::decode(&bytes).unwrap();
        let mut b = sim();
        b.apply_save(&file).unwrap();
        assert_eq!(b.tick_count(), 77);
        assert_eq!(player_rec(&b)[11], 3.0);
        b.set_input(&input(1.0, 0.5, buttons::SPRINT, 0.7));
        for _ in 0..60 {
            b.tick(1.0 / 60.0);
        }
        assert_eq!(player_rec(&a), player_rec(&b));
        assert_eq!(a.digest(), b.digest());
    }

    #[test]
    fn interact_targets_the_interactable_in_front_and_sends_a_message() {
        use sim_core::bevy_ecs::message::Messages;
        let mut s = sim();
        // Two interactables: one in front of the camera (-Z), one behind.
        let spawn = s.world().resource::<SpawnPoints>().player;
        let front = Vec3::new(spawn.x, 0.0, spawn.z - 3.0);
        let back = Vec3::new(spawn.x, 0.0, spawn.z + 2.0);
        let (front_id, back_id) = {
            let w = s.world_mut();
            let a = w.resource_mut::<IdAllocator>().alloc();
            let b = w.resource_mut::<IdAllocator>().alloc();
            w.spawn((a, Position(front), Interactable { radius: 5.0 }));
            w.spawn((b, Position(back), Interactable { radius: 5.0 }));
            (a.0, b.0)
        };
        s.set_input(&input(0.0, 0.0, 0, 0.0));
        s.tick(1.0 / 60.0);
        assert_eq!(player_rec(&s)[13], front_id as f32, "aim should pick the one in front (not {back_id})");
        s.drain_events();
        s.set_input(&input(0.0, 0.0, buttons::INTERACT, 0.0));
        s.tick(1.0 / 60.0);
        let ev: Vec<f32> = s.drain_events();
        assert!(ev.chunks(7).any(|e| e[0] == f32::from(events::INTERACT.0) && e[1] == front_id as f32));
        let msgs = s.world().resource::<Messages<Interact>>();
        assert!(msgs.iter_current_update_messages().any(|m| m.target == front_id), "Interact message was not written");
        // turning the camera around retargets the other one
        s.set_input(&input(0.0, 0.0, 0, math::PI));
        s.tick(1.0 / 60.0);
        assert_eq!(player_rec(&s)[13], back_id as f32);
    }
}
