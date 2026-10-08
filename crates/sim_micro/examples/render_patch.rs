//! Visual check of the M1 mesher without the game renderer: meshes a patch of the real island and draws an oblique orthographic
//! view with a tiny software rasteriser (z-buffer, per-vertex AO, per-voxel hash tint, sun lambert), writing a PNG.
//!
//! `cargo run --release -p sim_micro --example render_patch -- --out shots/voxel/m1 [--size 10] [--level 0] [--yaw 35] [--pitch 38]`
//! renders the four preset areas (meadow, beach, forest, cliff). `--center x,z` renders one explicit spot.

mod common;
use common::*;
use sim_micro::noise::h3;
use sim_micro::{Mesher, Style};
use std::io::Write;

const SS: usize = 2; // supersampling

struct Img {
    w: usize,
    h: usize,
    rgb: Vec<f32>,
    z: Vec<f32>,
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        table[i as usize] = c;
    }
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = table[((c ^ u32::from(b)) & 255) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn write_png(path: &str, w: usize, h: usize, rgb: &[u8]) {
    let mut raw = Vec::with_capacity((w * 3 + 1) * h);
    for y in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgb[y * w * 3..(y + 1) * w * 3]);
    }
    // zlib, stored blocks
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65535).peekable();
    while let Some(c) = chunks.next() {
        z.push(u8::from(chunks.peek().is_none()));
        z.extend_from_slice(&(c.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(c.len() as u16)).to_le_bytes());
        z.extend_from_slice(c);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |ty: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = ty.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    if let Some(dir) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::File::create(path).unwrap().write_all(&out).unwrap();
}

#[derive(Clone, Copy)]
struct V {
    p: [f32; 3],
    ao: f32,
}

struct Cam {
    right: [f32; 3],
    up: [f32; 3],
    dir: [f32; 3],
    c: [f32; 3],
    scale: f32,
    w: f32,
    h: f32,
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

impl Cam {
    fn project(&self, p: [f32; 3]) -> [f32; 3] {
        let q = [p[0] - self.c[0], p[1] - self.c[1], p[2] - self.c[2]];
        [self.w * 0.5 + dot(q, self.right) * self.scale, self.h * 0.5 - dot(q, self.up) * self.scale, dot(q, self.dir)]
    }
}

fn shade(base: [f32; 3], n: [f32; 3], ao: f32, voxel: [i32; 3], tint: f32) -> [f32; 3] {
    let sun = [0.45f32, 0.80, 0.40];
    let l = (dot(n, sun) / dot(sun, sun).sqrt()).max(0.0);
    let hv = h3(77, voxel[0], voxel[1], voxel[2]);
    let v = 1.0 + (((hv & 255) as f32 / 255.0) - 0.5) * 0.16 * tint;
    let light = (0.42 + 0.72 * l) * (0.50 + 0.50 * ao / 3.0) * v;
    [(base[0] * light).min(1.0), (base[1] * light).min(1.0), (base[2] * light).min(1.0)]
}

#[allow(clippy::too_many_arguments)]
fn raster(img: &mut Img, cam: &Cam, tri: [V; 3], n: [f32; 3], base: [f32; 3], vs: f32, alpha: f32, flat_ao: bool) {
    let s: Vec<[f32; 3]> = tri.iter().map(|v| cam.project(v.p)).collect();
    let (minx, maxx) = (s.iter().map(|p| p[0]).fold(f32::MAX, f32::min).floor().max(0.0), s.iter().map(|p| p[0]).fold(f32::MIN, f32::max).ceil().min(img.w as f32 - 1.0));
    let (miny, maxy) = (s.iter().map(|p| p[1]).fold(f32::MAX, f32::min).floor().max(0.0), s.iter().map(|p| p[1]).fold(f32::MIN, f32::max).ceil().min(img.h as f32 - 1.0));
    let area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
    if area.abs() < 1e-6 {
        return;
    }
    let inv = 1.0 / area;
    for y in miny as usize..=maxy as usize {
        for x in minx as usize..=maxx as usize {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let w0 = ((s[1][0] - px) * (s[2][1] - py) - (s[2][0] - px) * (s[1][1] - py)) * inv;
            let w1 = ((s[2][0] - px) * (s[0][1] - py) - (s[0][0] - px) * (s[2][1] - py)) * inv;
            let w2 = 1.0 - w0 - w1;
            if w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4 {
                continue;
            }
            let z = w0 * s[0][2] + w1 * s[1][2] + w2 * s[2][2];
            let i = y * img.w + x;
            if z >= img.z[i] {
                continue;
            }
            let wp = [0, 1, 2].map(|k| w0 * tri[0].p[k] + w1 * tri[1].p[k] + w2 * tri[2].p[k]);
            let ao = if flat_ao { 3.0 } else { w0 * tri[0].ao + w1 * tri[1].ao + w2 * tri[2].ao };
            // voxel under the pixel: step half a voxel into the surface
            let vx = [0, 1, 2].map(|k| ((wp[k] - 0.5 * vs * n[k]) / vs).floor() as i32);
            let c = shade(base, n, ao, vx, 1.0);
            if alpha >= 1.0 {
                img.z[i] = z;
                img.rgb[i * 3..i * 3 + 3].copy_from_slice(&c);
            } else {
                for k in 0..3 {
                    img.rgb[i * 3 + k] = img.rgb[i * 3 + k] * (1.0 - alpha) + c[k] * alpha;
                }
            }
        }
    }
}

struct Opts {
    size: f32,
    level: u8,
    yaw: f32,
    pitch: f32,
    out: String,
    center: Option<(f32, f32)>,
    w: usize,
    h: usize,
    noao: bool,
    style: Style,
}

fn render(blocks: &[u16], m: &mut Mesher, name: &str, cx: f32, cz: f32, o: &Opts) {
    let vs = (1 << o.level) as f32 / 16.0;
    let span = 2i32 << o.level;
    let half = o.size / 2.0;
    let ground = top_solid(blocks, cx as i32, cz as i32).map(|t| t.0).unwrap_or(0) as f32;
    let (x0, x1) = (cx - half, cx + half);
    let (z0, z1) = (cz - half, cz + half);
    let mut tris: Vec<([V; 3], [f32; 3], u8)> = Vec::new();
    let ymin = ((ground - 6.0) as i32).div_euclid(span);
    let ymax = ((ground + 12.0) as i32).div_euclid(span);
    for ccy in ymin..=ymax {
        for ccz in (z0.floor() as i32).div_euclid(span)..=(z1.ceil() as i32).div_euclid(span) {
            for ccx in (x0.floor() as i32).div_euclid(span)..=(x1.ceil() as i32).div_euclid(span) {
                let h = m.mesh(blocks, &D, &o.style, o.level, ccx, ccy, ccz);
                if h.vertex_count == 0 {
                    continue;
                }
                let org = [(ccx * 32) as f32 * vs, (ccy * 32) as f32 * vs, (ccz * 32) as f32 * vs];
                let vb = m.vertices();
                let verts: Vec<(V, u8, u8)> = (0..h.vertex_count as usize)
                    .map(|i| {
                        let b = &vb[i * 8..i * 8 + 8];
                        let p = [org[0] + f32::from(b[0]) * vs, org[1] + f32::from(b[1]) * vs, org[2] + f32::from(b[2]) * vs];
                        (V { p, ao: f32::from((b[3] >> 3) & 3) }, b[3] & 7, b[4])
                    })
                    .collect();
                for t in m.indices().chunks(3) {
                    let (a, b, c) = (verts[t[0] as usize], verts[t[1] as usize], verts[t[2] as usize]);
                    let cen = [(a.0.p[0] + b.0.p[0] + c.0.p[0]) / 3.0, (a.0.p[2] + b.0.p[2] + c.0.p[2]) / 3.0];
                    if cen[0] < x0 || cen[0] > x1 || cen[1] < z0 || cen[1] > z1 {
                        continue;
                    }
                    let n = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]][usize::from(a.1)];
                    tris.push(([a.0, b.0, c.0], n, a.2));
                }
            }
        }
    }
    let (w, h) = (o.w * SS, o.h * SS);
    let (yaw, pitch) = (o.yaw.to_radians(), o.pitch.to_radians());
    let dir = [pitch.cos() * yaw.sin(), -pitch.sin(), pitch.cos() * yaw.cos()];
    let right = [yaw.cos(), 0.0, -yaw.sin()];
    let up = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]];
    let up = if up[1] < 0.0 { [-up[0], -up[1], -up[2]] } else { up };
    let cam = Cam { right, up, dir, c: [cx, ground + 0.8, cz], scale: o.w as f32 * SS as f32 / (o.size * 1.42), w: w as f32, h: h as f32 };
    let mut img = Img { w, h, rgb: vec![0.0; w * h * 3], z: vec![f32::MAX; w * h] };
    // sky gradient
    for y in 0..h {
        let t = y as f32 / h as f32;
        for x in 0..w {
            let i = (y * w + x) * 3;
            img.rgb[i] = 0.62 + 0.2 * (1.0 - t);
            img.rgb[i + 1] = 0.74 + 0.12 * (1.0 - t);
            img.rgb[i + 2] = 0.9;
        }
    }
    for (t, n, mat) in &tris {
        let col = sim_core::blocks::def(u16::from(*mat)).color;
        let base = [f32::from(col[0]) / 255.0, f32::from(col[1]) / 255.0, f32::from(col[2]) / 255.0];
        // linear-ish tone so greens are not neon
        let base = base.map(|c| c.powf(1.15));
        raster(&mut img, &cam, *t, *n, base, vs, 1.0, o.noao);
    }
    // sea plane at y = -0.05 (water is a separate mesh in the game)
    let sea = |x: f32, z: f32| V { p: [x, -0.05, z], ao: 3.0 };
    let (a, b, c, d) = (sea(x0 - 1.0, z0 - 1.0), sea(x1 + 1.0, z0 - 1.0), sea(x1 + 1.0, z1 + 1.0), sea(x0 - 1.0, z1 + 1.0));
    for t in [[a, b, c], [a, c, d]] {
        raster(&mut img, &cam, t, [0.0, 1.0, 0.0], [0.17, 0.62, 0.78], 100.0, 0.55, true);
    }
    // resolve
    let mut out = vec![0u8; o.w * o.h * 3];
    for y in 0..o.h {
        for x in 0..o.w {
            for k in 0..3 {
                let mut acc = 0.0;
                for sy in 0..SS {
                    for sx in 0..SS {
                        acc += img.rgb[((y * SS + sy) * w + x * SS + sx) * 3 + k];
                    }
                }
                let v = (acc / (SS * SS) as f32).clamp(0.0, 1.0).powf(1.0 / 1.05);
                out[(y * o.w + x) * 3 + k] = (v * 255.0 + 0.5) as u8;
            }
        }
    }
    let path = format!("{}/{}.png", o.out, name);
    write_png(&path, o.w, o.h, &out);
    println!("{path}: {} triangles, centre ({cx},{cz}), size {} m, level {}", tris.len(), o.size, o.level);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let mut style = Style::default();
    if let Some(v) = get("--relief") {
        let a: i8 = v.parse().unwrap();
        style.relief_hi = a;
        style.relief_lo = -a - 1 + i8::from(a == 0);
    }
    let o = Opts {
        size: get("--size").and_then(|s| s.parse().ok()).unwrap_or(10.0),
        level: get("--level").and_then(|s| s.parse().ok()).unwrap_or(0),
        yaw: get("--yaw").and_then(|s| s.parse().ok()).unwrap_or(35.0),
        pitch: get("--pitch").and_then(|s| s.parse().ok()).unwrap_or(38.0),
        out: get("--out").unwrap_or_else(|| "shots/voxel/m1".into()),
        center: get("--center").and_then(|s| {
            let mut it = s.split(',');
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        }),
        w: get("--w").and_then(|s| s.parse().ok()).unwrap_or(1400),
        h: get("--h").and_then(|s| s.parse().ok()).unwrap_or(900),
        noao: args.iter().any(|a| a == "--noao"),
        style,
    };
    let tag = get("--tag").unwrap_or_default();
    let blocks = island(1);
    let mut m = Mesher::new();
    if let Some((x, z)) = o.center {
        render(&blocks, &mut m, &format!("spot{tag}"), x, z, &o);
        return;
    }
    for (area, name) in AREAS {
        let cells = find_cells(&blocks, area, 12, 0xC0FFEE);
        // pick the cell nearest to the cluster median for a representative view
        let Some(&(x, z)) = cells.get(cells.len() / 2) else {
            println!("{name}: no area found");
            continue;
        };
        render(&blocks, &mut m, &format!("{name}{tag}"), x as f32 + 1.0, z as f32 + 1.0, &o);
    }
}
