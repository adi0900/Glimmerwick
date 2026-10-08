//! Binary greedy mesher over `u64` bit columns (34 bits = 32 inner voxels + 1 apron each side).
//!
//! Face masks come from word-wide ops (`c & !(c >> 1)` ...), per-face greedy rectangles merge by **material and AO pattern**
//! (a rectangle only grows along an axis if its AO is constant along that axis, so interpolation stays exact), vertices are
//! 8 bytes. Skirts hang under the 4 side boundaries to hide LOD cracks.
//!
//! Vertex (8 bytes, little endian):
//! `[x, y, z, flags, mat_lo, mat_hi, w, h]` - x,y,z voxel units inside the micro-chunk (0..=32);
//! `flags = face(3b) | ao(2b) << 3 | corner(2b) << 5 | skirt << 7`; face 0..6 = +x -x +y -y +z -z; ao 0 (dark) .. 3 (open);
//! corner 0..4 = (0,0) (1,0) (1,1) (0,1) in the quad's (bit axis, row axis); `w`,`h` = quad extent in voxels along those axes.

use crate::voxgen::{FULL34, GenScratch, N, Region, generate_region, region_origin};
use crate::grid::GridDesc;
use crate::style::Style;

pub const MC: usize = 32;
pub const VERTEX_BYTES: usize = 8;
const INNER: u64 = 0x1_FFFF_FFFE;
const MAX_VERTS: usize = 65_532;

/// Per-axis tables: face id, normal, bit-axis unit, row-axis unit, flip winding.
/// Axis order of the 6 faces: +x -x +y -y +z -z.
const FACE_N: [[i32; 3]; 6] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/// tangent (bit axis, row axis) per face
const FACE_T: [([i32; 3], [i32; 3]); 6] = [
    ([0, 1, 0], [0, 0, 1]),
    ([0, 1, 0], [0, 0, 1]),
    ([1, 0, 0], [0, 0, 1]),
    ([1, 0, 0], [0, 0, 1]),
    ([0, 1, 0], [1, 0, 0]),
    ([0, 1, 0], [1, 0, 0]),
];
const FACE_FLIP: [bool; 6] = [false, true, true, false, true, false];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MeshHeader {
    pub level: u8,
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub vertex_count: u32,
    pub index_count: u32,
    /// quads including skirt quads
    pub quads: u32,
    pub skirt_quads: u32,
    /// no solid voxel in the region (no mesh)
    pub empty: bool,
    /// every voxel solid, nothing visible (no mesh)
    pub full: bool,
    /// the 16-bit index space ran out; geometry was cut (only pathological noise)
    pub truncated: bool,
    /// inner-voxel bounding box of the geometry (min x,y,z, max x,y,z), voxel units 0..=32
    pub bbox: [u8; 6],
}

/// Pooled mesher: owns every work buffer, so steady state does no allocation.
pub struct Mesher {
    reg: Region,
    sc: GenScratch,
    verts: Vec<u8>,
    idx: Vec<u16>,
    planes: Vec<[u32; 32]>,
    /// per-plane bit-parallel AO: [corner * 2 + (0 lo | 1 hi)][row] bit = cell
    ao_t: [[u32; 32]; 8],
    ao_on: bool,
    quads: u32,
    skirt_quads: u32,
    truncated: bool,
    bb_min: [u8; 3],
    bb_max: [u8; 3],
}

impl Default for Mesher {
    fn default() -> Self {
        Self::new()
    }
}

impl Mesher {
    pub fn new() -> Self {
        Mesher {
            reg: Region::new(),
            sc: GenScratch::default(),
            verts: Vec::with_capacity(64 * 1024),
            idx: Vec::with_capacity(48 * 1024),
            planes: vec![[0u32; 32]; 32],
            ao_t: [[0u32; 32]; 8],
            ao_on: true,
            quads: 0,
            skirt_quads: 0,
            truncated: false,
            bb_min: [32; 3],
            bb_max: [0; 3],
        }
    }

    pub fn vertices(&self) -> &[u8] {
        &self.verts
    }
    pub fn indices(&self) -> &[u16] {
        &self.idx
    }
    /// Moves the output buffers out (the pool re-grows lazily); use [`vertices`](Self::vertices) to avoid the copy.
    pub fn take(&mut self) -> (Vec<u8>, Vec<u16>) {
        (std::mem::take(&mut self.verts), std::mem::take(&mut self.idx))
    }
    /// The region of the last [`mesh`](Self::mesh) / [`mesh_region`](Self::mesh_region) (tests, tools).
    pub fn region(&self) -> &Region {
        &self.reg
    }
    /// Mutable region for tests: fill `occ` / `mat` then call [`mesh_region`](Self::mesh_region).
    pub fn region_mut(&mut self) -> &mut Region {
        &mut self.reg
    }

    /// Full pipeline for micro-chunk `(cx, cy, cz)` at `level`: generate bit columns from the block grid, mesh, add skirts.
    pub fn mesh(&mut self, blocks: &[u16], desc: &GridDesc, style: &Style, level: u8, cx: i32, cy: i32, cz: i32) -> MeshHeader {
        self.verts.clear();
        self.idx.clear();
        let any = generate_region(blocks, desc, style, level, region_origin(cx, cy, cz), &mut self.reg, &mut self.sc);
        let mut h = MeshHeader { level, cx, cy, cz, ..Default::default() };
        if !any {
            h.empty = true;
            return h;
        }
        self.mesh_region_inner(style.ao, i32::from(style.skirt_voxels), h)
    }

    /// Meshes the already filled [`region_mut`](Self::region_mut).
    pub fn mesh_region(&mut self, ao: bool, skirt_voxels: u8) -> MeshHeader {
        self.verts.clear();
        self.idx.clear();
        self.mesh_region_inner(ao, i32::from(skirt_voxels), MeshHeader::default())
    }

    fn mesh_region_inner(&mut self, ao: bool, skirt: i32, mut h: MeshHeader) -> MeshHeader {
        self.ao_on = ao;
        self.quads = 0;
        self.skirt_quads = 0;
        self.truncated = false;
        self.bb_min = [32; 3];
        self.bb_max = [0; 3];
        let (mut any, mut all) = (0u64, u64::MAX);
        for &c in &self.reg.occ {
            any |= c;
            all &= c;
        }
        if any == 0 {
            h.empty = true;
            return h;
        }
        if all == FULL34 {
            h.full = true;
            return h;
        }
        // +-Y faces: transpose into (slice y, row z, bit x)
        for face in [2usize, 3] {
            let mut touched = 0u32;
            for x in 1..=MC {
                for z in 1..=MC {
                    let c = self.reg.occ[x * N + z];
                    let mut f = if face == 2 { c & !(c >> 1) } else { c & !(c << 1) } & INNER;
                    while f != 0 {
                        let y = f.trailing_zeros() as usize;
                        f &= f - 1;
                        self.planes[y - 1][z - 1] |= 1 << (x - 1);
                        touched |= 1 << (y - 1);
                    }
                }
            }
            self.run_planes(face, touched);
        }
        // +-X faces: slice x, row z, bits = y column
        for face in [0usize, 1] {
            let mut touched = 0u32;
            for x in 1..=MC {
                for z in 1..=MC {
                    let c = self.reg.occ[x * N + z];
                    let n = if face == 0 { self.reg.occ[(x + 1) * N + z] } else { self.reg.occ[(x - 1) * N + z] };
                    let f = (c & !n & INNER) >> 1;
                    if f != 0 {
                        self.planes[x - 1][z - 1] = f as u32;
                        touched |= 1 << (x - 1);
                    }
                }
            }
            self.run_planes(face, touched);
        }
        // +-Z faces: slice z, row x, bits = y column
        for face in [4usize, 5] {
            let mut touched = 0u32;
            for x in 1..=MC {
                for z in 1..=MC {
                    let c = self.reg.occ[x * N + z];
                    let n = if face == 4 { self.reg.occ[x * N + z + 1] } else { self.reg.occ[x * N + z - 1] };
                    let f = (c & !n & INNER) >> 1;
                    if f != 0 {
                        self.planes[z - 1][x - 1] = f as u32;
                        touched |= 1 << (z - 1);
                    }
                }
            }
            self.run_planes(face, touched);
        }
        if skirt > 0 {
            self.skirts(skirt);
        }
        h.vertex_count = (self.verts.len() / VERTEX_BYTES) as u32;
        h.index_count = self.idx.len() as u32;
        h.quads = self.quads;
        h.skirt_quads = self.skirt_quads;
        h.truncated = self.truncated;
        if self.quads > 0 {
            h.bbox = [self.bb_min[0], self.bb_min[1], self.bb_min[2], self.bb_max[0], self.bb_max[1], self.bb_max[2]];
        }
        h
    }

    fn run_planes(&mut self, face: usize, mut touched: u32) {
        while touched != 0 {
            let s = touched.trailing_zeros() as usize;
            touched &= touched - 1;
            let mut rows = self.planes[s];
            self.planes[s] = [0; 32];
            self.greedy(face, s, &mut rows);
        }
    }

    /// Region voxel (x, y, z) of plane cell (slice s, row r, bit b) for `face`.
    #[inline]
    fn cell(face: usize, s: usize, r: usize, b: usize) -> (i32, i32, i32) {
        match face {
            2 | 3 => (b as i32 + 1, s as i32 + 1, r as i32 + 1),
            0 | 1 => (s as i32 + 1, b as i32 + 1, r as i32 + 1),
            _ => (r as i32 + 1, b as i32 + 1, s as i32 + 1),
        }
    }

    /// Bit-parallel AO of one plane: for every cell of `rows` and each of the 4 corners the 2-bit AO value
    /// (`3 - (side1 + side2 + corner)`, 0 if both sides are set) computed for 32 cells per word from the occupancy of the
    /// layer just outside the face. Only rows that have faces are computed.
    fn plane_ao(&mut self, face: usize, s: usize, rows: &[u32; 32]) {
        let n = if face & 1 == 0 { 1 } else { -1 };
        let mut o = [0u64; N];
        let lay = (s as i32 + 1 + n) as usize;
        match face >> 1 {
            0 => {
                for rr in 0..N {
                    o[rr] = self.reg.occ[lay * N + rr];
                }
            }
            1 => {
                for (rr, w) in o.iter_mut().enumerate() {
                    let mut acc = 0u64;
                    for q in 0..N {
                        acc |= ((self.reg.occ[q * N + rr] >> lay) & 1) << q;
                    }
                    *w = acc;
                }
            }
            _ => {
                for rr in 0..N {
                    o[rr] = self.reg.occ[rr * N + lay];
                }
            }
        }
        for r in 0..32 {
            if rows[r] == 0 {
                continue;
            }
            let rr = r + 1;
            for k in 0..4usize {
                let (ib, ir) = (k & 1, k >> 1);
                let rn = if ir == 0 { rr - 1 } else { rr + 1 };
                let sh = |w: u64| if ib == 0 { w << 1 } else { w >> 1 };
                let s1 = sh(o[rr]);
                let s2 = o[rn];
                let c = sh(o[rn]);
                let both = s1 & s2;
                let lo = (s1 ^ s2 ^ c) | both;
                let hi = both | (s1 & c) | (s2 & c);
                self.ao_t[2 * k][r] = (!lo >> 1) as u32;
                self.ao_t[2 * k + 1][r] = (!hi >> 1) as u32;
            }
        }
    }

    /// (material, packed AO 4 x 2 bits: corner index = ib + 2 * ir).
    #[inline]
    fn key(&self, face: usize, s: usize, r: usize, b: usize) -> (u8, u8) {
        let (x, y, z) = Self::cell(face, s, r, b);
        let mat = self.reg.mat[(x as usize * N + z as usize) * N + y as usize];
        if !self.ao_on {
            return (mat, 0xFF);
        }
        let mut pat = 0u8;
        for k in 0..4 {
            let lo = (self.ao_t[2 * k][r] >> b) & 1;
            let hi = (self.ao_t[2 * k + 1][r] >> b) & 1;
            pat |= ((lo | (hi << 1)) as u8) << (2 * k);
        }
        (mat, pat)
    }

    fn greedy(&mut self, face: usize, s: usize, rows: &mut [u32; 32]) {
        if self.ao_on {
            self.plane_ao(face, s, rows);
        }
        for r in 0..32 {
            while rows[r] != 0 {
                let b = rows[r].trailing_zeros() as usize;
                let run = (!(rows[r] >> b)).trailing_zeros() as usize;
                let run = run.min(32 - b);
                let key = self.key(face, s, r, b);
                let pat = key.1;
                let ao = |i: u32| (pat >> (2 * i)) & 3;
                let merge_b = ao(0) == ao(1) && ao(2) == ao(3);
                let merge_r = ao(0) == ao(2) && ao(1) == ao(3);
                let mut w = 1;
                if merge_b {
                    while w < run && self.key(face, s, r, b + w) == key {
                        w += 1;
                    }
                }
                let wmask = if w == 32 { u32::MAX } else { ((1u32 << w) - 1) << b };
                let mut h = 1;
                if merge_r {
                    'grow: while r + h < 32 && rows[r + h] & wmask == wmask {
                        for bb in b..b + w {
                            if self.key(face, s, r + h, bb) != key {
                                break 'grow;
                            }
                        }
                        h += 1;
                    }
                }
                for rr in r..r + h {
                    rows[rr] &= !wmask;
                }
                self.emit_quad(face, s, r, b, h, w, key);
            }
        }
    }

    fn push_vertex(&mut self, p: [i32; 3], face: usize, ao: u8, corner: u8, skirt: bool, mat: u8, w: usize, h: usize) {
        for a in 0..3 {
            self.bb_min[a] = self.bb_min[a].min(p[a] as u8);
            self.bb_max[a] = self.bb_max[a].max(p[a] as u8);
        }
        let flags = face as u8 | (ao << 3) | (corner << 5) | (u8::from(skirt) << 7);
        self.verts.extend_from_slice(&[p[0] as u8, p[1] as u8, p[2] as u8, flags, mat, 0, w as u8, h as u8]);
    }

    /// Quad of `h` rows x `w` bits at (row r, bit b) in slice s.
    fn emit_quad(&mut self, face: usize, s: usize, r: usize, b: usize, h: usize, w: usize, key: (u8, u8)) {
        if self.verts.len() / VERTEX_BYTES + 4 > MAX_VERTS {
            self.truncated = true;
            return;
        }
        let pos = face & 1 == 0;
        let plane = s as i32 + i32::from(pos);
        let (b0, b1, r0, r1) = (b as i32, (b + w) as i32, r as i32, (r + h) as i32);
        // corners (bit, row) order: (0,0) (1,0) (1,1) (0,1)
        let cb = [b0, b1, b1, b0];
        let cr = [r0, r0, r1, r1];
        let ao_of = |c: usize| -> u8 {
            let ib = [0, 1, 1, 0][c];
            let ir = [0, 0, 1, 1][c];
            (key.1 >> (2 * (ib + 2 * ir))) & 3
        };
        let mut p = [[0i32; 3]; 4];
        for c in 0..4 {
            p[c] = match face {
                2 | 3 => [cb[c], plane, cr[c]],
                0 | 1 => [plane, cb[c], cr[c]],
                _ => [cr[c], cb[c], plane],
            };
        }
        let base = (self.verts.len() / VERTEX_BYTES) as u16;
        for c in 0..4 {
            self.push_vertex(p[c], face, ao_of(c), c as u8, false, key.0, w, h);
        }
        let a = [ao_of(0), ao_of(1), ao_of(2), ao_of(3)];
        let tris: [[u16; 3]; 2] = if a[0] + a[2] >= a[1] + a[3] { [[0, 1, 2], [0, 2, 3]] } else { [[0, 1, 3], [1, 2, 3]] };
        for t in tris {
            let t = if FACE_FLIP[face] { [t[0], t[2], t[1]] } else { t };
            self.idx.extend_from_slice(&[base + t[0], base + t[1], base + t[2]]);
        }
        self.quads += 1;
    }

    /// Skirt quads: under every exposed top voxel of the 4 boundary columns, hanging `depth` voxels down, outward facing.
    fn skirts(&mut self, depth: i32) {
        // sides: (face id, fixed axis is x?, boundary index (region), plane coordinate)
        for (face, along_z, fixed, plane) in [(0usize, true, MC, MC as i32), (1, true, 1, 0), (4, false, MC, MC as i32), (5, false, 1, 0)] {
            let mut ups = [0u32; 32];
            let mut any = 0u32;
            for t in 1..=MC {
                let c = if along_z { self.reg.occ[fixed * N + t] } else { self.reg.occ[t * N + fixed] };
                let up = ((c & !(c >> 1) & INNER) >> 1) as u32;
                ups[t - 1] = up;
                any |= up;
            }
            let mut ys = any;
            while ys != 0 {
                let y = ys.trailing_zeros() as usize;
                ys &= ys - 1;
                let mut t = 0;
                while t < 32 {
                    if (ups[t] >> y) & 1 == 0 {
                        t += 1;
                        continue;
                    }
                    let mat = self.skirt_mat(along_z, fixed, t + 1, y + 1);
                    let mut e = t + 1;
                    while e < 32 && (ups[e] >> y) & 1 == 1 && self.skirt_mat(along_z, fixed, e + 1, y + 1) == mat {
                        e += 1;
                    }
                    self.emit_skirt(face, along_z, plane, t as i32, e as i32, y as i32 + 1, depth, mat);
                    t = e;
                }
            }
        }
    }

    #[inline]
    fn skirt_mat(&self, along_z: bool, fixed: usize, t: usize, y: usize) -> u8 {
        let (x, z) = if along_z { (fixed, t) } else { (t, fixed) };
        self.reg.mat[(x * N + z) * N + y]
    }

    fn emit_skirt(&mut self, face: usize, along_z: bool, plane: i32, t0: i32, t1: i32, ytop: i32, depth: i32, mat: u8) {
        if self.verts.len() / VERTEX_BYTES + 4 > MAX_VERTS {
            self.truncated = true;
            return;
        }
        let y0 = (ytop - depth).max(0);
        // quad corners: (bit = y, row = t): (y0,t0) (ytop,t0) (ytop,t1) (y0,t1)
        let cb = [y0, ytop, ytop, y0];
        let cr = [t0, t0, t1, t1];
        let base = (self.verts.len() / VERTEX_BYTES) as u16;
        let (w, h) = ((ytop - y0) as usize, (t1 - t0) as usize);
        for c in 0..4 {
            let p = if along_z { [plane, cb[c], cr[c]] } else { [cr[c], cb[c], plane] };
            self.push_vertex(p, face, 3, c as u8, true, mat, w, h);
        }
        for t in [[0u16, 1, 2], [0, 2, 3]] {
            let t = if FACE_FLIP[face] { [t[0], t[2], t[1]] } else { t };
            self.idx.extend_from_slice(&[base + t[0], base + t[1], base + t[2]]);
        }
        self.quads += 1;
        self.skirt_quads += 1;
    }
}
