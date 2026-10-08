//! Native unit tests: determinism, exactly-once face emission vs a naive reference, early-outs, seams, dirty list.

use crate::blocks::{self, Class};
use crate::mesh::{MC, Mesher};
use crate::voxgen::{N, Region, generate_region, micro, region_origin};
use crate::{GridDesc, Style, dirty_micro_chunks};
use std::collections::HashMap;
use std::sync::OnceLock;

// ------------------------------------------------------------------------------------------------- helpers

fn island() -> &'static Vec<u16> {
    static W: OnceLock<Vec<u16>> = OnceLock::new();
    W.get_or_init(|| {
        let sim = sim_core::Sim::build(1, |app| {
            app.add_plugins(sim_world::WorldPlugin);
        });
        let data = sim.world().resource::<sim_world::WorldData>();
        let blocks = data.world.0.read().unwrap().blocks.clone();
        blocks
    })
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 32) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

type Face = (u8, i32, i32, i32); // face, region x, y, z

/// Reference: every exposed unit face of the inner voxels with its material.
fn naive_faces(reg: &Region) -> HashMap<Face, u8> {
    let mut m = HashMap::new();
    for x in 1..=32usize {
        for z in 1..=32usize {
            for y in 1..=32usize {
                if !reg.solid_at(x, y, z) {
                    continue;
                }
                for (f, n) in [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].iter().enumerate() {
                    let (nx, ny, nz) = ((x as i32 + n[0]) as usize, (y as i32 + n[1]) as usize, (z as i32 + n[2]) as usize);
                    if !reg.solid_at(nx, ny, nz) {
                        m.insert((f as u8, x as i32, y as i32, z as i32), reg.material_at(x, y, z));
                    }
                }
            }
        }
    }
    m
}

/// Independent AO reference for the face of voxel (x,y,z) with normal index f: corners (0,0) (1,0) (1,1) (0,1) in (bit, row) axes.
fn naive_ao(reg: &Region, f: usize, x: i32, y: i32, z: i32) -> [u8; 4] {
    let (n, tb, tr): ([i32; 3], [i32; 3], [i32; 3]) = match f {
        0 => ([1, 0, 0], [0, 1, 0], [0, 0, 1]),
        1 => ([-1, 0, 0], [0, 1, 0], [0, 0, 1]),
        2 => ([0, 1, 0], [1, 0, 0], [0, 0, 1]),
        3 => ([0, -1, 0], [1, 0, 0], [0, 0, 1]),
        4 => ([0, 0, 1], [0, 1, 0], [1, 0, 0]),
        _ => ([0, 0, -1], [0, 1, 0], [1, 0, 0]),
    };
    let at = |a: i32, b: i32| -> u8 {
        let (px, py, pz) = (x + n[0] + a * tb[0] + b * tr[0], y + n[1] + a * tb[1] + b * tr[1], z + n[2] + a * tb[2] + b * tr[2]);
        u8::from(reg.solid_at(px as usize, py as usize, pz as usize))
    };
    let mut out = [0u8; 4];
    for (i, (ib, ir)) in [(0, 0), (1, 0), (1, 1), (0, 1)].iter().enumerate() {
        let (sb, sr) = (if *ib == 0 { -1 } else { 1 }, if *ir == 0 { -1 } else { 1 });
        let (s1, s2, c) = (at(sb, 0), at(0, sr), at(sb, sr));
        out[i] = if s1 == 1 && s2 == 1 { 0 } else { 3 - (s1 + s2 + c) };
    }
    out
}

/// Expands the non-skirt quads back into unit faces. Asserts structure (counts, indices, winding, AO pattern per unit face).
fn decode(m: &Mesher, reg: &Region, ao: bool) -> (HashMap<Face, u8>, usize) {
    let v = m.vertices();
    let idx = m.indices();
    assert_eq!(v.len() % 32, 0);
    let quads = v.len() / 32;
    assert_eq!(idx.len(), quads * 6);
    assert!(idx.iter().all(|&i| usize::from(i) < quads * 4));
    let mut out: HashMap<Face, u8> = HashMap::new();
    let mut skirts = 0;
    for q in 0..quads {
        let vs: Vec<[u8; 8]> = (0..4).map(|c| v[(q * 4 + c) * 8..(q * 4 + c) * 8 + 8].try_into().unwrap()).collect();
        let face = vs[0][3] & 7;
        assert!(vs.iter().all(|a| a[3] & 7 == face && a[4] == vs[0][4]));
        let skirt = vs[0][3] >> 7 == 1;
        // winding: both triangles face outward
        let n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][usize::from(face)];
        for t in 0..2 {
            let p = |k: usize| {
                let a = &vs[(idx[q * 6 + t * 3 + k] as usize) - q * 4];
                [i32::from(a[0]), i32::from(a[1]), i32::from(a[2])]
            };
            let (a, b, c) = (p(0), p(1), p(2));
            let (e1, e2) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
            assert!(dot > 0, "triangle winding/degenerate: face {face} dot {dot}");
        }
        if skirt {
            skirts += 1;
            continue;
        }
        let (mut mn, mut mx) = ([i32::MAX; 3], [i32::MIN; 3]);
        for a in &vs {
            for k in 0..3 {
                mn[k] = mn[k].min(i32::from(a[k]));
                mx[k] = mx[k].max(i32::from(a[k]));
            }
        }
        let pos = face & 1 == 0;
        let ax = usize::from(face >> 1);
        // plane position -> voxel index along the normal axis (region index = local + 1)
        let plane = if pos { mn[ax] - 1 } else { mn[ax] };
        assert_eq!(mn[ax], mx[ax]);
        let ranges: Vec<usize> = (0..3).filter(|&a| a != ax).collect();
        for a in mn[ranges[0]]..mx[ranges[0]] {
            for b in mn[ranges[1]]..mx[ranges[1]] {
                let mut c = [0i32; 3];
                c[ax] = plane + 1;
                c[ranges[0]] = a + 1;
                c[ranges[1]] = b + 1;
                let key = (face, c[0], c[1], c[2]);
                assert!(out.insert(key, vs[0][4]).is_none(), "face emitted twice: {key:?}");
                if ao {
                    // every unit face of the quad must carry the quad's per-vertex AO pattern
                    let nao = naive_ao(reg, usize::from(face), c[0], c[1], c[2]);
                    for (ci, a) in vs.iter().enumerate() {
                        assert_eq!((a[3] >> 3) & 3, nao[ci], "ao mismatch face {face} {c:?} corner {ci}");
                    }
                }
            }
        }
    }
    (out, skirts)
}

fn check_against_naive(m: &mut Mesher, ao: bool) {
    let h = m.mesh_region(ao, 0);
    assert!(!h.truncated);
    let (got, skirts) = decode(m, m.region(), ao);
    assert_eq!(skirts, 0);
    let want = naive_faces(m.region());
    assert_eq!(got.len(), want.len(), "face count differs");
    for (k, mat) in &want {
        assert_eq!(got.get(k), Some(mat), "missing / wrong material for {k:?}");
    }
}

fn fill_box(reg: &mut Region, lo: [usize; 3], hi: [usize; 3], dens: u32, rng: &mut Rng, nmat: u32) {
    for x in lo[0]..hi[0] {
        for z in lo[2]..hi[2] {
            for y in lo[1]..hi[1] {
                if rng.below(100) < dens {
                    reg.occ[x * N + z] |= 1 << y;
                    reg.mat[(x * N + z) * N + y] = 1 + rng.below(nmat) as u8;
                }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------- tests

#[test]
fn greedy_matches_naive_on_random_grids() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut m = Mesher::new();
    for case in 0..60 {
        m.region_mut().clear();
        let dens = [8, 30, 50, 75, 95][case % 5];
        let nmat = [1, 2, 4][case % 3];
        // boxes touching the apron and the inner boundaries
        let lo = [rng.below(12) as usize, rng.below(12) as usize, rng.below(12) as usize];
        let hi = [(lo[0] + 8 + rng.below(14) as usize).min(34), (lo[1] + 8 + rng.below(14) as usize).min(34), (lo[2] + 8 + rng.below(14) as usize).min(34)];
        let mut reg = std::mem::take(m.region_mut());
        fill_box(&mut reg, lo, hi, dens, &mut rng, nmat);
        *m.region_mut() = reg;
        check_against_naive(&mut m, case % 2 == 0);
    }
    // a big sparse volume over the whole region
    m.region_mut().clear();
    let mut reg = std::mem::take(m.region_mut());
    fill_box(&mut reg, [0; 3], [34; 3], 3, &mut rng, 3);
    *m.region_mut() = reg;
    check_against_naive(&mut m, true);
}

#[test]
fn greedy_merges_flat_areas() {
    let mut m = Mesher::new();
    // solid floor y <= 10 incl. apron, nothing else
    for x in 0..N {
        for z in 0..N {
            m.region_mut().occ[x * N + z] = (1u64 << 11) - 1;
            for y in 0..11 {
                m.region_mut().mat[(x * N + z) * N + y] = 7;
            }
        }
    }
    let h = m.mesh_region(true, 4);
    // one 32x32 top quad + one skirt per side
    assert_eq!(h.quads, 5);
    assert_eq!(h.skirt_quads, 4);
    assert_eq!(h.vertex_count, 20);
    assert_eq!(h.index_count, 30);
    assert!(!h.empty && !h.full);
    // skirts: on the boundary planes, hanging exactly `depth` below the top (y 10)
    let v = m.vertices();
    for q in 1..5 {
        for c in 0..4 {
            let a = &v[(q * 4 + c) * 8..(q * 4 + c) * 8 + 8];
            assert_eq!(a[3] >> 7, 1);
            let face = a[3] & 7;
            let on_plane = match face {
                0 => a[0] == 32,
                1 => a[0] == 0,
                4 => a[2] == 32,
                5 => a[2] == 0,
                _ => false,
            };
            assert!(on_plane, "skirt vertex off its boundary plane");
            assert!(a[1] == 10 || a[1] == 6, "skirt y {}", a[1]);
        }
    }
    assert_eq!(h.bbox[4], 10);
}

#[test]
fn empty_and_full_early_out() {
    let mut m = Mesher::new();
    let h = m.mesh_region(true, 4);
    assert!(h.empty && !h.full && h.vertex_count == 0 && m.vertices().is_empty() && m.indices().is_empty());
    for c in m.region_mut().occ.iter_mut() {
        *c = crate::voxgen::FULL34;
    }
    let h = m.mesh_region(true, 4);
    assert!(h.full && !h.empty && h.vertex_count == 0 && m.vertices().is_empty());
    // block-level: sky and deep underground of the real island
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let sky = m.mesh(blocks, &d, &Style::default(), 0, 0, 20, 0);
    assert!(sky.empty);
    let deep = m.mesh(blocks, &d, &Style::default(), 0, 0, -6, 0); // y = -12..-10 m: solid rock
    assert!(deep.full || deep.vertex_count == 0, "deep chunk should not emit faces: {deep:?}");
}

#[test]
fn deterministic_same_input_same_bytes() {
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let st = Style::default();
    let mut pooled = Mesher::new();
    let mut checked = 0;
    for (level, cx, cy, cz) in [(0u8, 3, 0, 5), (0, -20, 0, 8), (0, 12, 1, -14), (1, -4, 0, 3), (2, 2, 0, -2), (3, 0, 0, 0)] {
        let a = pooled.mesh(blocks, &d, &st, level, cx, cy, cz);
        let (va, ia) = (pooled.vertices().to_vec(), pooled.indices().to_vec());
        // reuse the pooled mesher after meshing something else, then compare with a brand new one
        pooled.mesh(blocks, &d, &st, 0, 9, 0, 9);
        let b = pooled.mesh(blocks, &d, &st, level, cx, cy, cz);
        let mut fresh = Mesher::new();
        let c = fresh.mesh(blocks, &d, &st, level, cx, cy, cz);
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(va, pooled.vertices());
        assert_eq!(ia, pooled.indices());
        assert_eq!(va, fresh.vertices());
        assert_eq!(ia, fresh.indices());
        checked += usize::from(a.vertex_count > 0);
    }
    assert!(checked >= 3, "test chunks should contain geometry");
}

#[test]
fn real_chunks_are_exactly_once_and_wound_correctly() {
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let st = Style::default();
    let mut m = Mesher::new();
    let mut seen = 0;
    for cx in -20..20 {
        for cz in (-10..10).step_by(3) {
            for cy in -1..3 {
                let h = m.mesh(blocks, &d, &st, 0, cx, cy, cz);
                if h.vertex_count == 0 {
                    continue;
                }
                assert!(!h.truncated, "{h:?}");
                let (got, _) = decode(&m, m.region(), true);
                let want = naive_faces(m.region());
                assert_eq!(got.len(), want.len(), "chunk {cx},{cy},{cz}");
                for (k, mat) in &want {
                    assert_eq!(got.get(k), Some(mat));
                    assert_ne!(*mat, 0, "face without a material at {k:?} chunk {cx},{cy},{cz}");
                }
                seen += 1;
            }
        }
    }
    assert!(seen > 30, "only {seen} real chunks had geometry");
}

#[test]
fn micro_function_matches_region_generation() {
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let st = Style::default();
    let mut reg = Region::new();
    let mut sc = crate::GenScratch::default();
    let mut rng = Rng(77);
    for level in 0..=2u8 {
        let origin = region_origin(1, 0, 2);
        generate_region(blocks, &d, &st, level, origin, &mut reg, &mut sc);
        for _ in 0..40 {
            let (x, y, z) = (rng.below(32) as usize + 1, rng.below(32) as usize + 1, rng.below(32) as usize + 1);
            let (s, mat) = micro(blocks, &d, &st, level, origin[0] + x as i32, origin[1] + y as i32, origin[2] + z as i32);
            assert_eq!(s, reg.solid_at(x, y, z));
            if s {
                assert_eq!(mat, u16::from(reg.material_at(x, y, z)));
            }
        }
    }
}

#[test]
fn neighbouring_regions_agree_on_shared_voxels() {
    // The micro function is a pure function of world position: overlapping voxels of adjacent chunks must be identical.
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let st = Style::default();
    let (mut a, mut b) = (Region::new(), Region::new());
    let mut sc = crate::GenScratch::default();
    let mut compared = 0u32;
    for level in 0..=3u8 {
        for (base, axis) in [((2, 0, 1), 0usize), ((2, 0, 1), 1), ((2, 0, 1), 2), ((-6, 0, 3), 0), ((-6, 0, 3), 2)] {
            let oa = region_origin(base.0, base.1, base.2);
            let mut nb = [base.0, base.1, base.2];
            nb[axis] += 1;
            let ob = region_origin(nb[0], nb[1], nb[2]);
            generate_region(blocks, &d, &st, level, oa, &mut a, &mut sc);
            generate_region(blocks, &d, &st, level, ob, &mut b, &mut sc);
            for i in 0..N {
                for j in 0..N {
                    for k in 0..2usize {
                        // slab: A index 32 + k  <->  B index k along `axis`
                        let (pa, pb) = match axis {
                            0 => ([32 + k, i, j], [k, i, j]),
                            1 => ([i, 32 + k, j], [i, k, j]),
                            _ => ([i, j, 32 + k], [i, j, k]),
                        };
                        let (sa, sb) = (a.solid_at(pa[0], pa[1], pa[2]), b.solid_at(pb[0], pb[1], pb[2]));
                        assert_eq!(sa, sb, "level {level} axis {axis} {pa:?}");
                        if sa {
                            assert_eq!(a.material_at(pa[0], pa[1], pa[2]), b.material_at(pb[0], pb[1], pb[2]));
                            compared += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(compared > 1000);
}

#[test]
fn block_table_matches_sim_core() {
    use sim_core::blocks::{BLOCKS, flag};
    for def in BLOCKS.iter() {
        let c = blocks::class(def.id);
        let solid = def.flags & flag::SOLID != 0;
        assert_eq!(blocks::solid(def.id), solid, "{} solid", def.name);
        assert_eq!(c == Class::Liquid, def.flags & flag::LIQUID != 0, "{} liquid", def.name);
        assert_eq!(c == Class::Leaf, def.flags & flag::FOLIAGE != 0, "{} leaf", def.name);
        if def.id != 0 {
            assert_ne!(c, Class::Air, "{} unclassified", def.name);
        }
    }
    assert_eq!(BLOCKS.len(), blocks::COUNT);
}

#[test]
fn grid_desc_matches_sim_world() {
    use sim_world::voxel as v;
    let d = GridDesc::GLIMMERWICK;
    assert_eq!((d.nx, d.ny, d.nz, d.ch), (v::NX as i32, v::NY as i32, v::NZ as i32, v::CH as i32));
    assert_eq!((d.origin_x, d.origin_z, d.sea_y), (v::ORIGIN_X, v::ORIGIN_Z, v::SEA_Y));
    assert_eq!(d.total_cells(), v::TOTAL_CELLS);
    let blocks = island();
    let mut rng = Rng(5);
    for _ in 0..2000 {
        let (x, y, z) = (rng.below(360) as i32 - 170, rng.below(70) as i32 - 20, rng.below(300) as i32 - 140);
        let want = if y + d.sea_y < 0 { 39 } else { sim_world_get(blocks, x, y, z) };
        assert_eq!(d.block(blocks, x, y, z), want);
    }
}

/// Independent re-implementation of `VoxelWorld::cell` for the cross-check.
fn sim_world_get(blocks: &[u16], x: i32, y: i32, z: i32) -> u16 {
    use sim_world::voxel as v;
    let (ix, iy, iz) = (x - v::ORIGIN_X, y + v::SEA_Y, z - v::ORIGIN_Z);
    if iy >= v::NY as i32 || ix < 0 || iz < 0 || ix >= v::NX as i32 || iz >= v::NZ as i32 {
        return 0;
    }
    blocks[v::VoxelWorld::cell(ix as usize, iy as usize, iz as usize)]
}

#[test]
fn dirty_list_covers_every_changed_chunk() {
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let st = Style::default();
    let mut m = Mesher::new();
    // find a few surface blocks: first non-air block from the top in some columns, edit them (remove / replace)
    let mut cases = Vec::new();
    for (x, z) in [(0, 0), (20, -30), (-40, 25), (60, 10)] {
        let mut y = 30;
        while y > -10 && blocks::class(d.block(blocks, x, y, z)) == Class::Air {
            y -= 1;
        }
        cases.push([x, y, z]);
    }
    for bpos in cases {
        let mut edited = blocks.clone();
        let idx = {
            let (ix, iy, iz) = ((bpos[0] - d.origin_x) as usize, (bpos[1] + d.sea_y) as usize, (bpos[2] - d.origin_z) as usize);
            sim_world::voxel::VoxelWorld::cell(ix, iy, iz)
        };
        edited[idx] = if edited[idx] == 3 { 0 } else { 3 };
        for level in 0u8..=3 {
            let dirty = dirty_micro_chunks(bpos);
            let r = 16i32 >> level;
            let c0 = [bpos[0] * r / 32, bpos[1] * r / 32, bpos[2] * r / 32];
            let mut changed = 0;
            for cy in c0[1] - 2..=c0[1] + 2 {
                for cz in c0[2] - 2..=c0[2] + 2 {
                    for cx in c0[0] - 2..=c0[0] + 2 {
                        let ha = m.mesh(blocks, &d, &st, level, cx, cy, cz);
                        let (va, ia) = (m.vertices().to_vec(), m.indices().to_vec());
                        let hb = m.mesh(&edited, &d, &st, level, cx, cy, cz);
                        let differs = ha != hb || va != m.vertices() || ia != m.indices();
                        if differs {
                            changed += 1;
                            assert!(dirty.contains(&(level, cx, cy, cz)), "chunk {:?} changed but is not in the dirty list (block {bpos:?})", (level, cx, cy, cz));
                        }
                    }
                }
            }
            assert!(changed > 0 || level >= 2, "edit changed no chunk at level {level}");
        }
    }
}

#[test]
fn dirty_list_sizes() {
    let l = dirty_micro_chunks([5, 3, -7]);
    let l0 = l.iter().filter(|k| k.0 == 0).count();
    assert!((8..=27).contains(&l0), "L0 dirty chunks {l0}");
    assert!(l.iter().any(|k| k.0 == 3));
}

#[test]
fn style_changes_the_output() {
    let blocks = island();
    let d = GridDesc::GLIMMERWICK;
    let mut m = Mesher::new();
    let flat = Style { relief_hi: 0, relief_lo: 0, side_inset_density: 0, strata_band: 0, tuft_density: 0, pebble_density: 0, ..Style::default() };
    let (mut qa, mut qb) = (0, 0);
    for cx in (-30..30).step_by(2) {
        for cz in (-20..20).step_by(2) {
            for cy in -1..4 {
                qa += m.mesh(blocks, &d, &Style::default(), 0, cx, cy, cz).quads;
                qb += m.mesh(blocks, &d, &flat, 0, cx, cy, cz).quads;
            }
        }
    }
    assert!(qa > qb && qb > 0, "relief must add geometry: {qa} vs {qb}");
    let _ = MC;
}
