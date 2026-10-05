//! Read-only environment snapshot shared by all modules.
//!
//! `sim_systems` owns time and weather and writes [`Environment`] every step; creatures (sleep at
//! night, shelter from rain), the player and builders read it without depending on `sim_systems`.
//! (The same values reach JS through the `time` channel.)

use crate::math::{self, Vec2, Vec3};
use bevy_ecs::prelude::Resource;

/// Weather kinds (`time` channel column 4).
pub mod weather {
    pub const CLEAR: u8 = 0;
    pub const CLOUDY: u8 = 1;
    pub const RAIN: u8 = 2;
    pub const STORM: u8 = 3;
    pub const SNOW: u8 = 4;
    pub const FOG: u8 = 5;
    pub const NAMES: [&str; 6] = ["clear", "cloudy", "rain", "storm", "snow", "fog"];

    pub fn name(kind: u8) -> &'static str {
        NAMES.get(usize::from(kind)).copied().unwrap_or("unknown")
    }

    /// Parses a kind from its name (case-insensitive).
    pub fn from_name(name: &str) -> Option<u8> {
        NAMES.iter().position(|n| n.eq_ignore_ascii_case(name)).map(|i| i as u8)
    }
}

/// Seasons (`time` channel column 2).
pub const SEASON_NAMES: [&str; 4] = ["spring", "summer", "autumn", "winter"];

/// Current environment (resource, written by `sim_systems`).
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct Environment {
    /// Hour of the day, `0..24`.
    pub hours: f32,
    /// Days since the world was created.
    pub day_index: u32,
    /// `0..=3` (see [`SEASON_NAMES`]).
    pub season: u8,
    /// Progress through the season, `0..1`.
    pub season_t: f32,
    /// One of [`weather`] kinds.
    pub weather_kind: u8,
    /// `0..1`.
    pub weather_intensity: f32,
    /// Wind in m/s on the XZ plane.
    pub wind: Vec2,
    /// Unit vector pointing *toward* the sun (y < 0 at night; the moon is the opposite direction).
    pub sun_dir: Vec3,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            hours: 12.0,
            day_index: 0,
            season: 0,
            season_t: 0.0,
            weather_kind: weather::CLEAR,
            weather_intensity: 0.0,
            wind: Vec2::ZERO,
            sun_dir: Vec3::new(0.0, 1.0, 0.0),
        }
    }
}

impl Environment {
    /// 0 at night .. 1 in full daylight (smooth around dawn/dusk).
    pub fn daylight(&self) -> f32 {
        math::smoothstep(-0.12, 0.30, self.sun_dir.y)
    }

    /// True while the sun is clearly below the horizon.
    pub fn is_night(&self) -> bool {
        self.sun_dir.y < -0.10
    }

    /// True when it is raining, storming or snowing.
    pub fn is_precipitating(&self) -> bool {
        matches!(self.weather_kind, weather::RAIN | weather::STORM | weather::SNOW) && self.weather_intensity > 0.15
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_names_roundtrip() {
        for (i, n) in weather::NAMES.iter().enumerate() {
            assert_eq!(weather::from_name(n), Some(i as u8));
            assert_eq!(weather::name(i as u8), *n);
        }
        assert_eq!(weather::from_name("RAIN"), Some(2));
        assert_eq!(weather::from_name("hail"), None);
    }

    #[test]
    fn daylight_follows_sun_height() {
        let mut e = Environment::default();
        assert!(e.daylight() > 0.99 && !e.is_night());
        e.sun_dir = Vec3::new(1.0, -0.8, 0.0).normalize();
        assert!(e.daylight() < 0.01 && e.is_night());
    }
}
