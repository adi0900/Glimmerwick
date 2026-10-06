//! Voxel world: storage, edits, `HeightQuery` adapter and the voxel-native generator.
//!
//! Layout (all deterministic, IEEE ops + `sim_core::math` only):
//! * **Grid:** `NX x NZ` columns of 1 m, `NY` layers. World block `(x, y, z)` (integer *world metres*, `y` may be
//!   negative) lives at layer `(x - ORIGIN_X, y + SEA_Y, z - ORIGIN_Z)`; layer `SEA_Y - 1` is the one whose top face
//!   is sea level (`y = 0`). Layer 0 is bedrock.
//! * **Storage:** `blocks` is chunk-major (chunk = 16 x 16 columns x all layers, chunk index `cz * NCX + cx`), inside a
//!   chunk column-major with `y` fastest: `index = chunk * CH_CELLS + ((lz * 16 + lx) * NY + y)`. The same array is
//!   published as channel `vox.data` (u16).
//! * **Generation:** the island design of `worldgen.rs` (lobed shoreline, 3-tier highland, pond + streams, coves,
//!   village clearing, paths, biomes) is sampled per column at 1 m, quantised with a spike cleanup, then made
//!   voxel-native: strata, grass-over-dirt, beaches, stream beds, cliff recesses (overhangs), sea caves, block trees,
//!   bushes and cottages. Decor flora (kinds >= 32 and ferns) stays in the `flora` channel, re-grounded on the blocks.

use crate::biome;
use crate::flora::FLORA_STRIDE;
use crate::noise::{fbm_rot, value_noise};
use crate::worldgen::Generated;
use sim_core::blocks::{self, BLOCKS, BlockId, BlockSource, flag, id::*};
use sim_core::math::{self, Vec3};
use sim_core::terrain::{Terrain, TerrainBounds};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

pub const NX: usize = 352;
pub const NZ: usize = 288;
pub const NY: usize = 56;
pub const CH: usize = 16;
pub const NCX: usize = NX / CH;
pub const NCZ: usize = NZ / CH;
pub const NCHUNKS: usize = NCX * NCZ;
pub const CH_CELLS: usize = CH * CH * NY;
pub const TOTAL_CELLS: usize = NCHUNKS * CH_CELLS;
/// World x / z (integer metres) of column 0.
pub const ORIGIN_X: i32 = -160;
pub const ORIGIN_Z: i32 = -136;
/// Layer index whose *bottom* face is world y = 0 minus one block, i.e. world y = layer - SEA_Y.
pub const SEA_Y: i32 = 14;

#[inline]
pub fn chunk_of(ix: usize, iz: usize) -> usize {
    (iz / CH) * NCX + ix / CH
}

// ------------------------------------------------------------------------------------------------- helpers

#[inline]
fn ss(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
fn h3(seed: u32, x: i32, y: i32, z: i32) -> u32 {
    let mut h = seed ^ 0x9E37_79B9;
    h = (h ^ (x as u32).wrapping_mul(0x85EB_CA6B)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h = (h ^ (y as u32).wrapping_mul(0xC2B2_AE35)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h = (h ^ (z as u32).wrapping_mul(0x27D4_EB2F)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

#[inline]
fn u01(h: u32) -> f32 {
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn vnoise3(seed: u32, x: f32, y: f32, z: f32) -> f32 {
    let (x0, y0, z0) = (x.floor(), y.floor(), z.floor());
    let (fx, fy, fz) = (fade(x - x0), fade(y - y0), fade(z - z0));
    let (xi, yi, zi) = (x0 as i32, y0 as i32, z0 as i32);
    let c = |dx: i32, dy: i32, dz: i32| u01(h3(seed, xi + dx, yi + dy, zi + dz));
    let a = lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy);
    let b = lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy);
    lerp(a, b, fz)
}

/// Rock band at layer `l`: tilted strata of warm / cool / dark stone.
fn strata_block(seed: u32, l: usize, ix: usize, iz: usize) -> BlockId {
    let t = l as f32 * 0.6 + value_noise(seed ^ 0x77, ix as f32 * 0.045, iz as f32 * 0.045) * 2.4;
    match (t.floor() as i32).rem_euclid(7) {
        0 | 1 | 4 => STONE_WARM,
        2 | 3 | 6 => STONE,
        _ => STONE_DARK,
    }
}

// ------------------------------------------------------------------------------------------------- storage

/// Result of a successful [`VoxelWorld::edit`].
#[derive(Clone, Debug)]
pub struct EditInfo {
    pub old: BlockId,
    pub cell: usize,
    pub column: usize,
    /// chunks whose mesh must be rebuilt (the edited one first, then border neighbours)
    pub chunks: Vec<usize>,
    pub changed: bool,
}

pub struct VoxelWorld {
    /// chunk-major block ids (`vox.data`)
    pub blocks: Vec<u16>,
    /// per column (`iz * NX + ix`): top *ground* layer (solid, not vegetation) or -1
    pub top: Vec<i16>,
    /// per column biome id (docs/WORLD_CONTRACT.md)
    pub biome: Vec<u8>,
    /// per column 3 x 3 mean of the surface height (m): gentle slopes for `HeightQuery::normal`
    pub smooth: Vec<f32>,
    /// per chunk, bumped on every change that affects its mesh (including border neighbours)
    pub versions: Vec<u32>,
    /// per chunk: highest non-air layer + 1 (meshing loop bound)
    pub max_layer: Vec<u8>,
    /// per chunk: edited since generation (saved)
    pub edited: Vec<bool>,
    /// chunk ids touched since the last [`take_dirty`](Self::take_dirty)
    pub dirty: Vec<u32>,
}

impl VoxelWorld {
    pub fn empty() -> Self {
        VoxelWorld {
            blocks: vec![0; TOTAL_CELLS],
            top: vec![-1; NX * NZ],
            biome: vec![biome::OCEAN_DEEP; NX * NZ],
            smooth: vec![-(SEA_Y as f32); NX * NZ],
            versions: vec![1; NCHUNKS],
            max_layer: vec![0; NCHUNKS],
            edited: vec![false; NCHUNKS],
            dirty: Vec::new(),
        }
    }

    #[inline]
    pub fn column_base(ix: usize, iz: usize) -> usize {
        chunk_of(ix, iz) * CH_CELLS + ((iz % CH) * CH + ix % CH) * NY
    }

    #[inline]
    pub fn cell(ix: usize, iy: usize, iz: usize) -> usize {
        Self::column_base(ix, iz) + iy
    }

    /// Block at layer coordinates. Below layer 0: bedrock; outside the columns / above the top: air.
    #[inline]
    pub fn get_l(&self, ix: i32, iy: i32, iz: i32) -> BlockId {
        if iy < 0 {
            return BEDROCK;
        }
        if iy >= NY as i32 || ix < 0 || iz < 0 || ix >= NX as i32 || iz >= NZ as i32 {
            return AIR;
        }
        self.blocks[Self::cell(ix as usize, iy as usize, iz as usize)]
    }

    /// Block at world block coordinates.
    #[inline]
    pub fn get(&self, x: i32, y: i32, z: i32) -> BlockId {
        self.get_l(x - ORIGIN_X, y + SEA_Y, z - ORIGIN_Z)
    }

    /// Surface height (m) of a column's top ground block.
    #[inline]
    pub fn surface_m(&self, ix: usize, iz: usize) -> f32 {
        (i32::from(self.top[iz * NX + ix]) + 1 - SEA_Y) as f32
    }

    /// Top ground block's world y at world column `(x, z)` (None outside the world / no ground).
    pub fn ground_block_y(&self, x: i32, z: i32) -> Option<i32> {
        let (ix, iz) = (x - ORIGIN_X, z - ORIGIN_Z);
        if ix < 0 || iz < 0 || ix >= NX as i32 || iz >= NZ as i32 {
            return None;
        }
        let t = self.top[iz as usize * NX + ix as usize];
        (t >= 0).then(|| i32::from(t) - SEA_Y)
    }

    fn recompute_column(&mut self, ix: usize, iz: usize) {
        let base = Self::column_base(ix, iz);
        let col = &self.blocks[base..base + NY];
        let mut hi = NY;
        while hi > 0 && col[hi - 1] == AIR {
            hi -= 1;
        }
        let mut l = hi;
        while l > 0 && !blocks::is_ground(col[l - 1]) {
            l -= 1;
        }
        self.top[iz * NX + ix] = l as i16 - 1;
        let ch = chunk_of(ix, iz);
        if hi as u8 > self.max_layer[ch] {
            self.max_layer[ch] = hi as u8;
        }
    }

    fn recompute_smooth_at(&mut self, ix: usize, iz: usize) {
        let mut s = 0.0;
        for dz in -1..=1i32 {
            for dx in -1..=1i32 {
                let x = (ix as i32 + dx).clamp(0, NX as i32 - 1) as usize;
                let z = (iz as i32 + dz).clamp(0, NZ as i32 - 1) as usize;
                s += self.surface_m(x, z);
            }
        }
        self.smooth[iz * NX + ix] = s / 9.0;
    }

    /// Recomputes every derived array (tops, chunk heights, smoothed surface).
    pub fn recompute_all(&mut self) {
        self.max_layer.iter_mut().for_each(|m| *m = 0);
        for iz in 0..NZ {
            for ix in 0..NX {
                self.recompute_column(ix, iz);
            }
        }
        for iz in 0..NZ {
            for ix in 0..NX {
                self.recompute_smooth_at(ix, iz);
            }
        }
    }

    /// Sets a block with change tracking (versions of the chunk and its border neighbours, dirty list, saved flag).
    pub fn edit(&mut self, x: i32, y: i32, z: i32, id: BlockId) -> Result<EditInfo, String> {
        let (ixi, iyi, izi) = (x - ORIGIN_X, y + SEA_Y, z - ORIGIN_Z);
        if ixi < 0 || izi < 0 || ixi >= NX as i32 || izi >= NZ as i32 || iyi >= NY as i32 || iyi < 0 {
            return Err(format!("block ({x}, {y}, {z}) is outside the world"));
        }
        if iyi == 0 {
            return Err("the bottom layer is bedrock".to_string());
        }
        if usize::from(id) >= BLOCKS.len() {
            return Err(format!("unknown block id {id}"));
        }
        let (ix, iy, iz) = (ixi as usize, iyi as usize, izi as usize);
        let cell = Self::cell(ix, iy, iz);
        let column = iz * NX + ix;
        let old = self.blocks[cell];
        if old == id {
            return Ok(EditInfo { old, cell, column, chunks: Vec::new(), changed: false });
        }
        if old == BEDROCK {
            return Err("bedrock cannot be edited".to_string());
        }
        self.blocks[cell] = id;
        self.recompute_column(ix, iz);
        for dz in -1..=1i32 {
            for dx in -1..=1i32 {
                let (a, b) = ((ix as i32 + dx).clamp(0, NX as i32 - 1) as usize, (iz as i32 + dz).clamp(0, NZ as i32 - 1) as usize);
                self.recompute_smooth_at(a, b);
            }
        }
        let c0 = chunk_of(ix, iz);
        let mut chunks = vec![c0];
        let (lx, lz) = (ix % CH, iz % CH);
        let xs: &[i32] = if lx == 0 { &[-1, 0] } else if lx == CH - 1 { &[0, 1] } else { &[0] };
        let zs: &[i32] = if lz == 0 { &[-1, 0] } else if lz == CH - 1 { &[0, 1] } else { &[0] };
        for &dx in xs {
            for &dz in zs {
                let (a, b) = (ix as i32 + dx, iz as i32 + dz);
                if a < 0 || b < 0 || a >= NX as i32 || b >= NZ as i32 {
                    continue;
                }
                let c = chunk_of(a as usize, b as usize);
                if !chunks.contains(&c) {
                    chunks.push(c);
                }
            }
        }
        for &c in &chunks {
            self.versions[c] = self.versions[c].wrapping_add(1);
            if !self.dirty.contains(&(c as u32)) {
                self.dirty.push(c as u32);
            }
        }
        self.edited[c0] = true;
        if (iy + 1) as u8 > self.max_layer[c0] {
            self.max_layer[c0] = (iy + 1) as u8;
        }
        Ok(EditInfo { old, cell, column, chunks, changed: true })
    }

    pub fn take_dirty(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.dirty)
    }

    /// Run-length encoding of one chunk: `[id, run, id, run, ...]`.
    pub fn encode_chunk(&self, c: usize) -> Vec<u16> {
        let cells = &self.blocks[c * CH_CELLS..(c + 1) * CH_CELLS];
        let mut out = Vec::new();
        let (mut cur, mut run) = (cells[0], 0u32);
        for &v in cells {
            if v == cur && run < 65535 {
                run += 1;
            } else {
                out.push(cur);
                out.push(run as u16);
                cur = v;
                run = 1;
            }
        }
        out.push(cur);
        out.push(run as u16);
        out
    }

    pub fn decode_chunk(&mut self, c: usize, rle: &[u16]) -> Result<(), String> {
        if c >= NCHUNKS || rle.len() % 2 != 0 {
            return Err("bad chunk record".to_string());
        }
        let total: usize = rle.chunks_exact(2).map(|p| usize::from(p[1])).sum();
        if total != CH_CELLS || rle.chunks_exact(2).any(|p| usize::from(p[0]) >= BLOCKS.len()) {
            return Err("chunk data is corrupt".to_string());
        }
        let mut i = c * CH_CELLS;
        for p in rle.chunks_exact(2) {
            let n = usize::from(p[1]);
            self.blocks[i..i + n].fill(p[0]);
            i += n;
        }
        self.edited[c] = true;
        self.versions[c] = self.versions[c].wrapping_add(1);
        Ok(())
    }

    // ---- terrain adapters ------------------------------------------------------------------------

    /// Ground height: flat on every block, a ~0.4 m ramp at block borders (continuous for the controllers).
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        let fx = (x - ORIGIN_X as f32 - 0.5).clamp(0.0, (NX - 1) as f32);
        let fz = (z - ORIGIN_Z as f32 - 0.5).clamp(0.0, (NZ - 1) as f32);
        let (ix, iz) = (fx.floor() as usize, fz.floor() as usize);
        let (ix1, iz1) = ((ix + 1).min(NX - 1), (iz + 1).min(NZ - 1));
        let (tx, tz) = (ss(0.3, 0.7, fx - ix as f32), ss(0.3, 0.7, fz - iz as f32));
        let a = lerp(self.surface_m(ix, iz), self.surface_m(ix1, iz), tx);
        let b = lerp(self.surface_m(ix, iz1), self.surface_m(ix1, iz1), tx);
        lerp(a, b, tz)
    }

    fn smooth_at(&self, x: f32, z: f32) -> f32 {
        let fx = (x - ORIGIN_X as f32 - 0.5).clamp(0.0, (NX - 1) as f32);
        let fz = (z - ORIGIN_Z as f32 - 0.5).clamp(0.0, (NZ - 1) as f32);
        let (ix, iz) = (fx.floor() as usize, fz.floor() as usize);
        let (ix1, iz1) = ((ix + 1).min(NX - 1), (iz + 1).min(NZ - 1));
        let (tx, tz) = (fx - ix as f32, fz - iz as f32);
        let g = |a: usize, b: usize| self.smooth[b * NX + a];
        lerp(lerp(g(ix, iz), g(ix1, iz), tx), lerp(g(ix, iz1), g(ix1, iz1), tx), tz)
    }

    /// Gentle normal from the blurred surface (steps of 1-2 m read as walkable slopes, 3 m+ cliffs as walls).
    pub fn normal_at(&self, x: f32, z: f32) -> Vec3 {
        let e = 0.5;
        let gx = (self.smooth_at(x + e, z) - self.smooth_at(x - e, z)) / (2.0 * e);
        let gz = (self.smooth_at(x, z + e) - self.smooth_at(x, z - e)) / (2.0 * e);
        Vec3::new(-gx * 1.25, 1.0, -gz * 1.25).normalize()
    }

    pub fn biome_at(&self, x: f32, z: f32) -> u8 {
        let ix = (x.floor() as i32 - ORIGIN_X).clamp(0, NX as i32 - 1) as usize;
        let iz = (z.floor() as i32 - ORIGIN_Z).clamp(0, NZ as i32 - 1) as usize;
        self.biome[iz * NX + ix]
    }
}

impl BlockSource for VoxelWorld {
    fn block(&self, x: i32, y: i32, z: i32) -> BlockId {
        self.get(x, y, z)
    }
}

/// Shared handle used by the `HeightQuery` adapter, the `VoxelQuery` resource and the command handlers.
#[derive(Clone)]
pub struct SharedWorld(pub Arc<RwLock<VoxelWorld>>);

impl BlockSource for SharedWorld {
    fn block(&self, x: i32, y: i32, z: i32) -> BlockId {
        self.0.read().expect("voxel world lock").get(x, y, z)
    }
}

/// [`Terrain`] over the voxel columns (top ground block per column).
#[derive(Clone)]
pub struct VoxelTerrain(pub SharedWorld);

impl Terrain for VoxelTerrain {
    fn height(&self, x: f32, z: f32) -> f32 {
        (self.0).0.read().expect("voxel world lock").height_at(x, z)
    }
    fn normal(&self, x: f32, z: f32) -> Vec3 {
        (self.0).0.read().expect("voxel world lock").normal_at(x, z)
    }
    fn biome(&self, x: f32, z: f32) -> u8 {
        (self.0).0.read().expect("voxel world lock").biome_at(x, z)
    }
    fn sea_level(&self) -> f32 {
        0.0
    }
    fn bounds(&self) -> TerrainBounds {
        let m = 4.0;
        TerrainBounds { min_x: ORIGIN_X as f32 + m, min_z: ORIGIN_Z as f32 + m, max_x: (ORIGIN_X + NX as i32) as f32 - m, max_z: (ORIGIN_Z + NZ as i32) as f32 - m }
    }
}

// ------------------------------------------------------------------------------------------------- generation

/// Everything the generator produces besides the blocks.
pub struct Built {
    pub world: VoxelWorld,
    /// decor flora records (stride 8), re-grounded on the blocks
    pub decor: Vec<f32>,
    /// `[x, y, z, dir_x, dir_z, height]` of carved caves (world metres; floor y)
    pub caves: Vec<[f32; 6]>,
    /// `[x, z, door_dir, base_y]` of the village cottages
    pub cottages: Vec<[f32; 4]>,
    pub tree_count: usize,
}

struct Cottage {
    x0: i32,
    z0: i32,
    w: i32,
    d: i32,
    base_y: i32,
    door: u8,
}

const STRATA_TOP: BlockId = u16::MAX;

struct Gen<'a> {
    g: &'a Generated,
    seed: u32,
    h: Vec<i32>,
    bio: Vec<u8>,
    wl: Vec<i16>,
    bed: Vec<u8>,
    w: VoxelWorld,
}

impl<'a> Gen<'a> {
    fn new(g: &'a Generated, seed: u32) -> Self {
        Gen { g, seed, h: vec![0; NX * NZ], bio: vec![0; NX * NZ], wl: vec![-1; NX * NZ], bed: vec![0; NX * NZ], w: VoxelWorld::empty() }
    }

    #[inline]
    fn hc(&self, ix: i32, iz: i32) -> i32 {
        self.h[ix.clamp(0, NX as i32 - 1) as usize + iz.clamp(0, NZ as i32 - 1) as usize * NX]
    }

    /// 1 m column heights from the smooth design heightfield (2 x 2 supersample), edge fade to a flat sea floor.
    fn heights(&mut self) {
        let hf = &self.g.field;
        let mut hz = vec![0.0f32; NX * NZ];
        let mut mk = vec![0.0f32; NX * NZ];
        for iz in 0..NZ {
            for ix in 0..NX {
                let wx = (ORIGIN_X + ix as i32) as f32 + 0.5;
                let wz = (ORIGIN_Z + iz as i32) as f32 + 0.5;
                let mut s = 0.0;
                for (dx, dz) in [(-0.25f32, -0.25f32), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)] {
                    s += hf.sample(wx + dx, wz + dz);
                }
                let mut hh = s * 0.25;
                let ed = ix.min(NX - 1 - ix).min(iz).min(NZ - 1 - iz) as f32;
                if hh > -12.0 {
                    hh = -12.0 + (hh + 12.0) * ss(1.0, 30.0, ed);
                }
                let b = hf.biome_at(wx, wz);
                hz[iz * NX + ix] = hh;
                mk[iz * NX + ix] = if b == biome::HIGHLAND || b == biome::CLIFF_ROCK { 1.0 } else { 0.0 };
                self.bio[iz * NX + ix] = b;
            }
        }
        // box-blur the highland mask (radius 4, separable) so the terracing fades in smoothly
        let blur = |src: &[f32], horizontal: bool| -> Vec<f32> {
            let mut out = vec![0.0f32; NX * NZ];
            for iz in 0..NZ {
                for ix in 0..NX {
                    let mut acc = 0.0;
                    for k in -4i32..=4 {
                        let (x, z) = if horizontal { ((ix as i32 + k).clamp(0, NX as i32 - 1), iz as i32) } else { (ix as i32, (iz as i32 + k).clamp(0, NZ as i32 - 1)) };
                        acc += src[z as usize * NX + x as usize];
                    }
                    out[iz * NX + ix] = acc / 9.0;
                }
            }
            out
        };
        let mk = blur(&blur(&mk, true), false);
        // keep the walkable ramp (paths[4], village -> highland top) free of cliffs
        let ramp: Vec<[f32; 2]> = self.g.features.paths.get(4).cloned().unwrap_or_default();
        const TIER: f32 = 5.5;
        for iz in 0..NZ {
            for ix in 0..NX {
                let c = iz * NX + ix;
                let mut w = ss(0.2, 0.8, mk[c]);
                if w > 0.0 && hz[c] > 1.5 {
                    let (wx, wz) = ((ORIGIN_X + ix as i32) as f32 + 0.5, (ORIGIN_Z + iz as i32) as f32 + 0.5);
                    let mut d2 = f32::MAX;
                    for q in &ramp {
                        d2 = d2.min((q[0] - wx) * (q[0] - wx) + (q[1] - wz) * (q[1] - wz));
                    }
                    w *= ss(6.0, 16.0, d2.sqrt());
                    if w > 0.0 {
                        let t = (hz[c] - 1.0) / TIER;
                        let i = t.floor();
                        let ht = 1.0 + (i + ss(0.40, 0.60, t - i)) * TIER;
                        hz[c] = lerp(hz[c], ht, w);
                    }
                }
                self.h[c] = ((hz[c] + 0.5).floor() as i32).clamp(-(SEA_Y - 2), NY as i32 - SEA_Y - 14);
            }
        }
    }

    /// Removes 1-block spikes and pits (noisy staircase).
    fn despike(&mut self) {
        for _ in 0..2 {
            let src = self.h.clone();
            for iz in 1..NZ - 1 {
                for ix in 1..NX - 1 {
                    let c = iz * NX + ix;
                    let v = src[c];
                    if v < -1 {
                        continue;
                    }
                    let n = [src[c - 1], src[c + 1], src[c - NX], src[c + NX]];
                    let mx = n.iter().copied().max().unwrap_or(v);
                    let mn = n.iter().copied().min().unwrap_or(v);
                    if v > mx && v - mx <= 1 {
                        self.h[c] = mx;
                    } else if v < mn && mn - v <= 1 {
                        self.h[c] = mn;
                    }
                }
            }
        }
    }

    /// Organic sea floor: the depth grows steadily with the distance from the nearest land (no flat plateaus / discs),
    /// plus low-frequency noise and sand bars; cliff coasts keep the design's deeper water.
    fn bathymetry(&mut self) {
        let n = NX * NZ;
        let mut d = vec![i32::MAX / 2; n];
        for c in 0..n {
            if self.h[c] >= 0 {
                d[c] = 0;
            }
        }
        for iz in 0..NZ {
            for ix in 0..NX {
                let c = iz * NX + ix;
                let mut v = d[c];
                if ix > 0 {
                    v = v.min(d[c - 1] + 3);
                }
                if iz > 0 {
                    v = v.min(d[c - NX] + 3);
                    if ix > 0 {
                        v = v.min(d[c - NX - 1] + 4);
                    }
                    if ix + 1 < NX {
                        v = v.min(d[c - NX + 1] + 4);
                    }
                }
                d[c] = v;
            }
        }
        for iz in (0..NZ).rev() {
            for ix in (0..NX).rev() {
                let c = iz * NX + ix;
                let mut v = d[c];
                if ix + 1 < NX {
                    v = v.min(d[c + 1] + 3);
                }
                if iz + 1 < NZ {
                    v = v.min(d[c + NX] + 3);
                    if ix + 1 < NX {
                        v = v.min(d[c + NX + 1] + 4);
                    }
                    if ix > 0 {
                        v = v.min(d[c + NX - 1] + 4);
                    }
                }
                d[c] = v;
            }
        }
        for c in 0..n {
            if self.h[c] >= 0 {
                continue;
            }
            let (ix, iz) = (c % NX, c / NX);
            let dist = d[c] as f32 / 3.0;
            let lump = fbm_rot(self.seed ^ 0xB47, ix as f32 * 0.03, iz as f32 * 0.03, 3, 0.5);
            let ridge = value_noise(self.seed ^ 0xB48, ix as f32 * 0.09, iz as f32 * 0.09);
            let mut depth = 0.6 + 0.085 * dist.min(40.0) + 7.5 * ss(28.0, 120.0, dist);
            depth += (lump - 0.5) * 2.4 * ss(3.0, 14.0, dist);
            depth -= 1.4 * ss(0.62, 0.82, ridge) * (1.0 - ss(10.0, 34.0, dist));
            let old = -self.h[c] as f32;
            let depth = depth.max(old * 0.9).clamp(1.0, 12.0);
            self.h[c] = -(depth.round() as i32);
        }
    }

    fn pond(&mut self) {
        let p = self.g.features.pond.clone();
        let water_y = (p.level + 0.02).floor() as i32;
        let r = p.rx.max(p.rz) * 1.7;
        let (x0, x1) = (((p.x - r).floor() as i32 - ORIGIN_X).max(0) as usize, ((p.x + r).ceil() as i32 - ORIGIN_X).clamp(0, NX as i32 - 1) as usize);
        let (z0, z1) = (((p.z - r).floor() as i32 - ORIGIN_Z).max(0) as usize, ((p.z + r).ceil() as i32 - ORIGIN_Z).clamp(0, NZ as i32 - 1) as usize);
        for iz in z0..=z1 {
            for ix in x0..=x1 {
                let (wx, wz) = ((ORIGIN_X + ix as i32) as f32 + 0.5, (ORIGIN_Z + iz as i32) as f32 + 0.5);
                let e = p.e(wx, wz);
                let c = iz * NX + ix;
                if e < 1.02 {
                    let bed = if e < 0.55 { water_y - 2 } else { water_y - 1 };
                    self.h[c] = self.h[c].min(bed);
                    self.wl[c] = (water_y + SEA_Y - 1) as i16;
                    self.bed[c] = if e < 0.4 { 4 } else { 2 };
                    self.bio[c] = biome::POND_BANK;
                } else if e < 1.3 {
                    self.h[c] = self.h[c].max(water_y);
                    if e < 1.14 {
                        self.bio[c] = biome::POND_BANK;
                    }
                }
            }
        }
    }

    fn streams(&mut self) {
        // per column: (ratio to the centre line, water surface y, half width) of the nearest stream point
        let mut best: Vec<(f32, i32, f32)> = vec![(f32::MAX, 0, 1.0); NX * NZ];
        for st in &self.g.features.streams {
            for w in st.pts.windows(2) {
                let (a, b) = (w[0], w[1]);
                let len = ((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])).sqrt();
                let n = ((len / 0.5).ceil() as usize).max(1);
                for k in 0..=n {
                    let t = k as f32 / n as f32;
                    let (cx, cz) = (lerp(a[0], b[0], t), lerp(a[1], b[1], t));
                    let lv = lerp(a[3], b[3], t);
                    let hw = lerp(a[2], b[2], t).max(0.9);
                    let wy = (lv + 0.02).floor() as i32;
                    let reach = hw + 1.7;
                    let (x0, x1) = (((cx - reach).floor() as i32 - ORIGIN_X).max(0), ((cx + reach).ceil() as i32 - ORIGIN_X).min(NX as i32 - 1));
                    let (z0, z1) = (((cz - reach).floor() as i32 - ORIGIN_Z).max(0), ((cz + reach).ceil() as i32 - ORIGIN_Z).min(NZ as i32 - 1));
                    for iz in z0..=z1 {
                        for ix in x0..=x1 {
                            let (wx, wz) = ((ORIGIN_X + ix) as f32 + 0.5, (ORIGIN_Z + iz) as f32 + 0.5);
                            let d = ((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz)).sqrt();
                            let ratio = d / hw;
                            let c = iz as usize * NX + ix as usize;
                            if ratio < best[c].0 {
                                best[c] = (ratio, wy, hw);
                            }
                        }
                    }
                }
            }
        }
        for c in 0..NX * NZ {
            let (ratio, wy, hw) = best[c];
            if ratio == f32::MAX {
                continue;
            }
            if ratio <= 1.0 {
                self.h[c] = self.h[c].min(wy - 1);
                self.wl[c] = self.wl[c].max((wy + SEA_Y - 1) as i16);
                self.bed[c] = if ratio < 0.7 { 1 } else { 3 };
                self.bio[c] = biome::POND_BANK;
            } else if ratio * hw <= hw + 1.5 {
                self.h[c] = self.h[c].max(wy);
            }
        }
    }

    /// Picks up to four cottage sites on the village clearing and flattens them (before the columns are filled).
    fn plan_cottages(&mut self) -> Vec<Cottage> {
        let f = &self.g.features;
        let (vx, vz) = (f.village[0], f.village[1]);
        let spawn = f.spawn;
        let a0 = u01(h3(self.seed, 7, 7, 7)) * math::TAU;
        let mut out: Vec<Cottage> = Vec::new();
        for k in 0..8i32 {
            if out.len() >= 4 {
                break;
            }
            let a = a0 + k as f32 * (math::TAU / 8.0) + (u01(h3(self.seed, k, 3, 3)) - 0.5) * 0.25;
            let r = 11.0 + (k % 2) as f32 * 4.0;
            let (sa, ca) = math::sin_cos(a);
            let (cx, cz) = (vx + ca * r, vz + sa * r);
            if ((cx - spawn[0]) * (cx - spawn[0]) + (cz - spawn[1]) * (cz - spawn[1])).sqrt() < 7.5 {
                continue;
            }
            let (w, d) = if k % 2 == 0 { (7, 5) } else { (5, 5) };
            let ix0 = cx.floor() as i32 - ORIGIN_X - w / 2;
            let iz0 = cz.floor() as i32 - ORIGIN_Z - d / 2;
            if ix0 < 4 || iz0 < 4 || ix0 + w + 4 >= NX as i32 || iz0 + d + 4 >= NZ as i32 {
                continue;
            }
            let (mut lo, mut hi, mut ok) = (i32::MAX, i32::MIN, true);
            for z in iz0 - 1..=iz0 + d {
                for x in ix0 - 1..=ix0 + w {
                    let c = z as usize * NX + x as usize;
                    lo = lo.min(self.h[c]);
                    hi = hi.max(self.h[c]);
                    let b = self.bio[c];
                    if self.wl[c] >= 0 || self.h[c] < 1 || !matches!(b, biome::VILLAGE | biome::MEADOW | biome::FLOWER_MEADOW | biome::DIRT_PATH) {
                        ok = false;
                    }
                }
            }
            if !ok || hi - lo > 2 {
                continue;
            }
            let overlaps = out.iter().any(|o| ix0 < o.x0 + o.w + 3 && o.x0 < ix0 + w + 3 && iz0 < o.z0 + o.d + 3 && o.z0 < iz0 + d + 3);
            if overlaps {
                continue;
            }
            let base_y = lo + (hi - lo + 1) / 2;
            for z in iz0 - 1..=iz0 + d {
                for x in ix0 - 1..=ix0 + w {
                    let c = z as usize * NX + x as usize;
                    self.h[c] = base_y;
                    self.bed[c] = 5;
                }
            }
            let (dx, dz) = (vx - cx, vz - cz);
            let door = if dx.abs() > dz.abs() { if dx > 0.0 { 0 } else { 1 } } else if dz > 0.0 { 2 } else { 3 };
            out.push(Cottage { x0: ix0, z0: iz0, w, d, base_y, door });
        }
        out
    }

    /// (top block, sub block, sub depth) for a column.
    fn surface(&self, ix: usize, iz: usize, y: i32, bio: u8, drop: i32, rise: i32, bed: u8) -> (BlockId, BlockId, usize) {
        match bed {
            1 => return (GRAVEL, GRAVEL, 2),
            2 => return (MUD, MUD, 2),
            3 => return (SAND, SAND, 3),
            4 => return (CLAY, CLAY, 2),
            5 => return (PACKED, DIRT, 3),
            _ => {}
        }
        match bio {
            biome::OCEAN_DEEP | biome::SHALLOWS => {
                let n = value_noise(self.seed ^ 0x61, ix as f32 * 0.06, iz as f32 * 0.06);
                let t = if y > -3 {
                    SAND
                } else if n > 0.66 {
                    GRAVEL
                } else if n < 0.2 && y < -4 {
                    CLAY
                } else {
                    SAND
                };
                (t, t, 2)
            }
            biome::SAND => (SAND, SAND, 4),
            biome::CLIFF_ROCK => (STRATA_TOP, STRATA_TOP, 0),
            biome::DIRT_PATH => (PATH, DIRT, 3),
            biome::VILLAGE => (GRASS, DIRT, 3),
            biome::POND_BANK => (MUD, DIRT, 2),
            _ => {
                if rise >= 3 && y >= 0 {
                    return (GRAVEL, STRATA_TOP, 0);
                }
                let sd = if drop >= 3 { 1 } else { 3 };
                match bio {
                    biome::HIGHLAND => (GRASS_HIGH, DIRT, sd.min(2)),
                    biome::FOREST_FLOOR => (GRASS_FOREST, DIRT, sd),
                    biome::FLOWER_MEADOW => (GRASS_FLOWER, DIRT, sd),
                    _ => (GRASS, DIRT, sd),
                }
            }
        }
    }

    fn assemble(&mut self) {
        let seed = self.seed;
        for iz in 0..NZ {
            for ix in 0..NX {
                let c = iz * NX + ix;
                let y = self.h[c];
                let top = (y + SEA_Y - 1).clamp(1, NY as i32 - 2) as usize;
                let (mut drop, mut rise) = (0, 0);
                for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                    let n = self.hc(ix as i32 + dx, iz as i32 + dz);
                    drop = drop.max(y - n);
                    rise = rise.max(n - y);
                }
                let (tb, sb, sd) = self.surface(ix, iz, y, self.bio[c], drop, rise, self.bed[c]);
                let sea_top = if y < 0 { SEA_Y as usize - 1 } else { 0 };
                let wt = if self.wl[c] >= 0 { (self.wl[c] as usize).max(sea_top) } else { sea_top };
                let base = VoxelWorld::column_base(ix, iz);
                let col = &mut self.w.blocks[base..base + NY];
                col[0] = STONE_DARK;
                for l in 1..=top {
                    col[l] = if l == top {
                        if tb == STRATA_TOP { strata_block(seed, l, ix, iz) } else { tb }
                    } else if l + sd > top {
                        if sb == STRATA_TOP { strata_block(seed, l, ix, iz) } else { sb }
                    } else {
                        strata_block(seed, l, ix, iz)
                    };
                }
                for l in (top + 1)..=wt {
                    col[l] = WATER;
                }
            }
        }
    }

    #[inline]
    fn put(&mut self, ix: i32, iy: i32, iz: i32, id: BlockId, force: bool) -> bool {
        if ix < 0 || iz < 0 || ix >= NX as i32 || iz >= NZ as i32 || iy < 1 || iy >= NY as i32 - 1 {
            return false;
        }
        let cell = VoxelWorld::cell(ix as usize, iy as usize, iz as usize);
        let cur = self.w.blocks[cell];
        if cur == WATER && !force {
            return false;
        }
        if force || cur == AIR {
            self.w.blocks[cell] = id;
            return true;
        }
        false
    }

    /// Recesses cut into the faces of cliffs >= 3 m: the lip stays, so the rock overhangs.
    fn notches(&mut self) {
        let seed = self.seed ^ 0x51;
        for iz in 2..NZ - 2 {
            for ix in 2..NX - 2 {
                let y = self.h[iz * NX + ix];
                if y < 3 {
                    continue;
                }
                let mut best = (0i32, 0i32, 0i32);
                for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                    let d = y - self.hc(ix as i32 + dx, iz as i32 + dz);
                    if d > best.0 {
                        best = (d, dx, dz);
                    }
                }
                if best.0 < 4 {
                    continue;
                }
                if self.hc(ix as i32 - best.1, iz as i32 - best.2) < y - 1 || self.hc(ix as i32 - 2 * best.1, iz as i32 - 2 * best.2) < y - 2 {
                    continue;
                }
                let l_top = y + SEA_Y - 1;
                let l_low = l_top - best.0;
                let mut l = (l_low + 2).max(SEA_Y);
                while l <= l_top - 2 {
                    if vnoise3(seed, ix as f32 * 0.45, l as f32 * 0.9, iz as f32 * 0.45) > 0.64 {
                        let cell = VoxelWorld::cell(ix, l as usize, iz);
                        if blocks::is_solid(self.w.blocks[cell]) {
                            self.w.blocks[cell] = AIR;
                        }
                    }
                    l += 1;
                }
            }
        }
    }

    /// Up to three cave mouths cut into tall cliff faces (tunnel along the face normal, 3 m+ of roof left).
    fn caves(&mut self) -> Vec<[f32; 6]> {
        let mut cands: Vec<(u32, usize, usize, i32, i32, i32, i32)> = Vec::new();
        for iz in (3..NZ - 3).step_by(2) {
            for ix in (3..NX - 3).step_by(2) {
                let y = self.h[iz * NX + ix];
                if y < 7 {
                    continue;
                }
                for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                    let l1 = self.hc(ix as i32 + dx, iz as i32 + dz);
                    let l2 = self.hc(ix as i32 + 2 * dx, iz as i32 + 2 * dz);
                    let back = self.hc(ix as i32 - 2 * dx, iz as i32 - 2 * dz);
                    let back4 = self.hc(ix as i32 - 5 * dx, iz as i32 - 5 * dz);
                    if y - l1 >= 4 && y - l2 >= 4 && back >= y - 1 && back4 >= y - 2 {
                        cands.push((h3(self.seed, ix as i32, iz as i32, 99), ix, iz, dx, dz, y, l1));
                    }
                }
            }
        }
        cands.sort();
        let mut picked: Vec<(usize, usize, i32, i32, i32, i32)> = Vec::new();
        for (_, ix, iz, dx, dz, y, l) in cands {
            if picked.len() >= 3 {
                break;
            }
            let near = picked.iter().any(|p| {
                let (a, b) = (p.0 as i32 - ix as i32, p.1 as i32 - iz as i32);
                a * a + b * b < 30 * 30
            });
            if !near {
                picked.push((ix, iz, dx, dz, y, l));
            }
        }
        let mut out = Vec::new();
        for (ix, iz, dx, dz, y, low) in picked {
            let fy = low.max(0);
            let drop = y - fy;
            if drop < 4 {
                continue;
            }
            let ry = ((drop - 2).min(4) as f32) * 0.5;
            let depth = 6.0f32;
            let (px, pz) = (-dz, dx);
            for s in -2..=8i32 {
                for o in -4..=4i32 {
                    for ly in 0..=((2.0 * ry).ceil() as i32) {
                        let (cx, cz) = (ix as i32 - dx * s + px * o, iz as i32 - dz * s + pz * o);
                        let n = (s as f32 - depth * 0.4) / (depth * 0.75 + 1.2);
                        let q = (o as f32 / 2.9) * (o as f32 / 2.9) + ((ly as f32 + 0.5 - ry) / ry) * ((ly as f32 + 0.5 - ry) / ry) + n * n;
                        // keep two blocks of roof under the surface (the tunnel follows the hill)
                        if q <= 1.0 && cx >= 0 && cz >= 0 && cx < NX as i32 && cz < NZ as i32 && fy + ly + SEA_Y <= self.h[cz as usize * NX + cx as usize] + SEA_Y - 3 {
                            let l = (fy + ly + SEA_Y) as usize;
                            let cell = VoxelWorld::cell(cx as usize, l, cz as usize);
                            if blocks::is_solid(self.w.blocks[cell]) {
                                self.w.blocks[cell] = AIR;
                            }
                        }
                    }
                }
            }
            out.push([(ORIGIN_X + ix as i32) as f32 + 0.5, fy as f32, (ORIGIN_Z + iz as i32) as f32 + 0.5, dx as f32, dz as f32, ry]);
        }
        out
    }

    fn build_cottage(&mut self, c: &Cottage) {
        let fl = c.base_y + SEA_Y;
        let (x0, z0, w, d) = (c.x0, c.z0, c.w, c.d);
        let (dx, dz) = match c.door {
            0 => (x0 + w - 1, z0 + d / 2),
            1 => (x0, z0 + d / 2),
            2 => (x0 + w / 2, z0 + d - 1),
            _ => (x0 + w / 2, z0),
        };
        for z in z0..z0 + d {
            for x in x0..x0 + w {
                let edge = x == x0 || x == x0 + w - 1 || z == z0 || z == z0 + d - 1;
                let corner = (x == x0 || x == x0 + w - 1) && (z == z0 || z == z0 + d - 1);
                self.put(x, fl - 1, z, if edge { COBBLE } else { PLANKS }, true);
                for dy in 0..3 {
                    let window = dy == 1 && !corner && ((z == z0 || z == z0 + d - 1) && x - x0 == w / 2 || (x == x0 || x == x0 + w - 1) && z - z0 == d / 2);
                    let door = x == dx && z == dz && dy < 2;
                    let id = if door || !edge {
                        AIR
                    } else if corner {
                        LOG_OAK
                    } else if dy == 0 {
                        COBBLE
                    } else if window {
                        GLASS
                    } else {
                        PLASTER
                    };
                    self.put(x, fl + dy, z, id, true);
                }
            }
        }
        // stepped gable roof along x with a one block overhang
        for k in 0..=((d + 1) / 2) {
            for z in (z0 - 1 + k)..=(z0 + d - k) {
                for x in (x0 - 1)..=(x0 + w) {
                    self.put(x, fl + 3 + k, z, ROOF_TILE, true);
                }
            }
        }
        self.put(x0 + w / 2, fl + 2, z0 + d / 2, LANTERN, true);
    }

    fn leaf_blob(&mut self, leaves: &mut Vec<(i32, i32, i32)>, cx: i32, cy: i32, cz: i32, rx: i32, ry: i32, leaf: BlockId, salt: i32) {
        let rxf = rx as f32 + 0.6;
        let ryf = ry as f32 + 0.6;
        for dy in -ry..=ry {
            for dz in -rx..=rx {
                for dx in -rx..=rx {
                    let nd = ((dx * dx + dz * dz) as f32) / (rxf * rxf) + (dy * dy) as f32 / (ryf * ryf);
                    let thr = 1.0 - 0.38 * u01(h3(self.seed ^ 0x1EAF, cx + dx + salt, cy + dy, cz + dz));
                    if nd <= thr && self.put(cx + dx, cy + dy, cz + dz, leaf, false) {
                        leaves.push((cx + dx, cy + dy, cz + dz));
                    }
                }
            }
        }
    }

    /// Removes leaf cells (of one tree) that are not face-connected to its logs.
    fn prune(&mut self, logs: &[(i32, i32, i32)], leaves: &[(i32, i32, i32)]) {
        let mut pending: HashSet<(i32, i32, i32)> = leaves.iter().copied().collect();
        let mut stack: Vec<(i32, i32, i32)> = logs.to_vec();
        while let Some((x, y, z)) = stack.pop() {
            for (dx, dy, dz) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] {
                let p = (x + dx, y + dy, z + dz);
                if pending.remove(&p) {
                    stack.push(p);
                }
            }
        }
        for (x, y, z) in leaves {
            if pending.contains(&(*x, *y, *z)) {
                self.w.blocks[VoxelWorld::cell(*x as usize, *y as usize, *z as usize)] = AIR;
            }
        }
    }

    /// Plants one block tree / bush. `base` = layer of the ground block it stands on.
    fn tree(&mut self, kind: u32, ix: i32, base: i32, iz: i32, scale: f32) -> bool {
        let seed = self.seed;
        let hs = move |s: i32| u01(h3(seed ^ 0x7BEE, ix, iz, s));
        let sc = scale.clamp(0.75, 1.45);
        let mut logs: Vec<(i32, i32, i32)> = Vec::new();
        let mut leaves: Vec<(i32, i32, i32)> = Vec::new();
        match kind {
            0 | 1 | 3 | 5 | 6 | 7 | 10 | 11 => {
                // designed canopies (layered discs, one leaf palette per species); the trunk stays visible below the crown
                let big = sc > 1.12 || hs(2) > 0.55;
                let (tmin, tvar, log, leaf) = match kind {
                    0 => (4, 2.0, LOG_OAK, LEAVES_OAK),
                    1 => (6, 3.0, LOG_OAK, LEAVES_OAK),
                    3 => (3, 2.0, LOG_OAK, LEAVES_BLOSSOM),
                    5 => (4, 2.0, LOG_OAK, LEAVES_WILLOW),
                    6 => (6, 3.0, LOG_BIRCH, LEAVES_BIRCH),
                    7 => (5, 2.0, LOG_OAK, LEAVES_MAPLE),
                    10 => (3, 2.0, LOG_OAK, LEAVES_APPLE),
                    _ => (3, 2.0, LOG_OAK, LEAVES_ORANGE),
                };
                let radii = canopy_radii(kind, big);
                let th = tmin + (hs(1) * tvar) as i32;
                for t in 1..=th {
                    self.put(ix, base + t, iz, log, true);
                    logs.push((ix, base + t, iz));
                }
                let y0 = base + th;
                for (k, &r) in radii.iter().enumerate() {
                    let lim = r * r + r / 2 + if r >= 3 { 1 } else { 0 };
                    let y = y0 + k as i32;
                    for dz in -r..=r {
                        for dx in -r..=r {
                            if dx * dx + dz * dz <= lim && self.put(ix + dx, y, iz + dz, leaf, false) {
                                leaves.push((ix + dx, y, iz + dz));
                            }
                        }
                    }
                }
                if kind == 5 {
                    // willow curtains hang from the rim
                    let rim_r = radii.iter().copied().max().unwrap_or(3);
                    let snapshot = leaves.clone();
                    for (x, y, z) in snapshot {
                        let rim = (x - ix) * (x - ix) + (z - iz) * (z - iz) >= rim_r * rim_r - 2;
                        if rim && y <= y0 + 2 && u01(h3(self.seed, x, y, z)) < 0.5 {
                            let len = 2 + (u01(h3(self.seed, z, y, x)) * 3.0) as i32;
                            for k in 1..=len {
                                if self.put(x, y - k, z, leaf, false) {
                                    leaves.push((x, y - k, z));
                                }
                            }
                        }
                    }
                }
            }
            2 => {
                let th = 5 + (hs(1) * 4.0 * sc) as i32;
                for t in 1..=th {
                    self.put(ix, base + t, iz, LOG_PINE, true);
                    logs.push((ix, base + t, iz));
                }
                let top = base + th + 2;
                for y in (base + 2)..=top {
                    let d = top - y;
                    let mut r = ((d as f32) * 0.5 + 0.6).floor().min(3.0) as i32;
                    if d % 2 == 1 && r > 1 {
                        r -= 1;
                    }
                    for dz in -r..=r {
                        for dx in -r..=r {
                            if dx * dx + dz * dz <= r * r + r / 2 && self.put(ix + dx, y, iz + dz, LEAVES_PINE, false) {
                                leaves.push((ix + dx, y, iz + dz));
                            }
                        }
                    }
                }
            }
            4 => {
                let th = 5 + (hs(1) * 3.0 * sc) as i32;
                let dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)];
                let (ldx, ldz) = dirs[(hs(2) * 4.0) as usize % 4];
                let (mut px, mut pz) = (ix, iz);
                for t in 1..=th {
                    if t == 3 || t == 5 {
                        // the lean steps sideways at this height: keep the old column's log so the trunk stays face-connected
                        self.put(px, base + t, pz, LOG_PALM, true);
                        logs.push((px, base + t, pz));
                        px += ldx;
                        pz += ldz;
                    }
                    self.put(px, base + t, pz, LOG_PALM, true);
                    logs.push((px, base + t, pz));
                }
                let top = base + th;
                // 4 straight fronds + 4 diagonal ones drawn as face-connected staircases
                let frond: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)];
                for (fx, fz) in frond {
                    let diag = fx != 0 && fz != 0;
                    let steps = if diag { 6 } else { 4 };
                    for k in 1..=steps {
                        let (ox, oz) = if !diag {
                            (fx * k, fz * k)
                        } else if k % 2 == 1 {
                            (fx * ((k + 1) / 2), fz * ((k - 1) / 2))
                        } else {
                            (fx * (k / 2), fz * (k / 2))
                        };
                        let yy = top + match k {
                            1 | 2 => 1,
                            3 | 4 => 0,
                            _ => -1,
                        };
                        if self.put(px + ox, yy, pz + oz, LEAVES_PALM, false) {
                            leaves.push((px + ox, yy, pz + oz));
                        }
                    }
                }
                if self.put(px, top + 1, pz, LEAVES_PALM, false) {
                    leaves.push((px, top + 1, pz));
                }
            }
            8 => {
                let th = 3 + (hs(1) * 3.0 * sc) as i32;
                for t in 1..=th {
                    self.put(ix, base + t, iz, MUSHROOM_STEM, true);
                    logs.push((ix, base + t, iz));
                }
                let top = base + th;
                for (y, r2) in [(top - 1, 9), (top, 9), (top + 1, 4)] {
                    for dz in -3..=3i32 {
                        for dx in -3..=3i32 {
                            let d2 = dx * dx + dz * dz;
                            let ring_only = y == top - 1;
                            if d2 <= r2 && (!ring_only || d2 > 4) && self.put(ix + dx, y, iz + dz, GLOWCAP, false) {
                                leaves.push((ix + dx, y, iz + dz));
                            }
                        }
                    }
                }
            }
            9 => {
                let th = 4 + (hs(1) * 3.0) as i32;
                for t in 1..=th {
                    self.put(ix, base + t, iz, LOG_OAK, true);
                    logs.push((ix, base + t, iz));
                }
                for k in 0..2 {
                    let (sx, sz) = [(1, 0), (-1, 0), (0, 1), (0, -1)][(hs(5 + k) * 4.0) as usize % 4];
                    let y = base + th - 1 - k;
                    for i in 1..=2 {
                        if self.put(ix + sx * i, y, iz + sz * i, LOG_OAK, true) {
                            logs.push((ix + sx * i, y, iz + sz * i));
                        }
                    }
                    if self.put(ix + sx * 2, y + 1, iz + sz * 2, LOG_OAK, true) {
                        logs.push((ix + sx * 2, y + 1, iz + sz * 2));
                    }
                }
            }
            16 | 17 | 19 | 20 => {
                let leaf = match kind {
                    17 => LEAVES_BERRY,
                    19 | 20 => LEAVES_BLOSSOM,
                    _ => LEAVES_OAK,
                };
                // the first leaf stands on the ground; neighbours need ground below, too
                let mut cells = vec![(ix, base + 1, iz)];
                for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    if hs(40 + dx * 3 + dz) < 0.6 {
                        cells.push((ix + dx, base + 1, iz + dz));
                    }
                }
                if hs(50) < 0.65 {
                    cells.push((ix, base + 2, iz));
                }
                for (x, y, z) in cells {
                    let below = self.w.get_l(x, y - 1, z);
                    if blocks::is_ground(below) || (x, z) == (ix, iz) {
                        if self.put(x, y, z, leaf, false) {
                            leaves.push((x, y, z));
                        }
                    }
                }
                // bushes are made of leaves only: anchor them on the ground cell
                logs.push((ix, base, iz));
            }
            _ => return false,
        }
        self.prune(&logs, &leaves);
        true
    }

    fn trees(&mut self, flora: &[f32]) -> usize {
        let mut n = 0;
        for r in flora.chunks_exact(FLORA_STRIDE) {
            let kind = r[0] as u32;
            if kind >= 32 || kind == 18 {
                continue;
            }
            let (ix, iz) = (r[1].floor() as i32 - ORIGIN_X, r[3].floor() as i32 - ORIGIN_Z);
            if ix < 4 || iz < 4 || ix >= NX as i32 - 4 || iz >= NZ as i32 - 4 {
                continue;
            }
            let c = iz as usize * NX + ix as usize;
            let y = self.h[c];
            let bio = self.bio[c];
            if self.wl[c] >= 0 || matches!(bio, biome::DIRT_PATH | biome::VILLAGE | biome::OCEAN_DEEP | biome::SHALLOWS) {
                continue;
            }
            if y < 1 && kind != 4 || y < 0 {
                continue;
            }
            let base = y + SEA_Y - 1;
            let ground = self.w.blocks[VoxelWorld::cell(ix as usize, base as usize, iz as usize)];
            if !blocks::is_ground(ground) || (kind == 4 && ground != SAND && ground != GRASS && ground != DIRT) {
                continue;
            }
            // keep the trunk column free of water neighbours
            if self.tree(kind, ix, base, iz, r[5]) {
                n += 1;
            }
        }
        n
    }

    /// Decor flora (flowers, rocks, shells, reeds, ferns...) re-grounded on the block surface.
    fn decor(&self, flora: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for r in flora.chunks_exact(FLORA_STRIDE) {
            let kind = r[0] as u32;
            if !(kind >= 32 || kind == 18) {
                continue;
            }
            let (ix, iz) = (r[1].floor() as i32 - ORIGIN_X, r[3].floor() as i32 - ORIGIN_Z);
            if ix < 1 || iz < 1 || ix >= NX as i32 - 1 || iz >= NZ as i32 - 1 {
                continue;
            }
            let c = iz as usize * NX + ix as usize;
            let t = self.w.top[c];
            if t < 0 {
                continue;
            }
            let ground = (i32::from(t) + 1 - SEA_Y) as f32;
            let water = if self.wl[c] >= 0 { Some((i32::from(self.wl[c]) + 1 - SEA_Y) as f32 - 0.12) } else { None };
            let y = if kind == 81 {
                match water {
                    Some(wy) => wy,
                    None => continue,
                }
            } else if (80..=82).contains(&kind) {
                if water.is_none() && ground < 0.0 {
                    continue;
                }
                ground
            } else if ground < 0.0 || water.is_some() {
                continue;
            } else {
                ground
            };
            let b = self.w.biome[c];
            if b == biome::DIRT_PATH || b == biome::VILLAGE {
                continue;
            }
            // not on top of leaves / logs placed after the ground was computed
            let above = self.w.get_l(ix, i32::from(t) + 1, iz);
            if above != AIR && above != WATER {
                continue;
            }
            out.extend_from_slice(&[r[0], r[1], y, r[3], r[4], r[5], r[6], r[7]]);
        }
        out
    }
}

/// Canopy disc radii, bottom -> top (rounded layered crowns; consecutive layers differ by <= 1 so they stay connected).
fn canopy_radii(kind: u32, big: bool) -> &'static [i32] {
    match kind {
        0 => {
            if big {
                &[2, 3, 4, 4, 3, 2, 1]
            } else {
                &[2, 3, 3, 3, 2, 1]
            }
        }
        1 => &[2, 3, 3, 3, 3, 2, 1],
        3 => {
            if big {
                &[2, 3, 3, 2, 1]
            } else {
                &[1, 2, 2, 1]
            }
        }
        5 => &[2, 3, 3, 3, 2],
        6 => &[1, 2, 2, 2, 2, 1],
        7 => {
            if big {
                &[2, 3, 4, 4, 3, 2]
            } else {
                &[2, 3, 3, 3, 2]
            }
        }
        _ => &[2, 3, 3, 2, 1],
    }
}

/// Builds the voxel world from the generated design heightfield + the scattered flora records.
pub fn build(g: &Generated, flora: &[f32], seed: u32) -> Built {
    let mut gx = Gen::new(g, seed);
    gx.heights();
    gx.despike();
    gx.bathymetry();
    gx.pond();
    gx.streams();
    let plans = gx.plan_cottages();
    gx.assemble();
    gx.notches();
    let caves = gx.caves();
    for c in &plans {
        gx.build_cottage(c);
    }
    let tree_count = gx.trees(flora);
    gx.w.biome.copy_from_slice(&gx.bio);
    gx.w.recompute_all();
    let decor = gx.decor(flora);
    let cottages = plans
        .iter()
        .map(|c| [(ORIGIN_X + c.x0 + c.w / 2) as f32 + 0.5, (ORIGIN_Z + c.z0 + c.d / 2) as f32 + 0.5, f32::from(c.door), c.base_y as f32])
        .collect();
    Built { world: gx.w, decor, caves, cottages, tree_count }
}

#[allow(dead_code)]
pub(crate) fn flag_of(id: BlockId) -> u8 {
    blocks::def(id).flags & (flag::SOLID | flag::OPAQUE)
}
