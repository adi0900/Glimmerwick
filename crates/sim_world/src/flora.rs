//! Flora placement per `docs/WORLD_CONTRACT.md`: kinds 0-127, densities per biome, groves / clumps / outcrops,
//! nothing in water (except reeds / cattails / lily pads), nothing on slopes > 35 deg, nothing within 2 m of paths
//! or the village clearing. Deterministic jittered-grid ("blue noise") sampling with noise-gated groves.
//!
//! Record layout (stride 8, `f32`): `kind · x · y · z · yaw · scale · variant(0-255) · state(0-1)`.

use crate::biome;
use crate::heightfield::{HALF, Heightfield};
use crate::noise::fbm_rot;
use crate::worldgen::{Features, Generated};
use sim_core::math;
use sim_core::rng::{hash2, hash_unit};

/// `f32` elements per flora record.
pub const FLORA_STRIDE: usize = 8;
/// Maximum number of flora instances the channel can hold.
pub const MAX_FLORA: usize = 32768;

/// Flora kinds (column 0) - the WORLD_CONTRACT.md table.
pub mod kind {
    pub const OAK: u16 = 0;
    pub const TALL: u16 = 1;
    pub const PINE: u16 = 2;
    pub const BLOSSOM: u16 = 3;
    pub const PALM: u16 = 4;
    pub const WILLOW: u16 = 5;
    pub const BIRCH: u16 = 6;
    pub const MAPLE: u16 = 7;
    pub const GIANT_GLOWCAP: u16 = 8;
    pub const DEAD_TREE: u16 = 9;
    pub const APPLE: u16 = 10;
    pub const ORANGE: u16 = 11;
    pub const ROUND_BUSH: u16 = 16;
    pub const BERRY_BUSH: u16 = 17;
    pub const FERN: u16 = 18;
    pub const HYDRANGEA: u16 = 19;
    pub const SHRUB_FLOWERING: u16 = 20;
    pub const DAISY: u16 = 32;
    pub const TULIP: u16 = 33;
    pub const LAVENDER: u16 = 34;
    pub const SUNFLOWER: u16 = 35;
    pub const BLUEBELL: u16 = 36;
    pub const POPPY: u16 = 37;
    pub const LILY: u16 = 38;
    pub const CLOVER: u16 = 39;
    pub const RED_CAP: u16 = 48;
    pub const GLOWCAP: u16 = 49;
    pub const BROWN_CLUSTER: u16 = 50;
    pub const BOULDER: u16 = 64;
    pub const FLAT_ROCK: u16 = 65;
    pub const PEBBLES: u16 = 66;
    pub const MOSSY_ROCK: u16 = 67;
    pub const CRYSTAL: u16 = 68;
    pub const SEA_STACK: u16 = 69;
    pub const REEDS: u16 = 80;
    pub const LILY_PAD: u16 = 81;
    pub const CATTAIL: u16 = 82;
    pub const SHELL: u16 = 96;
    pub const STARFISH: u16 = 97;
    pub const DRIFTWOOD: u16 = 98;
    pub const BEACH_GRASS: u16 = 99;
    pub const STUMP: u16 = 112;
    pub const LOG: u16 = 113;
    pub const MOSSY_LOG: u16 = 114;
}

/// Names indexed by kind id (empty string = unused id); published as `world.info.flora_kinds`.
pub fn kind_names() -> Vec<&'static str> {
    use kind::*;
    let mut n = vec![""; 128];
    for (k, name) in [
        (OAK, "oak_puff"),
        (TALL, "tall_puff"),
        (PINE, "pine_tier"),
        (BLOSSOM, "blossom"),
        (PALM, "palm"),
        (WILLOW, "willow"),
        (BIRCH, "birch"),
        (MAPLE, "maple"),
        (GIANT_GLOWCAP, "giant_glowcap"),
        (DEAD_TREE, "dead_tree"),
        (APPLE, "apple"),
        (ORANGE, "orange"),
        (ROUND_BUSH, "round_bush"),
        (BERRY_BUSH, "berry_bush"),
        (FERN, "fern"),
        (HYDRANGEA, "hydrangea"),
        (SHRUB_FLOWERING, "shrub_flowering"),
        (DAISY, "daisy"),
        (TULIP, "tulip"),
        (LAVENDER, "lavender"),
        (SUNFLOWER, "sunflower"),
        (BLUEBELL, "bluebell"),
        (POPPY, "poppy"),
        (LILY, "lily"),
        (CLOVER, "clover_patch"),
        (RED_CAP, "red_cap"),
        (GLOWCAP, "glowcap"),
        (BROWN_CLUSTER, "brown_cluster"),
        (BOULDER, "boulder"),
        (FLAT_ROCK, "flat_rock"),
        (PEBBLES, "pebbles"),
        (MOSSY_ROCK, "mossy_rock"),
        (CRYSTAL, "crystal_cluster"),
        (SEA_STACK, "sea_stack"),
        (REEDS, "reeds"),
        (LILY_PAD, "lily_pad"),
        (CATTAIL, "cattail"),
        (SHELL, "shell"),
        (STARFISH, "starfish"),
        (DRIFTWOOD, "driftwood"),
        (BEACH_GRASS, "beach_grass"),
        (STUMP, "stump"),
        (LOG, "log"),
        (MOSSY_LOG, "mossy_log"),
    ] {
        n[usize::from(k)] = name;
    }
    n
}

#[inline]
fn ss(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Derived random roll in `[0, 1)` from a cell hash.
#[inline]
fn roll(h: u32, k: i32) -> f32 {
    hash_unit(hash2(h, k, 3))
}

/// Jittered grid cells over the whole world: `(x, z, hash_a, hash_b)`. Jitter is confined to the cell's middle 70 %
/// so neighbours stay >= 0.3 spacing apart (cheap blue noise).
fn cells(seed: u32, salt: u32, spacing: f32) -> impl Iterator<Item = (f32, f32, u32, u32)> {
    let m = HALF - 6.0;
    let n = ((2.0 * m) / spacing) as i32;
    let s = seed ^ salt;
    (0..n).flat_map(move |cz| {
        (0..n).map(move |cx| {
            let h1 = hash2(s, cx, cz);
            let h2 = hash2(s ^ 0x55AA, cx, cz);
            let h3 = hash2(s ^ 0xA5A5, cx, cz);
            let x = -m + (cx as f32 + 0.15 + 0.7 * hash_unit(h1)) * spacing;
            let z = -m + (cz as f32 + 0.15 + 0.7 * hash_unit(h2)) * spacing;
            (x, z, h3, h1.rotate_left(13) ^ h2)
        })
    })
}

struct Placer<'a> {
    hf: &'a Heightfield,
    f: &'a Features,
    seed: u32,
    out: Vec<f32>,
    /// 1 m lattice: 1 = within 2 m of a path / the village clearing.
    keep: Vec<u8>,
}

const KN: usize = (2.0 * HALF) as usize + 1;

impl<'a> Placer<'a> {
    fn new(hf: &'a Heightfield, f: &'a Features, seed: u32) -> Self {
        // mark every lattice point within ~3 m of a fine path / clearing cell (conservative: the "2 m" rule + rounding)
        let mut keep = vec![0u8; KN * KN];
        for j in 0..hf.size {
            for i in 0..hf.size {
                let b = hf.biomes[j * hf.size + i];
                if b != biome::DIRT_PATH && b != biome::VILLAGE {
                    continue;
                }
                let (x, z) = hf.sample_pos(i, j);
                let (ci, cj) = ((x + HALF).round() as i32, (z + HALF).round() as i32);
                for dj in -3i32..=3 {
                    for di in -3i32..=3 {
                        if di * di + dj * dj > 9 {
                            continue;
                        }
                        let (a, b) = (ci + di, cj + dj);
                        if a >= 0 && b >= 0 && (a as usize) < KN && (b as usize) < KN {
                            keep[b as usize * KN + a as usize] = 1;
                        }
                    }
                }
            }
        }
        Placer { hf, f, seed, out: Vec::with_capacity(60_000), keep }
    }

    fn kept(&self, x: f32, z: f32) -> bool {
        let i = (x + HALF).round() as i32;
        let j = (z + HALF).round() as i32;
        i < 0 || j < 0 || i as usize >= KN || j as usize >= KN || self.keep[j as usize * KN + i as usize] != 0
    }

    /// `(height, steepness, biome)` of the ground at `(x, z)`.
    fn ground(&self, x: f32, z: f32) -> (f32, f32, u8) {
        (self.hf.sample(x, z), self.hf.steepness(x, z), self.hf.biome_at(x, z))
    }

    fn push(&mut self, k: u16, x: f32, z: f32, h: u32, scale: f32, state: f32) {
        if self.out.len() >= MAX_FLORA * FLORA_STRIDE {
            return;
        }
        let y = self.hf.sample(x, z);
        self.push_at(k, x, y, z, h, scale, state);
    }

    fn push_at(&mut self, k: u16, x: f32, y: f32, z: f32, h: u32, scale: f32, state: f32) {
        if self.out.len() >= MAX_FLORA * FLORA_STRIDE {
            return;
        }
        let yaw = (roll(h, 90) - 0.5) * math::TAU;
        let variant = (hash2(h, 91, 1) & 0xFF) as f32;
        self.out.extend_from_slice(&[f32::from(k), x, y, z, yaw, scale, variant, state]);
    }

    /// Land position free of water, steep ground, paths and the clearing.
    fn ok_land(&self, x: f32, z: f32, max_steep: f32) -> Option<(f32, u8)> {
        let (h, g, b) = self.ground(x, z);
        if h < 0.05 || g > max_steep || b == biome::POND_BANK || b == biome::VILLAGE || b == biome::DIRT_PATH || b == biome::CLIFF_ROCK || self.kept(x, z) {
            return None;
        }
        Some((h, b))
    }

    fn forest(&mut self) {
        let seed = self.seed;
        for (x, z, ha, _) in cells(seed, 0x1000, 4.0) {
            if self.hf.biome_at(x, z) != biome::FOREST_FLOOR {
                continue;
            }
            let Some(_) = self.ok_land(x, z, 0.55) else { continue };
            let grove = fbm_rot(seed ^ 0x11, x * 0.045, z * 0.045, 2, 0.5);
            if roll(ha, 1) > 0.55 + 0.42 * ss(0.35, 0.65, grove) {
                continue;
            }
            let r = roll(ha, 2);
            let k = if r < 0.30 {
                kind::OAK
            } else if r < 0.48 {
                kind::TALL
            } else if r < 0.70 {
                kind::PINE
            } else if r < 0.88 {
                kind::BIRCH
            } else {
                kind::MAPLE
            };
            self.push(k, x, z, ha, 0.85 + 0.45 * roll(ha, 3), 0.6 + 0.4 * roll(ha, 4));
        }
        // understory: ferns, mushrooms, bushes, logs, mossy rocks, the odd glowcap tree
        for (x, z, ha, _) in cells(seed, 0x1100, 2.2) {
            if self.hf.biome_at(x, z) != biome::FOREST_FLOOR {
                continue;
            }
            let r = roll(ha, 1);
            if r > 0.33 {
                continue;
            }
            let Some(_) = self.ok_land(x, z, 0.6) else { continue };
            let s = 0.8 + 0.5 * roll(ha, 3);
            let st = 0.4 + 0.6 * roll(ha, 4);
            if r < 0.24 {
                self.push(kind::FERN, x, z, ha, s, st);
            } else if r < 0.29 {
                let m = roll(ha, 5);
                let k = if m < 0.35 { kind::RED_CAP } else if m < 0.5 { kind::GLOWCAP } else { kind::BROWN_CLUSTER };
                self.push(k, x, z, ha, 0.7 + 0.5 * roll(ha, 3), st);
            } else if r < 0.31 {
                self.push(if roll(ha, 5) < 0.3 { kind::BERRY_BUSH } else { kind::ROUND_BUSH }, x, z, ha, s, st);
            } else if r < 0.318 {
                let m = roll(ha, 5);
                self.push(if m < 0.3 { kind::STUMP } else if m < 0.65 { kind::LOG } else { kind::MOSSY_LOG }, x, z, ha, s, 1.0);
            } else if r < 0.3235 {
                self.push(if roll(ha, 5) < 0.7 { kind::MOSSY_ROCK } else { kind::BOULDER }, x, z, ha, 0.7 + 0.8 * roll(ha, 3), 1.0);
            } else if r < 0.3255 {
                self.push(kind::GIANT_GLOWCAP, x, z, ha, 0.9 + 0.5 * roll(ha, 3), 1.0);
            } else if r < 0.3262 {
                self.push(kind::DEAD_TREE, x, z, ha, s, 1.0);
            }
        }
    }

    fn meadow(&mut self) {
        let seed = self.seed;
        // sparse single trees (~0.003 / m^2)
        for (x, z, ha, _) in cells(seed, 0x2000, 18.0) {
            let b = self.hf.biome_at(x, z);
            if b != biome::MEADOW && b != biome::FLOWER_MEADOW && b != biome::HIGHLAND {
                continue;
            }
            let Some((h, _)) = self.ok_land(x, z, 0.35) else { continue };
            if h < 1.5 || roll(ha, 1) > 0.9 {
                continue;
            }
            let r = roll(ha, 2);
            let k = if r < 0.30 {
                kind::OAK
            } else if r < 0.42 {
                kind::TALL
            } else if r < 0.56 {
                kind::BLOSSOM
            } else if r < 0.70 {
                kind::BIRCH
            } else if r < 0.84 {
                kind::APPLE
            } else if r < 0.90 {
                kind::ORANGE
            } else {
                kind::MAPLE
            };
            self.push(k, x, z, ha, 0.9 + 0.4 * roll(ha, 3), 0.7 + 0.3 * roll(ha, 4));
        }
        // bushes (~0.004 / m^2)
        for (x, z, ha, _) in cells(seed, 0x2100, 6.5) {
            let b = self.hf.biome_at(x, z);
            if b != biome::MEADOW && b != biome::FLOWER_MEADOW {
                continue;
            }
            if roll(ha, 1) > 0.22 {
                continue;
            }
            let Some((h, _)) = self.ok_land(x, z, 0.4) else { continue };
            if h < 1.4 {
                continue;
            }
            let r = roll(ha, 2);
            let k = if r < 0.4 {
                kind::ROUND_BUSH
            } else if r < 0.65 {
                kind::BERRY_BUSH
            } else if r < 0.8 {
                kind::HYDRANGEA
            } else {
                kind::SHRUB_FLOWERING
            };
            self.push(k, x, z, ha, 0.8 + 0.5 * roll(ha, 3), 0.5 + 0.5 * roll(ha, 4));
        }
        // flower clumps: Poisson-ish cluster centres, 6-30 flowers each
        let dom = [kind::DAISY, kind::TULIP, kind::LAVENDER, kind::BLUEBELL, kind::POPPY, kind::CLOVER];
        for (cx, cz, ha, _) in cells(seed, 0x2200, 15.0) {
            let b = self.hf.biome_at(cx, cz);
            if b != biome::MEADOW && b != biome::FLOWER_MEADOW {
                continue;
            }
            if fbm_rot(seed ^ 0x21, cx * 0.02, cz * 0.02, 2, 0.5) < 0.36 || roll(ha, 1) > 0.8 {
                continue;
            }
            let n = 6 + (roll(ha, 2) * 25.0) as i32;
            let rad = 1.2 + 0.1 * n as f32;
            let a_kind = dom[(roll(ha, 3) * dom.len() as f32) as usize % dom.len()];
            let b_kind = dom[(roll(ha, 4) * dom.len() as f32) as usize % dom.len()];
            for i in 0..n {
                let hh = hash2(ha, i, 11);
                let a = roll(hh, 1) * math::TAU;
                let rr = rad * roll(hh, 2).sqrt();
                let (sa, ca) = math::sin_cos(a);
                let (x, z) = (cx + ca * rr, cz + sa * rr);
                let bb = self.hf.biome_at(x, z);
                if bb != biome::MEADOW && bb != biome::FLOWER_MEADOW {
                    continue;
                }
                if self.ok_land(x, z, 0.5).is_none() {
                    continue;
                }
                let k = if roll(hh, 3) < 0.8 { a_kind } else { b_kind };
                self.push(k, x, z, hh, 0.75 + 0.5 * roll(hh, 4), 0.3 + 0.7 * roll(hh, 5));
            }
        }
        // flower-meadow: dense mixed flowers
        for (x, z, ha, _) in cells(seed, 0x2300, 1.7) {
            if self.hf.biome_at(x, z) != biome::FLOWER_MEADOW {
                continue;
            }
            let patch = 0.4 + 0.6 * ss(0.30, 0.60, fbm_rot(seed ^ 0x22, x * 0.1, z * 0.1, 2, 0.5));
            if roll(ha, 1) > patch {
                continue;
            }
            let Some(_) = self.ok_land(x, z, 0.5) else { continue };
            let r = roll(ha, 2);
            let k = if r < 0.28 {
                kind::DAISY
            } else if r < 0.45 {
                kind::TULIP
            } else if r < 0.57 {
                kind::LAVENDER
            } else if r < 0.62 {
                kind::SUNFLOWER
            } else if r < 0.77 {
                kind::BLUEBELL
            } else if r < 0.92 {
                kind::POPPY
            } else {
                kind::CLOVER
            };
            self.push(k, x, z, ha, 0.7 + 0.6 * roll(ha, 3), 0.3 + 0.7 * roll(ha, 4));
        }
    }

    fn beach(&mut self) {
        let seed = self.seed;
        for (x, z, ha, _) in cells(seed, 0x3000, 26.0) {
            let Some((h, b)) = self.ok_land(x, z, 0.3) else { continue };
            if b == biome::SAND && h > 0.9 {
                self.push(kind::PALM, x, z, ha, 0.9 + 0.4 * roll(ha, 3), 0.7 + 0.3 * roll(ha, 4));
            }
        }
        for (x, z, ha, _) in cells(seed, 0x3100, 11.0) {
            let Some((h, b)) = self.ok_land(x, z, 0.35) else { continue };
            if b == biome::SAND && h < 1.0 && roll(ha, 1) < 0.75 {
                self.push(kind::SHELL, x, z, ha, 0.8 + 0.5 * roll(ha, 3), 1.0);
            }
        }
        for (x, z, ha, _) in cells(seed, 0x3200, 22.0) {
            let Some((h, b)) = self.ok_land(x, z, 0.35) else { continue };
            if b == biome::SAND && h < 0.6 && roll(ha, 1) < 0.8 {
                self.push(kind::STARFISH, x, z, ha, 0.8 + 0.4 * roll(ha, 3), 1.0);
            }
        }
        for (x, z, ha, _) in cells(seed, 0x3300, 26.0) {
            let Some((h, b)) = self.ok_land(x, z, 0.35) else { continue };
            if b == biome::SAND && h < 0.8 && roll(ha, 1) < 0.65 {
                self.push(kind::DRIFTWOOD, x, z, ha, 0.8 + 0.6 * roll(ha, 3), 1.0);
            }
        }
        for (x, z, ha, _) in cells(seed, 0x3400, 3.2) {
            let Some((h, b)) = self.ok_land(x, z, 0.4) else { continue };
            if b == biome::SAND && h > 0.9 && roll(ha, 1) < 0.2 {
                self.push(kind::BEACH_GRASS, x, z, ha, 0.8 + 0.5 * roll(ha, 3), 0.5 + 0.5 * roll(ha, 4));
            }
        }
    }

    fn pond(&mut self) {
        let seed = self.seed;
        let p = self.f.pond.clone();
        let (sr, cr) = math::sin_cos(p.rot);
        let at = |e: f32, th: f32| -> (f32, f32) {
            let (st, ct) = math::sin_cos(th);
            let (lx, lz) = (ct * p.rx * e, st * p.rz * e);
            (p.x + lx * cr - lz * sr, p.z + lx * sr + lz * cr)
        };
        // reeds + cattails around the bank, in clumps
        for k in 0..110 {
            let ha = hash2(seed ^ 0x4000, k, 1);
            if roll(ha, 1) > 0.5 {
                continue;
            }
            let th = (k as f32 + roll(ha, 2)) * (math::TAU / 110.0);
            let e = 0.98 + 0.3 * roll(ha, 3);
            let (cx, cz) = at(e, th);
            if self.kept(cx, cz) {
                continue;
            }
            for i in 0..(2 + (roll(ha, 4) * 3.0) as i32) {
                let hh = hash2(ha, i, 12);
                let (x, z) = (cx + (roll(hh, 1) - 0.5) * 1.2, cz + (roll(hh, 2) - 0.5) * 1.2);
                let b = self.hf.biome_at(x, z);
                if b != biome::POND_BANK || self.hf.sample(x, z) < self.f.pond.level - 0.9 {
                    continue;
                }
                self.push(if roll(hh, 3) < 0.6 { kind::REEDS } else { kind::CATTAIL }, x, z, hh, 0.8 + 0.6 * roll(hh, 4), 0.6 + 0.4 * roll(hh, 5));
            }
        }
        // lily pads on the water
        for (x, z, ha, _) in cells(seed, 0x4100, 2.0) {
            if (x - p.x).abs() > p.rx * 1.1 || (z - p.z).abs() > p.rx * 1.1 {
                continue;
            }
            let e = p.e(x, z);
            if e > 0.86 || roll(ha, 1) > 0.3 || fbm_rot(seed ^ 0x41, x * 0.2, z * 0.2, 2, 0.5) < 0.45 {
                continue;
            }
            self.push_at(kind::LILY_PAD, x, p.level, z, ha, 0.8 + 0.5 * roll(ha, 3), 1.0);
        }
        // willows around the bank
        let n = 5;
        let th0 = roll(hash2(seed, 0x4200, 1), 1) * math::TAU;
        for i in 0..n {
            let ha = hash2(seed ^ 0x4200, i, 2);
            let th = th0 + (i as f32 + 0.3 * roll(ha, 1)) * (math::TAU / n as f32);
            let (x, z) = at(1.55 + 0.35 * roll(ha, 2), th);
            if self.ok_land(x, z, 0.3).is_some() {
                self.push(kind::WILLOW, x, z, ha, 1.0 + 0.3 * roll(ha, 3), 0.8 + 0.2 * roll(ha, 4));
            }
        }
        // stream banks: ferns and reeds
        let streams = self.f.streams.clone();
        for (si, st) in streams.iter().enumerate() {
            let mut acc = 0.0;
            for w in st.pts.windows(2) {
                let seg = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
                acc += seg;
                if acc < 3.5 {
                    continue;
                }
                acc = 0.0;
                let ha = hash2(seed ^ 0x4300, si as i32, (w[0][0] * 7.0) as i32);
                if roll(ha, 1) > 0.65 {
                    continue;
                }
                let side = if roll(ha, 2) < 0.5 { 1.0 } else { -1.0 };
                let (dx, dz) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
                let l = (dx * dx + dz * dz).sqrt().max(1e-3);
                let off = w[0][2] + 0.5 + 1.8 * roll(ha, 3);
                let (x, z) = (w[0][0] - dz / l * off * side, w[0][1] + dx / l * off * side);
                let b = self.hf.biome_at(x, z);
                if b == biome::POND_BANK && self.hf.sample(x, z) > -0.3 {
                    self.push(if roll(ha, 4) < 0.55 { kind::REEDS } else { kind::CATTAIL }, x, z, ha, 0.8 + 0.5 * roll(ha, 5), 0.8);
                } else if self.ok_land(x, z, 0.4).is_some() {
                    self.push(kind::FERN, x, z, ha, 0.9 + 0.5 * roll(ha, 5), 0.8);
                }
            }
        }
    }

    fn highland_and_rocks(&mut self) {
        let seed = self.seed;
        for (x, z, ha, _) in cells(seed, 0x5000, 5.0) {
            if self.hf.biome_at(x, z) != biome::HIGHLAND {
                continue;
            }
            let r = roll(ha, 1);
            if r > 0.45 {
                continue;
            }
            let Some(_) = self.ok_land(x, z, 0.5) else { continue };
            let s = 0.8 + 0.6 * roll(ha, 3);
            if r < 0.06 {
                self.push(kind::BOULDER, x, z, ha, s * 1.1, 1.0);
            } else if r < 0.11 {
                self.push(kind::MOSSY_ROCK, x, z, ha, s, 1.0);
            } else if r < 0.27 {
                self.push(kind::PINE, x, z, ha, 0.9 + 0.5 * roll(ha, 3), 0.7 + 0.3 * roll(ha, 4));
            } else if r < 0.36 {
                self.push(kind::SHRUB_FLOWERING, x, z, ha, s, 0.6);
            } else if r < 0.3615 {
                self.push(kind::CRYSTAL, x, z, ha, 0.9 + 0.5 * roll(ha, 3), 1.0);
            } else {
                self.push(kind::FLAT_ROCK, x, z, ha, s, 1.0);
            }
        }
        // rock outcrops: 3-6 boulders around a centre
        for (cx, cz, ha, _) in cells(seed, 0x5100, 45.0) {
            let b = self.hf.biome_at(cx, cz);
            if !(b == biome::MEADOW || b == biome::HIGHLAND || b == biome::FOREST_FLOOR) || roll(ha, 1) > 0.4 {
                continue;
            }
            let n = 3 + (roll(ha, 2) * 4.0) as i32;
            for i in 0..n {
                let hh = hash2(ha, i, 13);
                let a = roll(hh, 1) * math::TAU;
                let rr = 3.0 * roll(hh, 2).sqrt();
                let (sa, ca) = math::sin_cos(a);
                let (x, z) = (cx + ca * rr, cz + sa * rr);
                if self.ok_land(x, z, 0.5).is_none() {
                    continue;
                }
                let r = roll(hh, 3);
                let k = if r < 0.4 { kind::BOULDER } else if r < 0.7 { kind::MOSSY_ROCK } else if r < 0.9 { kind::FLAT_ROCK } else { kind::PEBBLES };
                self.push(k, x, z, hh, (1.5 - 0.15 * i as f32).max(0.6) * (0.8 + 0.4 * roll(hh, 4)), 1.0);
            }
        }
        // boulders at the foot of cliffs
        for (x, z, ha, _) in cells(seed, 0x5200, 4.0) {
            if roll(ha, 1) > 0.28 {
                continue;
            }
            let Some(_) = self.ok_land(x, z, 0.3) else { continue };
            let near_cliff = [(2.5, 0.0), (-2.5, 0.0), (0.0, 2.5), (0.0, -2.5)].iter().any(|(dx, dz)| self.hf.biome_at(x + dx, z + dz) == biome::CLIFF_ROCK);
            if near_cliff {
                let r = roll(ha, 2);
                let k = if r < 0.45 { kind::BOULDER } else if r < 0.8 { kind::MOSSY_ROCK } else { kind::FLAT_ROCK };
                self.push(k, x, z, ha, 0.9 + 0.9 * roll(ha, 3), 1.0);
            }
        }
        // sea stacks on rocky shores
        for (x, z, ha, _) in cells(seed, 0x5300, 14.0) {
            let (h, g, b) = self.ground(x, z);
            if h < 0.05 || h > 1.4 || g > 0.65 || !(b == biome::SAND || b == biome::CLIFF_ROCK) || self.kept(x, z) {
                continue;
            }
            let rocky = [(4.0, 0.0), (-4.0, 0.0), (0.0, 4.0), (0.0, -4.0)].iter().any(|(dx, dz)| self.hf.biome_at(x + dx, z + dz) == biome::CLIFF_ROCK);
            let wet = [(5.0, 0.0), (-5.0, 0.0), (0.0, 5.0), (0.0, -5.0)].iter().any(|(dx, dz)| self.hf.sample(x + dx, z + dz) < -0.3);
            if rocky && wet && roll(ha, 1) < 0.55 {
                self.push(kind::SEA_STACK, x, z, ha, 1.0 + 1.2 * roll(ha, 3), 1.0);
            }
        }
    }
}

/// Deterministic flora scatter for a generated world.
pub fn scatter(g: &Generated, seed: u32) -> Vec<f32> {
    let mut p = Placer::new(&g.field, &g.features, seed);
    p.forest();
    p.meadow();
    p.beach();
    p.pond();
    p.highland_and_rocks();
    p.out
}
