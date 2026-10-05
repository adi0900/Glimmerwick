//! Placeholder flora scatter so the `flora` channel carries real data in the reference slice.
//! (The world owner replaces this with the real placement rules - keep the record layout.)
//!
//! Record layout (stride 8, `f32`): `kind · x · y · z · yaw · scale · variant · state`.

use crate::heightfield::Heightfield;
use sim_core::math;
use sim_core::rng::{hash2, hash_unit};
use sim_core::terrain::biome;

/// `f32` elements per flora record.
pub const FLORA_STRIDE: usize = 8;
/// Maximum number of flora instances the channel can hold.
pub const MAX_FLORA: usize = 8192;

/// Flora kinds (column 0), indexable into [`KIND_NAMES`].
pub mod kind {
    pub const TREE: f32 = 0.0;
    pub const FLOWER: f32 = 1.0;
    pub const ROCK: f32 = 2.0;
    pub const BUSH: f32 = 3.0;
}
pub const KIND_NAMES: [&str; 4] = ["tree", "flower", "rock", "bush"];

/// Jittered-grid spacing in metres.
const SPACING: f32 = 3.0;

/// Deterministic scatter: one candidate per `SPACING` cell, accepted by biome-specific odds.
pub fn scatter(hf: &Heightfield, seed: u32) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    let half = (hf.size as f32 * hf.cell * 0.5 / SPACING) as i32 - 1;
    for cz in -half..half {
        for cx in -half..half {
            let h1 = hash2(seed, cx, cz);
            let h2 = hash2(seed ^ 0x55AA, cx, cz);
            let x = (cx as f32 + hash_unit(h1)) * SPACING;
            let z = (cz as f32 + hash_unit(h2)) * SPACING;
            let y = hf.sample(x, z);
            let b = hf.biome_at(x, z);
            let slope = math::acos(hf.normal(x, z).y.clamp(-1.0, 1.0));
            let roll = hash_unit(hash2(seed ^ 0x1234, cx, cz));
            let k = match b {
                biome::FOREST if slope < 0.6 => {
                    if roll < 0.62 {
                        Some(kind::TREE)
                    } else if roll < 0.80 {
                        Some(kind::BUSH)
                    } else {
                        None
                    }
                }
                biome::MEADOW if slope < 0.5 => {
                    if roll < 0.28 {
                        Some(kind::FLOWER)
                    } else if roll < 0.32 {
                        Some(kind::BUSH)
                    } else {
                        None
                    }
                }
                biome::ROCK if roll < 0.35 => Some(kind::ROCK),
                _ => None,
            };
            let Some(k) = k else { continue };
            if out.len() + FLORA_STRIDE > MAX_FLORA * FLORA_STRIDE {
                return out;
            }
            let yaw = (hash_unit(hash2(seed ^ 0x77, cx, cz)) - 0.5) * math::TAU;
            let scale = 0.8 + 0.5 * hash_unit(hash2(seed ^ 0x99, cx, cz));
            let variant = (hash2(seed ^ 0xBB, cx, cz) % 4) as f32;
            out.extend_from_slice(&[k, x, y, z, yaw, scale, variant, 0.0]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scatter_is_valid_and_deterministic() {
        let hf = Heightfield::generate(3);
        let a = scatter(&hf, 99);
        assert_eq!(a, scatter(&hf, 99));
        assert_ne!(a, scatter(&hf, 100));
        assert_eq!(a.len() % FLORA_STRIDE, 0);
        let n = a.len() / FLORA_STRIDE;
        assert!((150..=MAX_FLORA).contains(&n), "{n} instances");
        for r in a.chunks_exact(FLORA_STRIDE) {
            let (x, y, z) = (r[1], r[2], r[3]);
            assert!(hf.sample(x, z) >= 0.0, "flora in water at ({x},{z})");
            assert!((y - hf.sample(x, z)).abs() < 1e-4, "flora floating");
            assert!(r[0] >= 0.0 && r[0] < KIND_NAMES.len() as f32);
        }
    }
}
