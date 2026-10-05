//! The island heightfield container and its sampler.
//!
//! # Grid convention (published through `world.info`)
//! `heights[z * size + x]` is the ground height in metres at the world position
//! `(origin_x + x * cell, origin_z + z * cell)` - samples sit on *vertices*, `size` samples span
//! `size - 1` cells. Between samples the surface is bilinear. Sea level is 0.
//!
//! Resolution: 0.5 m cells over a 576 m world (1153 x 1153 samples = 1.33 M). Fine enough for rounded cliff lips
//! and half-metre building steps; the generator (see `worldgen.rs`) only evaluates the expensive noise on a 2 m
//! lattice and upsamples with a cubic B-spline, so a full world costs well under the 1.5 s wasm budget.

use sim_core::math::{self, Vec3};
use sim_core::terrain::{Terrain, TerrainBounds};
use std::sync::Arc;

/// Metres between samples.
pub const CELL: f32 = 0.5;
/// Cells per side (samples = cells + 1).
pub const CELLS: usize = 1152;
/// Samples per side.
pub const SIZE: usize = CELLS + 1;
/// Chunk edge length in cells for `world.dirty` (64 cells = 32 m; the web side meshes 32 x 32 m chunks).
pub const CHUNK: usize = 64;
/// Half extent of the world in metres (the grid spans `-HALF ..= HALF`).
pub const HALF: f32 = CELLS as f32 * CELL * 0.5;

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

impl Heightfield {
    /// Wraps generated arrays (`heights.len() == biomes.len() == SIZE * SIZE`).
    pub fn from_parts(heights: Vec<f32>, biomes: Vec<u8>) -> Self {
        let (min_height, max_height) = heights.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &h| (lo.min(h), hi.max(h)));
        Heightfield { size: SIZE, cell: CELL, origin_x: -HALF, origin_z: -HALF, sea_level: 0.0, heights, biomes, min_height, max_height }
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

    /// Height gradient `(dh/dx, dh/dz)` by central differences over +-1 cell (smooth enough for physics + placement).
    pub fn gradient(&self, x: f32, z: f32) -> (f32, f32) {
        let e = self.cell;
        ((self.sample(x + e, z) - self.sample(x - e, z)) / (2.0 * e), (self.sample(x, z + e) - self.sample(x, z - e)) / (2.0 * e))
    }

    /// Steepness `|grad h|` (tan of the slope angle).
    pub fn steepness(&self, x: f32, z: f32) -> f32 {
        let (gx, gz) = self.gradient(x, z);
        (gx * gx + gz * gz).sqrt()
    }

    /// Surface normal from central differences of the bilinear surface.
    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        let (gx, gz) = self.gradient(x, z);
        Vec3::new(-gx, 1.0, -gz).normalize()
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

    /// Chunk index (row-major over `CHUNK`-cell chunks) containing a sample.
    pub fn chunk_of_sample(&self, ix: usize, iz: usize) -> u32 {
        let per_row = self.size.div_ceil(CHUNK);
        ((iz / CHUNK) * per_row + ix / CHUNK) as u32
    }

    /// Slope angle in radians at a point.
    pub fn slope(&self, x: f32, z: f32) -> f32 {
        math::acos(self.normal(x, z).y.clamp(-1.0, 1.0))
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
