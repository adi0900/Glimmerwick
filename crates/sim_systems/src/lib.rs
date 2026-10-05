//! # sim_systems - time, seasons, weather (reference slice)
//!
//! * One in-game day lasts **24 real minutes** (1 game minute per real second); 4 seasons x 7 days.
//! * Channel `time` (`f32`, 16 elements, not interpolated, layout in `docs/BRIDGE_API.md`).
//! * Resource [`Environment`](sim_core::Environment) mirrors the same data for other crates.
//! * Commands `sys.set_time`, `sys.set_weather`, `sys.set_time_scale`; query `sys.time`.
//! * Events 500-504 (dawn, dusk, new day, weather changed, season changed).
//!
//! Economy, quests, villagers and entitlements will live here too; keep the `time` layout stable.

use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::math::{self, Vec2, Vec3};
use sim_core::rng::{Rng, hash2, hash_unit};
use sim_core::{ChannelId, ChannelSpec, Channels, Environment, EventBus, SIM_DT, SimAppExt, SimPublish, SimSet, weather};

/// Real seconds per in-game day.
pub const DAY_REAL_SECONDS: f64 = 1440.0;
/// In-game hours per real second at `time_scale = 1`.
pub const HOURS_PER_REAL_SECOND: f64 = 24.0 / DAY_REAL_SECONDS;
/// Days per season (4 seasons => 28-day year).
pub const SEASON_DAYS: u32 = 7;
/// Hour of the day a new world starts at.
pub const START_HOURS: f64 = 8.0;
/// Elements of the `time` channel.
pub const TIME_CHANNEL_LEN: usize = 16;

/// Event kinds of this crate (range 500-599). Payloads are documented in `docs/BRIDGE_API.md`.
pub mod events {
    use sim_core::EventKind;
    /// Sun rises (06:00). `a` = day index.
    pub const DAWN: EventKind = EventKind::systems(0);
    /// Sun sets (18:00). `a` = day index.
    pub const DUSK: EventKind = EventKind::systems(1);
    /// Midnight rolled over. `a` = new day index.
    pub const NEW_DAY: EventKind = EventKind::systems(2);
    /// Target weather changed. `a` = kind, `b` = target intensity.
    pub const WEATHER_CHANGED: EventKind = EventKind::systems(3);
    /// Season changed. `a` = season (0-3), `b` = day index.
    pub const SEASON_CHANGED: EventKind = EventKind::systems(4);
}

/// The game clock (resource). `total_hours` counts from world creation (day 0, 00:00).
#[derive(Resource, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameTime {
    pub total_hours: f64,
    /// 0 = frozen, 1 = normal, up to 100.
    pub time_scale: f32,
}

impl Default for GameTime {
    fn default() -> Self {
        Self { total_hours: START_HOURS, time_scale: 1.0 }
    }
}

impl GameTime {
    /// Hour of the day `0..24`.
    pub fn hours(&self) -> f32 {
        (self.total_hours % 24.0) as f32
    }

    pub fn day_index(&self) -> u32 {
        (self.total_hours / 24.0).floor().max(0.0) as u32
    }

    pub fn season(&self) -> u8 {
        ((self.day_index() / SEASON_DAYS) % 4) as u8
    }

    /// Progress through the current season `0..1`.
    pub fn season_t(&self) -> f32 {
        let days_in = self.day_index() % SEASON_DAYS;
        ((f64::from(days_in) + (self.total_hours % 24.0) / 24.0) / f64::from(SEASON_DAYS)) as f32
    }
}

/// Weather state machine (resource).
#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WeatherState {
    /// Current (displayed) kind / intensity - eased toward the target.
    pub kind: u8,
    pub intensity: f32,
    pub target_kind: u8,
    pub target_intensity: f32,
    /// Pick a new random weather every few game hours.
    pub auto: bool,
    pub next_change_hours: f64,
    rng: Rng,
}

/// Typed handle of the `time` channel.
#[derive(Resource, Clone, Copy)]
pub struct SystemsChannels {
    pub time: ChannelId<f32>,
}

pub struct SystemsPlugin;

#[derive(Serialize, Deserialize)]
struct SystemsSave {
    time: GameTime,
    weather: WeatherState,
}

impl Plugin for SystemsPlugin {
    fn build(&self, app: &mut App) {
        let rng = app.sim_seed().rng("systems.weather");
        let time = app.register_channel::<f32>(
            ChannelSpec::flat::<f32>("time", TIME_CHANNEL_LEN as u32)
                .doc("hours,day,season,season_t,weather_kind,weather_intensity,wind_x,wind_z,sun_dir xyz"),
        );
        app.insert_resource(SystemsChannels { time })
            .insert_resource(GameTime::default())
            .insert_resource(WeatherState {
                kind: weather::CLEAR,
                intensity: 0.0,
                target_kind: weather::CLEAR,
                target_intensity: 0.0,
                auto: false,
                next_change_hours: START_HOURS + 4.0,
                rng,
            });

        app.add_systems(Update, (advance_time, advance_weather, refresh_environment).chain().in_set(SimSet::Env));
        // Refreshing again at publish time keeps channels correct after commands and `load`.
        app.add_systems(SimPublish, (refresh_environment, publish_time).chain());

        register_api(app);
    }
}

// --- systems -------------------------------------------------------------------------------------

fn crossed(prev: f64, now: f64, mark: f64) -> bool {
    ((now - mark) / 24.0).floor() > ((prev - mark) / 24.0).floor()
}

fn advance_time(mut time: ResMut<GameTime>, mut bus: ResMut<EventBus>) {
    if time.time_scale <= 0.0 {
        return;
    }
    let prev = *time;
    time.total_hours += HOURS_PER_REAL_SECOND * f64::from(SIM_DT) * f64::from(time.time_scale);
    let now = *time;

    let day = now.day_index() as f32;
    if crossed(prev.total_hours, now.total_hours, 6.0) {
        bus.emit(events::DAWN, day, 0.0, Vec3::ZERO, 0.0);
    }
    if crossed(prev.total_hours, now.total_hours, 18.0) {
        bus.emit(events::DUSK, day, 0.0, Vec3::ZERO, 0.0);
    }
    if crossed(prev.total_hours, now.total_hours, 0.0) {
        bus.emit(events::NEW_DAY, day, 0.0, Vec3::ZERO, 0.0);
    }
    if now.season() != prev.season() {
        bus.emit(events::SEASON_CHANGED, f32::from(now.season()), day, Vec3::ZERO, 0.0);
    }
}

/// Weighted random weather for `auto` mode (snow only in winter).
fn pick_weather(rng: &mut Rng, season: u8) -> (u8, f32) {
    let roll = rng.f32();
    let kind = if roll < 0.45 {
        weather::CLEAR
    } else if roll < 0.70 {
        weather::CLOUDY
    } else if roll < 0.85 {
        if season == 3 { weather::SNOW } else { weather::RAIN }
    } else if roll < 0.93 {
        weather::FOG
    } else if season == 3 {
        weather::SNOW
    } else {
        weather::STORM
    };
    let intensity = match kind {
        weather::CLEAR => 0.0,
        weather::CLOUDY => rng.range_f32(0.3, 0.8),
        _ => rng.range_f32(0.4, 1.0),
    };
    (kind, intensity)
}

fn advance_weather(mut w: ResMut<WeatherState>, time: Res<GameTime>, mut bus: ResMut<EventBus>) {
    if w.auto && time.total_hours >= w.next_change_hours {
        let season = time.season();
        let (kind, intensity) = pick_weather(&mut w.rng, season);
        let hours = f64::from(w.rng.range_f32(3.0, 7.0));
        w.next_change_hours = time.total_hours + hours;
        w.target_kind = kind;
        w.target_intensity = intensity;
        bus.emit(events::WEATHER_CHANGED, f32::from(kind), intensity, Vec3::ZERO, 0.0);
    }

    // Ease: fade the old weather out, switch kind, fade the new one in.
    let fade_out = math::damp_factor(0.9, SIM_DT);
    let fade_in = math::damp_factor(0.5, SIM_DT);
    if w.kind != w.target_kind {
        w.intensity -= w.intensity * fade_out;
        if w.intensity < 0.03 {
            w.kind = w.target_kind;
            w.intensity = 0.0;
        }
    } else {
        let target = w.target_intensity;
        w.intensity += (target - w.intensity) * fade_in;
        if (w.intensity - target).abs() < 0.002 {
            w.intensity = target;
        }
    }
}

/// 1-D smooth value noise in `[0, 1)`, platform independent.
fn noise1(seed: u32, x: f32) -> f32 {
    let i = x.floor();
    let f = x - i;
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash_unit(hash2(seed, i as i32, 0));
    let b = hash_unit(hash2(seed, i as i32 + 1, 0));
    a + (b - a) * u
}

/// Pure function: the environment for a clock + weather state.
pub fn compute_environment(time: &GameTime, w: &WeatherState) -> Environment {
    let hours = time.hours();
    // Sun: east horizon at 06:00, zenith at 12:00, west horizon at 18:00, nadir at 00:00; a fixed
    // southward (+Z) offset keeps it off the exact east-west plane.
    let theta = (hours - 6.0) / 24.0 * math::TAU;
    let sun_dir = Vec3::new(math::cos(theta), math::sin(theta), 0.28).normalize();

    // Wind drifts slowly in strength and direction; storms blow harder.
    let t = time.total_hours as f32;
    let strength = 0.8 + 3.0 * w.intensity + if w.kind == weather::STORM { 3.0 * w.intensity } else { 0.0 };
    let angle = noise1(0x57_49_4E_44, t * 0.12) * math::TAU * 2.0;
    let gust = 0.75 + 0.5 * noise1(0x47_55_53_54, t * 1.7);
    let wind = Vec2::new(math::cos(angle), math::sin(angle)) * strength * gust;

    Environment {
        hours,
        day_index: time.day_index(),
        season: time.season(),
        season_t: time.season_t(),
        weather_kind: w.kind,
        weather_intensity: w.intensity,
        wind,
        sun_dir,
    }
}

fn refresh_environment(time: Res<GameTime>, w: Res<WeatherState>, mut env: ResMut<Environment>) {
    let new = compute_environment(&time, &w);
    if *env != new {
        *env = new;
    }
}

fn publish_time(env: Res<Environment>, ids: Res<SystemsChannels>, mut channels: ResMut<Channels>) {
    let mut ch = channels.writer(ids.time);
    ch.clear();
    ch.extend_from_slice(&[
        env.hours,
        env.day_index as f32,
        f32::from(env.season),
        env.season_t,
        f32::from(env.weather_kind),
        env.weather_intensity,
        env.wind.x,
        env.wind.y,
        env.sun_dir.x,
        env.sun_dir.y,
        env.sun_dir.z,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ]);
}

// --- commands / queries / save -----------------------------------------------------------------

#[derive(Deserialize)]
struct SetTimeArgs {
    hours: Option<f32>,
    day: Option<u32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum KindArg {
    Num(u8),
    Name(String),
}

#[derive(Deserialize)]
struct SetWeatherArgs {
    kind: Option<KindArg>,
    intensity: Option<f32>,
    auto: Option<bool>,
    /// Snap instead of easing (default true for commands).
    instant: Option<bool>,
}

#[derive(Deserialize)]
struct SetScaleArgs {
    scale: f32,
}

fn register_api(app: &mut App) {
    app.register_command("sys.set_time", |world: &mut World, a: SetTimeArgs| {
        let mut time = world.resource_mut::<GameTime>();
        let day = a.day.unwrap_or_else(|| time.day_index());
        let hours = match a.hours {
            Some(h) if h.is_finite() => f64::from(h.rem_euclid(24.0)),
            Some(_) => return Err("hours must be a finite number".to_string()),
            None => f64::from(time.hours()),
        };
        time.total_hours = f64::from(day.min(1_000_000)) * 24.0 + hours;
        Ok(json!({ "hours": time.hours(), "day": time.day_index() }))
    });

    app.register_command("sys.set_weather", |world: &mut World, a: SetWeatherArgs| {
        let kind = match a.kind {
            None => None,
            Some(KindArg::Num(n)) if usize::from(n) < weather::NAMES.len() => Some(n),
            Some(KindArg::Num(n)) => return Err(format!("weather kind {n} out of range 0..={}", weather::NAMES.len() - 1)),
            Some(KindArg::Name(s)) => Some(weather::from_name(&s).ok_or_else(|| format!("unknown weather '{s}'"))?),
        };
        let now = world.resource::<GameTime>().total_hours;
        let mut w = world.resource_mut::<WeatherState>();
        let kind = kind.unwrap_or(w.target_kind);
        let default_intensity = if kind == weather::CLEAR { 0.0 } else { 0.7 };
        let intensity = match a.intensity {
            Some(i) if i.is_finite() => i.clamp(0.0, 1.0),
            Some(_) => return Err("intensity must be a finite number".to_string()),
            None => default_intensity,
        };
        w.target_kind = kind;
        w.target_intensity = if kind == weather::CLEAR { 0.0 } else { intensity };
        w.auto = a.auto.unwrap_or(false);
        if w.auto {
            w.next_change_hours = now + 3.0;
        }
        if a.instant.unwrap_or(true) {
            w.kind = w.target_kind;
            w.intensity = w.target_intensity;
        }
        let (k, i) = (w.target_kind, w.target_intensity);
        world.resource_mut::<EventBus>().emit(events::WEATHER_CHANGED, f32::from(k), i, Vec3::ZERO, 0.0);
        Ok(json!({ "kind": k, "name": weather::name(k), "intensity": i }))
    });

    app.register_command("sys.set_time_scale", |world: &mut World, a: SetScaleArgs| {
        if !a.scale.is_finite() {
            return Err("scale must be a finite number".to_string());
        }
        let mut time = world.resource_mut::<GameTime>();
        time.time_scale = a.scale.clamp(0.0, 100.0);
        Ok(json!({ "scale": time.time_scale }))
    });

    app.register_query("sys.time", |world: &World, _: Value| {
        let time = world.resource::<GameTime>();
        let w = world.resource::<WeatherState>();
        let env = world.resource::<Environment>();
        Ok(json!({
            "hours": time.hours(),
            "day": time.day_index(),
            "season": time.season(),
            "season_name": sim_core::environment::SEASON_NAMES[usize::from(time.season())],
            "season_t": time.season_t(),
            "time_scale": time.time_scale,
            "real_seconds_per_day": DAY_REAL_SECONDS,
            "weather": { "kind": w.kind, "name": weather::name(w.kind), "intensity": w.intensity,
                         "target_kind": w.target_kind, "target_intensity": w.target_intensity, "auto": w.auto },
            "sun_dir": [env.sun_dir.x, env.sun_dir.y, env.sun_dir.z],
            "wind": [env.wind.x, env.wind.y],
        }))
    });

    app.register_event(events::DAWN, "sys.dawn", "a = day index")
        .register_event(events::DUSK, "sys.dusk", "a = day index")
        .register_event(events::NEW_DAY, "sys.new_day", "a = new day index")
        .register_event(events::WEATHER_CHANGED, "sys.weather_changed", "a = target kind, b = target intensity")
        .register_event(events::SEASON_CHANGED, "sys.season_changed", "a = season 0-3, b = day index");

    app.register_save_section(
        "systems",
        1,
        |w: &World| SystemsSave { time: *w.resource::<GameTime>(), weather: w.resource::<WeatherState>().clone() },
        |w: &mut World, s: SystemsSave| {
            if !s.time.total_hours.is_finite() || s.time.total_hours < 0.0 {
                return Err("corrupt clock".to_string());
            }
            *w.resource_mut::<GameTime>() = s.time;
            *w.resource_mut::<WeatherState>() = s.weather;
            Ok(())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::Sim;

    fn sim() -> Sim {
        Sim::build(3, |app| {
            app.add_plugins(SystemsPlugin);
        })
    }

    fn time_channel(s: &Sim) -> Vec<f32> {
        let ch = s.world().resource::<Channels>();
        ch.slice(s.world().resource::<SystemsChannels>().time).to_vec()
    }

    #[test]
    fn day_lasts_24_real_minutes() {
        let mut s = sim();
        let start = time_channel(&s)[0];
        assert!((start - 8.0).abs() < 1e-5);
        // 60 real seconds = 3600 steps = exactly one game hour.
        for _ in 0..3600 {
            s.step_once();
        }
        let t = time_channel(&s);
        assert!((t[0] - 9.0).abs() < 0.001, "hours {}", t[0]);
        // 24 real minutes later it is 08:00 again, one day older.
        for _ in 0..(3600 * 23) {
            s.step_once();
        }
        let t = time_channel(&s);
        assert!((t[0] - 8.0).abs() < 0.01 || (t[0] - 8.0 - 24.0).abs() < 0.01, "hours {}", t[0]);
        assert_eq!(t[1], 1.0, "day index");
    }

    #[test]
    fn sun_path_matches_the_clock() {
        let mut s = sim();
        for (hours, expect_y_sign, check) in [(12.0, 1.0, "noon"), (0.0, -1.0, "midnight"), (6.0, 0.0, "dawn"), (18.0, 0.0, "dusk")] {
            s.command("sys.set_time", &format!("{{\"hours\":{hours}}}"));
            let t = time_channel(&s);
            let sun = Vec3::new(t[8], t[9], t[10]);
            assert!((sun.length() - 1.0).abs() < 1e-4, "{check}: not unit {sun:?}");
            if expect_y_sign == 0.0 {
                assert!(sun.y.abs() < 0.05, "{check}: sun should be on the horizon {sun:?}");
            } else {
                assert!(sun.y * expect_y_sign > 0.9, "{check}: {sun:?}");
            }
        }
        // morning sun is in the east (+X), evening sun in the west (-X)
        s.command("sys.set_time", r#"{"hours":9}"#);
        assert!(time_channel(&s)[8] > 0.3);
        s.command("sys.set_time", r#"{"hours":15}"#);
        assert!(time_channel(&s)[8] < -0.3);
    }

    #[test]
    fn set_time_validates_and_wraps() {
        let mut s = sim();
        assert!(s.command("sys.set_time", r#"{"hours":30.5}"#).contains("6.5"));
        assert!((time_channel(&s)[0] - 6.5).abs() < 1e-4);
        assert!(s.command("sys.set_time", r#"{"hours":-1}"#).contains("23"));
        assert!(s.command("sys.set_time", r#"{"hours":"x"}"#).contains("error"));
        s.command("sys.set_time", r#"{"day":9,"hours":12}"#);
        let t = time_channel(&s);
        assert_eq!((t[1], t[2]), (9.0, 1.0), "day 9 is in season 1 (summer)");
        assert!(s.command("sys.set_time_scale", r#"{"scale":0}"#).contains("scale"));
        let before = time_channel(&s)[0];
        for _ in 0..600 {
            s.step_once();
        }
        assert_eq!(time_channel(&s)[0], before, "time_scale 0 freezes the clock");
    }

    #[test]
    fn weather_commands_snap_or_ease() {
        let mut s = sim();
        let reply: Value = serde_json::from_str(&s.command("sys.set_weather", r#"{"kind":"rain","intensity":0.8}"#)).unwrap();
        assert_eq!((reply["kind"].as_u64(), reply["name"].as_str()), (Some(2), Some("rain")));
        assert!((reply["intensity"].as_f64().unwrap() - 0.8).abs() < 1e-6);
        let t = time_channel(&s);
        assert_eq!((t[4], t[5]), (2.0, 0.8));
        assert!(s.command("sys.set_weather", r#"{"kind":9}"#).contains("out of range"));
        assert!(s.command("sys.set_weather", r#"{"kind":"hail"}"#).contains("unknown weather"));
        // blended change: old weather fades out before the new kind appears
        s.command("sys.set_weather", r#"{"kind":3,"intensity":1.0,"instant":false}"#);
        assert_eq!(time_channel(&s)[4], 2.0, "still raining right after the command");
        let mut saw_switch = false;
        for _ in 0..600 {
            s.step_once();
            if time_channel(&s)[4] == 3.0 {
                saw_switch = true;
                break;
            }
        }
        assert!(saw_switch, "storm never arrived");
        for _ in 0..900 {
            s.step_once();
        }
        assert!((time_channel(&s)[5] - 1.0).abs() < 0.01);
        // clear forces intensity 0
        s.command("sys.set_weather", r#"{"kind":0,"intensity":0.9}"#);
        assert_eq!(time_channel(&s)[5], 0.0);
    }

    #[test]
    fn auto_weather_is_deterministic_and_changes() {
        let run = || {
            let mut s = sim();
            s.command("sys.set_weather", r#"{"auto":true,"kind":"clear"}"#);
            s.command("sys.set_time_scale", r#"{"scale":50}"#);
            let mut kinds = std::collections::BTreeSet::new();
            for _ in 0..20_000 {
                s.step_once();
                kinds.insert(time_channel(&s)[4] as u8);
            }
            (s.digest(), kinds)
        };
        let (d1, k1) = run();
        let (d2, k2) = run();
        assert_eq!(d1, d2);
        assert_eq!(k1, k2);
        assert!(k1.len() >= 2, "auto weather never changed: {k1:?}");
    }

    #[test]
    fn events_fire_at_dawn_dusk_midnight() {
        let mut s = sim();
        s.command("sys.set_time", r#"{"hours":5.99}"#);
        s.drain_events();
        for _ in 0..120 {
            s.step_once();
        }
        let ev = s.drain_events();
        let kinds: Vec<u16> = ev.chunks(7).map(|e| e[0] as u16).collect();
        assert!(kinds.contains(&events::DAWN.0), "{kinds:?}");
        s.command("sys.set_time", r#"{"hours":23.99}"#);
        s.drain_events();
        for _ in 0..120 {
            s.step_once();
        }
        let kinds: Vec<u16> = s.drain_events().chunks(7).map(|e| e[0] as u16).collect();
        assert!(kinds.contains(&events::NEW_DAY.0), "{kinds:?}");
    }

    #[test]
    fn query_and_save_roundtrip() {
        let mut a = sim();
        a.command("sys.set_time", r#"{"day":3,"hours":14.25}"#);
        a.command("sys.set_weather", r#"{"kind":"fog","intensity":0.6}"#);
        for _ in 0..90 {
            a.step_once();
        }
        let q: Value = serde_json::from_str(&a.query("sys.time", "")).unwrap();
        assert_eq!(q["day"], 3);
        assert_eq!(q["weather"]["name"], "fog");
        assert_eq!(q["real_seconds_per_day"], 1440.0);

        let bytes = a.save().unwrap();
        let file = sim_core::SaveFile::decode(&bytes).unwrap();
        let mut b = sim();
        b.apply_save(&file).unwrap();
        assert_eq!(time_channel(&a), time_channel(&b));
        for _ in 0..200 {
            a.step_once();
            b.step_once();
        }
        assert_eq!(a.digest(), b.digest());
    }
}
