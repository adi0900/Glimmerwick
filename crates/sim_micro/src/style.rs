//! Tunable look of the micro world. All sizes are in **L0 voxels (1/16 m)** and are scaled down per level.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Style {
    pub seed: u32,
    /// chamfer radius of exposed edges of soft / rock blocks (voxels): remove voxel if `d_a + d_b < bevel`
    pub bevel: u8,
    /// man-made blocks (planks, plaster, roof, glass, lantern)
    pub bevel_hard: u8,
    /// logs, mushroom stems, glowcaps (round trunks)
    pub bevel_log: u8,
    /// extra radius for the three-face corner rule
    pub bevel_corner_extra: u8,
    /// relief of exposed soft tops, in voxels (inclusive range, e.g. -2..=1)
    pub relief_lo: i8,
    pub relief_hi: i8,
    /// value-noise lattice spacings (voxels) of the two relief octaves; `relief_mix_b` = weight of octave b (0..255)
    pub relief_cell_a: u8,
    pub relief_cell_b: u8,
    pub relief_mix_b: u8,
    /// contrast of the relief noise, 256 = 1.0 (more = more extreme levels)
    pub relief_gain: u16,
    /// highest level that gets relief (coarser rings are flat + bevel)
    pub relief_max_level: u8,
    /// grass / snow / path layer thickness on top of dirt (voxels)
    pub grass_depth: u8,
    /// probability (0..255) that a 2x2 voxel patch of an exposed soft side is indented by one voxel
    pub side_inset_density: u8,
    /// rock strata: band height in voxels (0 = off); odd bands are indented
    pub strata_band: u8,
    /// highest level with side indentation / strata
    pub inset_max_level: u8,
    /// leaf blocks: edge chamfer, shell occupancy (0..255 per 2x2x2 clump), shell thickness (voxels)
    pub leaf_bevel: u8,
    pub leaf_occupancy: u8,
    pub leaf_shell_depth: u8,
    pub leaf_shell_max_level: u8,
    /// decor: probability (0..255) per 4x4 voxel cell of a grass tuft (grass tops) / pebble (bare tops)
    pub tuft_density: u8,
    pub pebble_density: u8,
    pub decor_max_level: u8,
    /// per-vertex ambient occlusion on / off (off = flat 3)
    pub ao: bool,
    /// skirt depth in voxels of the chunk's own level
    pub skirt_voxels: u8,
}

impl Default for Style {
    fn default() -> Self {
        Style {
            seed: 0x6D1C_0001,
            bevel: 2,
            bevel_hard: 1,
            bevel_log: 3,
            bevel_corner_extra: 2,
            relief_lo: -1,
            relief_hi: 1,
            relief_cell_a: 9,
            relief_cell_b: 5,
            relief_mix_b: 70,
            relief_gain: 300,
            relief_max_level: 1,
            grass_depth: 3,
            side_inset_density: 45,
            strata_band: 3,
            inset_max_level: 1,
            leaf_bevel: 5,
            leaf_occupancy: 205,
            leaf_shell_depth: 1,
            leaf_shell_max_level: 1,
            tuft_density: 28,
            pebble_density: 24,
            decor_max_level: 0,
            ao: true,
            skirt_voxels: 4,
        }
    }
}

impl Style {
    /// Radius scaled to `level` (at least 1 voxel).
    #[inline]
    pub fn scaled(v: u8, level: u8) -> i32 {
        ((i32::from(v) + (1 << level) - 1) >> level).max(1)
    }
}
