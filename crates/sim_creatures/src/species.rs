//! Data-driven species table (placeholder values for the three hero species).
//!
//! The characters owner replaces/extends this table; species ids are indices into [`SPECIES`] and
//! are what channel column 1 and the `creature.species` query expose.

use sim_core::terrain::biome;

/// How a species reacts when it notices the player.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Personality {
    /// Walks over to have a look.
    Curious,
    /// Keeps its distance and runs away.
    Shy,
    /// Bounces around excitedly, then carries on.
    Playful,
}

impl Personality {
    pub fn name(self) -> &'static str {
        match self {
            Personality::Curious => "curious",
            Personality::Shy => "shy",
            Personality::Playful => "playful",
        }
    }
}

/// Static per-species data.
#[derive(Clone, Debug)]
pub struct Species {
    pub name: &'static str,
    /// Biomes the species is spawned in and wanders through.
    pub habitat: &'static [u8],
    /// m/s
    pub walk_speed: f32,
    pub run_speed: f32,
    /// Distance at which the player is noticed (in full daylight).
    pub notice_radius: f32,
    pub personality: Personality,
    /// Visual scale published in channel column 7.
    pub base_scale: f32,
    /// How far from its home a creature wanders (m).
    pub wander_radius: f32,
    /// Can enter shallow water (floats on the surface).
    pub swims: bool,
    /// Curious creatures stop this far from the player.
    pub stop_distance: f32,
}

/// Species ids.
pub const PUFFBUN: u8 = 0;
pub const TIDLER: u8 = 1;
pub const SPRIGFOX: u8 = 2;

pub const SPECIES: [Species; 3] = [
    Species {
        name: "Puffbun",
        habitat: &[biome::MEADOW],
        walk_speed: 1.1,
        run_speed: 3.2,
        notice_radius: 9.0,
        personality: Personality::Curious,
        base_scale: 0.8,
        wander_radius: 10.0,
        swims: false,
        stop_distance: 2.4,
    },
    Species {
        name: "Tidler",
        habitat: &[biome::BEACH, biome::SHALLOW_WATER],
        walk_speed: 1.0,
        run_speed: 2.8,
        notice_radius: 8.0,
        personality: Personality::Playful,
        base_scale: 0.9,
        wander_radius: 9.0,
        swims: true,
        stop_distance: 3.0,
    },
    Species {
        name: "Sprigfox",
        habitat: &[biome::FOREST],
        walk_speed: 1.6,
        run_speed: 5.2,
        notice_radius: 11.0,
        personality: Personality::Shy,
        base_scale: 0.75,
        wander_radius: 12.0,
        swims: false,
        stop_distance: 4.0,
    },
];

/// Species lookup with a safe fallback (corrupt saves can never index out of bounds).
pub fn species(id: u8) -> &'static Species {
    SPECIES.get(usize::from(id)).unwrap_or(&SPECIES[0])
}

/// Number of colour variants per species (variant column 2 is `0..VARIANTS`).
pub const VARIANTS: u8 = 3;

const NAMES: [&str; 24] = [
    "Pip", "Moss", "Bramble", "Tuft", "Nib", "Clover", "Fennel", "Wisp", "Dot", "Sorrel", "Bun", "Pebble", "Juniper", "Mallow",
    "Tansy", "Bean", "Thistle", "Posy", "Sprout", "Nettle", "Poppy", "Quill", "Dapple", "Marlow",
];

/// Deterministic placeholder name for UI (`creature.info`).
pub fn name_for(id: u32) -> &'static str {
    NAMES[(sim_core::rng::hash64(u64::from(id)) % NAMES.len() as u64) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sane() {
        for (i, s) in SPECIES.iter().enumerate() {
            assert!(!s.habitat.is_empty(), "{}", s.name);
            assert!(s.run_speed > s.walk_speed && s.walk_speed > 0.0, "{}", s.name);
            assert_eq!(species(i as u8).name, s.name);
        }
        assert_eq!(species(200).name, "Puffbun", "out-of-range ids fall back safely");
        assert_eq!(name_for(5), name_for(5));
    }
}
