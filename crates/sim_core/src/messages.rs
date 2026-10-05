//! Cross-module messages (Bevy `Message`s, the renamed events). They let crates talk without
//! depending on each other: the writer and the readers only share these types from `sim_core`.
//!
//! Messages live for two steps (Bevy double-buffers them in `First`), so a reader ordered before
//! the writer in the same step still sees them on the next step. Every message type here is
//! registered by `CorePlugin`.
//!
//! These are *internal* signals. Things JS must hear about go through the
//! [`EventBus`](crate::EventBus) instead.

use bevy_ecs::prelude::Message;

/// The player pressed INTERACT while looking at an [`Interactable`](crate::Interactable).
/// Written by `sim_player`; creatures / villagers / props react (emote, open a dialog, ...).
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Interact {
    /// [`Id`](crate::Id) of the targeted entity.
    pub target: u32,
    /// Tool the player was holding.
    pub tool: u8,
}
