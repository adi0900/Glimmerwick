//! Components shared by every module (plain data; no behaviour).

use crate::math::Vec3;
use bevy_ecs::prelude::Component;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

macro_rules! deref_newtype {
    ($name:ident, $inner:ty) => {
        impl Deref for $name {
            type Target = $inner;
            fn deref(&self) -> &$inner {
                &self.0
            }
        }
        impl DerefMut for $name {
            fn deref_mut(&mut self) -> &mut $inner {
                &mut self.0
            }
        }
    };
}

/// World position in metres (feet position for characters).
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Position(pub Vec3);
deref_newtype!(Position, Vec3);

/// Velocity in metres per second.
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Velocity(pub Vec3);
deref_newtype!(Velocity, Vec3);

/// Facing as a yaw angle in radians; facing direction = `(sin yaw, 0, cos yaw)`
/// (see [`crate::math`] conventions).
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Yaw(pub f32);
deref_newtype!(Yaw, f32);

/// Marks something the player can look at / interact with (creatures, villagers, props).
/// `sim_player` finds the nearest `Interactable` in front of the camera for
/// `player.look_target_id`; the owner of the entity decides what interacting does.
#[derive(Component, Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Interactable {
    /// Max distance (m) from which the player can target this entity.
    pub radius: f32,
}

impl Default for Interactable {
    fn default() -> Self {
        Self { radius: 5.0 }
    }
}

/// Marker of the (single) player entity, set by `sim_player`. Lets other crates find the player
/// through `sim_core` (e.g. `Single<(&Id, &Position), With<Player>>`).
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Player;
