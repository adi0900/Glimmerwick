//! Seeded island generator (deterministic, IEEE-only maths + `sim_core::math` for libm calls).
//!
//! Pipeline (all metres, +X east, -Z north, sea level 0):
//! 1. **Coarse lattice (2 m)** - everything smooth and expensive: shoreline signed distance `s` (smooth union of
//!    four land blobs minus two coves plus shoreline noise, plus three islets), beach/shelf/cliff coast profile,
//!    rolling hills, the highland mask `U` + terrace-presence `tau`, forest/flower masks, village + pond flattening.
//! 2. **Fine grid (0.5 m)** - cubic B-spline upsample of those fields, then everything crisp: three terrace tiers
//!    with *rounded lips* (smoothstep stairs of the tier coordinate `3U`, ragged by fine noise), small bumps, pond
//!    bowl, stream channels (nearest-segment carve), village disc / path stamping, biome classification.
//! 3. Spawn, habitats, stream + pond metadata for the web water meshes.

use crate::biome;
use crate::heightfield::{CELL, CELLS, HALF, Heightfield, SIZE};
use crate::noise::{fbm_rot, sn, value_noise};
use sim_core::math;
use sim_core::rng::{hash2, hash_unit};

/// Coarse lattice spacing (m).
const CG: f32 = 2.0;
const RATIO: usize = (CG / CELL) as usize;
const CN: usize = CELLS / RATIO + 1;
const NCH: usize = 7;
const C_H: usize = 0;
const C_S: usize = 1;
const C_U: usize = 2;
const C_TAU: usize = 3;
const C_SC: usize = 4;
const C_FOREST: usize = 5;
const C_FLOWER: usize = 6;

/// Beach width (m inland of the shoreline) and crest height (m).
const WB: f32 = 15.0;
const CREST: f32 = 1.35;
/// Terrace tier heights (m) of the highland.
const TIER: [f32; 3] = [3.9, 4.3, 4.7];
const TIER_SUM: f32 = 12.9;

/// Per-cell flags gathered while carving (read by the biome classifier).
pub const A_POND_WATER: u8 = 1;
pub const A_POND_BANK: u8 = 2;
pub const A_STREAM_WATER: u8 = 4;
pub const A_STREAM_BANK: u8 = 8;
pub const A_VILLAGE: u8 = 16;
pub const A_PATH: u8 = 32;

#[derive(Clone, Debug)]
pub struct Pond {
    pub x: f32,
    pub z: f32,
    pub rx: f32,
    pub rz: f32,
    pub rot: f32,
    /// Water surface height (m).
    pub level: f32,
    /// Flattened ground height around the pond.
    pub plane: f32,
    c: f32,
    s: f32,
}

impl Pond {
    /// Elliptic radius (1 = nominal shoreline).
    pub fn e(&self, x: f32, z: f32) -> f32 {
        let dx = x - self.x;
        let dz = z - self.z;
        let u = (dx * self.c + dz * self.s) / self.rx;
        let v = (-dx * self.s + dz * self.c) / self.rz;
        (u * u + v * v).sqrt()
    }
}

/// A stream polyline: `[x, z, half_width, water_level]` per point, flowing from index 0 to the end.
#[derive(Clone, Debug, Default)]
pub struct Stream {
    pub pts: Vec<[f32; 4]>,
}

/// Everything besides the raw grids that the web, flora and creatures need to know.
#[derive(Clone, Debug)]
pub struct Features {
    pub spawn: [f32; 2],
    pub village: [f32; 2],
    pub village_r: f32,
    pub village_h: f32,
    pub pond: Pond,
    pub streams: Vec<Stream>,
    pub paths: Vec<Vec<[f32; 2]>>,
    /// `[x, z, radius]` of the offshore islets.
    pub islets: Vec<[f32; 3]>,
    /// `[x, z, radius]` of the terraced highland.
    pub highland: [f32; 3],
    pub habitats: Vec<(u8, Vec<[f32; 3]>)>,
}

pub struct Generated {
    pub field: Heightfield,
    pub features: Features,
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
fn smax(a: f32, b: f32, k: f32) -> f32 {
    let h = (k - (a - b).abs()).max(0.0);
    a.max(b) + h * h * 0.25 / k
}

#[inline]
fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = (k - (a - b).abs()).max(0.0);
    a.min(b) - h * h * 0.25 / k
}

fn norm2(dx: f32, dz: f32) -> [f32; 2] {
    let l = (dx * dx + dz * dz).sqrt().max(1e-4);
    [dx / l, dz / l]
}

#[derive(Clone, Copy)]
struct Blob {
    cx: f32,
    cz: f32,
    rx: f32,
    rz: f32,
    c: f32,
    s: f32,
}

impl Blob {
    fn new(cx: f32, cz: f32, rx: f32, rz: f32, rot: f32) -> Self {
        let (s, c) = math::sin_cos(rot);
        Blob { cx, cz, rx, rz, c, s }
    }
    fn rmin(&self) -> f32 {
        self.rx.min(self.rz)
    }
    /// Approximate signed distance to the boundary (m, positive inside).
    fn field(&self, x: f32, z: f32) -> f32 {
        let dx = x - self.cx;
        let dz = z - self.cz;
        let u = (dx * self.c + dz * self.s) / self.rx;
        let v = (-dx * self.s + dz * self.c) / self.rz;
        (1.0 - (u * u + v * v).sqrt()) * self.rmin()
    }
}

struct Islet {
    blob: Blob,
    height: f32,
    cliff: f32,
}

struct Highland {
    cx: f32,
    cz: f32,
    rx: f32,
    rz: f32,
    c: f32,
    s: f32,
    fx: f32,
    fz: f32,
}

impl Highland {
    /// `(U, tau)`: `U` 0..1 smooth highland mask; `tau` how much of it is terraced (vs. a walkable ramp).
    fn mask(&self, seed: u32, x: f32, z: f32) -> (f32, f32) {
        let dx = x - self.cx;
        let dz = z - self.cz;
        let u = (dx * self.c + dz * self.s) / self.rx;
        let v = (-dx * self.s + dz * self.c) / self.rz;
        let d = (u * u + v * v).sqrt();
        if d > 1.5 {
            return (0.0, 1.0);
        }
        let d = d + 0.2 * sn(seed ^ 0x201, x * 0.011, z * 0.011, 4);
        let uu = ss(1.0, 0.22, d);
        let len = (dx * dx + dz * dz).sqrt().max(1e-3);
        let cosang = (dx * self.fx + dz * self.fz) / len + 0.25 * sn(seed ^ 0x202, x * 0.02, z * 0.02, 2);
        (uu, ss(-0.55, 0.15, cosang))
    }
}

fn beach_profile(s: f32) -> f32 {
    if s >= 0.0 {
        let t = (s / WB).min(1.0);
        CREST * t * (2.0 - t)
    } else {
        let d = -s;
        -(0.052 * d + 1.5 * (1.0 - math::exp(-d / 11.0)) + 10.5 * ss(48.0, 150.0, d))
    }
}

fn cliff_profile(s: f32) -> f32 {
    if s >= 0.0 {
        let t = (s / 4.0).min(1.0);
        1.9 * t * (2.0 - t)
    } else {
        let d = -s;
        -(1.6 * (1.0 - math::exp(-d / 3.5)) + 0.35 * d + 9.0 * ss(10.0, 90.0, d))
    }
}

// ------------------------------------------------------------------------------------------------- layout

struct Layout {
    seed: u32,
    body: [Blob; 4],
    coves: [[f32; 3]; 2],
    islets: [Islet; 3],
    hl: Highland,
    village: [f32; 2],
    village_r: f32,
    village_h: f32,
    pond: Pond,
}

impl Layout {
    fn new(seed: u32) -> Self {
        let j = |salt: i32, amp: f32| (hash_unit(hash2(seed ^ 0x5EED, salt, 17)) - 0.5) * 2.0 * amp;
        let body = [
            Blob::new(j(1, 6.0), 4.0 + j(2, 6.0), 118.0 + j(3, 5.0), 100.0 + j(4, 5.0), 0.3 + j(5, 0.15)),
            Blob::new(112.0 + j(6, 6.0), -16.0 + j(7, 6.0), 56.0 + j(8, 4.0), 41.0 + j(9, 4.0), -0.35 + j(10, 0.15)),
            Blob::new(-66.0 + j(11, 6.0), -54.0 + j(12, 6.0), 68.0 + j(13, 4.0), 60.0 + j(14, 4.0), 0.5 + j(15, 0.2)),
            Blob::new(12.0 + j(16, 6.0), 84.0 + j(17, 6.0), 70.0 + j(18, 4.0), 40.0 + j(19, 4.0), 0.12 + j(20, 0.12)),
        ];
        let coves = [[-48.0 + j(21, 5.0), 92.0 + j(22, 4.0), 32.0 + j(23, 2.0)], [90.0 + j(24, 5.0), 74.0 + j(25, 4.0), 27.0 + j(26, 2.0)]];
        let islets = [
            Islet { blob: Blob::new(212.0 + j(30, 6.0), -66.0 + j(31, 6.0), 27.0, 22.0, 0.4), height: 4.2, cliff: 0.15 },
            Islet { blob: Blob::new(-150.0 + j(32, 6.0), 166.0 + j(33, 6.0), 20.0, 17.0, -0.3), height: 2.8, cliff: 0.05 },
            Islet { blob: Blob::new(28.0 + j(34, 6.0), -200.0 + j(35, 6.0), 24.0, 21.0, 0.2), height: 9.0, cliff: 0.8 },
        ];
        let (s, c) = math::sin_cos(0.4);
        let hl = Highland { cx: -66.0 + j(36, 5.0), cz: -56.0 + j(37, 5.0), rx: 80.0, rz: 70.0, c, s, fx: -0.92, fz: 0.38 };
        let (ps, pc) = math::sin_cos(0.5);
        let pond = Pond { x: 6.0 + j(40, 4.0), z: 24.0 + j(41, 4.0), rx: 20.0, rz: 14.0, rot: 0.5, level: 2.0, plane: 2.6, c: pc, s: ps };
        Layout { seed, body, coves, islets, hl, village: [56.0 + j(42, 4.0), -4.0 + j(43, 4.0)], village_r: 21.0, village_h: 4.0, pond }
    }

    /// Pass A: the smooth terrain without village / pond flattening.
    fn eval_a(&self, x: f32, z: f32) -> [f32; NCH] {
        let seed = self.seed;
        let mut s = -1000.0f32;
        for b in &self.body {
            s = smax(s, b.field(x, z), 20.0);
        }
        for cv in &self.coves {
            let dx = x - cv[0];
            let dz = z - cv[1];
            s = smin(s, (dx * dx + dz * dz).sqrt() - cv[2], 10.0);
        }
        s += 8.5 * sn(seed ^ 0x101, x * 0.0125, z * 0.0125, 3) + 2.4 * sn(seed ^ 0x102, x * 0.043, z * 0.043, 2);
        let mut isl_h = 0.0f32;
        let mut isl_sc = 0.0f32;
        for (k, il) in self.islets.iter().enumerate() {
            let f = il.blob.field(x, z);
            if f < -70.0 {
                continue;
            }
            let f = f + 3.2 * sn(seed ^ (0x110 + k as u32), x * 0.05, z * 0.05, 2);
            s = smax(s, f, 6.0);
            isl_h = isl_h.max(il.height * ss(2.0, il.blob.rmin() * 0.8, f));
            isl_sc = isl_sc.max(il.cliff * ss(-6.0, 6.0, f));
        }
        let (u, tau) = self.hl.mask(seed, x, z);
        let sc = (ss(0.03, 0.25, u) * (0.35 + 0.65 * tau)).max(isl_sc);
        let coast = lerp(beach_profile(s), cliff_profile(s), sc);
        let inland = ss(WB * 0.7, WB + 75.0, s);
        let inland_k = ss(10.0, 55.0, s);
        let hill_n = fbm_rot(seed ^ 0x105, x * 0.0105, z * 0.0105, 4, 0.5);
        let hills = 0.6 + 5.0 * ss(0.30, 0.78, hill_n);
        let mid = 1.4 * sn(seed ^ 0x106, x * 0.038, z * 0.038, 3);
        let mut h = coast + inland * 1.4 + inland_k * (hills * (1.0 - 0.55 * u) + mid);
        if s > WB {
            h = h.max(1.25);
        }
        h += isl_h * ss(-1.0, 5.0, s);
        if s < 0.0 {
            let edge = x.abs().max(z.abs());
            h = h.min(lerp(h, -14.0, ss(235.0, 285.0, edge)));
        }
        [h, s, u, tau, sc, 0.0, 0.0]
    }

    /// Fixes `village_h` and the pond planes from pass-A heights.
    fn finish_planes(&mut self, coarse: &Coarse) {
        let (vx, vz) = (self.village[0], self.village[1]);
        let mut sum = 0.0;
        let mut n = 0.0;
        for iz in -2..=2 {
            for ix in -2..=2 {
                let (dx, dz) = (ix as f32 * self.village_r * 0.4, iz as f32 * self.village_r * 0.4);
                if dx * dx + dz * dz <= self.village_r * self.village_r {
                    sum += coarse.bilinear(C_H, vx + dx, vz + dz);
                    n += 1.0;
                }
            }
        }
        self.village_h = (sum / n).clamp(2.8, 6.2);
        let p = &self.pond;
        let mut sum = 0.0;
        for k in 0..16 {
            let a = k as f32 * (math::TAU / 16.0);
            let (sa, ca) = math::sin_cos(a);
            let (lx, lz) = (ca * p.rx * 1.7, sa * p.rz * 1.7);
            let (x, z) = (p.x + lx * p.c - lz * p.s, p.z + lx * p.s + lz * p.c);
            sum += coarse.bilinear(C_H, x, z);
        }
        let plane = (sum / 16.0).max(1.6);
        self.pond.plane = plane;
        self.pond.level = (plane - 0.55).max(1.0);
    }

    /// Pass B: village + pond flattening and the biome masks (needs `village_h` / pond planes).
    fn apply_b(&self, node: &mut [f32; NCH], x: f32, z: f32) {
        let seed = self.seed;
        let (s, u) = (node[C_S], node[C_U]);
        let dv = ((x - self.village[0]).powi(2) + (z - self.village[1]).powi(2)).sqrt() + 2.2 * sn(seed ^ 0x131, x * 0.03, z * 0.03, 2);
        let mv = 1.0 - ss(self.village_r, self.village_r + 16.0, dv);
        let e = self.pond.e(x, z);
        let fl = 1.0 - ss(1.3, 2.7, e);
        let mut h = node[C_H];
        h = lerp(h, self.village_h, mv);
        h = lerp(h, self.pond.plane, 0.88 * fl);
        node[C_H] = h;
        let away_v = ss(self.village_r + 8.0, self.village_r + 30.0, dv);
        let forest_n = fbm_rot(seed ^ 0x141, x * 0.017, z * 0.017, 4, 0.5);
        let forest = ss(0.40, 0.49, forest_n) * ss(10.0, 26.0, s) * (1.0 - ss(0.12, 0.35, u)) * away_v * ss(1.5, 2.6, e);
        let flower_n = fbm_rot(seed ^ 0x142, x * 0.03, z * 0.03, 3, 0.5);
        let flower = ss(0.59, 0.69, flower_n) * (1.0 - forest) * ss(8.0, 24.0, s) * (1.0 - ss(0.2, 0.5, u)) * ss(1.2, 2.2, e);
        node[C_FOREST] = forest;
        node[C_FLOWER] = flower;
    }

    /// Fine-resolution height and carve flags at `(x, z)` from the upsampled coarse fields `v`.
    fn fine_height(&self, x: f32, z: f32, v: &[f32; NCH], sidx: &StreamIndex) -> (f32, u8) {
        let seed = self.seed;
        let (hl, s, u, tau, sc) = (v[C_H], v[C_S], v[C_U], v[C_TAU], v[C_SC]);
        let mut flags = 0u8;
        let mut h = hl;
        if u > 0.004 {
            let n1 = value_noise(seed ^ 0x301, x * 0.16, z * 0.16);
            let n2 = value_noise(seed ^ 0x302, x * 0.045, z * 0.045);
            let uu = (u * 3.0 + (n1 - 0.5) * 0.16).clamp(0.0, 3.0);
            let w = 0.04 + 0.065 * n2;
            let stair = TIER[0] * ss(0.5 - w, 0.5 + w, uu) + TIER[1] * ss(1.5 - w, 1.5 + w, uu) + TIER[2] * ss(2.5 - w, 2.5 + w, uu);
            let ramp = TIER_SUM * ss(0.0, 1.0, u);
            let up = tau * stair + (1.0 - tau) * ramp + 2.0 * u;
            h += up * ss(-0.5, 3.5, s);
        }
        let dvx = x - self.village[0];
        let dvz = z - self.village[1];
        let dv2 = dvx * dvx + dvz * dvz;
        let vr_out = self.village_r + 16.0;
        let mv = if dv2 < vr_out * vr_out { 1.0 - ss(self.village_r, vr_out, dv2.sqrt()) } else { 0.0 };
        let det_mask = ss(3.0, 14.0, s) * (1.0 - 0.7 * sc) * (1.0 - 0.85 * mv);
        if det_mask > 0.001 {
            let d1 = fbm_rot(seed ^ 0x303, x * 0.2, z * 0.2, 2, 0.5);
            h += (d1 - 0.5) * 0.8 * det_mask;
        }
        if dv2 < self.village_r * self.village_r * 1.4 {
            let wob = (value_noise(seed ^ 0x305, x * 0.12, z * 0.12) - 0.5) * 4.0;
            if dv2.sqrt() + wob < self.village_r - 1.0 {
                flags |= A_VILLAGE;
            }
        }
        let p = &self.pond;
        if (x - p.x).abs() < p.rx * 2.8 && (z - p.z).abs() < p.rx * 2.8 {
            let e0 = p.e(x, z);
            if e0 < 2.6 {
                let e = e0 + 0.09 * sn(seed ^ 0x304, x * 0.08, z * 0.08, 2);
                let tgt = if e < 1.0 { p.level - 1.2 * (1.0 - e * e) } else { p.level + (e - 1.0) * p.rx * 0.13 };
                h = smin(h, tgt, 0.6);
                if e < 1.0 && h < p.level + 0.02 {
                    flags |= A_POND_WATER;
                } else if e < 1.42 {
                    flags |= A_POND_BANK;
                }
            }
        }
        if let Some((d, bed, level, hw)) = sidx.nearest(x, z) {
            let r = (d / hw).min(1.0);
            let tgt = if d <= hw { bed + (level + 0.2 - bed) * r * r } else { level + 0.2 + (d - hw) * 0.45 };
            h = smin(h, tgt, 0.5);
            if d < hw && h < level + 0.05 {
                flags |= A_STREAM_WATER;
            } else if d < hw + 1.8 {
                flags |= A_STREAM_BANK;
            }
        }
        (h.max(-14.0), flags)
    }

    fn pond_edge(&self, dir: [f32; 2]) -> [f32; 2] {
        let p = &self.pond;
        let mut r = 2.0;
        while r < 80.0 {
            let (x, z) = (p.x + dir[0] * r, p.z + dir[1] * r);
            if p.e(x, z) >= 1.0 {
                return [x, z];
            }
            r += 0.5;
        }
        [p.x + dir[0] * 20.0, p.z + dir[1] * 20.0]
    }

    /// Streams: highland-foot spring -> pond, and pond -> the SW cove (monotone bed, follows low terrain).
    fn build_streams(&self, coarse: &Coarse) -> Vec<Stream> {
        let p = &self.pond;
        let hat = |x: f32, z: f32| coarse.bilinear(C_H, x, z);
        let lat = |salt: i32, amp: f32| (hash_unit(hash2(self.seed ^ 0x4A, salt, 5)) - 0.5) * 2.0 * amp;

        // ---- inflow
        let to_hl = norm2(self.hl.cx - p.x, self.hl.cz - p.z);
        let mut spring = [p.x + to_hl[0] * 60.0, p.z + to_hl[1] * 60.0];
        let mut d = 28.0;
        while d < 170.0 {
            let (x, z) = (p.x + to_hl[0] * d, p.z + to_hl[1] * d);
            spring = [x, z];
            if coarse.bilinear(C_U, x, z) > 0.42 {
                break;
            }
            d += 3.0;
        }
        let edge_in = self.pond_edge(to_hl);
        let perp = [-to_hl[1], to_hl[0]];
        let c1 = [lerp(spring[0], edge_in[0], 0.35) + perp[0] * lat(1, 7.0), lerp(spring[1], edge_in[1], 0.35) + perp[1] * lat(1, 7.0)];
        let c2 = [lerp(spring[0], edge_in[0], 0.7) + perp[0] * lat(2, 6.0), lerp(spring[1], edge_in[1], 0.7) + perp[1] * lat(2, 6.0)];
        let line = catmull(&[spring, c1, c2, edge_in], 2.0);
        let n = line.len();
        let top = (hat(spring[0], spring[1]) - 0.5).max(p.level + 0.8);
        let mut inflow = Stream::default();
        let mut prev = f32::MAX;
        for (i, q) in line.iter().enumerate() {
            let tt = i as f32 / (n - 1) as f32;
            let prof = lerp(top, p.level - 0.45, tt);
            let bed = prof.min(hat(q[0], q[1]) - 0.35).min(prev);
            prev = bed;
            inflow.pts.push([q[0], q[1], 1.1 + 0.5 * tt, (bed + 0.55).max(p.level)]);
        }

        // ---- outflow towards the SW cove
        let cv = self.coves[0];
        let dir = norm2(cv[0] - p.x, cv[1] - p.z);
        let mut mouth = [cv[0], cv[1]];
        let mut d = 20.0;
        while d < 260.0 {
            let (x, z) = (p.x + dir[0] * d, p.z + dir[1] * d);
            mouth = [x, z];
            if coarse.bilinear(C_S, x, z) < 1.0 {
                break;
            }
            d += 2.0;
        }
        let end = [mouth[0] + dir[0] * 5.0, mouth[1] + dir[1] * 5.0];
        let edge_out = self.pond_edge(dir);
        let perp = [-dir[1], dir[0]];
        let mut ctrl = vec![edge_out];
        for (k, f) in [0.25f32, 0.5, 0.75].iter().enumerate() {
            let a = lat(10 + k as i32, 8.0);
            ctrl.push([lerp(edge_out[0], end[0], *f) + perp[0] * a, lerp(edge_out[1], end[1], *f) + perp[1] * a]);
        }
        ctrl.push(end);
        let line = catmull(&ctrl, 2.0);
        let n = line.len();
        let mut outflow = Stream::default();
        let mut prev = f32::MAX;
        for (i, q) in line.iter().enumerate() {
            let tt = i as f32 / (n - 1) as f32;
            let prof = lerp(p.level - 0.45, -0.6, tt.powf_safe(1.1));
            let bed = prof.min(hat(q[0], q[1]) - 0.35).min(prev);
            prev = bed;
            outflow.pts.push([q[0], q[1], 1.5 + 1.4 * tt, (bed + 0.55).max(0.0)]);
        }
        vec![inflow, outflow]
    }

    /// Dirt paths radiating from the village (polylines, 1 m spacing).
    fn build_paths(&self, coarse: &Coarse) -> Vec<Vec<[f32; 2]>> {
        let v = self.village;
        let lat = |salt: i32, amp: f32| (hash_unit(hash2(self.seed ^ 0x4B, salt, 9)) - 0.5) * 2.0 * amp;
        let march = |dir: [f32; 2], stop_s: f32| -> [f32; 2] {
            let mut r = 14.0;
            let mut last = [v[0] + dir[0] * r, v[1] + dir[1] * r];
            while r < 200.0 {
                let (x, z) = (v[0] + dir[0] * r, v[1] + dir[1] * r);
                if coarse.bilinear(C_S, x, z) < stop_s {
                    break;
                }
                last = [x, z];
                r += 2.0;
            }
            last
        };
        let mk = |salt: i32, end: [f32; 2]| -> Vec<[f32; 2]> {
            let d = norm2(end[0] - v[0], end[1] - v[1]);
            let perp = [-d[1], d[0]];
            let a = lat(salt, 9.0);
            let b = lat(salt + 50, 9.0);
            catmull(
                &[v, [lerp(v[0], end[0], 0.33) + perp[0] * a, lerp(v[1], end[1], 0.33) + perp[1] * a], [lerp(v[0], end[0], 0.66) + perp[0] * b, lerp(v[1], end[1], 0.66) + perp[1] * b], end],
                1.0,
            )
        };
        let p = &self.pond;
        let pe = self.pond_edge(norm2(v[0] - p.x, v[1] - p.z));
        let pdir = norm2(v[0] - p.x, v[1] - p.z);
        let pond_end = [pe[0] + pdir[0] * 1.6, pe[1] + pdir[1] * 1.6];
        let east = march(norm2(1.0, 0.04), 13.0);
        let cove2 = march(norm2(self.coves[1][0] - v[0], self.coves[1][1] - v[1]), 13.0);
        let north = march(norm2(0.15, -1.0), 13.0);
        let ramp = norm2(-self.hl.fx, -self.hl.fz);
        let top = [self.hl.cx + ramp[0] * 34.0, self.hl.cz + ramp[1] * 34.0];
        vec![mk(1, pond_end), mk(2, east), mk(3, cove2), mk(4, north), mk(5, top)]
    }
}

trait PowfSafe {
    fn powf_safe(self, e: f32) -> f32;
}
impl PowfSafe for f32 {
    fn powf_safe(self, e: f32) -> f32 {
        if self <= 0.0 { 0.0 } else { math::powf(self, e) }
    }
}

fn catmull(ctrl: &[[f32; 2]], step: f32) -> Vec<[f32; 2]> {
    let n = ctrl.len();
    let get = |i: i32| ctrl[i.clamp(0, n as i32 - 1) as usize];
    let mut out = vec![ctrl[0]];
    for i in 0..n - 1 {
        let (p0, p1, p2, p3) = (get(i as i32 - 1), get(i as i32), get(i as i32 + 1), get(i as i32 + 2));
        let len = ((p2[0] - p1[0]).powi(2) + (p2[1] - p1[1]).powi(2)).sqrt();
        let k = ((len / step).ceil() as usize).max(1);
        for j in 1..=k {
            let t = j as f32 / k as f32;
            let (t2, t3) = (t * t, t * t * t);
            let mut q = [0.0f32; 2];
            for a in 0..2 {
                q[a] = 0.5 * (2.0 * p1[a] + (-p0[a] + p2[a]) * t + (2.0 * p0[a] - 5.0 * p1[a] + 4.0 * p2[a] - p3[a]) * t2 + (-p0[a] + 3.0 * p1[a] - 3.0 * p2[a] + p3[a]) * t3);
            }
            out.push(q);
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------- stream index

struct Seg {
    a: [f32; 2],
    b: [f32; 2],
    lvl: [f32; 2],
    hw: [f32; 2],
}

const SG: f32 = 16.0;
const SGN: usize = (2.0 * HALF / SG) as usize;
/// Carve depth of the stream bed below the water surface.
const STREAM_DEPTH: f32 = 0.55;

struct StreamIndex {
    segs: Vec<Seg>,
    grid: Vec<Vec<u32>>,
}

impl StreamIndex {
    fn new(streams: &[Stream]) -> Self {
        let mut segs = Vec::new();
        for st in streams {
            for w in st.pts.windows(2) {
                segs.push(Seg { a: [w[0][0], w[0][1]], b: [w[1][0], w[1][1]], lvl: [w[0][3], w[1][3]], hw: [w[0][2], w[1][2]] });
            }
        }
        let mut grid = vec![Vec::new(); SGN * SGN];
        let reach = 30.0;
        for (i, s) in segs.iter().enumerate() {
            let (x0, x1) = (s.a[0].min(s.b[0]) - reach, s.a[0].max(s.b[0]) + reach);
            let (z0, z1) = (s.a[1].min(s.b[1]) - reach, s.a[1].max(s.b[1]) + reach);
            let gi = |v: f32| (((v + HALF) / SG).floor().max(0.0) as usize).min(SGN - 1);
            for gz in gi(z0)..=gi(z1) {
                for gx in gi(x0)..=gi(x1) {
                    grid[gz * SGN + gx].push(i as u32);
                }
            }
        }
        StreamIndex { segs, grid }
    }

    /// `(distance, bed, level, half_width)` of the nearest stream point, if within carving reach.
    fn nearest(&self, x: f32, z: f32) -> Option<(f32, f32, f32, f32)> {
        let gx = (((x + HALF) / SG).floor().max(0.0) as usize).min(SGN - 1);
        let gz = (((z + HALF) / SG).floor().max(0.0) as usize).min(SGN - 1);
        let list = &self.grid[gz * SGN + gx];
        if list.is_empty() {
            return None;
        }
        let mut best = (f32::MAX, 0.0f32, 1.0f32);
        for &i in list {
            let s = &self.segs[i as usize];
            let (abx, abz) = (s.b[0] - s.a[0], s.b[1] - s.a[1]);
            let len2 = (abx * abx + abz * abz).max(1e-6);
            let t = (((x - s.a[0]) * abx + (z - s.a[1]) * abz) / len2).clamp(0.0, 1.0);
            let (px, pz) = (s.a[0] + abx * t, s.a[1] + abz * t);
            let d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
            if d2 < best.0 {
                best = (d2, lerp(s.lvl[0], s.lvl[1], t), lerp(s.hw[0], s.hw[1], t));
            }
        }
        let d = best.0.sqrt();
        if d > best.2 + 26.0 {
            None
        } else {
            Some((d, best.1 - STREAM_DEPTH, best.1, best.2))
        }
    }
}

// ------------------------------------------------------------------------------------------------- coarse -> fine

struct Coarse {
    data: Vec<[f32; NCH]>,
}

impl Coarse {
    fn bilinear(&self, ch: usize, x: f32, z: f32) -> f32 {
        let fx = ((x + HALF) / CG).clamp(0.0, (CN - 1) as f32 - 1e-3);
        let fz = ((z + HALF) / CG).clamp(0.0, (CN - 1) as f32 - 1e-3);
        let (ix, iz) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - ix as f32, fz - iz as f32);
        let g = |i: usize, j: usize| self.data[j * CN + i][ch];
        lerp(lerp(g(ix, iz), g(ix + 1, iz), tx), lerp(g(ix, iz + 1), g(ix + 1, iz + 1), tx), tz)
    }
}

#[inline]
fn bspline(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    let o = 1.0 - t;
    [o * o * o / 6.0, (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0, (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0, t3 / 6.0]
}

struct Axis {
    base: Vec<i32>,
    w: Vec<[f32; 4]>,
}

fn build_axis() -> Axis {
    let mut base = Vec::with_capacity(SIZE);
    let mut w = Vec::with_capacity(SIZE);
    for a in 0..SIZE {
        let c = a as f32 / RATIO as f32;
        let i = (c.floor() as i32).min(CN as i32 - 2);
        base.push(i - 1);
        w.push(bspline(c - i as f32));
    }
    Axis { base, w }
}

/// Calls `f(a, b, values)` for every fine sample (a = x index, b = z index) with cubic-B-spline upsampled fields.
fn for_each_fine<F: FnMut(usize, usize, &[f32; NCH])>(coarse: &Coarse, axis: &Axis, mut f: F) {
    let mut row = vec![[0.0f32; NCH]; CN];
    let cn = CN as i32;
    for b in 0..SIZE {
        let wz = &axis.w[b];
        let zb = axis.base[b];
        for (x, slot) in row.iter_mut().enumerate() {
            let mut acc = [0.0f32; NCH];
            for k in 0..4 {
                let j = (zb + k as i32).clamp(0, cn - 1) as usize;
                let src = &coarse.data[j * CN + x];
                for c in 0..NCH {
                    acc[c] += wz[k] * src[c];
                }
            }
            *slot = acc;
        }
        for a in 0..SIZE {
            let wx = &axis.w[a];
            let xb = axis.base[a];
            let mut v = [0.0f32; NCH];
            for k in 0..4 {
                let i = (xb + k as i32).clamp(0, cn - 1) as usize;
                let src = &row[i];
                for c in 0..NCH {
                    v[c] += wx[k] * src[c];
                }
            }
            f(a, b, &v);
        }
    }
}

// ------------------------------------------------------------------------------------------------- generate

/// Generates the whole world for a seed (deterministic).
pub fn generate(seed: u32) -> Generated {
    let mut lay = Layout::new(seed);

    // ---- coarse pass A
    let mut coarse = Coarse { data: vec![[0.0; NCH]; CN * CN] };
    for j in 0..CN {
        for i in 0..CN {
            coarse.data[j * CN + i] = lay.eval_a(-HALF + i as f32 * CG, -HALF + j as f32 * CG);
        }
    }
    lay.finish_planes(&coarse);
    // ---- coarse pass B
    for j in 0..CN {
        for i in 0..CN {
            let (x, z) = (-HALF + i as f32 * CG, -HALF + j as f32 * CG);
            let mut node = coarse.data[j * CN + i];
            lay.apply_b(&mut node, x, z);
            coarse.data[j * CN + i] = node;
        }
    }
    let streams = lay.build_streams(&coarse);
    let paths = lay.build_paths(&coarse);
    let sidx = StreamIndex::new(&streams);

    // ---- fine heights
    let axis = build_axis();
    let mut heights = vec![0.0f32; SIZE * SIZE];
    let mut aux = vec![0u8; SIZE * SIZE];
    for_each_fine(&coarse, &axis, |a, b, v| {
        let (x, z) = (-HALF + a as f32 * CELL, -HALF + b as f32 * CELL);
        let (h, f) = lay.fine_height(x, z, v, &sidx);
        heights[b * SIZE + a] = h;
        aux[b * SIZE + a] = f;
    });

    // ---- path stamps
    for line in &paths {
        for q in line {
            let hw = 1.1 + 0.45 * value_noise(seed ^ 0x401, q[0] * 0.15, q[1] * 0.15);
            let r = (hw / CELL).ceil() as i32 + 1;
            let (cx, cz) = (((q[0] + HALF) / CELL).round() as i32, ((q[1] + HALF) / CELL).round() as i32);
            for dz in -r..=r {
                for dx in -r..=r {
                    let (ia, ib) = (cx + dx, cz + dz);
                    if ia < 0 || ib < 0 || ia >= SIZE as i32 || ib >= SIZE as i32 {
                        continue;
                    }
                    let (wx, wz) = (-HALF + ia as f32 * CELL, -HALF + ib as f32 * CELL);
                    if (wx - q[0]) * (wx - q[0]) + (wz - q[1]) * (wz - q[1]) < hw * hw {
                        aux[ib as usize * SIZE + ia as usize] |= A_PATH;
                    }
                }
            }
        }
    }

    // ---- biomes
    let mut biomes = vec![biome::MEADOW; SIZE * SIZE];
    for_each_fine(&coarse, &axis, |a, b, v| {
        let i = b * SIZE + a;
        let h = heights[i];
        let f = aux[i];
        let (s, u, sc, forest, flower) = (v[C_S], v[C_U], v[C_SC], v[C_FOREST], v[C_FLOWER]);
        let hx = heights[b * SIZE + (a + 1).min(SIZE - 1)] - heights[b * SIZE + a.saturating_sub(1)];
        let hz = heights[(b + 1).min(SIZE - 1) * SIZE + a] - heights[b.saturating_sub(1) * SIZE + a];
        let g = ((hx * hx + hz * hz).sqrt()) / (2.0 * CELL);
        let water = A_POND_WATER | A_STREAM_WATER;
        let bank = A_POND_BANK | A_STREAM_BANK;
        biomes[i] = if h < 0.0 {
            if f & (water | bank) != 0 {
                biome::POND_BANK
            } else if h < -2.4 {
                biome::OCEAN_DEEP
            } else {
                biome::SHALLOWS
            }
        } else if f & (water | bank) != 0 {
            biome::POND_BANK
        } else if g > 0.72 {
            biome::CLIFF_ROCK
        } else if f & A_VILLAGE != 0 {
            biome::VILLAGE
        } else if f & A_PATH != 0 && g < 0.5 {
            biome::DIRT_PATH
        } else {
            let (x, z) = (-HALF + a as f32 * CELL, -HALF + b as f32 * CELL);
            let sand_w = 11.0 + 6.0 * value_noise(seed ^ 0x501, x * 0.05, z * 0.05);
            if s < sand_w && h < 2.3 && g < 0.45 && sc < 0.6 {
                biome::SAND
            } else if u > 0.30 {
                biome::HIGHLAND
            } else if forest > 0.5 && g < 0.5 {
                biome::FOREST_FLOOR
            } else if flower > 0.5 {
                biome::FLOWER_MEADOW
            } else {
                biome::MEADOW
            }
        };
    });

    let field = Heightfield::from_parts(heights, biomes);
    let spawn = find_spawn(&field, &lay);
    let habitats = habitats(&field);
    let features = Features {
        spawn,
        village: lay.village,
        village_r: lay.village_r,
        village_h: lay.village_h,
        pond: lay.pond.clone(),
        streams,
        paths,
        islets: lay.islets.iter().map(|il| [il.blob.cx, il.blob.cz, il.blob.rmin()]).collect(),
        highland: [lay.hl.cx, lay.hl.cz, lay.hl.rx.min(lay.hl.rz)],
        habitats,
    };
    Generated { field, features }
}

/// A flat, dry, grassy spot 8-30 m from the village centre, preferably towards the pond.
fn find_spawn(hf: &Heightfield, lay: &Layout) -> [f32; 2] {
    let v = lay.village;
    let to_pond = (lay.pond.z - v[1]).atan2_safe(lay.pond.x - v[0]);
    let mut r = 8.0;
    while r < 34.0 {
        for k in 0..24 {
            let a = to_pond + (if k % 2 == 0 { 1.0 } else { -1.0 }) * ((k + 1) / 2) as f32 * (math::TAU / 24.0);
            let (sa, ca) = math::sin_cos(a);
            let (x, z) = (v[0] + ca * r, v[1] + sa * r);
            let b = hf.biome_at(x, z);
            if (b == biome::MEADOW || b == biome::FLOWER_MEADOW || b == biome::VILLAGE) && hf.sample(x, z) > 1.5 && hf.steepness(x, z) < 0.1 {
                // keep a margin from paths / water
                let ok = [(3.0, 0.0), (-3.0, 0.0), (0.0, 3.0), (0.0, -3.0)].iter().all(|(dx, dz)| {
                    let bb = hf.biome_at(x + dx, z + dz);
                    bb != biome::POND_BANK && bb != biome::DIRT_PATH
                });
                if ok {
                    return [x, z];
                }
            }
        }
        r += 2.0;
    }
    v
}

trait Atan2Safe {
    fn atan2_safe(self, x: f32) -> f32;
}
impl Atan2Safe for f32 {
    fn atan2_safe(self, x: f32) -> f32 {
        math::atan2(self, x)
    }
}

/// Habitat circles `[x, z, r]` per biome: homogeneous spots on an 8 m lattice, largest first, spread apart.
fn habitats(hf: &Heightfield) -> Vec<(u8, Vec<[f32; 3]>)> {
    const DIRS: [[f32; 2]; 8] = [[1.0, 0.0], [0.7071, 0.7071], [0.0, 1.0], [-0.7071, 0.7071], [-1.0, 0.0], [-0.7071, -0.7071], [0.0, -1.0], [0.7071, -0.7071]];
    let ids = [biome::SHALLOWS, biome::SAND, biome::MEADOW, biome::FOREST_FLOOR, biome::HIGHLAND, biome::CLIFF_ROCK, biome::POND_BANK, biome::FLOWER_MEADOW, biome::VILLAGE];
    let mut out = Vec::new();
    for id in ids {
        let mut cands: Vec<[f32; 3]> = Vec::new();
        let mut z = -HALF + 8.0;
        while z < HALF - 8.0 {
            let mut x = -HALF + 8.0;
            while x < HALF - 8.0 {
                if hf.biome_at(x, z) == id {
                    let mut r = 0.0;
                    for rr in [3.0f32, 6.0, 10.0, 15.0, 22.0, 30.0] {
                        if DIRS.iter().all(|d| hf.biome_at(x + d[0] * rr, z + d[1] * rr) == id) {
                            r = rr;
                        } else {
                            break;
                        }
                    }
                    if r > 0.0 {
                        cands.push([x, z, r]);
                    }
                }
                x += 8.0;
            }
            z += 8.0;
        }
        cands.sort_by(|a, b| b[2].total_cmp(&a[2]).then(a[0].total_cmp(&b[0])).then(a[1].total_cmp(&b[1])));
        let cap = if id == biome::MEADOW || id == biome::FOREST_FLOOR || id == biome::SAND { 8 } else { 5 };
        let mut picked: Vec<[f32; 3]> = Vec::new();
        for c in cands {
            if picked.len() >= cap {
                break;
            }
            if picked.iter().all(|p| ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2)).sqrt() > p[2].max(c[2]).max(16.0)) {
                picked.push(c);
            }
        }
        if !picked.is_empty() {
            out.push((id, picked));
        }
    }
    out
}
