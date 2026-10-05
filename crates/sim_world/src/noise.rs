//! Lattice value noise + fbm built only from IEEE-exact float ops (`+ - * /`, `floor`) and integer
//! hashing, so generated terrain is bit-identical on every platform (no libm calls at all).

use sim_core::rng::{hash2, hash_unit};

/// Quintic fade curve (C2 continuous).
#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Smooth value noise in `[0, 1)`.
pub fn value_noise(seed: u32, x: f32, y: f32) -> f32 {
    let x0 = x.floor();
    let y0 = y.floor();
    let u = fade(x - x0);
    let v = fade(y - y0);
    let (xi, yi) = (x0 as i32, y0 as i32);
    let h = |dx: i32, dy: i32| hash_unit(hash2(seed, xi.wrapping_add(dx), yi.wrapping_add(dy)));
    lerp(lerp(h(0, 0), h(1, 0), u), lerp(h(0, 1), h(1, 1), u), v)
}

/// Fractal Brownian motion, normalised to `[0, 1)` (mean ~0.5).
pub fn fbm(seed: u32, x: f32, y: f32, octaves: u32) -> f32 {
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for o in 0..octaves {
        sum += amp * value_noise(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}

/// fbm with a ~37 degree rotation + x2 scale per octave (hides the lattice axes), `[0, 1)`.
/// Only IEEE-exact ops, like everything in this file.
pub fn fbm_rot(seed: u32, x: f32, y: f32, octaves: u32, gain: f32) -> f32 {
    let (mut x, mut y) = (x, y);
    let mut amp = 0.5;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for o in 0..octaves {
        sum += amp * value_noise(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), x, y);
        norm += amp;
        amp *= gain;
        let nx = 1.6 * x + 1.2 * y + 17.3;
        let ny = -1.2 * x + 1.6 * y - 9.1;
        x = nx;
        y = ny;
    }
    sum / norm
}

/// Signed fbm in `(-1, 1)`.
pub fn sn(seed: u32, x: f32, y: f32, octaves: u32) -> f32 {
    (fbm_rot(seed, x, y, octaves, 0.5) - 0.5) * 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_is_deterministic_bounded_and_continuous() {
        for i in 0..200 {
            let (x, y) = (i as f32 * 0.37 - 20.0, i as f32 * 0.19 + 3.0);
            let a = value_noise(5, x, y);
            assert_eq!(a, value_noise(5, x, y));
            assert!((0.0..1.0).contains(&a));
            let f = fbm(5, x, y, 5);
            assert!((0.0..1.0).contains(&f), "{f}");
            // continuity: tiny step => tiny change
            assert!((value_noise(5, x + 1e-3, y) - a).abs() < 0.01);
        }
        assert_ne!(value_noise(1, 0.5, 0.5), value_noise(2, 0.5, 0.5));
    }

    #[test]
    fn fbm_mean_is_near_half() {
        let mut sum = 0.0;
        let n = 4000;
        for i in 0..n {
            sum += fbm(9, (i % 64) as f32 * 0.7, (i / 64) as f32 * 0.7, 5);
        }
        let mean = sum / n as f32;
        assert!((0.4..0.6).contains(&mean), "{mean}");
    }
}
