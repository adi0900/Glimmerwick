//! Seeded island heightfield (reference slice: 128 x 128 samples @ 1 m) and its sampler.
//!
//! # Grid convention (published through `world.info`)
//! `heights[z * size + x]` is the ground height in metres at the world position
//! `(origin_x + x * cell, origin_z + z * cell)` - samples sit on *vertices*, `size` samples span
//! `size - 1` cells. Between samples the surface is bilinear. Sea level is 0.
//!
//! The generator is `fbm` hills + domain-warped radial island falloff + beach shelf; it only uses
//! IEEE-exact float operations, so the same seed gives bit-identical terrain on every target.

use sim_core::math::{self, Vec3, smoothstep};
use sim_core::terrain::{Terrain, TerrainBounds, biome};
use std::sync::Arc;

use crate::noise::fbm;

/// Samples per side of the reference slice.
pub const SIZE: usize = 128;
/// Metres between samples.
pub const CELL: f32 = 1.0;
/// Nominal island radius in metres.
const ISLAND_RADIUS: f32 = 44.0;
/// Chunk edge length in samples for `world.dirty` (the web side meshes in 32 x 32 m chunks).
pub const CHUNK: usize = 32;

/// Ground-truth terrain data (immutable once built; edits replace the whole `Arc`).
#[derive(Debug)]
pub struct Heightfield {
    pub size: usize,
    pub cell: f32,
    pub origin_x: f32,
    pub origin_z: f32,
    pub sea_level: f32,
    pub heights: Vec<f32>,
    pub biomes: Vec<u8>,
    pub min_height: f32,
    pub max_height: f32,
}

/// Terrain height function (before sampling onto the grid).
fn island_height(seed: u32, x: f32, z: f32) -> f32 {
    // Domain warp gives a natural, non-circular coastline.
    let wx = (fbm(seed ^ 0xA1, x * 0.021, z * 0.021, 3) - 0.5) * 2.0;
    let wz = (fbm(seed ^ 0xB2, x * 0.021 + 17.3, z * 0.021 - 9.1, 3) - 0.5) * 2.0;
    let (px, pz) = (x + wx * 11.0, z + wz * 11.0);
    let d = (px * px + pz * pz).sqrt() / ISLAND_RADIUS;
    let t = 1.0 - d; // > 0 inland, ~0 at the shore, < 0 at sea

    // Sea floor -> shelf -> low land.
    let base = -7.0 + 8.0 * smoothstep(-0.55, 0.12, t);
    // Hills only grow inland of the beach.
    let inland = smoothstep(0.02, 0.55, t);
    let hills = fbm(seed ^ 0xC3, x * 0.04, z * 0.04, 5);
    let detail = fbm(seed ^ 0xD4, x * 0.11, z * 0.11, 3);
    base + inland * (hills * 11.5 + detail * 2.4)
}

impl Heightfield {
    /// Generates the reference island for a world seed.
    pub fn generate(seed: u32) -> Self {
        let size = SIZE;
        let origin = -(size as f32) * CELL * 0.5;
        let mut heights = vec![0.0f32; size * size];
        for z in 0..size {
            for x in 0..size {
                let wx = origin + x as f32 * CELL;
                let wz = origin + z as f32 * CELL;
                heights[z * size + x] = island_height(seed, wx, wz);
            }
        }
        let (min_height, max_height) = heights.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &h| (lo.min(h), hi.max(h)));
        let mut hf = Heightfield {
            size,
            cell: CELL,
            origin_x: origin,
            origin_z: origin,
            sea_level: 0.0,
            heights,
            biomes: vec![biome::DEEP_WATER; size * size],
            min_height,
            max_height,
        };
        hf.classify_biomes(seed);
        hf
    }

    /// Fills `biomes` from height, slope and a forest-patch noise.
    fn classify_biomes(&mut self, seed: u32) {
        for z in 0..self.size {
            for x in 0..self.size {
                let wx = self.origin_x + x as f32 * self.cell;
                let wz = self.origin_z + z as f32 * self.cell;
                let h = self.heights[z * self.size + x];
                let slope = math::acos(self.normal(wx, wz).y.clamp(-1.0, 1.0));
                let b = if h < -2.0 {
                    biome::DEEP_WATER
                } else if h < 0.0 {
                    biome::SHALLOW_WATER
                } else if h < 1.1 {
                    biome::BEACH
                } else if slope > 0.62 || h > 8.5 {
                    biome::ROCK
                } else if h > 2.0 && fbm(seed ^ 0xE5, wx * 0.06, wz * 0.06, 3) > 0.5 {
                    biome::FOREST
                } else {
                    biome::MEADOW
                };
                self.biomes[z * self.size + x] = b;
            }
        }
    }

    /// Height of the sample at integer grid coordinates (clamped to the grid).
    #[inline]
    pub fn at(&self, ix: i32, iz: i32) -> f32 {
        let max = self.size as i32 - 1;
        self.heights[(iz.clamp(0, max) as usize) * self.size + ix.clamp(0, max) as usize]
    }

    /// World position of a sample.
    pub fn sample_pos(&self, ix: usize, iz: usize) -> (f32, f32) {
        (self.origin_x + ix as f32 * self.cell, self.origin_z + iz as f32 * self.cell)
    }

    /// Bilinear ground height at world `(x, z)`; clamps to the edge samples outside the grid.
    pub fn sample(&self, x: f32, z: f32) -> f32 {
        let fx = ((x - self.origin_x) / self.cell).clamp(0.0, (self.size - 1) as f32);
        let fz = ((z - self.origin_z) / self.cell).clamp(0.0, (self.size - 1) as f32);
        let (x0, z0) = (fx.floor(), fz.floor());
        let (tx, tz) = (fx - x0, fz - z0);
        let (ix, iz) = (x0 as i32, z0 as i32);
        let h00 = self.at(ix, iz);
        let h10 = self.at(ix + 1, iz);
        let h01 = self.at(ix, iz + 1);
        let h11 = self.at(ix + 1, iz + 1);
        let a = h00 + (h10 - h00) * tx;
        let b = h01 + (h11 - h01) * tx;
        a + (b - a) * tz
    }

    /// Surface normal from central differences of the bilinear surface.
    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        let e = self.cell * 0.5;
        let dx = self.sample(x + e, z) - self.sample(x - e, z);
        let dz = self.sample(x, z + e) - self.sample(x, z - e);
        Vec3::new(-dx, 2.0 * e, -dz).normalize()
    }

    /// Biome id of the nearest sample.
    pub fn biome_at(&self, x: f32, z: f32) -> u8 {
        let fx = ((x - self.origin_x) / self.cell + 0.5).floor().clamp(0.0, (self.size - 1) as f32) as usize;
        let fz = ((z - self.origin_z) / self.cell + 0.5).floor().clamp(0.0, (self.size - 1) as f32) as usize;
        self.biomes[fz * self.size + fx]
    }

    /// Playable area: the grid minus a 4 m margin so nothing walks into the world edge.
    pub fn playable_bounds(&self) -> TerrainBounds {
        let extent = (self.size - 1) as f32 * self.cell;
        let margin = 4.0;
        TerrainBounds {
            min_x: self.origin_x + margin,
            min_z: self.origin_z + margin,
            max_x: self.origin_x + extent - margin,
            max_z: self.origin_z + extent - margin,
        }
    }

    /// Chunk index (row-major over `CHUNK`-sample chunks) containing a sample.
    pub fn chunk_of_sample(&self, ix: usize, iz: usize) -> u32 {
        let per_row = self.size.div_ceil(CHUNK);
        ((iz / CHUNK) * per_row + ix / CHUNK) as u32
    }

    /// Picks a pleasant, flat, dry meadow spot near the island centre for the player to start.
    pub fn find_spawn(&self) -> Vec3 {
        let mut fallback: Option<Vec3> = None;
        for ring in 0..30 {
            let radius = ring as f32 * 2.0;
            let steps = if ring == 0 { 1 } else { 8 + ring * 4 };
            for s in 0..steps {
                let a = s as f32 / steps as f32 * math::TAU;
                let (x, z) = (radius * math::cos(a), radius * math::sin(a));
                let h = self.sample(x, z);
                if h < 1.2 {
                    continue;
                }
                let slope = math::acos(self.normal(x, z).y.clamp(-1.0, 1.0));
                let b = self.biome_at(x, z);
                if b == biome::MEADOW && slope < 0.18 {
                    return Vec3::new(x, h, z);
                }
                if fallback.is_none() && !biome::is_water(b) && slope < 0.5 {
                    fallback = Some(Vec3::new(x, h, z));
                }
            }
        }
        fallback.unwrap_or(Vec3::new(0.0, self.sample(0.0, 0.0), 0.0))
    }
}

/// [`Terrain`] backed by a shared [`Heightfield`].
#[derive(Clone)]
pub struct WorldTerrain {
    pub field: Arc<Heightfield>,
}

impl Terrain for WorldTerrain {
    fn height(&self, x: f32, z: f32) -> f32 {
        self.field.sample(x, z)
    }
    fn normal(&self, x: f32, z: f32) -> Vec3 {
        self.field.normal(x, z)
    }
    fn biome(&self, x: f32, z: f32) -> u8 {
        self.field.biome_at(x, z)
    }
    fn sea_level(&self) -> f32 {
        self.field.sea_level
    }
    fn bounds(&self) -> TerrainBounds {
        self.field.playable_bounds()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(hf: &Heightfield) -> [usize; 6] {
        let mut c = [0usize; 6];
        for &b in &hf.biomes {
            c[usize::from(b)] += 1;
        }
        c
    }

    #[test]
    fn generation_is_deterministic_and_seed_dependent() {
        let a = Heightfield::generate(1);
        let b = Heightfield::generate(1);
        let c = Heightfield::generate(2);
        assert_eq!(a.heights, b.heights);
        assert_eq!(a.biomes, b.biomes);
        assert_ne!(a.heights, c.heights);
        assert_eq!(a.heights.len(), SIZE * SIZE);
    }

    #[test]
    fn looks_like_an_island() {
        for seed in [1u32, 2, 3, 77, 12345] {
            let hf = Heightfield::generate(seed);
            // corners are deep sea, the centre region is land well above sea level
            for &(x, z) in &[(-62.0, -62.0), (62.0, -62.0), (-62.0, 62.0), (62.0, 62.0), (0.0, 62.0)] {
                assert!(hf.sample(x, z) < -4.0, "seed {seed}: ({x},{z}) = {}", hf.sample(x, z));
            }
            let spawn = hf.find_spawn();
            assert!(spawn.y > 1.0, "seed {seed}: spawn {spawn:?}");
            assert!(!biome::is_water(hf.biome_at(spawn.x, spawn.z)));
            let c = counts(&hf);
            let land = c[2] + c[3] + c[4] + c[5];
            let frac = land as f32 / (SIZE * SIZE) as f32;
            assert!((0.18..0.55).contains(&frac), "seed {seed}: land fraction {frac}");
            assert!(c[biome::BEACH as usize] > 100, "seed {seed}: beach {}", c[2]);
            assert!(c[biome::MEADOW as usize] > 200, "seed {seed}: meadow {}", c[3]);
            assert!(c[biome::FOREST as usize] > 100, "seed {seed}: forest {}", c[4]);
            assert!(c[biome::SHALLOW_WATER as usize] > 200, "seed {seed}: shallow {}", c[1]);
            assert!(c[biome::ROCK as usize] > 20, "seed {seed}: rock {}", c[5]);
            assert!(hf.max_height > 6.0 && hf.max_height < 16.0, "seed {seed}: max {}", hf.max_height);
            assert!(hf.min_height > -9.0, "seed {seed}: min {}", hf.min_height);
        }
    }

    #[test]
    fn sampling_is_bilinear_and_continuous() {
        let hf = Heightfield::generate(4);
        // exactly at samples
        let (wx, wz) = hf.sample_pos(40, 50);
        assert_eq!(hf.sample(wx, wz), hf.heights[50 * SIZE + 40]);
        // midpoint is the average of the 4 neighbours on a bilinear patch
        let m = hf.sample(wx + 0.5, wz + 0.5);
        let avg = (hf.at(40, 50) + hf.at(41, 50) + hf.at(40, 51) + hf.at(41, 51)) / 4.0;
        assert!((m - avg).abs() < 1e-4);
        // continuity along a line
        let mut prev = hf.sample(-30.0, 5.0);
        for i in 1..600 {
            let h = hf.sample(-30.0 + i as f32 * 0.1, 5.0);
            assert!((h - prev).abs() < 0.8, "jump at step {i}: {prev} -> {h}");
            prev = h;
        }
        // outside the grid clamps instead of panicking
        assert!(hf.sample(1e6, -1e6).is_finite());
        assert!(hf.sample(f32::MAX, 0.0).is_finite());
    }

    #[test]
    fn normals_are_unit_and_point_up() {
        let hf = Heightfield::generate(6);
        let mut max_slope = 0.0f32;
        for i in 0..400 {
            let (x, z) = (-55.0 + (i % 20) as f32 * 5.5, -55.0 + (i / 20) as f32 * 5.5);
            let n = hf.normal(x, z);
            assert!((n.length() - 1.0).abs() < 1e-4);
            assert!(n.y > 0.0);
            max_slope = max_slope.max(math::acos(n.y));
        }
        assert!(max_slope > 0.2, "terrain should have some relief, max slope {max_slope}");
        assert!(max_slope < 1.4, "terrain should not be a wall, max slope {max_slope}");
    }

    #[test]
    fn terrain_trait_matches_field() {
        let hf = Arc::new(Heightfield::generate(8));
        let t = WorldTerrain { field: hf.clone() };
        assert_eq!(t.height(3.3, -7.7), hf.sample(3.3, -7.7));
        assert_eq!(t.sea_level(), 0.0);
        let b = t.bounds();
        assert!(b.contains(0.0, 0.0) && !b.contains(63.0, 0.0));
    }

    /// Dev aid: `cargo test -p sim_world print_map -- --ignored --nocapture [SEED=n]`.
    #[test]
    #[ignore = "prints an ASCII map of the island for eyeballing"]
    fn print_map() {
        let seed = std::env::var("SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1u32);
        let hf = Heightfield::generate(seed);
        println!("seed {seed}: height {:.1}..{:.1}  spawn {:?}", hf.min_height, hf.max_height, hf.find_spawn());
        println!("legend: ' ' deep  '.' shallow  ',' beach  '\"' meadow  'T' forest  '^' rock   (every 2nd sample)");
        for z in (0..SIZE).step_by(2) {
            let row: String = (0..SIZE)
                .step_by(1)
                .map(|x| match hf.biomes[z * SIZE + x] {
                    biome::DEEP_WATER => ' ',
                    biome::SHALLOW_WATER => '.',
                    biome::BEACH => ',',
                    biome::MEADOW => '"',
                    biome::FOREST => 'T',
                    _ => '^',
                })
                .collect();
            println!("{row}");
        }
        let c = counts(&hf);
        println!("counts deep/shallow/beach/meadow/forest/rock = {c:?}");
    }

    #[test]
    fn chunk_indices() {
        let hf = Heightfield::generate(1);
        assert_eq!(hf.chunk_of_sample(0, 0), 0);
        assert_eq!(hf.chunk_of_sample(31, 31), 0);
        assert_eq!(hf.chunk_of_sample(32, 0), 1);
        assert_eq!(hf.chunk_of_sample(0, 32), 4);
        assert_eq!(hf.chunk_of_sample(127, 127), 15);
    }
}
