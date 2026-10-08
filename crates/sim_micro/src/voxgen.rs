//! The micro function and fast per-block bit-column generation.
//!
//! A voxel's solidity/material is a pure function of the 1 m block grid (`vox.data`). Rather than evaluating it voxel by voxel
//! (which could never hit 0.15 ms per 34^3 region), [`generate_region`] walks the (few) blocks overlapping the region and
//! builds `u64` bit columns per (x, z) column straight from per-column interval maths. Block classification:
//!
//! * air / water-only / fully buried blocks cost (almost) nothing (empty / full-column fill);
//! * **surface blocks** are bevelled (chamfer on exposed edges), soft tops get relief (-2..+1 voxels, clumped value noise),
//!   soft/rock sides get 1-2 voxel indentation / strata ledges, grass blocks get a green cap over dirt, sparse decor
//!   (tufts / pebbles) sits on top;
//! * **leaf blocks** become rounded shells with clumped 2x2x2 occupancy holes in the outer layers and a solid core.
//!
//! Level `L` uses the same code with `16 >> L` voxels per block edge (L0..L3 = 1/16, 1/8, 1/4, 1/2 m).

use crate::blocks::{self, Class};
use crate::grid::GridDesc;
use crate::noise::{h3, value_noise_grid};
use crate::style::Style;

/// Region edge in voxels: 32 inner + 1 apron on each side.
pub const N: usize = 34;
pub const FULL34: u64 = (1u64 << 34) - 1;
const INF: i32 = 1000;

const SALT_SIDE: u32 = 0x5113_0001;
const SALT_STRATA: u32 = 0x5113_0A00;
const SALT_LEAF: u32 = 0x1EAF_0001;
const SALT_DECOR: u32 = 0xDEC0_0001;
const SALT_RELIEF: u32 = 0x7E11_0001;

/// Bit columns + per-voxel material for one 34^3 region. `occ[x * N + z]` bit `y`; `mat[(x * N + z) * N + y]`.
pub struct Region {
    pub occ: Vec<u64>,
    pub mat: Vec<u8>,
}

impl Default for Region {
    fn default() -> Self {
        Self::new()
    }
}

impl Region {
    pub fn new() -> Self {
        Region { occ: vec![0; N * N], mat: vec![0; N * N * N] }
    }
    pub fn clear(&mut self) {
        self.occ.fill(0);
        self.mat.fill(0);
    }
    #[inline]
    pub fn solid_at(&self, x: usize, y: usize, z: usize) -> bool {
        (self.occ[x * N + z] >> y) & 1 != 0
    }
    #[inline]
    pub fn material_at(&self, x: usize, y: usize, z: usize) -> u8 {
        self.mat[(x * N + z) * N + y]
    }
}

/// Reusable scratch buffers (the "pool").
#[derive(Default)]
pub struct GenScratch {
    ids: Vec<u16>,
    relief: Vec<i8>,
    na: Vec<u8>,
    nb: Vec<u8>,
    nodes: Vec<u8>,
}

const fn lut() -> [u16; 256] {
    let mut t = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut b = 0;
        let mut v = 0u16;
        while b < 8 {
            if (i >> b) & 1 != 0 {
                v |= 3 << (2 * b);
            }
            b += 1;
        }
        t[i] = v;
        i += 1;
    }
    t
}
/// 8 clump bits -> 16 voxel bits (each clump = 2 voxels).
static EXPAND: [u16; 256] = lut();

/// Region origin (voxel coords of region index 0, i.e. the apron voxel) of micro-chunk `c` at any level.
#[inline]
pub fn region_origin(cx: i32, cy: i32, cz: i32) -> [i32; 3] {
    [cx * 32 - 1, cy * 32 - 1, cz * 32 - 1]
}

/// Reference micro function: `(solid, material)` of voxel `(x, y, z)` (world voxel coordinates at `level`).
/// Identical by construction to what [`generate_region`] writes (it generates the 34^3 region around the voxel), so it is slow
/// (tens of microseconds): meant for tests, tools and debugging, not for bulk use.
pub fn micro(blocks: &[u16], desc: &GridDesc, style: &Style, level: u8, x: i32, y: i32, z: i32) -> (bool, u16) {
    let mut reg = Region::new();
    let mut sc = GenScratch::default();
    generate_region(blocks, desc, style, level, [x - 1, y - 1, z - 1], &mut reg, &mut sc);
    if reg.solid_at(1, 1, 1) { (true, u16::from(reg.material_at(1, 1, 1))) } else { (false, 0) }
}

/// Fills `reg` for the region whose voxel (level `level`) origin is `origin`. Returns `false` if nothing solid was found
/// among the overlapped blocks (the region is then empty).
pub fn generate_region(blocks: &[u16], desc: &GridDesc, st: &Style, level: u8, origin: [i32; 3], reg: &mut Region, sc: &mut GenScratch) -> bool {
    reg.clear();
    let level = level.min(3);
    let r = 16i32 >> level;
    let mut bmin = [0i32; 3];
    let mut nb = [0usize; 3];
    for a in 0..3 {
        bmin[a] = origin[a].div_euclid(r);
        nb[a] = ((origin[a] + 33).div_euclid(r) - bmin[a] + 1) as usize;
    }
    let (dx, dy, dz) = (nb[0] + 2, nb[1] + 2, nb[2] + 2);
    let idx = |i: usize, k: usize, j: usize| (i * dz + k) * dy + j;
    sc.ids.clear();
    sc.ids.resize(dx * dy * dz, 0);
    let mut any_solid = false;
    let mut any_relief = false;
    for i in 0..dx {
        for k in 0..dz {
            for j in 0..dy {
                let id = desc.block(blocks, bmin[0] - 1 + i as i32, bmin[1] - 1 + j as i32, bmin[2] - 1 + k as i32);
                sc.ids[idx(i, k, j)] = id;
                let c = blocks::class(id);
                any_solid |= !matches!(c, Class::Air | Class::Liquid);
                any_relief |= matches!(c, Class::Soft | Class::Rock);
            }
        }
    }
    if !any_solid {
        return false;
    }
    sc.relief.clear();
    sc.relief.resize(N * N, 0);
    if any_relief && level <= st.relief_max_level && st.relief_hi >= st.relief_lo {
        compute_relief(st, level, origin, sc);
    }
    let mut g = Gen { st, level, r, occ: &mut reg.occ, mat: &mut reg.mat, relief: &sc.relief };
    for i in 1..=nb[0] {
        for k in 1..=nb[2] {
            for j in 1..=nb[1] {
                let id = sc.ids[idx(i, k, j)];
                let cls = blocks::class(id);
                if matches!(cls, Class::Air | Class::Liquid) {
                    continue;
                }
                let s = |di: isize, dj: isize, dk: isize| blocks::solid(sc.ids[idx((i as isize + di) as usize, (k as isize + dk) as usize, (j as isize + dj) as usize)]);
                let ex = [!s(1, 0, 0), !s(-1, 0, 0), !s(0, 1, 0), !s(0, -1, 0), !s(0, 0, 1), !s(0, 0, -1)];
                let bw = [bmin[0] + i as i32 - 1, bmin[1] + j as i32 - 1, bmin[2] + k as i32 - 1];
                let ib = [bw[0] * r - origin[0], bw[1] * r - origin[1], bw[2] * r - origin[2]];
                if ex.iter().any(|e| *e) {
                    match cls {
                        Class::Leaf => g.gen_leaf(id, ex, bw, ib),
                        _ => g.gen_solid(id, cls, ex, bw, ib),
                    }
                } else {
                    // buried block: all 26 neighbours solid -> never visible, occupancy only
                    let mut deep = true;
                    'o: for di in -1isize..=1 {
                        for dj in -1isize..=1 {
                            for dk in -1isize..=1 {
                                if !s(di, dj, dk) {
                                    deep = false;
                                    break 'o;
                                }
                            }
                        }
                    }
                    let mat = if deep && cls != Class::Leaf { None } else if blocks::capped(id) { Some(blocks::DIRT) } else { Some(id as u8) };
                    g.fill_block(ib, mat);
                }
            }
        }
    }
    true
}

fn compute_relief(st: &Style, level: u8, origin: [i32; 3], sc: &mut GenScratch) {
    let step = 1i32 << level;
    let x0 = origin[0] * step + (step >> 1);
    let z0 = origin[2] * step + (step >> 1);
    sc.na.clear();
    sc.na.resize(N * N, 0);
    sc.nb.clear();
    sc.nb.resize(N * N, 0);
    value_noise_grid(st.seed ^ SALT_RELIEF, i32::from(st.relief_cell_a.max(1)), x0, z0, step, N, &mut sc.na, &mut sc.nodes);
    value_noise_grid(st.seed ^ SALT_RELIEF ^ 0x55, i32::from(st.relief_cell_b.max(1)), x0, z0, step, N, &mut sc.nb, &mut sc.nodes);
    let range = i32::from(st.relief_hi) - i32::from(st.relief_lo) + 1;
    let mix = i32::from(st.relief_mix_b);
    let gain = i32::from(st.relief_gain);
    for t in 0..N * N {
        let a = i32::from(sc.na[t]);
        let b = i32::from(sc.nb[t]);
        let n = (a * (256 - mix) + b * mix) >> 8;
        let n2 = (128 + (((n - 128) * gain) >> 8)).clamp(0, 255);
        let r0 = i32::from(st.relief_lo) + ((n2 * range) >> 8);
        let rel = if level == 0 { r0 } else { (r0 + ((1 << level) >> 1)) >> level };
        sc.relief[t] = rel as i8;
    }
}

struct Gen<'a> {
    st: &'a Style,
    level: u8,
    r: i32,
    occ: &'a mut [u64],
    mat: &'a mut [u8],
    relief: &'a [i8],
}

impl Gen<'_> {
    #[inline]
    fn fill_mat(&mut self, base: usize, a: i32, b: i32, m: u8) {
        let a = a.max(0);
        let b = b.min(N as i32);
        if a < b {
            self.mat[base + a as usize..base + b as usize].fill(m);
        }
    }

    /// Writes one column segment of a block: `mask` bit v = solid (v relative to the block bottom `yb`, region coordinates),
    /// material `m_lo` on `lo..split`, `m_hi` on `split..hi`.
    #[inline]
    fn put(&mut self, x: i32, z: i32, yb: i32, mask: u32, lo: i32, split: i32, hi: i32, m_lo: u8, m_hi: u8) {
        let ci = x as usize * N + z as usize;
        let bits = if yb >= 0 { u64::from(mask) << yb } else { u64::from(mask) >> (-yb) };
        self.occ[ci] |= bits & FULL34;
        let base = ci * N;
        self.fill_mat(base, yb + lo, yb + split, m_lo);
        self.fill_mat(base, yb + split, yb + hi, m_hi);
    }

    /// Block with no exposed face: full columns (`mat = None` skips materials: provably never read).
    fn fill_block(&mut self, ib: [i32; 3], mat: Option<u8>) {
        let r = self.r;
        let mask = (1u32 << r) - 1;
        let (u0, u1) = ((-ib[0]).max(0), r.min(N as i32 - ib[0]));
        let (w0, w1) = ((-ib[2]).max(0), r.min(N as i32 - ib[2]));
        for u in u0..u1 {
            for w in w0..w1 {
                let (x, z) = (ib[0] + u, ib[2] + w);
                match mat {
                    Some(m) => self.put(x, z, ib[1], mask, 0, r, r, m, m),
                    None => {
                        let ci = x as usize * N + z as usize;
                        let bits = if ib[1] >= 0 { u64::from(mask) << ib[1] } else { u64::from(mask) >> (-ib[1]) };
                        self.occ[ci] |= bits & FULL34;
                    }
                }
            }
        }
    }

    #[inline]
    fn relief_at(&self, x: i32, z: i32) -> i32 {
        i32::from(self.relief[x as usize * N + z as usize])
    }

    /// Indentation masks of one exposed side face (`m0` = outermost layer, `m1` = second layer), indexed by the along coordinate.
    fn side_inset(&self, cls: Class, f: usize, ag: i32, yg: i32, m0: &mut [u32; 16], m1: &mut [u32; 16]) {
        let (r, st, lvl) = (self.r, self.st, self.level);
        match cls {
            Class::Soft => {
                let half = r / 2;
                for ca in 0..half {
                    let (mut b0, mut b1) = (0u32, 0u32);
                    for cv in 0..half {
                        let hv = h3(st.seed ^ SALT_SIDE ^ f as u32, ag.div_euclid(2) + ca, yg.div_euclid(2) + cv, i32::from(lvl));
                        if (hv & 255) < u32::from(st.side_inset_density) {
                            b0 |= 3 << (2 * cv);
                            if ((hv >> 8) & 255) < 110 {
                                b1 |= 3 << (2 * cv);
                            }
                        }
                    }
                    for k in 0..2 {
                        m0[(2 * ca + k) as usize] = b0;
                        m1[(2 * ca + k) as usize] = b1;
                    }
                }
            }
            Class::Rock if st.strata_band > 0 => {
                let bh = Style::scaled(st.strata_band, lvl);
                for cq in 0..(r / 4).max(1) {
                    let agq = (ag + cq * 4).div_euclid(4);
                    let ph = (h3(st.seed ^ SALT_STRATA, f as i32, agq, i32::from(lvl)) % (2 * bh as u32)) as i32;
                    let (mut b0, mut b1) = (0u32, 0u32);
                    for v in 0..r {
                        if (yg + v + ph).div_euclid(bh) & 1 == 1 {
                            b0 |= 1 << v;
                            if h3(st.seed ^ SALT_STRATA ^ 0x77, f as i32 + 8, (yg + v) >> 1, agq) & 3 == 0 {
                                b1 |= 1 << v;
                            }
                        }
                    }
                    for k in 0..4 {
                        let a = (cq * 4 + k) as usize;
                        if a < 16 {
                            m0[a] = b0;
                            m1[a] = b1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn gen_solid(&mut self, id: u16, cls: Class, ex: [bool; 6], bw: [i32; 3], ib: [i32; 3]) {
        let (r, lvl, st) = (self.r, self.level, self.st);
        let bev = match cls {
            Class::Hard => st.bevel_hard,
            Class::Wood => st.bevel_log,
            _ => st.bevel,
        };
        let rad = Style::scaled(bev, lvl);
        let radc = rad + Style::scaled(st.bevel_corner_extra, lvl);
        let softlike = matches!(cls, Class::Soft | Class::Rock);
        let relief_on = ex[2] && softlike && lvl <= st.relief_max_level && st.relief_hi >= st.relief_lo;
        let cap = ex[2] && blocks::capped(id);
        let body: u8 = if blocks::capped(id) { blocks::DIRT } else { id as u8 };
        let band_mat = id as u8;
        let gd = Style::scaled(st.grass_depth, lvl);
        let horiz = ex[0] || ex[1] || ex[4] || ex[5];
        let ins_on = softlike && lvl <= st.inset_max_level && horiz;
        let mut m0 = [[0u32; 16]; 6];
        let mut m1 = [[0u32; 16]; 6];
        if ins_on {
            for f in [0usize, 1, 4, 5] {
                if ex[f] {
                    let ag = if f < 2 { bw[2] * r } else { bw[0] * r };
                    let (a0, a1) = (&mut m0[f], &mut m1[f]);
                    self.side_inset(cls, f, ag, bw[1] * r, a0, a1);
                }
            }
        }
        for w in 0..r {
            let z = ib[2] + w;
            if !(0..N as i32).contains(&z) {
                continue;
            }
            for u in 0..r {
                let x = ib[0] + u;
                if !(0..N as i32).contains(&x) {
                    continue;
                }
                let dxm = (if ex[0] { r - 1 - u } else { INF }).min(if ex[1] { u } else { INF });
                let dzm = (if ex[4] { r - 1 - w } else { INF }).min(if ex[5] { w } else { INF });
                if dxm < INF && dzm < INF && dxm + dzm < rad {
                    continue;
                }
                let sd1 = dxm.min(dzm);
                let pair = if dxm < INF && dzm < INF { dxm + dzm } else { INF };
                let edge_cut = (rad - sd1).max(radc - pair).max(0);
                let cut_top = if ex[2] { edge_cut } else { 0 };
                let cut_bot = if ex[3] { edge_cut } else { 0 };
                let mut hi = r - cut_top;
                let mut spill = 0;
                if relief_on {
                    let mut rr = self.relief_at(x, z);
                    if cls == Class::Rock {
                        rr >>= 1;
                    }
                    if rr < 0 {
                        hi += rr;
                    } else if cut_top == 0 {
                        spill = rr;
                    }
                }
                hi = hi.clamp(1, r);
                let lo = cut_bot.min(r - 1);
                if hi <= lo {
                    continue;
                }
                let hi_tot = hi + spill;
                let mut mask = ((1u32 << hi_tot) - 1) & !((1u32 << lo) - 1);
                if ins_on {
                    let mut rem = 0u32;
                    if ex[0] {
                        match r - 1 - u {
                            0 => rem |= m0[0][w as usize],
                            1 => rem |= m1[0][w as usize],
                            _ => {}
                        }
                    }
                    if ex[1] {
                        match u {
                            0 => rem |= m0[1][w as usize],
                            1 => rem |= m1[1][w as usize],
                            _ => {}
                        }
                    }
                    if ex[4] {
                        match r - 1 - w {
                            0 => rem |= m0[4][u as usize],
                            1 => rem |= m1[4][u as usize],
                            _ => {}
                        }
                    }
                    if ex[5] {
                        match w {
                            0 => rem |= m0[5][u as usize],
                            1 => rem |= m1[5][u as usize],
                            _ => {}
                        }
                    }
                    mask &= !rem;
                    if mask == 0 {
                        continue;
                    }
                }
                let split = if cap { (hi - gd).max(lo) } else { hi };
                if cap {
                    self.put(x, z, ib[1], mask, lo, split, hi_tot, body, band_mat);
                } else {
                    self.put(x, z, ib[1], mask, lo, split, hi_tot, body, body);
                }
            }
        }
        // decor: grass tufts / pebbles on exposed soft tops
        if ex[2] && cls == Class::Soft && lvl <= st.decor_max_level {
            let tuft = blocks::is_grass(id);
            let dens = if tuft { st.tuft_density } else if blocks::pebbly(id) { st.pebble_density } else { 0 };
            if dens > 0 {
                let cells = (r / 4).max(1);
                for cw in 0..cells {
                    for cu in 0..cells {
                        let hv = h3(st.seed ^ SALT_DECOR, bw[0] * cells + cu, bw[2] * cells + cw, i32::from(lvl));
                        if (hv & 255) >= u32::from(dens) {
                            continue;
                        }
                        let u = cu * 4 + ((hv >> 8) & 3) as i32;
                        let w = cw * 4 + ((hv >> 10) & 3) as i32;
                        let (x, z) = (ib[0] + u, ib[2] + w);
                        if !(0..N as i32).contains(&x) || !(0..N as i32).contains(&z) {
                            continue;
                        }
                        let dxm = (if ex[0] { r - 1 - u } else { INF }).min(if ex[1] { u } else { INF });
                        let dzm = (if ex[4] { r - 1 - w } else { INF }).min(if ex[5] { w } else { INF });
                        let pair = if dxm < INF && dzm < INF { dxm + dzm } else { INF };
                        if (rad - dxm.min(dzm)).max(radc - pair) > 0 || (dxm < INF && dzm < INF && dxm + dzm < rad) {
                            continue;
                        }
                        let mut rr = self.relief_at(x, z);
                        if lvl > st.relief_max_level {
                            rr = 0;
                        }
                        let base = r + rr;
                        let (h, m) = if tuft {
                            (1 + ((hv >> 12) % 2) as i32, if (hv >> 16) & 15 == 0 { blocks::GRASS_FLOWER } else { blocks::GRASS_HIGH })
                        } else {
                            (1, if (hv >> 16) & 1 == 0 { blocks::STONE } else { blocks::GRAVEL })
                        };
                        let mask = ((1u32 << (base + h)) - 1) & !((1u32 << base) - 1);
                        self.put(x, z, ib[1], mask, base, base, base + h, m, m);
                    }
                }
            }
        }
    }

    fn gen_leaf(&mut self, id: u16, ex: [bool; 6], bw: [i32; 3], ib: [i32; 3]) {
        let (r, lvl, st) = (self.r, self.level, self.st);
        let m = id as u8;
        let rad = Style::scaled(st.leaf_bevel, lvl);
        let radc = rad + Style::scaled(st.bevel_corner_extra, lvl);
        let shell = lvl <= st.leaf_shell_max_level && r >= 4;
        let depth = Style::scaled(st.leaf_shell_depth, lvl);
        let half = (r / 2) as usize;
        let mut cells = [[0u8; 8]; 8];
        if shell {
            for (cu, row) in cells.iter_mut().enumerate().take(half) {
                for (cw, cell) in row.iter_mut().enumerate().take(half) {
                    let mut bits = 0u8;
                    for cv in 0..half {
                        let (gx, gy, gz) = (bw[0] * half as i32 + cu as i32, bw[1] * half as i32 + cv as i32, bw[2] * half as i32 + cw as i32);
                        let hv = h3(st.seed ^ SALT_LEAF, gx, gy, gz);
                        // coarser 4-voxel patches modulate the occupancy so holes clump into leaf tufts instead of salt-and-pepper
                        let patch = (h3(st.seed ^ SALT_LEAF ^ 0x44, gx >> 1, gy >> 1, gz >> 1) & 255) as i32 - 128;
                        let occ = (i32::from(st.leaf_occupancy) + patch * 3 / 4).clamp(0, 256);
                        if (hv & 255) < occ as u32 {
                            bits |= 1 << cv;
                        }
                    }
                    *cell = bits;
                }
            }
        }
        let full = (1u32 << r) - 1;
        for w in 0..r {
            let z = ib[2] + w;
            if !(0..N as i32).contains(&z) {
                continue;
            }
            for u in 0..r {
                let x = ib[0] + u;
                if !(0..N as i32).contains(&x) {
                    continue;
                }
                let dxm = (if ex[0] { r - 1 - u } else { INF }).min(if ex[1] { u } else { INF });
                let dzm = (if ex[4] { r - 1 - w } else { INF }).min(if ex[5] { w } else { INF });
                if dxm < INF && dzm < INF && dxm + dzm < rad {
                    continue;
                }
                let sd1 = dxm.min(dzm);
                let pair = if dxm < INF && dzm < INF { dxm + dzm } else { INF };
                let edge_cut = (rad - sd1).max(radc - pair).max(0);
                let cut_top = if ex[2] { edge_cut } else { 0 };
                let cut_bot = if ex[3] { edge_cut } else { 0 };
                let hi = (r - cut_top).clamp(1, r);
                let lo = cut_bot.min(r - 1);
                if hi <= lo {
                    continue;
                }
                let mut mask = ((1u32 << hi) - 1) & !((1u32 << lo) - 1);
                if shell {
                    let e = u32::from(EXPAND[usize::from(cells[(u >> 1) as usize][(w >> 1) as usize])]);
                    if sd1 < depth {
                        mask &= e;
                    } else {
                        if ex[2] {
                            let t = full & !((1u32 << (r - depth)) - 1);
                            mask &= !(t & !e);
                        }
                        if ex[3] {
                            let b = (1u32 << depth) - 1;
                            mask &= !(b & !e);
                        }
                    }
                    if mask == 0 {
                        continue;
                    }
                }
                self.put(x, z, ib[1], mask, lo, hi, hi, m, m);
            }
        }
    }
}
