//! Save files: a small, versioned, checksummed container of per-module sections.
//!
//! # Why this format
//! * **Container** = hand-rolled little-endian binary (magic + versions + length-prefixed
//!   sections + CRC-32). It is trivially forward compatible (unknown sections are skipped, missing
//!   ones keep their fresh defaults), cheap to validate before touching the world, and has no
//!   dependency beyond a 20-line CRC.
//! * **Section payloads** = [`postcard`] (serde): compact varint encoding (2,000 creatures stay in
//!   the tens of kilobytes), deterministic bytes for equal state (so save files can be compared in
//!   tests), `no_std`-grade tiny code size, and the wire format is documented and stable. It is not
//!   self-describing, so every section carries its own `version: u16`; a module that changes its
//!   layout bumps the version and registers a *raw* section that migrates old payloads.
//!
//! # Layout (all integers little-endian)
//! ```text
//! 0   4  magic "GLMW"
//! 4   2  container version (= 1)
//! 6   2  flags (= 0)
//! 8   4  world seed (the u32 given to `new Game(seed)`)
//! 12  8  sim tick
//! 20  8  step accumulator (ns)
//! 28  2  section count
//! 30  .. sections: u8 name_len | name utf-8 | u16 version | u32 payload_len | payload
//! end 4  CRC-32 (IEEE) of every preceding byte
//! ```
//!
//! Loading validates magic, version and CRC and bounds-checks every length *before* any module
//! state is modified; section loaders then run in registration order (world before creatures, ...).

use bevy_ecs::prelude::{Resource, World};
use serde::{Serialize, de::DeserializeOwned};

pub const MAGIC: [u8; 4] = *b"GLMW";
/// Version of the container layout above.
pub const CONTAINER_VERSION: u16 = 1;
const MAX_SECTIONS: usize = 256;
const MAX_NAME: usize = 64;

// --- CRC-32 -------------------------------------------------------------------------------------

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}
static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 (IEEE 802.3, the zlib/PNG polynomial).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in data {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

// --- Container ----------------------------------------------------------------------------------

/// One module's serialised state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionData {
    pub name: String,
    pub version: u16,
    pub bytes: Vec<u8>,
}

/// A decoded save file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveFile {
    pub seed: u32,
    pub tick: u64,
    pub acc_ns: i64,
    pub sections: Vec<SectionData>,
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).ok_or("save truncated")?;
        let s = self.data.get(self.pos..end).ok_or("save truncated")?;
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().map_err(|_| "save truncated")?))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "save truncated")?))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "save truncated")?))
    }
}

impl SaveFile {
    /// Serialises the container (including the trailing CRC).
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        if self.sections.len() > MAX_SECTIONS {
            return Err("too many save sections".into());
        }
        let mut out = Vec::with_capacity(64 + self.sections.iter().map(|s| s.bytes.len() + 16).sum::<usize>());
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&CONTAINER_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.seed.to_le_bytes());
        out.extend_from_slice(&self.tick.to_le_bytes());
        out.extend_from_slice(&self.acc_ns.to_le_bytes());
        out.extend_from_slice(&(self.sections.len() as u16).to_le_bytes());
        for s in &self.sections {
            let name = s.name.as_bytes();
            if name.is_empty() || name.len() > MAX_NAME {
                return Err(format!("bad section name '{}'", s.name));
            }
            let len = u32::try_from(s.bytes.len()).map_err(|_| format!("section '{}' too large", s.name))?;
            out.push(name.len() as u8);
            out.extend_from_slice(name);
            out.extend_from_slice(&s.version.to_le_bytes());
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&s.bytes);
        }
        let crc = crc32(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        Ok(out)
    }

    /// Parses and validates a container. Touches no game state; never panics on malformed input.
    pub fn decode(bytes: &[u8]) -> Result<SaveFile, String> {
        if bytes.len() < 34 {
            return Err("save too short".into());
        }
        let (body, crc_bytes) = bytes.split_at(bytes.len() - 4);
        let stored = u32::from_le_bytes(crc_bytes.try_into().map_err(|_| "save truncated")?);
        if crc32(body) != stored {
            return Err("save checksum mismatch (file corrupted)".into());
        }
        let mut r = Reader { data: body, pos: 0 };
        if r.take(4)? != MAGIC {
            return Err("not a Glimmerwick save (bad magic)".into());
        }
        let version = r.u16()?;
        if version != CONTAINER_VERSION {
            return Err(format!("unsupported save container version {version} (this build reads {CONTAINER_VERSION})"));
        }
        let _flags = r.u16()?;
        let seed = r.u32()?;
        let tick = r.u64()?;
        let acc_ns = r.u64()? as i64;
        let count = usize::from(r.u16()?);
        if count > MAX_SECTIONS {
            return Err("too many save sections".into());
        }
        let mut sections = Vec::with_capacity(count);
        for _ in 0..count {
            let name_len = usize::from(r.u8()?);
            if name_len == 0 || name_len > MAX_NAME {
                return Err("bad section name length".into());
            }
            let name = std::str::from_utf8(r.take(name_len)?).map_err(|_| "section name is not UTF-8")?.to_string();
            let version = r.u16()?;
            let len = r.u32()? as usize;
            let payload = r.take(len)?.to_vec();
            sections.push(SectionData { name, version, bytes: payload });
        }
        if r.pos != body.len() {
            return Err("trailing bytes after last section".into());
        }
        Ok(SaveFile { seed, tick, acc_ns, sections })
    }

    pub fn section(&self, name: &str) -> Option<&SectionData> {
        self.sections.iter().find(|s| s.name == name)
    }
}

// --- Payload helpers ----------------------------------------------------------------------------

/// Encodes a section payload with postcard.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    postcard::to_allocvec(value).map_err(|e| format!("encode failed: {e}"))
}

/// Decodes a postcard section payload.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    postcard::from_bytes(bytes).map_err(|e| format!("decode failed: {e}"))
}

// --- Registry -----------------------------------------------------------------------------------

type SaveFn = Box<dyn Fn(&World) -> Result<Vec<u8>, String> + Send + Sync>;
type LoadFn = Box<dyn Fn(&mut World, u16, &[u8]) -> Result<(), String> + Send + Sync>;

struct SectionDef {
    name: &'static str,
    version: u16,
    save: SaveFn,
    load: LoadFn,
}

/// Registered save sections (resource). Order of registration = order of loading.
#[derive(Resource, Default)]
pub struct SaveSections {
    list: Vec<SectionDef>,
}

impl SaveSections {
    /// Registers a section with raw byte payloads. `load` receives the version found in the file,
    /// so it can migrate older layouts. Panics on a duplicate name (build-time error).
    pub fn register_raw(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> Result<Vec<u8>, String> + Send + Sync + 'static,
        load: impl Fn(&mut World, u16, &[u8]) -> Result<(), String> + Send + Sync + 'static,
    ) {
        assert!(!self.list.iter().any(|s| s.name == name), "save section '{name}' registered twice");
        assert!(!name.is_empty() && name.len() <= MAX_NAME, "bad save section name '{name}'");
        self.list.push(SectionDef { name, version, save: Box::new(save), load: Box::new(load) });
    }

    /// Registers a section whose state is a serde type (postcard encoded). Files written by a
    /// different `version` are rejected; use [`register_raw`](Self::register_raw) to migrate.
    pub fn register<T>(
        &mut self,
        name: &'static str,
        version: u16,
        save: impl Fn(&World) -> T + Send + Sync + 'static,
        load: impl Fn(&mut World, T) -> Result<(), String> + Send + Sync + 'static,
    ) where
        T: Serialize + DeserializeOwned + 'static,
    {
        self.register_raw(
            name,
            version,
            move |w| encode(&save(w)),
            move |w, v, bytes| {
                if v != version {
                    return Err(format!("section '{name}' has version {v}, this build expects {version}"));
                }
                load(w, decode::<T>(bytes).map_err(|e| format!("section '{name}': {e}"))?)
            },
        );
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.list.iter().map(|s| s.name).collect()
    }

    /// Serialises every registered section (registration order).
    pub fn collect(world: &World) -> Result<Vec<SectionData>, String> {
        let reg = world.get_resource::<SaveSections>().ok_or("save registry missing")?;
        reg.list
            .iter()
            .map(|s| Ok(SectionData { name: s.name.to_string(), version: s.version, bytes: (s.save)(world)? }))
            .collect()
    }

    /// Applies the sections found in `file` to `world` (registration order). Sections absent from
    /// the file keep their current (default) state; unknown sections are ignored.
    pub fn apply(world: &mut World, file: &SaveFile) -> Result<(), String> {
        let Some(reg) = world.remove_resource::<SaveSections>() else {
            return Err("save registry missing".into());
        };
        let mut result = Ok(());
        for def in &reg.list {
            match file.section(def.name) {
                Some(s) => {
                    if let Err(e) = (def.load)(world, s.version, &s.bytes) {
                        result = Err(format!("loading section '{}': {e}", def.name));
                        break;
                    }
                }
                None => log::info!("save has no '{}' section; keeping defaults", def.name),
            }
        }
        for s in &file.sections {
            if !reg.list.iter().any(|d| d.name == s.name) {
                log::warn!("save contains unknown section '{}' (ignored)", s.name);
            }
        }
        world.insert_resource(reg);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn sample() -> SaveFile {
        SaveFile {
            seed: 1234,
            tick: 987_654_321_012,
            acc_ns: 4_242,
            sections: vec![
                SectionData { name: "core".into(), version: 1, bytes: vec![1, 2, 3] },
                SectionData { name: "creatures".into(), version: 7, bytes: vec![] },
                SectionData { name: "world".into(), version: 2, bytes: (0..=255).collect() },
            ],
        }
    }

    #[test]
    fn crc32_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn container_roundtrip() {
        let f = sample();
        let bytes = f.encode().unwrap();
        assert_eq!(&bytes[0..4], b"GLMW");
        assert_eq!(SaveFile::decode(&bytes).unwrap(), f);
        // deterministic bytes
        assert_eq!(bytes, f.encode().unwrap());
    }

    #[test]
    fn detects_corruption_everywhere() {
        let bytes = sample().encode().unwrap();
        for i in 0..bytes.len() {
            let mut b = bytes.clone();
            b[i] ^= 0x40;
            assert!(SaveFile::decode(&b).is_err(), "flip at {i} went unnoticed");
        }
    }

    #[test]
    fn rejects_garbage_and_truncation() {
        assert!(SaveFile::decode(&[]).is_err());
        assert!(SaveFile::decode(b"hello world, this is definitely not a save file").is_err());
        let bytes = sample().encode().unwrap();
        for n in 0..bytes.len() {
            assert!(SaveFile::decode(&bytes[..n]).is_err(), "prefix {n} accepted");
        }
    }

    #[test]
    fn rejects_future_container_version() {
        let mut bytes = sample().encode().unwrap();
        bytes[4] = 9;
        let n = bytes.len();
        let crc = crc32(&bytes[..n - 4]);
        bytes[n - 4..].copy_from_slice(&crc.to_le_bytes());
        let e = SaveFile::decode(&bytes).unwrap_err();
        assert!(e.contains("unsupported save container version"), "{e}");
    }

    #[derive(Resource, Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
    struct Thing {
        a: u32,
        b: Vec<f32>,
        name: String,
    }

    fn world_with_section() -> World {
        let mut w = World::new();
        w.insert_resource(Thing { a: 7, b: vec![1.0, 2.5], name: "hi".into() });
        let mut s = SaveSections::default();
        s.register("thing", 3, |w: &World| w.resource::<Thing>().clone(), |w: &mut World, t: Thing| {
            *w.resource_mut::<Thing>() = t;
            Ok(())
        });
        w.insert_resource(s);
        w
    }

    #[test]
    fn typed_sections_roundtrip() {
        let w = world_with_section();
        let sections = SaveSections::collect(&w).unwrap();
        assert_eq!(sections[0].name, "thing");
        assert_eq!(sections[0].version, 3);
        let file = SaveFile { seed: 1, tick: 2, acc_ns: 0, sections };

        let mut w2 = world_with_section();
        *w2.resource_mut::<Thing>() = Thing::default();
        SaveSections::apply(&mut w2, &file).unwrap();
        assert_eq!(w2.resource::<Thing>(), w.resource::<Thing>());
    }

    #[test]
    fn version_mismatch_and_bad_payload_are_errors() {
        let w = world_with_section();
        let mut file = SaveFile { seed: 1, tick: 2, acc_ns: 0, sections: SaveSections::collect(&w).unwrap() };
        file.sections[0].version = 2;
        let mut w2 = world_with_section();
        let e = SaveSections::apply(&mut w2, &file).unwrap_err();
        assert!(e.contains("version 2"), "{e}");
        file.sections[0].version = 3;
        file.sections[0].bytes = vec![0xFF; 3];
        assert!(SaveSections::apply(&mut w2, &file).is_err());
        // registry is restored after failures
        assert!(w2.get_resource::<SaveSections>().is_some());
    }

    #[test]
    fn unknown_and_missing_sections_are_tolerated() {
        let mut w = world_with_section();
        let file = SaveFile {
            seed: 1,
            tick: 0,
            acc_ns: 0,
            sections: vec![SectionData { name: "from_the_future".into(), version: 1, bytes: vec![1] }],
        };
        SaveSections::apply(&mut w, &file).unwrap();
        assert_eq!(w.resource::<Thing>().a, 7, "missing section keeps current state");
    }
}
