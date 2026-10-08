//! Block classification for the micro function. Mirrors `sim_core::blocks::BLOCKS` by id (a test checks the flags).
//! sim_micro stays free of Bevy, so the table is duplicated here: ids are append-only (docs/WORLD_CONTRACT.md).

pub const AIR: u8 = 0;
pub const GRASS: u8 = 1;
pub const DIRT: u8 = 2;
pub const STONE: u8 = 3;
pub const STONE_WARM: u8 = 4;
pub const SAND: u8 = 6;
pub const GRAVEL: u8 = 7;
pub const PATH: u8 = 10;
pub const PACKED: u8 = 11;
pub const GRASS_HIGH: u8 = 13;
pub const GRASS_FLOWER: u8 = 14;
pub const SNOW: u8 = 15;
pub const WATER: u8 = 16;
pub const BEDROCK: u8 = 39;
pub const COUNT: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// air and unknown ids
    Air,
    Liquid,
    /// grass, dirt, sand, snow, gravel, clay, mud, path: relief + indentation
    Soft,
    /// stone family, cobble, bedrock: strata
    Rock,
    /// logs, mushroom stem, glowcap: round
    Wood,
    /// planks, plaster, roof, glass, lantern: sharp
    Hard,
    /// foliage shells
    Leaf,
}

const fn class_of(id: usize) -> Class {
    match id {
        1 | 2 | 6..=15 => Class::Soft,
        3..=5 | 34 | 39 => Class::Rock,
        16 => Class::Liquid,
        17..=20 | 31 | 32 => Class::Wood,
        21..=30 => Class::Leaf,
        33 | 35..=38 => Class::Hard,
        _ => Class::Air,
    }
}

const fn build() -> [Class; 256] {
    let mut t = [Class::Air; 256];
    let mut i = 0;
    while i < COUNT {
        t[i] = class_of(i);
        i += 1;
    }
    t
}

static CLASS: [Class; 256] = build();

/// Class of a block id (ids >= 256 and unknown ids behave like air).
#[inline]
pub fn class(id: u16) -> Class {
    if id < 256 { CLASS[usize::from(id)] } else { Class::Air }
}

/// Solid for the micro world (everything that is not air / unknown / liquid).
#[inline]
pub fn solid(id: u16) -> bool {
    !matches!(class(id), Class::Air | Class::Liquid)
}

#[inline]
pub fn is_log(id: u16) -> bool {
    matches!(id, 17..=20)
}

/// Blocks that get a top "cap" layer over dirt (the top tile differs from the side tile in the 1 m world).
#[inline]
pub fn capped(id: u16) -> bool {
    matches!(id, 1 | 10 | 11 | 12..=15)
}

#[inline]
pub fn is_grass(id: u16) -> bool {
    matches!(id, 1 | 12..=14)
}

/// Bare ground that may carry pebbles.
#[inline]
pub fn pebbly(id: u16) -> bool {
    matches!(id, 2 | 6 | 7 | 8 | 9 | 10 | 11)
}
