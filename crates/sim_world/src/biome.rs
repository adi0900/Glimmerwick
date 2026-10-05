//! Biome ids of `world.biome` (docs/WORLD_CONTRACT.md). Ids 2/3/4/1 agree with `sim_core::terrain::biome`
//! (what creatures use for habitats); ids >= 5 follow the contract (sim_core's old `ROCK = 5` is stale).

pub const OCEAN_DEEP: u8 = 0;
pub const SHALLOWS: u8 = 1;
pub const SAND: u8 = 2;
pub const MEADOW: u8 = 3;
pub const FOREST_FLOOR: u8 = 4;
pub const HIGHLAND: u8 = 5;
pub const CLIFF_ROCK: u8 = 6;
pub const DIRT_PATH: u8 = 7;
pub const POND_BANK: u8 = 8;
pub const FLOWER_MEADOW: u8 = 9;
pub const VILLAGE: u8 = 10;
pub const SNOW: u8 = 11;

pub const COUNT: usize = 12;
pub const NAMES: [&str; COUNT] = [
    "ocean_deep",
    "shallows",
    "sand",
    "meadow",
    "forest_floor",
    "highland_grass",
    "cliff_rock",
    "dirt_path",
    "pond_bank",
    "flower_meadow",
    "village_clearing",
    "snow",
];

pub fn name(id: u8) -> &'static str {
    NAMES.get(usize::from(id)).copied().unwrap_or("unknown")
}

/// Sea water (deep or shallow).
pub fn is_sea(id: u8) -> bool {
    id <= SHALLOWS
}
