//! End-to-end contract tests of the assembled simulation (native; the wasm build runs the very
//! same code, see tools/smoke-wasm.mjs for the in-WASM check).

use bridge::GameCore;
use serde_json::Value;
use sim_core::{Channels, buttons};

const DT: f32 = 1.0 / 60.0;

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("invalid JSON from the bridge: {e}: {s}"))
}

/// Deterministic scripted input as a function of the tick index.
fn script(n: usize) -> [f32; 16] {
    let mut i = [0.0f32; 16];
    let phase = (n / 90) % 6;
    match phase {
        0 | 1 => i[1] = 1.0,                  // forward
        2 => { i[0] = 1.0; i[1] = 0.6; }      // forward-right
        3 => i[1] = 1.0,                      // forward again
        4 => { i[0] = -1.0; }                 // strafe left
        _ => {}                               // stand
    }
    let mut b = 0u32;
    if n % 120 == 5 {
        b |= buttons::JUMP;
    }
    if (n / 200) % 2 == 1 {
        b |= buttons::SPRINT;
    }
    if n % 150 == 20 {
        b |= buttons::TOOL_NEXT;
    }
    i[4] = b as f32;
    // Camera yaw sweeps. Plain arithmetic (no sin) so the f32 values are bit-identical to the JS
    // script in tools/smoke-wasm.mjs.
    i[5] = ((n % 400) as f32 - 200.0) * 0.006;
    i
}

fn run(core: &mut GameCore, ticks: usize) {
    for n in 0..ticks {
        core.set_input(&script(n));
        core.tick(DT);
    }
}

fn all_channel_bytes(core: &GameCore) -> Vec<(String, Vec<u8>)> {
    let ch = core.sim().world().resource::<Channels>();
    ch.names().into_iter().map(|n| (n.to_string(), ch.to_bytes(n).unwrap())).collect()
}

const CHANNELS: [(&str, &str, u64, bool); 11] = [
    // voxel world (docs/BRIDGE_API.md, world section)
    ("vox.data", "u16", 1, false),
    ("vox.chunks", "u32", 2, false),
    ("vox.dirty", "u32", 1, false),
    // name, kind, stride, interpolated
    ("time", "f32", 1, false),
    ("player", "f32", 16, true),
    ("creatures", "f32", 16, true),
    ("world.height", "f32", 1, false),
    ("world.biome", "u8", 1, false),
    ("world.dirty", "u32", 1, false),
    ("flora", "f32", 8, false),
    ("props", "f32", 12, false),
];

#[test]
fn channel_table_matches_the_documented_contract() {
    let g = GameCore::new(1);
    let names: Vec<String> = json(&g.channel_names()).as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    for (name, kind, stride, interpolated) in CHANNELS {
        assert!(names.iter().any(|n| n == name), "channel '{name}' missing from {names:?}");
        let info = json(&g.channel_info(name));
        for key in ["ptr", "prev_ptr", "len", "cap", "stride", "kind", "version"] {
            assert!(info.get(key).is_some(), "channel_info('{name}') lacks '{key}': {info}");
        }
        assert_eq!(info["kind"], kind, "{name}");
        assert_eq!(info["stride"], stride, "{name}");
        assert_eq!(info["prev_ptr"] != 0, interpolated, "{name}: prev_ptr {}", info["prev_ptr"]);
        assert!(info["len"].as_u64() <= info["cap"].as_u64(), "{name}");
        assert_eq!(info["len"].as_u64().unwrap() % stride, 0, "{name}: len must be a whole number of records");
    }
    assert_eq!(names.len(), CHANNELS.len(), "unexpected extra channels: {names:?}");

    // exact documented lengths at start-up
    assert_eq!(json(&g.channel_info("time"))["len"], 16);
    assert_eq!(json(&g.channel_info("player"))["len"], 16);
    assert_eq!(json(&g.channel_info("creatures"))["len"], 12 * 16);
    // grid size comes from world.info (extent in metres, vertex sampling: n = size / cell + 1), never a hard-coded constant
    let world = json(&g.query("world.info", ""));
    let cell = world["cell"].as_f64().unwrap();
    // `sample: "cell"` (voxel world: one sample per block column at its centre) => n = size / cell; "vertex" => + 1
    let extra = if world["sample"] == "cell" { 0 } else { 1 };
    let nx = (world["size_x"].as_f64().unwrap() / cell).round() as u64 + extra;
    let nz = (world["size_z"].as_f64().unwrap() / cell).round() as u64 + extra;
    let samples = nx * nz;
    assert!(samples > 0, "world.info reports an empty grid: {world}");
    assert_eq!(json(&g.channel_info("world.height"))["len"], samples);
    assert_eq!(json(&g.channel_info("world.biome"))["len"], samples);
    assert_eq!(json(&g.channel_info("world.dirty"))["len"], 0);
    assert_eq!(json(&g.channel_info("props"))["len"], 0);
    assert!(json(&g.channel_info("flora"))["len"].as_u64().unwrap() >= 8 * 100);

    // unknown channel -> error JSON
    assert!(g.channel_info("nope").contains("error"));
}

#[test]
fn registered_api_surface() {
    let g = GameCore::new(1);
    let stats = json(&g.query("core.stats", ""));
    let has = |list: &str, name: &str| stats[list].as_array().unwrap().iter().any(|v| v == name);
    for c in ["sys.set_time", "sys.set_weather", "sys.set_time_scale", "debug.teleport", "debug.spawn_creature", "player.set_tool"] {
        assert!(has("commands", c), "command {c} missing");
    }
    for q in ["world.info", "sys.time", "player.info", "creature.info", "creature.species", "build.info", "core.digest", "core.stats", "core.events"] {
        assert!(has("queries", q), "query {q} missing");
    }
    for s in ["core", "world", "systems", "player", "creatures", "build"] {
        assert!(has("save_sections", s), "save section {s} missing");
    }
    assert_eq!(stats["channels_overflowed"].as_array().unwrap().len(), 0);

    // event table covers every domain in use
    let events = json(&g.query("core.events", ""));
    let kinds: Vec<u64> = events.as_array().unwrap().iter().map(|e| e["kind"].as_u64().unwrap()).collect();
    for k in [1u64, 2, 200, 201, 202, 203, 204, 205, 206, 300, 301, 302, 303, 304, 305, 500, 501, 502, 503, 504] {
        assert!(kinds.contains(&k), "event kind {k} not registered");
    }
}

#[test]
fn same_seed_and_inputs_give_byte_identical_channels_after_600_ticks() {
    let mut a = GameCore::new(42);
    let mut b = GameCore::new(42);
    run(&mut a, 600);
    run(&mut b, 600);
    assert_eq!(a.sim().tick_count(), 600);
    assert_eq!(a.sim().digest(), b.sim().digest());
    let (ca, cb) = (all_channel_bytes(&a), all_channel_bytes(&b));
    for ((name, x), (_, y)) in ca.iter().zip(&cb) {
        assert_eq!(x, y, "channel '{name}' differs between identical runs");
    }
    // ...and the run did something (not trivially equal because nothing happens)
    let start = GameCore::new(42);
    assert_ne!(start.sim().digest(), a.sim().digest());
}

#[test]
fn different_seed_gives_different_world_and_state() {
    let mut a = GameCore::new(42);
    let mut b = GameCore::new(43);
    run(&mut a, 600);
    run(&mut b, 600);
    assert_ne!(a.sim().digest(), b.sim().digest());
    let (ca, cb) = (all_channel_bytes(&a), all_channel_bytes(&b));
    let differs = |name: &str| ca.iter().find(|c| c.0 == name).unwrap().1 != cb.iter().find(|c| c.0 == name).unwrap().1;
    assert!(differs("world.height"), "terrain should depend on the seed");
    assert!(differs("creatures"));
    assert!(differs("player"));
}

#[test]
fn results_do_not_depend_on_how_ticks_are_chunked() {
    // Same constant input; one run ticks at 60 Hz, the other with irregular 24-80 ms frames.
    let input = {
        let mut i = [0.0f32; 16];
        i[1] = 1.0;
        i[4] = buttons::SPRINT as f32;
        i[5] = 0.3;
        i
    };
    let mut a = GameCore::new(5);
    a.set_input(&input);
    for _ in 0..600 {
        a.tick(DT);
    }
    let mut b = GameCore::new(5);
    b.set_input(&input);
    let frames = [0.024f32, 0.080, 0.033, 0.050, 0.041, 0.017, 0.062];
    let mut i = 0;
    while b.sim().tick_count() < 590 {
        b.tick(frames[i % frames.len()]);
        i += 1;
    }
    while b.sim().tick_count() < 600 {
        b.sim_mut().step_once();
    }
    assert_eq!(b.sim().tick_count(), 600);
    assert_eq!(a.sim().digest(), b.sim().digest(), "frame pacing changed the simulation result");
}

#[test]
fn scripted_run_is_sane() {
    let mut g = GameCore::new(3);
    let before = json(&g.query("player.info", ""));
    run(&mut g, 600);
    let after = json(&g.query("player.info", ""));
    assert_ne!(before["pos"], after["pos"], "player never moved");
    let p = after["pos"].as_array().unwrap();
    assert!(p.iter().all(|v| v.as_f64().unwrap().is_finite()));

    // every float in every float channel is finite; nothing overflowed
    let ch = g.sim().world().resource::<Channels>();
    for name in ch.names() {
        let bytes = ch.to_bytes(name).unwrap();
        if json(&g.channel_info(name))["kind"] == "f32" {
            for c in bytes.chunks_exact(4) {
                let v = f32::from_le_bytes(c.try_into().unwrap());
                assert!(v.is_finite(), "non-finite value in channel '{name}'");
            }
        }
    }
    assert!(ch.overflowed().is_empty());

    // creature records: ids ascending, species/variant in range
    let bytes = ch.to_bytes("creatures").unwrap();
    let f: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    assert_eq!(f.len(), 12 * 16);
    let ids: Vec<f32> = f.chunks(16).map(|r| r[0]).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    assert!(f.chunks(16).all(|r| r[1] < 3.0 && r[2] < 3.0));

    // time channel advanced: 600 steps = 10 s = 1/6 of an hour from 08:00
    let t = ch.slice_by_name::<f32>("time").unwrap();
    assert!((t[0] - (8.0 + 10.0 / 60.0)).abs() < 0.01, "hours {}", t[0]);
}

#[test]
fn save_load_roundtrip_continues_identically() {
    let mut a = GameCore::new(7);
    run(&mut a, 300);
    a.command("debug.spawn_creature", r#"{"count":3}"#);
    a.command("sys.set_weather", r#"{"kind":"rain","intensity":0.5}"#);
    let bytes = a.save();
    assert!(bytes.len() > 100 && &bytes[0..4] == b"GLMW", "save header");
    for n in 300..600 {
        a.set_input(&script(n));
        a.tick(DT);
    }
    let want = all_channel_bytes(&a);

    // load into a game built from a *different* seed: the save carries its own
    let mut b = GameCore::new(999);
    assert!(b.load(&bytes));
    assert_eq!(b.sim().tick_count(), 300);
    assert_eq!(json(&b.query("sys.time", ""))["weather"]["name"], "rain");
    for n in 300..600 {
        b.set_input(&script(n));
        b.tick(DT);
    }
    assert_eq!(b.sim().tick_count(), 600);
    for ((name, x), (_, y)) in want.iter().zip(all_channel_bytes(&b).iter()) {
        assert_eq!(x, y, "channel '{name}' diverged after load");
    }
    // a LOADED event reaches JS
    let mut c = GameCore::new(1);
    c.drain_events();
    assert!(c.load(&bytes));
    assert!(c.drain_events().chunks(7).any(|e| e[0] == 1.0), "core.loaded event missing");
}

#[test]
fn corrupt_or_foreign_saves_are_rejected_and_leave_the_game_untouched() {
    let mut g = GameCore::new(11);
    run(&mut g, 120);
    let digest = g.sim().digest();
    let tick = g.sim().tick_count();
    let good = g.save();

    assert!(!g.load(&[]));
    assert!(!g.load(b"definitely not a save"));
    let mut flipped = good.clone();
    flipped[good.len() / 2] ^= 0x10;
    assert!(!g.load(&flipped));
    assert!(!g.load(&good[..good.len() - 1]));
    // valid container + valid CRC but a section payload that is garbage
    let mut file = sim_core::SaveFile::decode(&good).unwrap();
    file.sections.iter_mut().find(|s| s.name == "creatures").unwrap().bytes = vec![0xFF; 40];
    assert!(!g.load(&file.encode().unwrap()));
    // valid container for a different world layout is fine, but a bad `world` seed section is not
    let mut file = sim_core::SaveFile::decode(&good).unwrap();
    file.sections.iter_mut().find(|s| s.name == "world").unwrap().bytes = sim_core::save::encode(&123_456u32).unwrap();
    assert!(!g.load(&file.encode().unwrap()));

    assert_eq!(g.sim().digest(), digest, "a rejected load changed the running game");
    assert_eq!(g.sim().tick_count(), tick);
    assert!(g.load(&good), "the good save still loads");
}

#[test]
fn events_are_packed_in_sevens_and_drain_clears() {
    let mut g = GameCore::new(2);
    run(&mut g, 400);
    let ev = g.drain_events();
    assert_eq!(ev.len() % 7, 0);
    assert!(!ev.is_empty(), "400 ticks of play should have produced footsteps / jumps");
    for e in ev.chunks(7) {
        assert!(e[0] >= 0.0 && e[0] < 600.0, "event kind {} outside every domain", e[0]);
        assert!(e.iter().all(|v| v.is_finite()));
    }
    assert!(g.drain_events().is_empty());
}

#[test]
fn robust_against_garbage_from_js() {
    let mut g = GameCore::new(4);
    g.set_input(&[]);
    g.set_input(&[f32::NAN; 16]);
    g.set_input(&[f32::INFINITY, -f32::INFINITY, 1e30, -1e30, 99999.0, f32::NAN, f32::NAN, f32::NAN, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
    for dt in [f32::NAN, -1.0, 0.0, f32::INFINITY, 1e9, 0.5, 1e-9] {
        g.tick(dt);
    }
    for (name, args) in [
        ("", ""),
        ("no.such.command", "{}"),
        ("debug.teleport", "}{"),
        ("debug.teleport", r#"{"x":1e99,"z":-1e99}"#),
        ("debug.teleport", r#"{"x":null,"z":[]}"#),
        ("sys.set_time", r#"{"hours":1e300}"#),
        ("sys.set_weather", r#"{"kind":-1}"#),
        ("debug.spawn_creature", r#"{"count":-3}"#),
        ("debug.spawn_creature", r#"{"x":1e30,"z":1e30}"#),
        ("player.set_tool", r#"{"tool":255}"#),
    ] {
        let r = g.command(name, args);
        let _ = json(&r); // always valid JSON
    }
    for (name, args) in [("", ""), ("world.info", "[1,2"), ("creature.info", r#"{"id":4294967295}"#), ("creature.info", "{}")] {
        let _ = json(&g.query(name, args));
    }
    assert!(g.channel_info("").contains("error"));
    // the game still works
    g.set_input(&script(0));
    g.tick(DT);
    assert!(json(&g.query("core.digest", ""))["tick"].as_u64().unwrap() > 0);
}

#[test]
fn teleport_and_spawn_commands_show_up_in_channels_immediately() {
    let mut g = GameCore::new(6);
    let r = json(&g.command("debug.teleport", r#"{"x":10.5,"z":-8.25}"#));
    assert_eq!(r["x"], 10.5);
    let ch = g.sim().world().resource::<Channels>();
    let p = ch.slice_by_name::<f32>("player").unwrap();
    assert_eq!((p[0], p[2]), (10.5, -8.25), "teleport must be visible before the next tick");
    let r = json(&g.command("debug.spawn_creature", r#"{"species":"puffbun","count":2}"#));
    assert_eq!(r["ids"].as_array().unwrap().len(), 2);
    assert_eq!(json(&g.channel_info("creatures"))["len"], 14 * 16);
}

/// Prints the digest of the canonical 600-tick run (compare with the wasm run in smoke-wasm.mjs).
#[test]
#[ignore = "prints the cross-platform determinism fingerprint"]
fn print_golden_digest() {
    let mut g = GameCore::new(42);
    run(&mut g, 600);
    println!("GOLDEN seed=42 ticks=600 digest={:016x}", g.sim().digest());
}

/// Native step-time benchmark: `cargo test -p bridge --release bench -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark"]
fn bench_step_time() {
    for extra in [0usize, 1988] {
        let mut g = GameCore::new(42);
        if extra > 0 {
            g.command("debug.spawn_creature", &format!(r#"{{"count":{extra}}}"#));
        }
        run(&mut g, 120);
        let n = 600;
        let t = std::time::Instant::now();
        let mut worst = 0.0f64;
        for i in 0..n {
            g.set_input(&script(i));
            let s = std::time::Instant::now();
            g.tick(DT);
            worst = worst.max(s.elapsed().as_secs_f64() * 1000.0);
        }
        let creatures = json(&g.channel_info("creatures"))["len"].as_u64().unwrap() / 16;
        println!(
            "{creatures:>5} creatures: mean {:.3} ms/step, worst {:.3} ms (native)",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64,
            worst
        );
    }
}
