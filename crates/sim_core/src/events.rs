//! One-shot gameplay events for the JS side (sounds, particles, UI toasts, camera shakes).
//!
//! Systems call [`EventBus::emit`]; JS calls `Game::drain_events()` once per frame and receives a
//! packed `Float32Array` of `[kind, a, b, x, y, z, f] * n` ([`EVENT_STRIDE`] = 7). Events are
//! *not* part of save files and are discarded on `load`.
//!
//! # Kind ranges (stable contract)
//! | domain | range | owner |
//! |---|---|---|
//! | core | 0-99 | sim_core |
//! | world | 100-199 | sim_world |
//! | player | 200-299 | sim_player |
//! | creatures | 300-399 | sim_creatures |
//! | build | 400-499 | sim_build |
//! | systems | 500-599 | sim_systems |
//!
//! Declare kinds as constants with the range-checked constructors, e.g.
//! `pub const NOTICE: EventKind = EventKind::creatures(0);` - an offset >= 100 fails to compile.
//! `a` / `b` are free payload slots (ids are exact up to 2^24), `(x,y,z)` a world position, `f` a
//! free float (strength, speed, ...). Document each kind's payload next to its constant.

use crate::math::Vec3;
use bevy_ecs::prelude::Resource;

/// Floats per packed event.
pub const EVENT_STRIDE: usize = 7;
/// Events kept between two `drain_events` calls; further events are counted in `dropped` and lost.
pub const MAX_EVENTS: usize = 8192;

/// Numeric event kind (see module docs for ranges).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventKind(pub u16);

/// Event domains with their reserved ranges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventDomain {
    Core,
    World,
    Player,
    Creatures,
    Build,
    Systems,
}

impl EventDomain {
    pub const fn base(self) -> u16 {
        match self {
            EventDomain::Core => 0,
            EventDomain::World => 100,
            EventDomain::Player => 200,
            EventDomain::Creatures => 300,
            EventDomain::Build => 400,
            EventDomain::Systems => 500,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            EventDomain::Core => "core",
            EventDomain::World => "world",
            EventDomain::Player => "player",
            EventDomain::Creatures => "creatures",
            EventDomain::Build => "build",
            EventDomain::Systems => "systems",
        }
    }
}

impl EventKind {
    const fn in_domain(domain: EventDomain, offset: u16) -> Self {
        assert!(offset < 100, "event offset must be in 0..100 (each domain owns 100 kinds)");
        EventKind(domain.base() + offset)
    }
    pub const fn core(offset: u16) -> Self {
        Self::in_domain(EventDomain::Core, offset)
    }
    pub const fn world(offset: u16) -> Self {
        Self::in_domain(EventDomain::World, offset)
    }
    pub const fn player(offset: u16) -> Self {
        Self::in_domain(EventDomain::Player, offset)
    }
    pub const fn creatures(offset: u16) -> Self {
        Self::in_domain(EventDomain::Creatures, offset)
    }
    pub const fn build(offset: u16) -> Self {
        Self::in_domain(EventDomain::Build, offset)
    }
    pub const fn systems(offset: u16) -> Self {
        Self::in_domain(EventDomain::Systems, offset)
    }

    /// The domain this kind belongs to, if it is inside a reserved range.
    pub const fn domain(self) -> Option<EventDomain> {
        match self.0 {
            0..=99 => Some(EventDomain::Core),
            100..=199 => Some(EventDomain::World),
            200..=299 => Some(EventDomain::Player),
            300..=399 => Some(EventDomain::Creatures),
            400..=499 => Some(EventDomain::Build),
            500..=599 => Some(EventDomain::Systems),
            _ => None,
        }
    }
}

/// Core events (0-99).
pub mod core_events {
    use super::EventKind;
    /// Emitted once after `load()` restored a save. `a` = restored tick count (low 24 bits exact).
    pub const LOADED: EventKind = EventKind::core(1);
    /// The sim fell behind and dropped time. `a` = seconds dropped.
    pub const FRAME_DROP: EventKind = EventKind::core(2);
}

/// Ring-less, bounded queue of packed events (resource).
#[derive(Resource, Debug, Default)]
pub struct EventBus {
    buf: Vec<f32>,
    dropped: u64,
}

impl EventBus {
    /// Queues one event.
    pub fn emit(&mut self, kind: EventKind, a: f32, b: f32, pos: Vec3, f: f32) {
        if self.buf.len() >= MAX_EVENTS * EVENT_STRIDE {
            self.dropped += 1;
            return;
        }
        self.buf.extend_from_slice(&[f32::from(kind.0), a, b, pos.x, pos.y, pos.z, f]);
    }

    /// Queues an event that only carries a position.
    pub fn emit_at(&mut self, kind: EventKind, pos: Vec3) {
        self.emit(kind, 0.0, 0.0, pos, 0.0);
    }

    /// Number of queued events.
    pub fn len(&self) -> usize {
        self.buf.len() / EVENT_STRIDE
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Total events lost to the [`MAX_EVENTS`] cap since creation.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Returns all queued events as packed floats and clears the queue.
    pub fn drain(&mut self) -> Vec<f32> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let out = self.buf.clone();
        self.buf.clear();
        out
    }

    /// Iterates queued events without consuming them (tests / debug tools).
    pub fn iter(&self) -> impl Iterator<Item = &[f32]> {
        self.buf.chunks_exact(EVENT_STRIDE)
    }

    /// Discards everything (used on load).
    pub fn clear(&mut self) {
        self.buf.clear();
    }
}

/// One documented event kind (for `core.events` query and generated docs).
#[derive(Clone, Debug)]
pub struct EventDef {
    pub kind: EventKind,
    pub name: &'static str,
    pub doc: &'static str,
}

/// Name table of registered events (resource). Purely informational; emitting does not require it.
#[derive(Resource, Debug, Default)]
pub struct EventRegistry {
    pub entries: Vec<EventDef>,
}

impl EventRegistry {
    /// Registers a kind. Panics on a duplicate kind or name: that is a programmer error at build
    /// time (two modules claiming the same number), never reachable from JS.
    pub fn register(&mut self, kind: EventKind, name: &'static str, doc: &'static str) {
        assert!(
            !self.entries.iter().any(|e| e.kind == kind || e.name == name),
            "event kind {} / name '{name}' registered twice",
            kind.0
        );
        assert!(kind.domain().is_some(), "event kind {} is outside every reserved range", kind.0);
        self.entries.push(EventDef { kind, name, doc });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(EventKind::core(0).0, 0);
        assert_eq!(EventKind::world(0).0, 100);
        assert_eq!(EventKind::player(5).0, 205);
        assert_eq!(EventKind::creatures(99).0, 399);
        assert_eq!(EventKind::build(1).0, 401);
        assert_eq!(EventKind::systems(0).0, 500);
        assert_eq!(EventKind(250).domain(), Some(EventDomain::Player));
        assert_eq!(EventKind(600).domain(), None);
    }

    #[test]
    fn pack_and_drain() {
        let mut bus = EventBus::default();
        assert!(bus.drain().is_empty());
        bus.emit(EventKind::player(1), 2.0, 3.0, Vec3::new(4.0, 5.0, 6.0), 7.0);
        bus.emit_at(EventKind::world(2), Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(bus.len(), 2);
        let v = bus.drain();
        assert_eq!(v.len(), 2 * EVENT_STRIDE);
        assert_eq!(&v[0..7], &[201.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]);
        assert_eq!(&v[7..14], &[102.0, 0.0, 0.0, 1.0, 2.0, 3.0, 0.0]);
        assert!(bus.is_empty());
    }

    #[test]
    fn cap_drops_newest_and_counts() {
        let mut bus = EventBus::default();
        for _ in 0..MAX_EVENTS + 10 {
            bus.emit_at(EventKind::core(1), Vec3::ZERO);
        }
        assert_eq!(bus.len(), MAX_EVENTS);
        assert_eq!(bus.dropped(), 10);
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn registry_rejects_duplicates() {
        let mut r = EventRegistry::default();
        r.register(EventKind::player(0), "a", "");
        r.register(EventKind::player(0), "b", "");
    }
}
