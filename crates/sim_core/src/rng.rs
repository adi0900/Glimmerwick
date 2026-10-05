//! Seeded, splittable, platform-independent random numbers.
//!
//! * [`Rng`] is xoshiro256++ seeded through SplitMix64: tiny, fast, 256 bits of state that can be
//!   serialised into save files, and no dependency on `rand`, OS entropy or `std::time`
//!   (none of which work in `wasm32-unknown-unknown`).
//! * Streams are **split by label** ([`Rng::split`]) so every system / entity owns an independent,
//!   reproducible stream: adding a creature never changes the numbers the weather draws.
//! * [`SimSeed`] is the root: `seed.rng("creatures")` is the recommended way to get a stream at
//!   plugin-build time. For per-entity streams use `stream.split_u64(entity_id)`.
//! * [`hash2`] / [`hash_unit`] are stateless integer hashes for noise / scatter functions.
//!
//! All float helpers use only IEEE-exact operations or `sim_core::math` (libm) wrappers.

use crate::math::{self, Vec2};
use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};

/// One SplitMix64 step. Used for seeding and splitting.
#[inline]
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Stateless 64-bit finaliser (SplitMix64 mix of a single value).
#[inline]
pub fn hash64(x: u64) -> u64 {
    let mut s = x;
    splitmix64(&mut s)
}

/// FNV-1a over bytes; used to turn split labels into seeds and for channel digests.
#[inline]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    h
}

/// Stateless 2-D integer hash (lowbias32-style finaliser). Great for lattice noise.
#[inline]
pub fn hash2(seed: u32, x: i32, y: i32) -> u32 {
    let mut h = seed ^ (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^= h >> 16;
    h
}

/// Maps a hash to `[0, 1)` (24 bits of precision, exact in f32).
#[inline]
pub fn hash_unit(h: u32) -> f32 {
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// xoshiro256++ generator. `Clone` + `Serialize` so it can live in components and save files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    /// Creates a stream from a 64-bit seed.
    pub fn from_seed(seed: u64) -> Self {
        let mut sm = seed;
        let mut s = [0u64; 4];
        for slot in &mut s {
            *slot = splitmix64(&mut sm);
        }
        // xoshiro must not start in the all-zero state (cannot happen with SplitMix64, but be safe).
        if s == [0; 4] {
            s[0] = 1;
        }
        Self { s }
    }

    /// Derives an independent child stream from this stream's *current state* and a label.
    /// Does not advance `self`. Split from a pristine root (e.g. [`SimSeed::rng`]) for results that
    /// depend only on `(seed, label)`.
    pub fn split(&self, label: &str) -> Rng {
        self.split_u64(fnv1a64(label.as_bytes()))
    }

    /// Like [`split`](Self::split) with a numeric key (entity id, chunk index, ...).
    pub fn split_u64(&self, key: u64) -> Rng {
        let mix = hash64(self.s[0] ^ hash64(self.s[1].rotate_left(17)) ^ hash64(self.s[2] ^ self.s[3].rotate_left(41)));
        Rng::from_seed(mix ^ hash64(key.wrapping_add(0xD1B5_4A32_D192_ED03)))
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let s = &mut self.s;
        let result = s[0].wrapping_add(s[3]).rotate_left(23).wrapping_add(s[0]);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform in `[0, 1)`.
    #[inline]
    pub fn f32(&mut self) -> f32 {
        hash_unit(self.next_u32())
    }

    /// Uniform in `[lo, hi)`.
    #[inline]
    pub fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }

    /// Uniform integer in `[0, n)`; returns 0 for `n == 0`. (Multiply-shift: bias < n / 2^32.)
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        ((u64::from(self.next_u32()) * u64::from(n)) >> 32) as u32
    }

    /// Uniform integer in `[lo, hi]` (inclusive). Swaps the bounds if reversed.
    #[inline]
    pub fn range_u32(&mut self, lo: u32, hi: u32) -> u32 {
        let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
        lo + self.below(hi - lo + 1)
    }

    /// `true` with probability `p`.
    #[inline]
    pub fn chance(&mut self, p: f32) -> bool {
        self.f32() < p
    }

    /// Uniformly picks an element.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() { None } else { items.get(self.below(items.len() as u32) as usize) }
    }

    /// Fisher-Yates shuffle.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u32 + 1) as usize;
            items.swap(i, j);
        }
    }

    /// Uniform direction on the unit circle.
    pub fn unit_vec2(&mut self) -> Vec2 {
        let (s, c) = math::sin_cos(self.f32() * math::TAU);
        Vec2::new(c, s)
    }

    /// Uniform point inside a disc of the given radius.
    pub fn in_disc(&mut self, radius: f32) -> Vec2 {
        let r = radius * self.f32().sqrt();
        self.unit_vec2() * r
    }

    /// Standard normal (Box-Muller, one value per call).
    pub fn normal(&mut self) -> f32 {
        let u1 = self.f32().max(1e-7);
        let u2 = self.f32();
        (-2.0 * math::ln(u1)).sqrt() * math::cos(u2 * math::TAU)
    }
}

/// Root seed of a simulation (resource). Everything random derives from it.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimSeed(pub u64);

impl SimSeed {
    /// Expands the 32-bit seed that JS passes to `new Game(seed)`.
    pub fn from_u32(seed: u32) -> Self {
        SimSeed(hash64(u64::from(seed) ^ 0x4C49_4D4D_4552_5749)) // "LIMMERWI"
    }

    /// The recommended way to obtain a named stream: depends only on `(seed, label)`.
    pub fn rng(&self, label: &str) -> Rng {
        Rng::from_seed(self.0).split(label)
    }

    /// 32-bit view (for noise functions that take a `u32` seed), decorrelated per label.
    pub fn noise_seed(&self, label: &str) -> u32 {
        (hash64(self.0 ^ fnv1a64(label.as_bytes())) >> 32) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = Rng::from_seed(42);
        let mut b = Rng::from_seed(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut c = Rng::from_seed(43);
        let differs = (0..16).any(|_| Rng::from_seed(42).next_u64() != c.next_u64());
        assert!(differs);
    }

    #[test]
    fn known_vector_is_stable() {
        // Guards against accidental algorithm changes (would silently break saves & goldens).
        let mut r = Rng::from_seed(0);
        let v: Vec<u64> = (0..3).map(|_| r.next_u64()).collect();
        assert_eq!(v, vec![0x53175d61490b23df, 0x61da6f3dc380d507, 0x5c0fdf91ec9a7bfc]);
    }

    #[test]
    fn split_is_independent_and_pure() {
        let root = Rng::from_seed(7);
        let a1 = root.split("a");
        let a2 = root.split("a");
        let b = root.split("b");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        // Splitting does not advance the parent.
        assert_eq!(root, Rng::from_seed(7));
        // Numeric keys differ.
        assert_ne!(root.split_u64(1), root.split_u64(2));
    }

    #[test]
    fn f32_in_unit_interval_and_roughly_uniform() {
        let mut r = Rng::from_seed(1);
        let mut buckets = [0u32; 10];
        for _ in 0..20_000 {
            let x = r.f32();
            assert!((0.0..1.0).contains(&x));
            buckets[(x * 10.0) as usize] += 1;
        }
        for (i, n) in buckets.iter().enumerate() {
            assert!((1700..2300).contains(n), "bucket {i} = {n}");
        }
    }

    #[test]
    fn below_and_range_cover_bounds() {
        let mut r = Rng::from_seed(5);
        let mut seen = [false; 6];
        for _ in 0..500 {
            seen[r.range_u32(0, 5) as usize] = true;
            assert!(r.below(1) == 0);
            assert!(r.below(0) == 0);
        }
        assert!(seen.iter().all(|s| *s));
        assert!(r.range_u32(5, 2) >= 2);
    }

    #[test]
    fn shuffle_is_permutation() {
        let mut r = Rng::from_seed(9);
        let mut v: Vec<u32> = (0..50).collect();
        r.shuffle(&mut v);
        let mut sorted = v.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..50).collect::<Vec<_>>());
        assert_ne!(v, sorted);
    }

    #[test]
    fn serde_roundtrip_continues_sequence() {
        let mut a = Rng::from_seed(11);
        for _ in 0..10 {
            a.next_u64();
        }
        let bytes = postcard::to_allocvec(&a).unwrap();
        let mut b: Rng = postcard::from_bytes(&bytes).unwrap();
        for _ in 0..10 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn hash2_is_stable_and_spread() {
        assert_eq!(hash2(1, 2, 3), hash2(1, 2, 3));
        assert_ne!(hash2(1, 2, 3), hash2(1, 3, 2));
        assert_ne!(hash2(1, 2, 3), hash2(2, 2, 3));
        let u = hash_unit(hash2(9, -5, 77));
        assert!((0.0..1.0).contains(&u));
    }

    #[test]
    fn disc_points_inside() {
        let mut r = Rng::from_seed(3);
        for _ in 0..1000 {
            assert!(r.in_disc(2.0).length() <= 2.0 + 1e-5);
        }
    }
}
