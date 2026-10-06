# Micro-voxel world, stage 2 — study notes and recommended architecture

Analyst notes (2026-10-06). Sources: John Lin's three MIT repos (read via shallow clones, deleted afterwards) plus general public knowledge of binary greedy meshing and clipmap LOD. Everything below is written in our own words. **Nothing here was measured on our hardware**: every triangle/ms figure is an estimate from stated assumptions and must be confirmed by the M1/M2 benchmarks.

Terminology: **voxel** = 1/16 m cube (L0). **Block** = today's 1 m world cell (`world.set_block`), seen as 16x16x16 voxels. **MC** = micro-chunk, the unit of generation, meshing, upload and culling.

---------------------------------------------------------------------------------------------------

## 1. What the three repos do (and what we can use)

### 1.1 BinaryMeshFitting (C++, MIT, 2018) — the relevant one
Files studied: `ChunkBlocks.hpp`, `ChunkGenerator.cpp`, `DMCChunk.cpp`, `WorldOctree.cpp/.hpp`, `WorldOctreeNode.cpp`, `WorldWatcher.cpp`, `WorldStitcher.cpp/.hpp`, `MeshProcessor.cpp`, `NoiseSampler.cpp`, `DefaultOptions.h`, `README.md`.

* **LOD structure.** A world octree (`WorldOctree`); every leaf is meshed from a *fixed* 32^3 sample grid (`chunk_resolution = 32`), whatever its size. So a node one level up covers 2x the space with the same cost: constant work per chunk, geometric growth of reach (levels 1..7 by default). Split rule: a node splits when its centre is closer to the focus than `size*split_mult + size/2`; merge rule uses a 2x larger multiplier (`group_multiplier = 2*split_multiplier`). That gap is hysteresis, so chunks do not flicker between LODs as the camera jitters. **Take this directly**: constant-cost chunks + hysteresis.
* **Making meshing fast.** Density noise comes in blocks (FastNoiseSIMD, 4 B/sample, transient, ~128 KB per chunk), is immediately collapsed to **1 bit per sample** (`label_grid`: one `uint32` holds 32 z-samples, `m |= 1<<z` when the sample is inside). Everything after that works on bit columns: sign changes between neighbours are found with word-wide operations, and a 64-bit "8x8 mask" (`1ull << (z*8+m)`) marks cell edges in `label_edges`. Chunks whose columns are all-0 or all-1 are flagged `contains_mesh=false` and skipped. Work buffers (`BinaryBlock`, `DensityBlock`, `MasksBlock`, `IsoVertexBlock`...) come from per-type pooled allocators (`ResourceAllocator`, `MemoryPool`) and are freed back the moment the mesh exists; extraction runs under `#pragma omp parallel for` over a batch. A background `WorldWatcher` thread owns the queue; the main thread only uploads. The author's article on pseudo-SIMD mask building (linked from the README) is the same idea. **Take: bits first, pool buffers, batch + thread, early-out on empty/full chunks.**
* **Surface shape.** Dual marching cubes on the binary grid, then optional "dual/primal mesh optimisation" (`MeshProcessor`, `process_iters`, default 0) that relaxes vertices toward a smooth surface. Irrelevant for a cube world (we want sharp voxels); skip.
* **Seams.** Chunks sample a slightly oversized region (`overlap = 0.035`, so neighbours overlap a few percent) and `WorldStitcher` (849 lines: `stitch_face_xy/zy/xz`, `stitch_edge_x/y/z`) walks the octree to build crack-closing geometry across LOD borders. Note `enable_stitching = false` by default: the author's own default was *no* stitching. Heavy machinery for smooth surfaces; for cubes **skirts** are far cheaper (section 2.7).
* **Memory.** Transient: 4 B/voxel float density + 1 bit/voxel binary + per-vertex dual-vertex structs (a fat ~40 B struct with adjacency data) — fine on a desktop with threads, too fat for us; we keep only the 1-bit grid and emit 8 B vertices.
* **Procedural generation, edits.** The world is a pure function of position (`NoiseSampler`: fractal value noise, 2D perturbed terrain); nothing is stored. README lists "realtime modification" as *not done*. So there is **no edit-storage idea to borrow**; our overlay design (2.5) is our own.

### 1.2 PushingVoxelsForward (C, MIT, 2017) — the predecessor
Files studied: `THierarchy.h/.c` (+ README, tree list). SnapMC (marching cubes with vertices snapped to grid points) on a **tetrahedral hierarchy**: six top-level tetrahedra, "diamond" refinement (adjacent tetrahedra that must split together are grouped in a `TDiamond`, found via a hash map keyed by the shared vertex), 18 LOD levels, a split-check queue driven by distance to `focus_point`. The diamond rule is how it gets crack-free LOD *without* separate stitching. Interesting but built around smooth isosurfaces, not axis-aligned cubes; its README benchmark (256^3 in ~1 s on a 2012 CPU) is 3 orders of magnitude slower than binary meshing. **Concept only: view-dependent split queue, "split together or not at all" to avoid cracks.** We get the same property for free with clipmap rings + skirts.

### 1.3 isosurface (C#/XNA, MIT, 2016) — dual contouring zoo
Files studied: `ManifoldDC/MDC3D.cs`, `AdaptiveDualContouring/Octree.cs` (+ `ADC3D.cs`), `UniformDualContouring/DC3D.cs`, `QEFSolver/*`, README. Reference implementations of (adaptive/manifold) dual contouring with a QEF vertex solver and octree simplification (`Simplify(threshold)` collapses children while the QEF error stays below a threshold). Author states they are unoptimised and not paper-exact. **Not useful**: we need sharp-edged cubes, not Hermite surfaces. The one transferable idea — error-driven octree simplification — has an easier equivalent for us (coarsening by ring; flat regions merge anyway under greedy meshing).

### 1.4 Verdict
**Recommend: concepts only, no code adapted**, original Rust. The *techniques that matter* (binary bit-columns, constant-cost chunks, split/merge hysteresis, pooled buffers, threaded generation, skip empty chunks) are generic and are all re-derived below for cube voxels. The *code* is smooth-surface-specific (dual marching cubes, tables, QEF) and C++/OpenMP/OpenGL-bound. If a later agent does lift anything (we advise against), it must keep the MIT notice and be listed per file in `THIRD_PARTY.md`; the only candidates would be generic pooling helpers (`MemoryPool.h/.tcc`, `ResourceAllocator.hpp`) — trivial to rewrite instead.

---------------------------------------------------------------------------------------------------

## 2. Recommended architecture for Glimmerwick

### 2.1 Core idea: the micro-voxel world is a *pure function* of the 1 m block grid
Never store 26 billion voxels (352x288x56 m = 5.7 M m^3 x 4096 voxels = 23 G). A voxel's solidity/material is computed on demand by `micro(x,y,z, level) -> (solid, material)`:

1. look up the 1 m block `B` containing the voxel (O(1) in `vox.data`, u16 ids) and its 6 face-neighbours (and for bevels the 12 edge-neighbours);
2. start from the full cube; **bevel** every edge/corner that borders air by 1-2 voxels (rounded-box look, in the spirit of the existing bevel shader but now real geometry);
3. **relief**: on exposed top faces of soft blocks (grass, dirt, sand, snow) displace the surface by a per-column value in [-2, +1] voxels from hashed 2D noise at a 2-3 voxel feature size; on rock faces carve strata steps of 1 voxel; mean zero;
4. **foliage/leaf blocks**: not full cubes — hashed ~45-60 % occupancy (clumped), only for blocks that touch air (interior leaf blocks are skipped entirely);
5. sparse **micro-decor** (grass tufts 1-3 voxels tall, pebbles) from hash(x,z) below a density threshold.

All noise is integer-hash based (`h3()` already exists in `sim_world/src/voxel.rs`), deterministic, seed-stable, WASM/JS-identical. **No new worldgen is required**: heights, biomes, trees and structures are already in the block grid; this only adds the sub-block layer. This also means generation "straight from our worldgen height/biome functions" works at every LOD ring identically — coarser rings call the same function with voxel size 2^L/16 m.

### 2.2 Chunk and LOD layout (clipmap of equal-cost chunks, after Lin's constant-resolution nodes)
* **MC = 32x32x32 voxels** (+1-voxel apron for culling/AO, so 34 bits per column fit a `u64`). At L0 an MC is 2 m = 2x2x2 blocks; at level L it spans 2 m x 2^L. Every ring therefore costs the same per chunk.
* Rings are **concentric, snapped to MC boundaries of their own level, centred on the camera focus point** (the player), with split/merge hysteresis of 25 % of the ring step.
* Voxel pixel size at 1080p, 50 deg vertical FOV is ~ 1158 * s / d px. Rule: keep voxel footprint >= ~3.5 px; finer is wasted triangles and aliasing. Hence the ring table below.

| ring | voxel | MC size | profile **A** (Iris Xe, "R32") | profile **B** (default 3060, "R48") | profile **C** (ultra, "R64") |
|---|---|---|---|---|---|
| L0 | 1/16 m | 2 m | 0-12 m | 0-16 m | 0-24 m |
| L1 | 1/8 m | 4 m | 12-20 | 16-28 | 24-40 |
| L2 | 1/4 m | 8 m | 20-32 | 28-48 | 40-64 |
| L3 | 1/2 m | 16 m | 32-64 | 48-96 | 64-128 |
| L4 | 1 m | — | existing `mesher.ts` 32 m regions beyond | same | same |

"R" is the outer radius of the 1/4 m ring (last ring that still has sub-block detail). L3 is nearly the plain 1 m look but smoother (half-block bevels); L4 stays the current mesher so the old pipeline remains a complete fallback and covers the world edge. Vertical: only MC layers that intersect the surface or contain non-air exposed faces are generated (see `max_layer`/`tops` already tracked in `voxel.rs`); a typical column has 1-3 such MCs of the 56 m height.

### 2.3 Where each thing runs
* **Rust (new crate `crates/sim_micro`, pure functions, no Bevy)** — the micro function (2.1), column-bit generation, binary greedy mesher, skirts, AO, vertex packing. Input: read-only view of `vox.data`/block registry + level + MC coords. Output: `Vec<u8>` vertex bytes + `Vec<u16>` indices + a small header (counts, bbox, level).
* **Where it executes: a second instance of the *same wasm module in a Web Worker pool (2-3 workers)*, not in the sim.** Reasons: sim budget is ~3 ms/tick and single threaded; one 32^3 MC costs an estimated 0.15-0.4 ms in WASM (see 2.9), and 100+ MCs/s are needed while running. A worker holds its own copy of the block grid (11 MB u16; send once with `postMessage`, then send only deltas `{block idx, id}` on `world.block_changed`). If the page becomes cross-origin isolated, switch to a `SharedArrayBuffer` for the grid. Fallback if workers are unavailable: run the same function on the main thread with a 1.5 ms/frame budget.
* **JS/Three.js** — scheduling (which MCs are wanted: ring maths, hysteresis, frustum + priority), upload, materials/shaders, fade-in, culling, LOD debug overlay. The sim never meshes micro voxels and never sees them.
* **Collision / AI / pathing**: unchanged, 1 m (`height_at`, blocks). Relief is bounded to [-2,+1] voxels (-12.5 cm..+6 cm) around the block top so a collision-resting foot never visibly floats or sinks by more than ~6 cm; creature voxels (also 1/16 m) walk "through" 1-voxel grass relief without issue.

### 2.4 Voxel data and per-voxel colour
* In-flight chunk data only (never persistent): `occ: [u64; 34*34]` bit columns (9 KB), plus `mat: [u8; 34^3]` (39 KB) filled lazily. No float density, no per-voxel RGB.
* **Colour is not stored in vertices.** A vertex carries a `(block-id, face-kind)` material index; the fragment shader reconstructs the voxel (`floor(posVoxel - 0.5*normal)`) and looks up a **16x16 RGB tile of block colours** per (tile, face-kind) from a small `texture2DArray` built once at load by box-filtering the existing 128 px atlas tiles 8x8 -> 1 (`atlas.ts` already holds them), then multiplies by a per-voxel hash brightness (+/-6 %) and the AO/lighting. Consequence: **greedy merging is by material only**, colour variety is free, and the look is pixel-crisp voxel colour with NEAREST sampling. This is the single biggest triangle saver (compare: per-voxel colour in the vertex would kill merging).
* Palette/colour grading stays in `atlas.ts` (voxel owner), so season/biome tints keep working through the existing uniforms.

### 2.5 Sparse edit overlay (reuse `world.set_block` semantics)
* **Level 1 (everything the game does today):** edits are 1 m blocks. `world.set_block` mutates `vox.data` exactly as now; the micro function re-derives the 16^3 cube, bevels and relief automatically. **Zero extra memory, zero extra save data.** The dirty list (`EditInfo.chunks`, `versions`) maps to MCs: a changed block affects the 3x3x3 block neighbourhood (bevel rule), i.e. typically 8, at most 27 L0 MCs, plus one MC per coarser ring covering the position. Rust-side `fn dirty_micro_chunks(block) -> SmallVec<(level,mc)>`.
* **Level 2 (future chisel/sub-block building):** `HashMap<BlockIdx, Box<MicroPatch>>` with `MicroPatch = RLE of a 16^3 u8 material grid` (typ. < 200 B, max 4 KB); the micro function consults the patch first. 10 000 chiselled blocks <= 40 MB worst case, ~2 MB typical. Persist inside the save as `(block idx, rle)` pairs next to the existing run-length chunk codec (`encode_chunk`). Not needed for M1-M5.
* Edit latency target: affected L0 MCs re-queued at top priority, remeshed in <= 2 worker round trips (< 50 ms); the old MC stays visible until the new one arrives (no hole).

### 2.6 Binary greedy meshing with per-voxel material (original Rust)
Per MC, per axis (3 passes, 2 directions each):
1. Build `col[a][b]: u64` bit columns along the axis (done once while generating: 1 bit per voxel).
2. Face mask for the "+" direction: `faces = col & !(col >> 1)`; for "-": `col & !(col << 1)`; neighbour apron bits make chunk borders correct without cross-chunk lookups. This does 34 voxels per ALU op (Lin's 32-per-word trick).
3. For each non-zero `faces` word iterate set bits with `trailing_zeros`, bucket by depth slice into 2D bit planes `plane[depth][row]: u32`.
4. Greedy: per plane, find a run along the row with `trailing_zeros(!(bits >> start))`, then extend the rectangle across rows while the same bit-run is set and the **material** (and AO pattern, 2.8) of the voxel in the next row is equal; clear the consumed bits. Material is read from the lazily filled `mat` array only for set bits (sparse).
5. Emit one quad (4 verts, shared quad index pattern `0 1 2 0 2 3`).
Known results for this style of mesher (public benchmarks of 62^3 chunks) are tens of microseconds natively; I assume 0.15-0.4 ms per *full pipeline* MC in WASM (generation + meshing + skirts), which is the number M1 must verify.

Vertex format, **8 bytes**: `x,y,z` u8 (0..32 voxel units in the MC, +1 for the far face), `face(3b)|ao(2b)|spare` u8, `material u16`, `uv-extent / variant u16`. The fragment derives quad-local voxel UVs from the interpolated voxel-space position. Three.js attribute with `gpuType = IntType` / `Uint8/Uint16` integer attributes (WebGL2 `vertexAttribIPointer`) — verify in the pinned three version.

### 2.7 Seams between LOD rings: skirts + hysteresis (no stitching)
* Every MC emits **skirt quads** on its 4 vertical side planes (and bottom at the world edge): for each boundary column that has an exposed top/side face, a vertical quad hangs down by `2 * voxel(level+1)` using the same material. Cracks between a fine MC and a coarser neighbour are always smaller than that, so they are hidden. Cost: 32 boundary columns x 4 sides = <= 128 quads per MC (~3 % of its tris).
* Surface agreement: a coarse MC computes a column's height as the **max** of the fine columns it contains (silhouette never dips below the fine ring; skirts then hide the over-height by lowering the coarse top 0.5 coarse voxel — tuned per biome in M3).
* Rings do not overlap in space (no z-fighting); swap fine<->coarse at ring borders by **fading**: new MC fades in over ~0.3 s with a screen-door dither discard while the old one stays, then the old is dropped (uniform `uFade`, no blending cost).
* Lin's `overlap` (3.5 % over-sampling) + octree stitcher solves the same problem for smooth surfaces; for cube surfaces it is not needed.

### 2.8 Ambient occlusion and lighting
* **Per-vertex AO** (0-3, from the 3 neighbour bits at each quad corner — the usual 0fps formulation, done with bit ops on the same columns). Greedy merge requires equal AO on the four corner pattern; open flat areas have uniform AO so they still merge; crevices split (this is where AO pays for itself).
* The engine's sun / hemisphere / fog / season uniforms are reused by extending the existing voxel material (`materials.ts`): same `onBeforeCompile` hooks, new vertex/fragment chunk for the integer attributes. Shadows: same shadow-map path as the 1 m world; MCs cast and receive (L2+ cast only, to cap the shadow pass cost).
* Water stays the existing separate mesh (flat, 1 m). It intersects micro relief fine.

### 2.9 Budgets
Assumptions (stated so the critic and M1 can check them): L0 "relief mode" averages **~300 triangles/m^2** (a random +/-1 voxel relief gives ~1000/m^2 worst case; flat-only ~4/m^2); triangles/m^2 scale with 1/voxel^2 for coarser rings (L1 ~75, L2 ~19, L3 ~5); frustum keeps ~45 % of the ring area; trees/rocks/cliffs add ~+60 % (leaf blocks use occupancy-dithered shell only; far ones drop to 1/8 m).

| profile | rings (m) | tris if nothing culled | tris on screen (~45 %) incl. foliage/cliffs | MCs resident | GPU geometry (8 B x 4 verts/quad) |
|---|---|---|---|---|---|
| A, R32 | 12/20/32/64 | ~0.28 M | **~0.20 M** | ~1 000 | ~6 MB |
| B, R48 | 16/28/48/96 | ~0.56 M | **~0.40 M** | ~2 800 | ~13 MB |
| C, R64 | 24/40/64/128 | ~1.06 M | **~0.75 M** | ~5 500 | ~24 MB |
| worst case (3.3x relief, B) | | | ~1.3 M | | ~40 MB |

* **Mesh budget per frame (main thread):** <= 1.0 ms or <= 300 KB of buffer uploads, whichever first; the worker pool is given <= 4 queued MCs per worker so priorities stay fresh (nearest + in-frustum + edits first). Steady running costs ~100 L0 MCs/s (perimeter crossing at 6 m/s) = ~0.4 CPU-core worker time at the upper assumption.
* **Draw calls:** MCs go into one `BatchedMesh` (three.js; WEBGL_multi_draw -> one draw per ring material, per-instance frustum culling) with a **fallback of merged 16 m tile meshes** (rebuild a tile on change; ~150-400 draws at R48) when the extension is missing. Target <= 300 draws for the micro world.
* **CPU memory:** blocks 11 MB + worker copies 11 MB each + transient 50 KB per in-flight MC + patches (level 2). Mesh bytes are not kept CPU-side after upload (unless a re-upload fallback needs them: +13 MB at R48).
* **Sim impact:** ~0 (sim only emits the existing `block_changed`; mapping to MCs is JS-side or a tiny Rust fn in the worker).

### 2.10 Go / no-go
* **RTX 3060 @ 60 fps: GO** for profiles B and C. 0.4-0.75 M micro triangles with a small integer-attribute shader are well below what a 3060 sustains in WebGL2 (low single-digit M tris at 60 fps is routine; the existing grass/creatures/post stack will remain the heavier part). Even the 1.3 M worst case should hold; C is the demo/trailer profile.
* **Intel Iris Xe @ >= 30 fps: GO with profile A**, conditions: 0.75-0.85 render scale, L2+ do not cast shadows, no per-MC fade on Iris, `BatchedMesh` or <= 200 draws, AO kept (it is baked). Triangle load (~0.2 M) is comfortably inside an Iris Xe's ~50-100 M tris/s practical range; the risk is fill rate/overdraw from the existing grass + post chain, not these meshes. Gate: M2 benchmark on real Iris-class hardware or a throttled-GPU emulation before declaring done.
* **NO-GO items** (do not do): storing voxels at 1/16 m globally; smooth/DC surfaces; per-voxel colour in vertices; meshing in the sim thread; micro-collision.

---------------------------------------------------------------------------------------------------

## 3. Stepwise plan

Owners follow ARCHITECTURE.md: **voxel-world** owns `web/src/modules/voxel/**` and the new crate; **sim_world owner (world)** owns `crates/sim_world/**`; **foundation-rust** owns `crates/bridge`, `tools/build-wasm.ps1`; **look** owns `engine/Materials.ts`, `Post.ts`, `glsl/**`. New files are requested via `docs/REQUESTS.md` where owner differs.

| M | scope | owner (files) | acceptance criteria |
|---|---|---|---|
| **M1** Micro function + binary mesher, offline | `crates/sim_micro`: micro function (bevel, relief, leaves), bit columns, binary greedy mesher, AO, skirts, vertex packing, `dirty_micro_chunks`; native unit tests + a `bench` bin | voxel-world (`crates/sim_micro/**`; Cargo workspace line via REQUESTS to foundation-rust) | Deterministic (same input -> same bytes, tested); watertight within an MC (every exposed face emitted exactly once, tested against a naive mesher on random grids); empty/full MC early-out; **native p95 <= 0.15 ms and wasm (headless chrome) p95 <= 0.5 ms per L0 MC on `worldgen` seed 1 islands**; triangle count/m^2 report for flat / relief / forest / cliff areas; matches the section 2.9 assumptions within 2x, else numbers there are amended. |
| **M2** Worker pool + L0 on screen | bridge export (`micro_mesh(level,cx,cy,cz)`), worker (`web/src/modules/voxel/microWorker.ts`), `micro.ts` scheduler, `microMaterial.ts` (integer attributes + colour-LUT shader), `BatchedMesh` + fallback tiles; L0 ring only, 1 m mesher hidden inside it | voxel-world; bridge export by foundation-rust (REQUESTS) | Running, break/place a block: new micro mesh within 50 ms, no hole; no frame > 16.7 ms due to uploads on 3060 at R(L0)=16 m; `shots/voxel/rN/` close-ups show 1/16 m voxels with per-voxel colour, bevels and relief; 3060 >= 60 fps and Iris-class run >= 30 fps with profile-A L0 only (numbers in the report). |
| **M3** LOD rings L1-L3 + skirts + hysteresis | ring manager, split/merge hysteresis, skirts verified, max-height coarse columns, LOD fade-in, `?lod=1` debug colours | voxel-world | Walking a loop of the island: no visible cracks or popping holes in a 20-shot sweep (shots listed); ring switches show no flicker (hysteresis test: camera jitter +/-1 m causes 0 LOD swaps); triangle counters within 1.5x of 2.9; draw calls <= 300. |
| **M4** Quality: AO, shadows, foliage, decor, water join | AO in greedy key; leaf/foliage occupancy shells; micro-decor (grass tufts, pebbles); shadow-cast policy per ring; coastline relief vs water; season/biome tints through uniforms | voxel-world + look (shader hooks only) | Critic-grade stills vs Animal Crossing/Minecraft-shader references: coastline, forest floor, cliff, village path, night; no z-fighting at ring borders; tree <= 25 k tris at L0. |
| **M5** Performance profiles + shipping | quality presets A/B/C (auto-select via first-seconds frame-time probe), mobile/low profile = L4 only, edit stress test (fill 1000 blocks), save/load unchanged, memory report | voxel-world + ui (settings entry) | 3060 profile B/C >= 60 fps p95 (record via `tools/record-showcase.mjs` run); Iris-class profile A >= 30 fps; `fill` of 1000 blocks keeps frame < 33 ms (back-pressure queue); GPU memory <= 40 MB micro geometry; docs in `docs/BRIDGE_API.md`. |

Ordering note: M1 can start immediately; it needs no renderer. Critics should receive M2 stills before M3 starts, because the visual identity (relief amplitude, bevel radius, colour LUT) is decided there and is cheap to change only before rings multiply the cost.

---------------------------------------------------------------------------------------------------

## 4. Risks and fallbacks

| risk | likelihood / impact | mitigation / fallback |
|---|---|---|
| Per-column relief explodes triangles (up to ~1000/m^2) | high / medium | relief is a *tunable* (amplitude, feature size); default clumped 2-3 voxel blobs; M1 reports tris/m^2; ring distances shrink first; "flat" mode (bevel + shader colour only) is a one-line switch |
| Greedy meshing merges poorly because of AO + material variety | medium / medium | AO optional per quad (flat-AO quads); fewer materials per block (colour variety is in the shader LUT, not in material ids) |
| Worker/wasm second instance not feasible in the build (bundler, memory) | low-medium / high | same Rust function behind the same JS interface on the main thread with a 1.5 ms budget and half the L0 radius; or compile the mesher to plain JS/TS typed arrays (slower, ~2-3x) |
| `WEBGL_multi_draw` / BatchedMesh missing or slow on Iris Xe drivers | medium / medium | 16 m merged tiles (also a 16 MB vertex pool with `bufferSubData`); fewer, larger MCs at L1+ (MC = 64^3 at L2+) |
| Pop-in / LOD popping looks cheap | medium / medium | dither-fade (2.7), larger hysteresis, fog already hides L3; keep L3 -> L4 border outside fog start |
| Cracks at ring borders on cliffs (vertical faces) | medium / medium | skirts on all 4 sides *and* side-plane vertical skirts; coarse columns use max-height; if still visible, add 1-voxel overlap at the border of finer rings with polygon offset |
| Edits cause stutter (27 MCs/remesh x worker latency) | medium / low | priority queue, edited blocks first, old mesh retained until replacement, cap 8 MCs/frame upload |
| Shadow pass cost with 5 k MCs | medium / medium | only L0-L1 cast; cascade tuned by `look`; instance culling per ring |
| Visual identity drifts away from the creature voxel style (flat vs painted) | medium / medium | colour LUT built from the AI-generated tiles (already graded in `atlas.ts`), per-voxel hash tint matches creature palette ramps; critic reviews M2 stills |
| Integer vertex attributes unsupported by the bundled three build | low / medium | encode as normalised bytes + reinterpret in shader (`unpackUnorm`-style) — 1 day of work, no design change |
| Our time estimates for wasm speed wrong by 3x | medium / medium | M1 measures first and amends 2.9; ring profile A is built to survive a 3x miss |
| Licensing | none | MIT repos, concepts only; ledger rows added to `THIRD_PARTY.md` |
