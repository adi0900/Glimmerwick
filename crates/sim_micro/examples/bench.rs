//! M1 benchmark: `cargo run --release -p sim_micro --example bench [-- --stride 3]`
//!
//! * timing: full pipeline (bit-column generation + greedy meshing + skirts) per micro-chunk on the seed-1 island,
//!   p50 / p95 / max over chunks that contain geometry, plus the cost of the empty / full early-outs;
//! * density: triangles per m^2 of ground footprint for flat / relief / forest / cliff / beach / meadow areas and levels L0..L3.

mod common;
use common::*;
use sim_micro::{GenScratch, Mesher, Region, Style, generate_region, region_origin};
use std::time::Instant;

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * p) as usize] }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let stride: i32 = args.iter().position(|a| a == "--stride").and_then(|i| args.get(i + 1)).and_then(|s| s.parse().ok()).unwrap_or(3);
    let t0 = Instant::now();
    let blocks = island(1);
    println!("island(seed 1) generated in {:.2} s", t0.elapsed().as_secs_f32());
    let st = Style::default();
    let mut m = Mesher::new();
    let (mut greg, mut gsc) = (Region::new(), GenScratch::default());

    // ---- timing per level
    for level in 0u8..=3 {
        let span = 2 << level; // metres per chunk
        let (cx0, cx1) = (-160 / span - 1, 192 / span + 1);
        let (cz0, cz1) = (-136 / span - 1, 152 / span + 1);
        let (cy0, cy1) = (-8 / span - 1, 24 / span + 1);
        let s = if level == 0 { stride } else { 1.max(stride >> level) };
        // warm-up
        for cx in 0..8 {
            m.mesh(&blocks, &D, &st, level, cx, 0, 0);
        }
        let mut gen_ms: Vec<f64> = Vec::new();
        let (mut geo, mut early, mut tris, mut quads, mut skirt, mut verts) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), 0u64, Vec::new());
        let mut n_empty = 0;
        let mut n_full = 0;
        let mut trunc = 0;
        let mut cx = cx0;
        while cx <= cx1 {
            let mut cz = cz0;
            while cz <= cz1 {
                for cy in cy0..=cy1 {
                    let t = Instant::now();
                    let h = m.mesh(&blocks, &D, &st, level, cx, cy, cz);
                    let ms = t.elapsed().as_secs_f64() * 1000.0;
                    if h.vertex_count > 0 {
                        let t = Instant::now();
                        generate_region(&blocks, &D, &st, level, region_origin(cx, cy, cz), &mut greg, &mut gsc);
                        gen_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                        geo.push(ms);
                        tris.push(f64::from(h.index_count / 3));
                        quads.push(f64::from(h.quads));
                        verts.push(f64::from(h.vertex_count));
                        skirt += u64::from(h.skirt_quads);
                        trunc += usize::from(h.truncated);
                    } else {
                        early.push(ms);
                        n_empty += usize::from(h.empty);
                        n_full += usize::from(h.full);
                    }
                }
                cz += s;
            }
            cx += s;
        }
        let n = geo.len();
        let mean_tri = tris.iter().sum::<f64>() / n.max(1) as f64;
        println!(
            "L{level}: {n} chunks with geometry | ms p50 {:.4}  p95 {:.4}  p99 {:.4}  max {:.4}  mean {:.4} | tris/chunk p50 {:.0} p95 {:.0} mean {:.0} | verts p95 {:.0} | skirt quads/chunk {:.1} | truncated {trunc}",
            pct(&mut geo.clone(), 0.5),
            pct(&mut geo.clone(), 0.95),
            pct(&mut geo.clone(), 0.99),
            pct(&mut geo.clone(), 1.0),
            geo.iter().sum::<f64>() / n.max(1) as f64,
            pct(&mut tris.clone(), 0.5),
            pct(&mut tris.clone(), 0.95),
            mean_tri,
            pct(&mut verts.clone(), 0.95),
            skirt as f64 / n.max(1) as f64
        );
        println!("    of which generation only: p50 {:.4} p95 {:.4} (meshing = remainder)", pct(&mut gen_ms.clone(), 0.5), pct(&mut gen_ms.clone(), 0.95));
        println!(
            "    early-outs: {} chunks (empty {n_empty}, full {n_full}) | ms p50 {:.4} p95 {:.4}",
            early.len(),
            pct(&mut early.clone(), 0.5),
            pct(&mut early.clone(), 0.95)
        );
    }

    // ---- triangle density per area
    println!("\ntriangles per m^2 of ground footprint (all chunks in the column, skirts included / excluded)");
    let flat = Style { relief_lo: 0, relief_hi: 0, side_inset_density: 0, strata_band: 0, tuft_density: 0, pebble_density: 0, ..Style::default() };
    let styles: [(&str, &Style); 2] = [("relief (default)", &st), ("flat (bevel only)", &flat)];
    for (area, name) in common::AREAS {
        let cells = find_cells(&blocks, area, 120, 0xA11CE ^ (name.len() as u64));
        if cells.is_empty() {
            println!("{name}: no cells found");
            continue;
        }
        for (sname, sty) in styles {
            for level in 0u8..=3 {
                let span = 2i32 << level;
                let mut per_m2 = Vec::new();
                let mut per_m2_noskirt = Vec::new();
                for &(x, z) in &cells {
                    let (cx, cz) = (x.div_euclid(span), z.div_euclid(span));
                    let (mut t, mut ts) = (0u32, 0u32);
                    for cy in (-8 / span - 1)..=(40 / span + 1) {
                        let h = m.mesh(&blocks, &D, sty, level, cx, cy, cz);
                        t += h.index_count / 3;
                        ts += (h.index_count / 3).saturating_sub(h.skirt_quads * 2);
                    }
                    let area_m2 = (span * span) as f64;
                    per_m2.push(f64::from(t) / area_m2);
                    per_m2_noskirt.push(f64::from(ts) / area_m2);
                }
                println!(
                    "{name:7} {sname:18} L{level}: tris/m^2 median {:7.1}  mean {:7.1}  p90 {:7.1} | without skirts median {:7.1}   ({} cells)",
                    pct(&mut per_m2.clone(), 0.5),
                    per_m2.iter().sum::<f64>() / per_m2.len() as f64,
                    pct(&mut per_m2.clone(), 0.9),
                    pct(&mut per_m2_noskirt.clone(), 0.5),
                    cells.len()
                );
            }
        }
    }
}
