//! Integer hash + value noise. Everything is exact integer math, so native and wasm agree bit for bit.

/// Same construction as `sim_world::voxel::h3` (murmur-style mix of seed and three coordinates).
#[inline]
pub fn h3(seed: u32, x: i32, y: i32, z: i32) -> u32 {
    let mut h = seed ^ 0x9E37_79B9;
    h = (h ^ (x as u32).wrapping_mul(0x85EB_CA6B)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h = (h ^ (y as u32).wrapping_mul(0xC2B2_AE35)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h = (h ^ (z as u32).wrapping_mul(0x27D4_EB2F)).rotate_left(13).wrapping_mul(5).wrapping_add(0xE654_6B64);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

/// `smoothstep` on 0..=256 -> 0..=256.
#[inline]
fn smooth(t: i32) -> i32 {
    (t * t * (768 - 2 * t)) >> 16
}

/// Fills `out[i * n + j]` (i along x, j along z) with 2D value noise 0..=255 for the integer L0-voxel positions
/// `x0 + i * step`, `z0 + j * step`, lattice spacing `cell` L0 voxels. Lattice values are hashed once per node.
pub fn value_noise_grid(seed: u32, cell: i32, x0: i32, z0: i32, step: i32, n: usize, out: &mut [u8], nodes: &mut Vec<u8>) {
    let last = (n as i32 - 1) * step;
    let xi0 = x0.div_euclid(cell);
    let zi0 = z0.div_euclid(cell);
    let nx = ((x0 + last).div_euclid(cell) - xi0 + 2) as usize;
    let nz = ((z0 + last).div_euclid(cell) - zi0 + 2) as usize;
    nodes.clear();
    for i in 0..nx {
        for j in 0..nz {
            nodes.push((h3(seed, xi0 + i as i32, 0, zi0 + j as i32) >> 24) as u8);
        }
    }
    for i in 0..n {
        let x = x0 + i as i32 * step;
        let xi = (x.div_euclid(cell) - xi0) as usize;
        let fx = x.rem_euclid(cell);
        let sx = smooth(((fx * 2 + 1) * 128) / cell);
        for j in 0..n {
            let z = z0 + j as i32 * step;
            let zi = (z.div_euclid(cell) - zi0) as usize;
            let fz = z.rem_euclid(cell);
            let sz = smooth(((fz * 2 + 1) * 128) / cell);
            let c = |dx: usize, dz: usize| i32::from(nodes[(xi + dx) * nz + zi + dz]);
            let a = c(0, 0) * (256 - sx) + c(1, 0) * sx;
            let b = c(0, 1) * (256 - sx) + c(1, 1) * sx;
            out[i * n + j] = ((a * (256 - sz) + b * sz) >> 16) as u8;
        }
    }
}
