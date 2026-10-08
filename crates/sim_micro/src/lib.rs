//! `sim_micro`: the micro-voxel world of Glimmerwick (docs/specs/MICROVOXEL_NOTES.md, milestone M1).
//!
//! Pure functions, no Bevy, no dependencies. The 1 m block grid (`vox.data`) is the only source of truth; this crate turns it
//! into 1/16 m ... 1/2 m voxels on demand ([`micro`]) and meshes 32^3 micro-chunks with a binary greedy mesher ([`Mesher`]).
//!
//! * Public API is plain slices in, plain `Vec<u8>` / `Vec<u16>` out ([`mesh_micro_chunk`]), so a `wasm-bindgen` export is
//!   a one-liner (M2). Hot paths should keep a [`Mesher`] per worker (pooled buffers).
//! * Coordinates: block `(x, y, z)` = integer world metres; level `L` voxel = `2^L / 16` m; micro-chunk `(cx, cy, cz)` at level
//!   `L` covers voxels `[32 c, 32 c + 32)` = `2^(L+1)` m per edge.
//! * Output vertex layout: see [`mesh`] (8 bytes).

pub mod blocks;
pub mod voxgen;
pub mod grid;
pub mod mesh;
pub mod noise;
pub mod style;

pub use voxgen::{GenScratch, Region, generate_region, micro, region_origin};
pub use grid::GridDesc;
pub use mesh::{MC, MeshHeader, Mesher, VERTEX_BYTES};
pub use style::Style;

/// One micro-chunk key: `(level, cx, cy, cz)`.
pub type MicroKey = (u8, i32, i32, i32);

/// Result of [`mesh_micro_chunk`].
#[derive(Clone, Debug, Default)]
pub struct MeshOut {
    pub header: MeshHeader,
    /// 8 bytes per vertex (layout in [`mesh`])
    pub vertices: Vec<u8>,
    /// triangle list, 16-bit
    pub indices: Vec<u16>,
}

/// One-shot convenience (allocates): default [`Style`] and the Glimmerwick grid layout. Prefer a kept [`Mesher`] in workers.
pub fn mesh_micro_chunk(blocks: &[u16], level: u8, cx: i32, cy: i32, cz: i32) -> MeshOut {
    let mut m = Mesher::new();
    let header = m.mesh(blocks, &GridDesc::GLIMMERWICK, &Style::default(), level, cx, cy, cz);
    let (vertices, indices) = m.take();
    MeshOut { header, vertices, indices }
}

/// Every micro-chunk (levels 0..=3) whose mesh can change when the 1 m block at world block coords `block` changes.
/// A block influences its 3x3x3 block neighbourhood (bevel / exposure / relief spill), and chunks read a 1-voxel apron.
/// Typically 8 L0 chunks (27 at most) plus 1-8 per coarser level.
pub fn dirty_micro_chunks(block: [i32; 3]) -> Vec<MicroKey> {
    let mut out = Vec::with_capacity(48);
    dirty_micro_chunks_into(block, &mut out);
    out
}

pub fn dirty_micro_chunks_into(block: [i32; 3], out: &mut Vec<MicroKey>) {
    for level in 0u8..=3 {
        let r = 16i32 >> level;
        let range = |b: i32| {
            let lo_v = (b - 1) * r; // first affected voxel
            let hi_v = (b + 2) * r; // one past the last
            // chunk c reads voxels [32c - 1, 32c + 33)
            ((lo_v - 33).div_euclid(32) + 1, hi_v.div_euclid(32))
        };
        let (x0, x1) = range(block[0]);
        let (y0, y1) = range(block[1]);
        let (z0, z1) = range(block[2]);
        for cy in y0..=y1 {
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    out.push((level, cx, cy, cz));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
