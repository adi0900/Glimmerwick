//! Stable gameplay ids.
//!
//! Bevy `Entity` values are not stable across save/load and mean nothing to JS, so everything the
//! outside world refers to (creatures, the player, props, ...) carries an [`Id`]. Ids are allocated
//! from one global monotonic counter ([`IdAllocator`], saved in the `core` section), start at 1
//! (`0` = "none" in channels), and stay exact in `f32` channel columns up to 2^24.
//!
//! [`IdIndex`] maps `Id -> Entity` and is maintained automatically by the component hooks of
//! [`Id`], so `index.get(id)` is always current (also after `despawn`). Iteration is by ascending id.

use bevy_ecs::lifecycle::HookContext;
use bevy_ecs::prelude::*;
use bevy_ecs::world::DeferredWorld;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Stable id of a gameplay entity. Immutable once spawned.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[component(immutable, on_add = id_on_add, on_remove = id_on_remove)]
pub struct Id(pub u32);

fn id_on_add(mut world: DeferredWorld, ctx: HookContext) {
    let Some(id) = world.get::<Id>(ctx.entity).copied() else { return };
    if let Some(mut index) = world.get_resource_mut::<IdIndex>() {
        index.map.insert(id.0, ctx.entity);
    }
}

fn id_on_remove(mut world: DeferredWorld, ctx: HookContext) {
    let Some(id) = world.get::<Id>(ctx.entity).copied() else { return };
    if let Some(mut index) = world.get_resource_mut::<IdIndex>() {
        // Only remove our own mapping (a replacement entity may already own the id).
        if index.map.get(&id.0) == Some(&ctx.entity) {
            index.map.remove(&id.0);
        }
    }
}

/// Global id counter (resource).
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdAllocator {
    next: u32,
}

impl Default for IdAllocator {
    fn default() -> Self {
        Self { next: 1 }
    }
}

impl IdAllocator {
    /// Allocates a fresh id (never 0).
    pub fn alloc(&mut self) -> Id {
        let id = self.next;
        self.next = self.next.wrapping_add(1).max(1);
        Id(id)
    }

    /// Next id that will be handed out (for save files).
    pub fn peek(&self) -> u32 {
        self.next
    }

    /// Restores the counter (for save files).
    pub fn set_next(&mut self, next: u32) {
        self.next = next.max(1);
    }
}

/// `Id -> Entity` lookup (resource), maintained by the hooks on [`Id`].
#[derive(Resource, Default, Debug)]
pub struct IdIndex {
    map: BTreeMap<u32, Entity>,
}

impl IdIndex {
    pub fn get(&self, id: u32) -> Option<Entity> {
        self.map.get(&id).copied()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// `(id, entity)` pairs in ascending id order.
    pub fn iter(&self) -> impl Iterator<Item = (u32, Entity)> + '_ {
        self.map.iter().map(|(k, v)| (*k, *v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_follows_spawn_and_despawn() {
        let mut w = World::new();
        w.init_resource::<IdIndex>();
        let mut alloc = IdAllocator::default();
        let a = alloc.alloc();
        let b = alloc.alloc();
        assert_eq!((a.0, b.0), (1, 2));
        let ea = w.spawn(a).id();
        let eb = w.spawn(b).id();
        assert_eq!(w.resource::<IdIndex>().get(1), Some(ea));
        assert_eq!(w.resource::<IdIndex>().get(2), Some(eb));
        w.despawn(ea);
        assert_eq!(w.resource::<IdIndex>().get(1), None);
        assert_eq!(w.resource::<IdIndex>().len(), 1);
        assert_eq!(w.resource::<IdIndex>().iter().next().map(|(i, _)| i), Some(2));
    }

    #[test]
    fn allocator_restore_never_returns_zero() {
        let mut a = IdAllocator::default();
        a.set_next(0);
        assert_eq!(a.alloc().0, 1);
        a.set_next(u32::MAX);
        assert_eq!(a.alloc().0, u32::MAX);
        assert_eq!(a.alloc().0, 1, "wraps over 0");
    }
}
