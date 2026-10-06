//! Block registry + generic voxel algorithms (voxel world, VOXEL PIVOT r1).
//!
//! * [`BLOCKS`]: every block type (`u16` id, 0 = air) with flags, hardness, drop, texture-tile *names* (top, side,
//!   bottom; the web atlas paints tiles by name) and a representative colour.
//! * [`BlockSource`]: anything that can answer "which block is at world block coords (x, y, z)?". Block coords are
//!   integers in **world metres** (`floor(x)`, `floor(y)`, `floor(z)`); block `(x, y, z)` covers
//!   `[x, x+1) x [y, y+1) x [z, z+1)`.
//! * [`raycast`] (Amanatides-Woo DDA) and [`aabb_sweep`] (axis-ordered swept box vs. solid blocks) work on any source,
//!   so `sim_player` / `sim_creatures` / `sim_build` can use them through the [`VoxelQuery`] resource without
//!   depending on `sim_world`.

use bevy_ecs::prelude::Resource;
use serde_json::{Value, json};

pub type BlockId = u16;

/// Block flags.
pub mod flag {
    /// blocks movement
    pub const SOLID: u8 = 1;
    /// hides the faces behind it (meshing culls, AO / skylight treat it as an occluder)
    pub const OPAQUE: u8 = 2;
    pub const LIQUID: u8 = 4;
    /// leaves: shader wind sway
    pub const FOLIAGE: u8 = 8;
    /// emissive (bloom)
    pub const GLOW: u8 = 16;
    /// vegetation (logs, leaves, mushrooms): solid for collision but not "ground" for `HeightQuery`
    pub const PLANT: u8 = 32;
    /// emissive only at night (lit windows)
    pub const NIGHT_GLOW: u8 = 64;
}

/// Block ids.
pub mod id {
    pub const AIR: u16 = 0;
    pub const GRASS: u16 = 1;
    pub const DIRT: u16 = 2;
    pub const STONE: u16 = 3;
    pub const STONE_WARM: u16 = 4;
    pub const STONE_DARK: u16 = 5;
    pub const SAND: u16 = 6;
    pub const GRAVEL: u16 = 7;
    pub const CLAY: u16 = 8;
    pub const MUD: u16 = 9;
    pub const PATH: u16 = 10;
    pub const PACKED: u16 = 11;
    pub const GRASS_FOREST: u16 = 12;
    pub const GRASS_HIGH: u16 = 13;
    pub const GRASS_FLOWER: u16 = 14;
    pub const SNOW: u16 = 15;
    pub const WATER: u16 = 16;
    pub const LOG_OAK: u16 = 17;
    pub const LOG_PINE: u16 = 18;
    pub const LOG_BIRCH: u16 = 19;
    pub const LOG_PALM: u16 = 20;
    pub const LEAVES_OAK: u16 = 21;
    pub const LEAVES_PINE: u16 = 22;
    pub const LEAVES_BLOSSOM: u16 = 23;
    pub const LEAVES_BIRCH: u16 = 24;
    pub const LEAVES_MAPLE: u16 = 25;
    pub const LEAVES_PALM: u16 = 26;
    pub const LEAVES_WILLOW: u16 = 27;
    pub const LEAVES_BERRY: u16 = 28;
    pub const LEAVES_APPLE: u16 = 29;
    pub const LEAVES_ORANGE: u16 = 30;
    pub const GLOWCAP: u16 = 31;
    pub const MUSHROOM_STEM: u16 = 32;
    pub const PLANKS: u16 = 33;
    pub const COBBLE: u16 = 34;
    pub const PLASTER: u16 = 35;
    pub const ROOF_TILE: u16 = 36;
    pub const GLASS: u16 = 37;
    pub const LANTERN: u16 = 38;
    pub const BEDROCK: u16 = 39;
    pub const COUNT: u16 = 40;
}

#[derive(Clone, Copy, Debug)]
pub struct BlockDef {
    pub id: BlockId,
    pub name: &'static str,
    pub flags: u8,
    /// seconds-ish; < 0 = unbreakable
    pub hardness: f32,
    pub drop: BlockId,
    /// atlas tile names: top, side, bottom
    pub tex: [&'static str; 3],
    pub color: [u8; 3],
}

use flag::{FOLIAGE as FO, GLOW as GL, LIQUID as LQ, OPAQUE as OP, PLANT as PL, SOLID as SO};

const fn b(id: BlockId, name: &'static str, flags: u8, hardness: f32, drop: BlockId, tex: [&'static str; 3], color: [u8; 3]) -> BlockDef {
    BlockDef { id, name, flags, hardness, drop, tex, color }
}

const SOLID_OPAQUE: u8 = SO | OP;

/// The registry; index = id.
pub static BLOCKS: [BlockDef; id::COUNT as usize] = [
    b(0, "air", 0, 0.0, 0, ["", "", ""], [0, 0, 0]),
    b(1, "grass", SOLID_OPAQUE, 0.6, 2, ["grass_top", "grass_side", "dirt"], [98, 204, 90]),
    b(2, "dirt", SOLID_OPAQUE, 0.5, 2, ["dirt", "dirt", "dirt"], [139, 90, 54]),
    b(3, "stone", SOLID_OPAQUE, 1.5, 34, ["stone_cool", "stone_cool", "stone_cool"], [168, 156, 191]),
    b(4, "stone_warm", SOLID_OPAQUE, 1.5, 34, ["stone_warm", "stone_warm", "stone_warm"], [201, 169, 140]),
    b(5, "stone_dark", SOLID_OPAQUE, 1.8, 34, ["stone_dark", "stone_dark", "stone_dark"], [108, 91, 123]),
    b(6, "sand", SOLID_OPAQUE, 0.4, 6, ["sand", "sand", "sand"], [246, 226, 179]),
    b(7, "gravel", SOLID_OPAQUE, 0.5, 7, ["gravel", "gravel", "gravel"], [150, 140, 135]),
    b(8, "clay", SOLID_OPAQUE, 0.5, 8, ["clay", "clay", "clay"], [201, 133, 95]),
    b(9, "mud", SOLID_OPAQUE, 0.5, 9, ["mud", "mud", "mud"], [107, 78, 58]),
    b(10, "path", SOLID_OPAQUE, 0.5, 2, ["path_top", "dirt", "dirt"], [201, 162, 107]),
    b(11, "packed_earth", SOLID_OPAQUE, 0.5, 2, ["packed_top", "dirt", "dirt"], [200, 187, 110]),
    b(12, "grass_forest", SOLID_OPAQUE, 0.6, 2, ["grass_forest_top", "grass_forest_side", "dirt"], [62, 142, 90]),
    b(13, "grass_highland", SOLID_OPAQUE, 0.6, 2, ["grass_high_top", "grass_high_side", "dirt"], [181, 214, 106]),
    b(14, "grass_flowers", SOLID_OPAQUE, 0.6, 2, ["grass_flower_top", "grass_side", "dirt"], [120, 210, 100]),
    b(15, "snow", SOLID_OPAQUE, 0.3, 15, ["snow_top", "snow_side", "dirt"], [240, 246, 255]),
    b(16, "water", LQ, -1.0, 0, ["water", "water", "water"], [43, 184, 217]),
    b(17, "log_oak", SOLID_OPAQUE | PL, 1.2, 17, ["log_top", "log_oak_side", "log_top"], [122, 74, 43]),
    b(18, "log_pine", SOLID_OPAQUE | PL, 1.2, 18, ["log_top", "log_pine_side", "log_top"], [138, 82, 56]),
    b(19, "log_birch", SOLID_OPAQUE | PL, 1.2, 19, ["log_top", "log_birch_side", "log_top"], [237, 230, 216]),
    b(20, "log_palm", SOLID_OPAQUE | PL, 1.2, 20, ["log_top", "log_palm_side", "log_top"], [183, 155, 106]),
    b(21, "leaves_oak", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_oak", "leaves_oak", "leaves_oak"], [77, 184, 90]),
    b(22, "leaves_pine", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_pine", "leaves_pine", "leaves_pine"], [62, 154, 110]),
    b(23, "leaves_blossom", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_blossom", "leaves_blossom", "leaves_blossom"], [255, 143, 190]),
    b(24, "leaves_birch", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_birch", "leaves_birch", "leaves_birch"], [181, 224, 96]),
    b(25, "leaves_maple", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_maple", "leaves_maple", "leaves_maple"], [240, 128, 58]),
    b(26, "leaves_palm", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_palm", "leaves_palm", "leaves_palm"], [102, 204, 102]),
    b(27, "leaves_willow", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_willow", "leaves_willow", "leaves_willow"], [165, 216, 112]),
    b(28, "leaves_berry", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_berry", "leaves_berry", "leaves_berry"], [77, 184, 90]),
    b(29, "leaves_apple", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_apple", "leaves_apple", "leaves_apple"], [77, 184, 90]),
    b(30, "leaves_orange", SOLID_OPAQUE | FO | PL, 0.2, 0, ["leaves_orange", "leaves_orange", "leaves_orange"], [77, 184, 90]),
    b(31, "glowcap", SOLID_OPAQUE | GL | PL, 0.4, 31, ["glowcap", "glowcap", "glowcap"], [63, 214, 200]),
    b(32, "mushroom_stem", SOLID_OPAQUE | PL, 0.4, 32, ["mushroom_stem", "mushroom_stem", "mushroom_stem"], [242, 232, 213]),
    b(33, "planks", SOLID_OPAQUE, 1.0, 33, ["planks", "planks", "planks"], [201, 142, 82]),
    b(34, "cobble", SOLID_OPAQUE, 1.5, 34, ["cobble", "cobble", "cobble"], [157, 149, 171]),
    b(35, "plaster", SOLID_OPAQUE, 1.0, 35, ["plaster", "plaster", "plaster"], [255, 243, 224]),
    b(36, "roof_tile", SOLID_OPAQUE, 1.0, 36, ["roof_tile", "roof_tile", "roof_tile"], [226, 103, 74]),
    b(37, "glass", SOLID_OPAQUE | flag::NIGHT_GLOW, 0.3, 0, ["glass", "glass", "glass"], [191, 233, 245]),
    b(38, "lantern", SOLID_OPAQUE | GL, 0.3, 38, ["lantern", "lantern", "lantern"], [255, 210, 122]),
    b(39, "bedrock", SOLID_OPAQUE, -1.0, 0, ["stone_dark", "stone_dark", "stone_dark"], [60, 50, 70]),
];

/// Definition of `id` (unknown ids behave like air).
#[inline]
pub fn def(id: BlockId) -> &'static BlockDef {
    BLOCKS.get(usize::from(id)).unwrap_or(&BLOCKS[0])
}

#[inline]
pub fn is_solid(id: BlockId) -> bool {
    def(id).flags & flag::SOLID != 0
}
#[inline]
pub fn is_opaque(id: BlockId) -> bool {
    def(id).flags & flag::OPAQUE != 0
}
#[inline]
pub fn is_liquid(id: BlockId) -> bool {
    def(id).flags & flag::LIQUID != 0
}
/// Solid ground for `HeightQuery`: solid and not vegetation.
#[inline]
pub fn is_ground(id: BlockId) -> bool {
    let f = def(id).flags;
    f & flag::SOLID != 0 && f & flag::PLANT == 0
}

/// `world.blocks` query payload (registry for the web atlas / UI).
pub fn registry_json() -> Value {
    let blocks: Vec<Value> = BLOCKS
        .iter()
        .map(|d| {
            json!({
                "id": d.id, "name": d.name, "solid": d.flags & flag::SOLID != 0, "opaque": d.flags & flag::OPAQUE != 0,
                "liquid": d.flags & flag::LIQUID != 0, "foliage": d.flags & flag::FOLIAGE != 0, "glow": d.flags & flag::GLOW != 0,
                "plant": d.flags & flag::PLANT != 0, "night_glow": d.flags & flag::NIGHT_GLOW != 0, "hardness": d.hardness, "drop": d.drop, "tex": d.tex, "color": d.color,
            })
        })
        .collect();
    json!({ "count": BLOCKS.len(), "blocks": blocks })
}

// ------------------------------------------------------------------------------------------------- queries

/// Anything that can say which block sits at world block coordinates.
pub trait BlockSource: Send + Sync {
    fn block(&self, x: i32, y: i32, z: i32) -> BlockId;
}

/// Resource wrapping the active [`BlockSource`] (installed by `sim_world`). Edits are visible immediately.
#[derive(Resource)]
pub struct VoxelQuery {
    inner: Box<dyn BlockSource>,
}

impl VoxelQuery {
    pub fn new(source: impl BlockSource + 'static) -> Self {
        Self { inner: Box::new(source) }
    }
    #[inline]
    pub fn block(&self, x: i32, y: i32, z: i32) -> BlockId {
        self.inner.block(x, y, z)
    }
    #[inline]
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        is_solid(self.inner.block(x, y, z))
    }
    /// Highest ground block (solid, not vegetation) at column `(x, z)` between `from_y` (inclusive) and `to_y`.
    pub fn ground_y(&self, x: i32, z: i32, from_y: i32, to_y: i32) -> Option<i32> {
        ground_y(&*self.inner, x, z, from_y, to_y)
    }
    pub fn raycast(&self, origin: [f32; 3], dir: [f32; 3], max: f32, liquids: bool) -> Option<RayHit> {
        raycast(&*self.inner, origin, dir, max, liquids)
    }
    pub fn aabb_sweep(&self, min: [f32; 3], size: [f32; 3], delta: [f32; 3]) -> SweepResult {
        aabb_sweep(&*self.inner, min, size, delta)
    }
}

/// Highest ground block of column `(x, z)` scanning down from `from_y` to `to_y` (both inclusive).
pub fn ground_y(src: &dyn BlockSource, x: i32, z: i32, from_y: i32, to_y: i32) -> Option<i32> {
    let mut y = from_y;
    while y >= to_y {
        if is_ground(src.block(x, y, z)) {
            return Some(y);
        }
        y -= 1;
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RayHit {
    /// block that was hit
    pub pos: [i32; 3],
    /// face normal pointing out of the block towards the ray origin (zero if the origin is inside the block)
    pub normal: [i32; 3],
    pub id: BlockId,
    /// distance along the (normalised) ray
    pub dist: f32,
    pub point: [f32; 3],
}

/// Voxel DDA. `liquids = true` also stops at water. `dir` need not be normalised.
pub fn raycast(src: &dyn BlockSource, origin: [f32; 3], dir: [f32; 3], max: f32, liquids: bool) -> Option<RayHit> {
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if !(len > 1e-6) || !origin.iter().all(|v| v.is_finite()) {
        return None;
    }
    let d = [dir[0] / len, dir[1] / len, dir[2] / len];
    let mut cell = [origin[0].floor() as i32, origin[1].floor() as i32, origin[2].floor() as i32];
    let step = [if d[0] > 0.0 { 1 } else { -1 }, if d[1] > 0.0 { 1 } else { -1 }, if d[2] > 0.0 { 1 } else { -1 }];
    let mut t_max = [f32::INFINITY; 3];
    let mut t_delta = [f32::INFINITY; 3];
    for a in 0..3 {
        if d[a].abs() > 1e-9 {
            let next = if step[a] > 0 { cell[a] as f32 + 1.0 } else { cell[a] as f32 };
            t_max[a] = (next - origin[a]) / d[a];
            t_delta[a] = (1.0 / d[a]).abs();
        }
    }
    let mut normal = [0i32; 3];
    let mut t = 0.0f32;
    for _ in 0..4096 {
        let id = src.block(cell[0], cell[1], cell[2]);
        if is_solid(id) || (liquids && is_liquid(id)) {
            return Some(RayHit {
                pos: cell,
                normal,
                id,
                dist: t,
                point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
            });
        }
        let a = if t_max[0] <= t_max[1] && t_max[0] <= t_max[2] {
            0
        } else if t_max[1] <= t_max[2] {
            1
        } else {
            2
        };
        t = t_max[a];
        if t > max {
            return None;
        }
        cell[a] += step[a];
        t_max[a] += t_delta[a];
        normal = [0; 3];
        normal[a] = -step[a];
    }
    None
}

/// Result of [`aabb_sweep`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SweepResult {
    /// new minimum corner of the box
    pub pos: [f32; 3],
    /// per axis: true if the move was stopped by a solid block
    pub hit: [bool; 3],
}

const SKIN: f32 = 1e-3;

fn solid_range(src: &dyn BlockSource, axis: usize, k: i32, b: (usize, i32, i32), c: (usize, i32, i32)) -> bool {
    for vb in b.1..=b.2 {
        for vc in c.1..=c.2 {
            let mut p = [0i32; 3];
            p[axis] = k;
            p[b.0] = vb;
            p[c.0] = vc;
            if is_solid(src.block(p[0], p[1], p[2])) {
                return true;
            }
        }
    }
    false
}

fn sweep_axis(src: &dyn BlockSource, min: &mut [f32; 3], size: [f32; 3], axis: usize, delta: f32) -> bool {
    if delta == 0.0 || !delta.is_finite() {
        return false;
    }
    let (ib, ic) = match axis {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    };
    let b = (ib, (min[ib] + SKIN).floor() as i32, (min[ib] + size[ib] - SKIN).floor() as i32);
    let c = (ic, (min[ic] + SKIN).floor() as i32, (min[ic] + size[ic] - SKIN).floor() as i32);
    if delta > 0.0 {
        let edge = min[axis] + size[axis];
        let first = (edge - SKIN).ceil() as i32;
        let last = (edge + delta).floor() as i32;
        for k in first..=last {
            if solid_range(src, axis, k, b, c) {
                let allow = (k as f32 - edge - SKIN).max(0.0);
                min[axis] += allow;
                return true;
            }
        }
    } else {
        let edge = min[axis];
        let first = (edge + SKIN).floor() as i32 - 1;
        let last = (edge + delta).floor() as i32;
        let mut k = first;
        while k >= last {
            if solid_range(src, axis, k, b, c) {
                let mv = ((k + 1) as f32 + SKIN - edge).min(0.0);
                min[axis] += mv;
                return true;
            }
            k -= 1;
        }
    }
    min[axis] += delta;
    false
}

/// Moves the box `[min, min + size]` by `delta` against solid blocks, resolving y, then x, then z (so landing is
/// resolved before sliding). The box never ends up inside a solid block if it started outside of one.
pub fn aabb_sweep(src: &dyn BlockSource, min: [f32; 3], size: [f32; 3], delta: [f32; 3]) -> SweepResult {
    let mut p = min;
    let mut hit = [false; 3];
    for axis in [1usize, 0, 2] {
        hit[axis] = sweep_axis(src, &mut p, size, axis, delta[axis]);
    }
    SweepResult { pos: p, hit }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// stone floor at y < 0 plus a wall block column at x = 5
    struct Mini;
    impl BlockSource for Mini {
        fn block(&self, x: i32, y: i32, z: i32) -> BlockId {
            if y < 0 || (x == 5 && z == 0 && y < 3) {
                id::STONE
            } else {
                id::AIR
            }
        }
    }

    #[test]
    fn registry_is_consistent() {
        for (i, d) in BLOCKS.iter().enumerate() {
            assert_eq!(usize::from(d.id), i, "{}", d.name);
            assert!(usize::from(d.drop) < BLOCKS.len());
        }
        assert!(is_solid(id::GRASS) && !is_solid(id::WATER) && is_liquid(id::WATER) && !is_opaque(id::AIR));
        assert!(is_ground(id::GRASS) && !is_ground(id::LEAVES_OAK) && !is_ground(id::LOG_OAK) && is_solid(id::LOG_OAK));
        assert_eq!(registry_json()["blocks"].as_array().unwrap().len(), BLOCKS.len());
    }

    #[test]
    fn raycast_hits_floor_and_wall() {
        let h = raycast(&Mini, [0.5, 3.5, 0.5], [0.0, -1.0, 0.0], 20.0, false).unwrap();
        assert_eq!((h.pos, h.normal), ([0, -1, 0], [0, 1, 0]));
        assert!((h.dist - 3.5).abs() < 1e-4);
        let w = raycast(&Mini, [0.5, 1.5, 0.5], [1.0, 0.0, 0.0], 20.0, false).unwrap();
        assert_eq!((w.pos, w.normal), ([5, 1, 0], [-1, 0, 0]));
        assert!(raycast(&Mini, [0.5, 1.5, 0.5], [0.0, 1.0, 0.0], 20.0, false).is_none());
    }

    #[test]
    fn sweep_lands_slides_and_stops() {
        // falling box lands on the floor
        let r = aabb_sweep(&Mini, [0.2, 2.0, 0.2], [0.6, 1.8, 0.6], [0.0, -5.0, 0.0]);
        assert!(r.hit[1] && (r.pos[1] - 0.0).abs() < 0.01, "{r:?}");
        // walking into the wall stops at its face
        let r = aabb_sweep(&Mini, [3.0, 0.0, 0.2], [0.6, 1.8, 0.6], [3.0, 0.0, 0.0]);
        assert!(r.hit[0] && (r.pos[0] + 0.6 - 5.0).abs() < 0.01, "{r:?}");
        // above the wall (y >= 3) nothing stops it
        let r = aabb_sweep(&Mini, [3.0, 3.0, 0.2], [0.6, 1.0, 0.6], [4.0, 0.0, 0.0]);
        assert!(!r.hit[0] && (r.pos[0] - 7.0).abs() < 1e-4, "{r:?}");
        // never ends inside the floor
        let r = aabb_sweep(&Mini, [0.2, 0.0, 0.2], [0.6, 1.0, 0.6], [0.0, -3.0, 0.0]);
        assert!(r.pos[1] >= -1e-3);
    }
}
