//! Channels: named, flat, typed arrays that live in WASM memory and are rewritten by Rust every
//! fixed step. JS reads them with zero-copy typed-array views (`new Float32Array(memory.buffer,
//! ptr, len)`), see `Game::channel_info`.
//!
//! # Rules
//! * Capacity is fixed at registration; storage is allocated once and **never reallocated**, so
//!   `ptr` / `prev_ptr` stay valid for the lifetime of the `Game` (JS must still rebuild its views
//!   when `memory.buffer` changes after a `memory.grow`).
//! * `len` is the number of *valid elements*. Record-style channels use `stride` elements per
//!   record, so `records = len / stride`.
//! * **Interpolated** channels are double-buffered: at the start of every fixed step the current
//!   buffer is copied into the `prev` buffer, systems/publishers then rewrite `cur`. The renderer
//!   draws `lerp(prev, cur, alpha)`. Records that appear this step (`len` grew) are mirrored into
//!   `prev` so new entities do not interpolate from garbage; use [`Channels::mark_discontinuity`]
//!   after teleports / respawns / loads to snap `prev := cur`. Records are matched by index, so
//!   channels that can reorder (creatures) must keep a stable order (sorted by id) and carry the
//!   id in a column so JS can detect a mismatch.
//! * `version` is bumped by the owner whenever *static* content changes (terrain edited, flora
//!   regrown, props placed) so JS can skip rebuilding derived GPU data.
//!
//! # Usage (inside a module crate)
//! ```ignore
//! // Plugin::build — one line registers the channel, the handle is a plain Copy value:
//! let id = app.register_channel::<f32>(ChannelSpec::records::<f32>("creatures", 16, 4096).interpolated());
//! app.insert_resource(MyChannels { creatures: id });
//! // publish system:
//! let mut w = channels.writer(my.creatures);
//! w.clear();
//! for c in &query { w.extend_from_slice(&record); }
//! ```

use crate::rng::fnv1a64;
use bevy_ecs::prelude::Resource;
use serde::Serialize;
use std::collections::BTreeMap;
use std::marker::PhantomData;

/// Element type of a channel (the `kind` string in `channel_info`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChannelKind {
    F32,
    U32,
    U16,
    U8,
}

impl ChannelKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ChannelKind::F32 => "f32",
            ChannelKind::U32 => "u32",
            ChannelKind::U16 => "u16",
            ChannelKind::U8 => "u8",
        }
    }

    /// Bytes per element.
    pub const fn size(self) -> usize {
        match self {
            ChannelKind::F32 | ChannelKind::U32 => 4,
            ChannelKind::U16 => 2,
            ChannelKind::U8 => 1,
        }
    }
}

mod sealed {
    pub trait Sealed {}
    impl Sealed for f32 {}
    impl Sealed for u32 {}
    impl Sealed for u16 {}
    impl Sealed for u8 {}
}

/// Element types a channel can hold: `f32`, `u32`, `u16`, `u8`.
pub trait ChannelElem: sealed::Sealed + Copy + Default + Send + Sync + 'static {
    const KIND: ChannelKind;
    #[doc(hidden)]
    fn buf(s: &Storage) -> Option<&Buf<Self>>;
    #[doc(hidden)]
    fn buf_mut(s: &mut Storage) -> Option<&mut Buf<Self>>;
    #[doc(hidden)]
    fn new_storage(cap: usize, interpolated: bool) -> Storage;
}

#[doc(hidden)]
#[derive(Debug)]
pub struct Buf<T> {
    cur: Vec<T>,
    /// Empty for non-interpolated channels.
    prev: Vec<T>,
}

impl<T: Copy + Default> Buf<T> {
    fn new(cap: usize, interpolated: bool) -> Self {
        Self { cur: vec![T::default(); cap], prev: if interpolated { vec![T::default(); cap] } else { Vec::new() } }
    }
    fn copy_cur_to_prev(&mut self, range: std::ops::Range<usize>) {
        if !self.prev.is_empty() {
            self.prev[range.clone()].copy_from_slice(&self.cur[range]);
        }
    }
}

#[doc(hidden)]
#[derive(Debug)]
pub enum Storage {
    F32(Buf<f32>),
    U32(Buf<u32>),
    U16(Buf<u16>),
    U8(Buf<u8>),
}

macro_rules! impl_elem {
    ($t:ty, $kind:ident, $variant:ident) => {
        impl ChannelElem for $t {
            const KIND: ChannelKind = ChannelKind::$kind;
            fn buf(s: &Storage) -> Option<&Buf<Self>> {
                match s {
                    Storage::$variant(b) => Some(b),
                    _ => None,
                }
            }
            fn buf_mut(s: &mut Storage) -> Option<&mut Buf<Self>> {
                match s {
                    Storage::$variant(b) => Some(b),
                    _ => None,
                }
            }
            fn new_storage(cap: usize, interpolated: bool) -> Storage {
                Storage::$variant(Buf::new(cap, interpolated))
            }
        }
    };
}
impl_elem!(f32, F32, F32);
impl_elem!(u32, U32, U32);
impl_elem!(u16, U16, U16);
impl_elem!(u8, U8, U8);

impl Storage {
    fn cur_ptr(&self) -> usize {
        match self {
            Storage::F32(b) => b.cur.as_ptr() as usize,
            Storage::U32(b) => b.cur.as_ptr() as usize,
            Storage::U16(b) => b.cur.as_ptr() as usize,
            Storage::U8(b) => b.cur.as_ptr() as usize,
        }
    }

    fn prev_ptr(&self) -> usize {
        match self {
            Storage::F32(b) => b.prev.as_ptr() as usize,
            Storage::U32(b) => b.prev.as_ptr() as usize,
            Storage::U16(b) => b.prev.as_ptr() as usize,
            Storage::U8(b) => b.prev.as_ptr() as usize,
        }
        // an empty Vec has a dangling non-null pointer; callers only expose it when interpolated
    }

    fn copy_cur_to_prev(&mut self, range: std::ops::Range<usize>) {
        match self {
            Storage::F32(b) => b.copy_cur_to_prev(range),
            Storage::U32(b) => b.copy_cur_to_prev(range),
            Storage::U16(b) => b.copy_cur_to_prev(range),
            Storage::U8(b) => b.copy_cur_to_prev(range),
        }
    }

    fn hash_cur(&self, len: usize, h: &mut u64) {
        #[inline]
        fn feed(h: &mut u64, v: u32) {
            for b in v.to_le_bytes() {
                *h ^= u64::from(b);
                *h = h.wrapping_mul(0x0000_0100_0000_01B3);
            }
        }
        match self {
            Storage::F32(b) => {
                for v in &b.cur[..len] {
                    // canonicalise NaN payloads (differ between targets)
                    feed(h, if v.is_nan() { 0x7FC0_0000 } else { v.to_bits() });
                }
            }
            Storage::U32(b) => b.cur[..len].iter().for_each(|v| feed(h, *v)),
            Storage::U16(b) => b.cur[..len].iter().for_each(|v| feed(h, u32::from(*v))),
            Storage::U8(b) => b.cur[..len].iter().for_each(|v| feed(h, u32::from(*v))),
        }
    }
}

/// Static description of a channel.
#[derive(Clone, Debug)]
pub struct ChannelSpec {
    pub name: &'static str,
    pub kind: ChannelKind,
    /// Elements per record (1 for flat grids / vectors).
    pub stride: u32,
    /// Capacity in elements (`records * stride`).
    pub cap: u32,
    pub interpolated: bool,
    pub doc: &'static str,
}

impl ChannelSpec {
    /// Record-style channel: `stride` elements per record, room for `max_records` records.
    pub fn records<T: ChannelElem>(name: &'static str, stride: u32, max_records: u32) -> Self {
        Self { name, kind: T::KIND, stride, cap: stride.saturating_mul(max_records), interpolated: false, doc: "" }
    }

    /// Flat channel (stride 1) with room for `cap` elements.
    pub fn flat<T: ChannelElem>(name: &'static str, cap: u32) -> Self {
        Self::records::<T>(name, 1, cap)
    }

    /// Double-buffer this channel for render interpolation.
    pub fn interpolated(mut self) -> Self {
        self.interpolated = true;
        self
    }

    /// One-line description shown in `core.stats` and the docs tooling.
    pub fn doc(mut self, doc: &'static str) -> Self {
        self.doc = doc;
        self
    }
}

/// Typed handle to a registered channel (cheap `Copy`; store it in a resource).
pub struct ChannelId<T> {
    index: usize,
    _t: PhantomData<fn() -> T>,
}

impl<T> Clone for ChannelId<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for ChannelId<T> {}
impl<T> std::fmt::Debug for ChannelId<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ChannelId({})", self.index)
    }
}

/// What JS needs to build a view (serialises to the exact `channel_info` JSON).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChannelInfo {
    /// Address of the current buffer in WASM linear memory (bytes).
    pub ptr: usize,
    /// Address of the previous-step buffer, `0` if the channel is not interpolated.
    pub prev_ptr: usize,
    /// Valid elements.
    pub len: usize,
    /// Capacity in elements.
    pub cap: usize,
    pub stride: u32,
    pub kind: &'static str,
    pub version: u32,
}

struct Channel {
    spec: ChannelSpec,
    storage: Storage,
    len: usize,
    prev_len: usize,
    version: u32,
    snap: bool,
    overflowed: bool,
}

/// Registry + storage of all channels (resource).
#[derive(Resource, Default)]
pub struct Channels {
    list: Vec<Channel>,
    by_name: BTreeMap<&'static str, usize>,
}

impl Channels {
    /// Registers a channel. Panics on a programmer error (duplicate name, wrong element type,
    /// zero stride/capacity, capacity not a multiple of stride): this only runs at build time.
    pub fn register<T: ChannelElem>(&mut self, spec: ChannelSpec) -> ChannelId<T> {
        assert!(spec.kind == T::KIND, "channel '{}': spec kind {:?} != element type {:?}", spec.name, spec.kind, T::KIND);
        assert!(spec.stride >= 1 && spec.cap >= 1, "channel '{}': stride and capacity must be >= 1", spec.name);
        assert!(spec.cap % spec.stride == 0, "channel '{}': capacity must be a multiple of stride", spec.name);
        assert!(!self.by_name.contains_key(spec.name), "channel '{}' registered twice", spec.name);

        let index = self.list.len();
        self.by_name.insert(spec.name, index);
        self.list.push(Channel {
            storage: T::new_storage(spec.cap as usize, spec.interpolated),
            spec,
            len: 0,
            prev_len: 0,
            version: 0,
            snap: false,
            overflowed: false,
        });
        ChannelId { index, _t: PhantomData }
    }

    /// Looks up a typed handle by name (None if missing or of a different element type).
    pub fn id<T: ChannelElem>(&self, name: &str) -> Option<ChannelId<T>> {
        let index = *self.by_name.get(name)?;
        (self.list[index].spec.kind == T::KIND).then_some(ChannelId { index, _t: PhantomData })
    }

    /// Opens a writer for the current buffer. Writing marks nothing by itself; bump the version
    /// separately for static data.
    pub fn writer<T: ChannelElem>(&mut self, id: ChannelId<T>) -> ChannelWriter<'_, T> {
        let ch = &mut self.list[id.index];
        let buf = T::buf_mut(&mut ch.storage).expect("ChannelId<T> always matches the channel kind");
        ChannelWriter { data: &mut buf.cur, len: &mut ch.len, overflowed: &mut ch.overflowed, name: ch.spec.name }
    }

    /// Valid elements of the current buffer.
    pub fn slice<T: ChannelElem>(&self, id: ChannelId<T>) -> &[T] {
        let ch = &self.list[id.index];
        let buf = T::buf(&ch.storage).expect("ChannelId<T> always matches the channel kind");
        &buf.cur[..ch.len]
    }

    /// Valid elements of the previous-step buffer (empty for non-interpolated channels).
    pub fn prev_slice<T: ChannelElem>(&self, id: ChannelId<T>) -> &[T] {
        let ch = &self.list[id.index];
        let buf = T::buf(&ch.storage).expect("ChannelId<T> always matches the channel kind");
        if buf.prev.is_empty() { &[] } else { &buf.prev[..ch.len.min(ch.prev_len)] }
    }

    /// Typed slice lookup by name (tests, debug tooling).
    pub fn slice_by_name<T: ChannelElem>(&self, name: &str) -> Option<&[T]> {
        self.id::<T>(name).map(|id| self.slice(id))
    }

    pub fn version<T: ChannelElem>(&self, id: ChannelId<T>) -> u32 {
        self.list[id.index].version
    }

    /// Announces that static content changed (JS rebuilds derived data when `version` differs).
    pub fn bump_version<T: ChannelElem>(&mut self, id: ChannelId<T>) {
        let ch = &mut self.list[id.index];
        ch.version = ch.version.wrapping_add(1);
    }

    /// The next `end_step` copies `cur` into `prev` for this channel (teleport / respawn / load).
    pub fn mark_discontinuity<T: ChannelElem>(&mut self, id: ChannelId<T>) {
        self.list[id.index].snap = true;
    }

    /// Like [`mark_discontinuity`](Self::mark_discontinuity) by name; returns false if unknown.
    pub fn mark_discontinuity_by_name(&mut self, name: &str) -> bool {
        match self.by_name.get(name) {
            Some(&i) => {
                self.list[i].snap = true;
                true
            }
            None => false,
        }
    }

    /// Marks every channel as discontinuous and applies it immediately.
    pub fn snap_all(&mut self) {
        for ch in &mut self.list {
            ch.snap = true;
        }
        self.end_step();
    }

    /// Called by `CorePlugin` at the start of each fixed step: `prev := cur`.
    pub fn begin_step(&mut self) {
        for ch in &mut self.list {
            if ch.spec.interpolated {
                ch.storage.copy_cur_to_prev(0..ch.len);
                ch.prev_len = ch.len;
            }
        }
    }

    /// Called by `CorePlugin` after publishing: mirrors new records / snapped channels into `prev`.
    pub fn end_step(&mut self) {
        for ch in &mut self.list {
            if !ch.spec.interpolated {
                continue;
            }
            if ch.snap {
                ch.storage.copy_cur_to_prev(0..ch.len);
                ch.prev_len = ch.len;
                ch.snap = false;
            } else if ch.len > ch.prev_len {
                ch.storage.copy_cur_to_prev(ch.prev_len..ch.len);
                ch.prev_len = ch.len;
            }
        }
    }

    /// Channel names in registration order.
    pub fn names(&self) -> Vec<&'static str> {
        self.list.iter().map(|c| c.spec.name).collect()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// Specs in registration order.
    pub fn specs(&self) -> impl Iterator<Item = &ChannelSpec> {
        self.list.iter().map(|c| &c.spec)
    }

    /// `channel_info` payload for a channel.
    pub fn info(&self, name: &str) -> Option<ChannelInfo> {
        let ch = &self.list[*self.by_name.get(name)?];
        Some(ChannelInfo {
            ptr: ch.storage.cur_ptr(),
            prev_ptr: if ch.spec.interpolated { ch.storage.prev_ptr() } else { 0 },
            len: ch.len,
            cap: ch.spec.cap as usize,
            stride: ch.spec.stride,
            kind: ch.spec.kind.as_str(),
            version: ch.version,
        })
    }

    /// The valid part of a channel's current buffer as little-endian bytes - exactly what JS sees
    /// through its typed-array view (tests, golden files, debug tooling).
    pub fn to_bytes(&self, name: &str) -> Option<Vec<u8>> {
        let ch = &self.list[*self.by_name.get(name)?];
        let mut out = Vec::with_capacity(ch.len * ch.spec.kind.size());
        match &ch.storage {
            Storage::F32(b) => b.cur[..ch.len].iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes())),
            Storage::U32(b) => b.cur[..ch.len].iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes())),
            Storage::U16(b) => b.cur[..ch.len].iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes())),
            Storage::U8(b) => out.extend_from_slice(&b.cur[..ch.len]),
        }
        Some(out)
    }

    /// Names of channels whose writers tried to exceed capacity (should always be empty).
    pub fn overflowed(&self) -> Vec<&'static str> {
        self.list.iter().filter(|c| c.overflowed).map(|c| c.spec.name).collect()
    }

    /// FNV-1a digest over every channel's name, length and valid `cur` data - the determinism
    /// fingerprint used by tests and the smoke script. Versions are deliberately *not* included:
    /// they count content changes (a `load` bumps them even when the restored content is
    /// identical), the digest fingerprints what JS actually sees.
    pub fn digest(&self) -> u64 {
        let mut h = fnv1a64(b"channels");
        for ch in &self.list {
            h ^= fnv1a64(ch.spec.name.as_bytes());
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
            h ^= ch.len as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
            ch.storage.hash_cur(ch.len, &mut h);
        }
        h
    }
}

/// Write access to a channel's current buffer.
pub struct ChannelWriter<'a, T> {
    data: &'a mut Vec<T>,
    len: &'a mut usize,
    overflowed: &'a mut bool,
    name: &'static str,
}

impl<T: ChannelElem> ChannelWriter<'_, T> {
    /// Sets `len` to zero (contents are left as they are; they are overwritten by pushes).
    pub fn clear(&mut self) {
        *self.len = 0;
    }

    pub fn len(&self) -> usize {
        *self.len
    }

    pub fn is_empty(&self) -> bool {
        *self.len == 0
    }

    pub fn capacity(&self) -> usize {
        self.data.len()
    }

    fn overflow(&mut self) {
        if !*self.overflowed {
            log::error!("channel '{}' overflowed its capacity of {} elements; data truncated", self.name, self.data.len());
        }
        *self.overflowed = true;
    }

    /// Appends one element. Returns false (and flags overflow) if the channel is full.
    pub fn push(&mut self, v: T) -> bool {
        if *self.len >= self.data.len() {
            self.overflow();
            return false;
        }
        self.data[*self.len] = v;
        *self.len += 1;
        true
    }

    /// Appends a whole record/slice atomically: either all of it fits or nothing is written.
    pub fn extend_from_slice(&mut self, vs: &[T]) -> bool {
        let end = *self.len + vs.len();
        if end > self.data.len() {
            self.overflow();
            return false;
        }
        self.data[*self.len..end].copy_from_slice(vs);
        *self.len = end;
        true
    }

    /// Replaces the content with `src` (truncating, with overflow flag, if it is too long).
    pub fn replace_with(&mut self, src: &[T]) {
        let n = src.len().min(self.data.len());
        if n < src.len() {
            self.overflow();
        }
        self.data[..n].copy_from_slice(&src[..n]);
        *self.len = n;
    }

    /// The whole capacity as a mutable slice (for grid channels written in place); follow with
    /// [`set_len`](Self::set_len).
    pub fn full_slice_mut(&mut self) -> &mut [T] {
        self.data
    }

    /// Sets the number of valid elements (clamped to capacity).
    pub fn set_len(&mut self, n: usize) {
        *self.len = n.min(self.data.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make() -> (Channels, ChannelId<f32>, ChannelId<u8>) {
        let mut c = Channels::default();
        let a = c.register::<f32>(ChannelSpec::records::<f32>("ents", 4, 8).interpolated());
        let b = c.register::<u8>(ChannelSpec::flat::<u8>("grid", 16));
        (c, a, b)
    }

    #[test]
    fn register_and_info() {
        let (mut c, a, b) = make();
        assert_eq!(c.names(), vec!["ents", "grid"]);
        c.writer(a).extend_from_slice(&[1.0, 2.0, 3.0, 4.0]);
        let i = c.info("ents").unwrap();
        assert_eq!((i.len, i.cap, i.stride, i.kind), (4, 32, 4, "f32"));
        assert_ne!(i.ptr, 0);
        assert_ne!(i.prev_ptr, 0);
        assert_ne!(i.ptr, i.prev_ptr);
        let g = c.info("grid").unwrap();
        assert_eq!((g.prev_ptr, g.kind, g.stride, g.cap), (0, "u8", 1, 16));
        assert!(c.info("nope").is_none());
        assert!(c.id::<f32>("grid").is_none(), "wrong element type is rejected");
        assert!(c.id::<u8>("grid").is_some());
        let _ = b;
        // serialises to the documented JSON keys, in order
        let json = serde_json::to_string(&i).unwrap();
        assert!(json.starts_with("{\"ptr\":"), "{json}");
        assert!(json.contains("\"prev_ptr\":") && json.contains("\"kind\":\"f32\"") && json.ends_with("\"version\":0}"));
    }

    #[test]
    fn pointers_never_move() {
        let (mut c, a, _) = make();
        let p0 = c.info("ents").unwrap();
        for step in 0..100 {
            c.begin_step();
            let mut w = c.writer(a);
            w.clear();
            for r in 0..8 {
                w.extend_from_slice(&[step as f32, r as f32, 0.0, 0.0]);
            }
            c.end_step();
        }
        let p1 = c.info("ents").unwrap();
        assert_eq!((p0.ptr, p0.prev_ptr), (p1.ptr, p1.prev_ptr));
    }

    #[test]
    fn double_buffer_holds_previous_step() {
        let (mut c, a, _) = make();
        // step 1
        c.begin_step();
        c.writer(a).extend_from_slice(&[1.0, 10.0, 0.0, 0.0]);
        c.end_step();
        // step 2: prev must be step-1 data, cur step-2 data
        c.begin_step();
        {
            let mut w = c.writer(a);
            w.clear();
            w.extend_from_slice(&[2.0, 20.0, 0.0, 0.0]);
        }
        c.end_step();
        assert_eq!(c.slice(a), &[2.0, 20.0, 0.0, 0.0]);
        assert_eq!(c.prev_slice(a), &[1.0, 10.0, 0.0, 0.0]);
        // step 3
        c.begin_step();
        {
            let mut w = c.writer(a);
            w.clear();
            w.extend_from_slice(&[3.0, 30.0, 0.0, 0.0]);
        }
        c.end_step();
        assert_eq!(c.prev_slice(a), &[2.0, 20.0, 0.0, 0.0]);
        assert_eq!(c.slice(a), &[3.0, 30.0, 0.0, 0.0]);
    }

    #[test]
    fn new_records_mirror_into_prev_so_they_do_not_pop() {
        let (mut c, a, _) = make();
        c.begin_step();
        c.writer(a).extend_from_slice(&[1.0, 1.0, 1.0, 1.0]);
        c.end_step();
        // step 2 adds a second record
        c.begin_step();
        {
            let mut w = c.writer(a);
            w.clear();
            w.extend_from_slice(&[1.5, 1.5, 1.5, 1.5]);
            w.extend_from_slice(&[9.0, 9.0, 9.0, 9.0]);
        }
        c.end_step();
        assert_eq!(c.slice(a).len(), 8);
        assert_eq!(c.prev_slice(a).len(), 8);
        assert_eq!(&c.prev_slice(a)[0..4], &[1.0; 4], "existing record keeps its real previous value");
        assert_eq!(&c.prev_slice(a)[4..8], &[9.0; 4], "new record starts at its own value (no interpolation)");
    }

    #[test]
    fn discontinuity_snaps_prev_to_cur() {
        let (mut c, a, _) = make();
        c.begin_step();
        c.writer(a).extend_from_slice(&[0.0; 4]);
        c.end_step();
        c.begin_step();
        {
            let mut w = c.writer(a);
            w.clear();
            w.extend_from_slice(&[100.0; 4]); // teleport
        }
        c.mark_discontinuity(a);
        c.end_step();
        assert_eq!(c.prev_slice(a), c.slice(a));
        // and only once
        c.begin_step();
        {
            let mut w = c.writer(a);
            w.clear();
            w.extend_from_slice(&[101.0; 4]);
        }
        c.end_step();
        assert_eq!(c.prev_slice(a), &[100.0; 4]);
    }

    #[test]
    fn overflow_is_atomic_and_flagged() {
        let (mut c, a, _) = make();
        let mut w = c.writer(a);
        for _ in 0..8 {
            assert!(w.extend_from_slice(&[1.0; 4]));
        }
        assert!(!w.extend_from_slice(&[2.0; 4]));
        assert!(!w.push(3.0));
        assert_eq!(w.len(), 32);
        assert!(c.overflowed().contains(&"ents"));
    }

    #[test]
    fn grid_channel_full_slice_and_version() {
        let (mut c, _, b) = make();
        {
            let mut w = c.writer(b);
            for (i, v) in w.full_slice_mut().iter_mut().enumerate() {
                *v = i as u8;
            }
            w.set_len(16);
        }
        assert_eq!(c.slice(b)[15], 15);
        assert_eq!(c.version(b), 0);
        c.bump_version(b);
        assert_eq!(c.version(b), 1);
        assert_eq!(c.info("grid").unwrap().version, 1);
        assert!(c.prev_slice(b).is_empty());
    }

    #[test]
    fn digest_tracks_content_and_len_but_not_version() {
        let (mut c, a, b) = make();
        let d0 = c.digest();
        assert_eq!(d0, c.digest());
        c.writer(a).extend_from_slice(&[1.0, 2.0, 3.0, 4.0]);
        let d1 = c.digest();
        assert_ne!(d0, d1);
        c.bump_version(b);
        assert_eq!(d1, c.digest(), "versions are not part of the fingerprint");
        c.writer(a).clear();
        assert_ne!(d1, c.digest(), "len is");
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_names_panic() {
        let mut c = Channels::default();
        c.register::<f32>(ChannelSpec::flat::<f32>("x", 4));
        c.register::<f32>(ChannelSpec::flat::<f32>("x", 4));
    }

    #[test]
    fn replace_with_truncates() {
        let (mut c, _, b) = make();
        let mut w = c.writer(b);
        w.replace_with(&[7u8; 20]);
        assert_eq!(w.len(), 16);
        assert!(c.overflowed().contains(&"grid"));
    }
}
