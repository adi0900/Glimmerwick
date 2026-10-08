//! Shared helpers of the bench / render examples: the real island (seed 1) and area classification.
#![allow(dead_code)]

use sim_micro::GridDesc;
use sim_micro::blocks::{self, Class};

pub const D: GridDesc = GridDesc::GLIMMERWICK;

/// The game's world for sim seed `seed` (same generator path as the running game).
pub fn island(seed: u32) -> Vec<u16> {
    let sim = sim_core::Sim::build(seed, |app| {
        app.add_plugins(sim_world::WorldPlugin);
    });
    let data = sim.world().resource::<sim_world::WorldData>();
    let blocks = data.world.0.read().unwrap().blocks.clone();
    blocks
}

/// Highest solid block of world column (x, z): `(y, id)`.
pub fn top_solid(b: &[u16], x: i32, z: i32) -> Option<(i32, u16)> {
    let mut y = 44;
    while y >= -14 {
        let id = D.block(b, x, y, z);
        if blocks::solid(id) {
            return Some((y, id));
        }
        y -= 1;
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Meadow,
    Beach,
    Forest,
    Cliff,
    Other,
}

pub const AREAS: [(Area, &str); 4] = [(Area::Meadow, "meadow"), (Area::Beach, "beach"), (Area::Forest, "forest"), (Area::Cliff, "cliff")];

/// Classifies the 2x2 m cell whose minimum corner is (x, z).
pub fn classify(b: &[u16], x: i32, z: i32) -> Area {
    let mut tops = [(0i32, 0u16); 4];
    for (i, (dx, dz)) in [(0, 0), (1, 0), (0, 1), (1, 1)].iter().enumerate() {
        match top_solid(b, x + dx, z + dz) {
            Some(t) => tops[i] = t,
            None => return Area::Other,
        }
    }
    let leaves = tops.iter().filter(|t| blocks::class(t.1) == Class::Leaf).count();
    if leaves >= 2 {
        return Area::Forest;
    }
    // 6x6 neighbourhood height range
    let (mut lo, mut hi) = (i32::MAX, i32::MIN);
    for dz in -2..4 {
        for dx in -2..4 {
            if let Some((y, id)) = top_solid(b, x + dx, z + dz) {
                if blocks::class(id) == Class::Leaf {
                    return Area::Other;
                }
                lo = lo.min(y);
                hi = hi.max(y);
            }
        }
    }
    let rock = tops.iter().filter(|t| blocks::class(t.1) == Class::Rock).count();
    if rock >= 2 && hi - lo >= 3 {
        return Area::Cliff;
    }
    if tops.iter().all(|t| t.1 == u16::from(blocks::SAND)) && hi - lo <= 1 && hi >= -1 && hi <= 2 {
        return Area::Beach;
    }
    if tops.iter().all(|t| blocks::is_grass(t.1)) && hi == lo && hi >= 1 {
        return Area::Meadow;
    }
    Area::Other
}

pub struct Lcg(pub u64);
impl Lcg {
    pub fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

/// Finds up to `want` cells of `area` (deterministic), as world (x, z) of the cell's min corner (even coordinates).
pub fn find_cells(b: &[u16], area: Area, want: usize, seed: u64) -> Vec<(i32, i32)> {
    let mut rng = Lcg(seed);
    let mut out = Vec::new();
    let mut tries = 0;
    while out.len() < want && tries < 400_000 {
        tries += 1;
        let x = (rng.next() % 340) as i32 - 156;
        let z = (rng.next() % 276) as i32 - 132;
        let (x, z) = (x & !1, z & !1);
        if classify(b, x, z) == area && !out.contains(&(x, z)) {
            out.push((x, z));
        }
    }
    out
}
