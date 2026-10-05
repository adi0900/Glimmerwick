//! Player input as delivered by `Game::set_input(Float32Array[16])`.
//!
//! Raw layout (ARCHITECTURE.md §4, stable):
//!
//! | idx | meaning |
//! |---|---|
//! | 0 | `move_x`  -1..1 (right +) |
//! | 1 | `move_y`  -1..1 (forward +) |
//! | 2 | `look_dx` px since the previous `set_input` |
//! | 3 | `look_dy` px since the previous `set_input` |
//! | 4 | `buttons` bitmask, see [`buttons`] (held state) |
//! | 5 | `camera_yaw` radians (movement is camera-relative) |
//! | 6 | `camera_pitch` radians |
//! | 7 | `zoom` |
//! | 8-15 | reserved (kept in [`Input::extra`]) |
//!
//! JS may call `set_input` more or less often than the sim steps (60 Hz): a 144 Hz display calls it
//! up to three times between steps, a slow frame runs several steps for one call. [`Input`]
//! therefore *latches*: look deltas accumulate, and button presses / releases that happen between
//! two steps are remembered in `pressed` / `released` until a step consumed them, so quick taps are
//! never lost. `CorePlugin` clears the latches at the end of every step.

use crate::math::Vec2;
use bevy_ecs::prelude::Resource;

/// Length of the raw input array.
pub const INPUT_LEN: usize = 16;

/// Button bits of `Input.buttons` (raw index 4).
pub mod buttons {
    pub const JUMP: u32 = 1;
    pub const INTERACT: u32 = 2;
    pub const SPRINT: u32 = 4;
    pub const USE_TOOL: u32 = 8;
    pub const CANCEL: u32 = 16;
    pub const MENU: u32 = 32;
    pub const BUILD_TOGGLE: u32 = 64;
    pub const PHOTO: u32 = 128;
    pub const TOOL_NEXT: u32 = 256;
    pub const TOOL_PREV: u32 = 512;
    /// All defined bits (anything else in the raw value is masked off).
    pub const ALL: u32 = 0x3FF;
}

/// Decoded, sanitised input (resource).
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct Input {
    /// Strafe axis, `-1..=1`, right positive (before camera rotation).
    pub move_x: f32,
    /// Forward axis, `-1..=1`, forward positive (before camera rotation).
    pub move_y: f32,
    /// Accumulated mouse/touch look delta since the last step consumed it (px).
    pub look_dx: f32,
    pub look_dy: f32,
    /// Buttons currently held (see [`buttons`]).
    pub buttons: u32,
    /// Buttons that went down since the last step consumed the latch.
    pub pressed: u32,
    /// Buttons that went up since the last step consumed the latch.
    pub released: u32,
    /// Camera yaw (rad) - movement is camera-relative.
    pub camera_yaw: f32,
    pub camera_pitch: f32,
    pub zoom: f32,
    /// Raw indices 8..16, reserved for future use.
    pub extra: [f32; 8],
}

impl Default for Input {
    fn default() -> Self {
        Self {
            move_x: 0.0,
            move_y: 0.0,
            look_dx: 0.0,
            look_dy: 0.0,
            buttons: 0,
            pressed: 0,
            released: 0,
            camera_yaw: 0.0,
            camera_pitch: 0.0,
            zoom: 1.0,
            extra: [0.0; 8],
        }
    }
}

#[inline]
fn finite_or(v: f32, fallback: f32) -> f32 {
    if v.is_finite() { v } else { fallback }
}

impl Input {
    /// Applies a raw `Float32Array` from JS. Never panics: short arrays are zero-padded, extra
    /// elements ignored, NaN/Inf replaced, ranges clamped.
    pub fn apply_raw(&mut self, raw: &[f32]) {
        let get = |i: usize| raw.get(i).copied().unwrap_or(0.0);

        self.move_x = finite_or(get(0), 0.0).clamp(-1.0, 1.0);
        self.move_y = finite_or(get(1), 0.0).clamp(-1.0, 1.0);
        self.look_dx += finite_or(get(2), 0.0).clamp(-10_000.0, 10_000.0);
        self.look_dy += finite_or(get(3), 0.0).clamp(-10_000.0, 10_000.0);

        let raw_buttons = finite_or(get(4), 0.0).clamp(0.0, 65_535.0) as u32 & buttons::ALL;
        self.pressed |= raw_buttons & !self.buttons;
        self.released |= self.buttons & !raw_buttons;
        self.buttons = raw_buttons;

        self.camera_yaw = finite_or(get(5), 0.0);
        self.camera_pitch = finite_or(get(6), 0.0);
        self.zoom = raw.get(7).copied().filter(|v| v.is_finite()).unwrap_or(1.0);
        for i in 0..8 {
            self.extra[i] = finite_or(get(8 + i), 0.0);
        }
    }

    /// Clears the per-step latches (look deltas and button edges). Called by `CorePlugin`.
    pub fn consume_latches(&mut self) {
        self.look_dx = 0.0;
        self.look_dy = 0.0;
        self.pressed = 0;
        self.released = 0;
    }

    /// `true` while *any* of the bits in `mask` is held.
    #[inline]
    pub fn held(&self, mask: u32) -> bool {
        self.buttons & mask != 0
    }

    /// `true` if any bit of `mask` went down since the last step.
    #[inline]
    pub fn just_pressed(&self, mask: u32) -> bool {
        self.pressed & mask != 0
    }

    /// `true` if any bit of `mask` went up since the last step.
    #[inline]
    pub fn just_released(&self, mask: u32) -> bool {
        self.released & mask != 0
    }

    /// Movement axes as a vector whose length never exceeds 1 (diagonals are not faster).
    pub fn move_vec(&self) -> Vec2 {
        let v = Vec2::new(self.move_x, self.move_y);
        if v.length_squared() > 1.0 { v.normalize() } else { v }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(f: impl FnOnce(&mut [f32; 16])) -> [f32; 16] {
        let mut a = [0.0; 16];
        f(&mut a);
        a
    }

    #[test]
    fn decodes_layout() {
        let mut i = Input::default();
        i.apply_raw(&raw(|a| {
            a[0] = 0.5;
            a[1] = -1.0;
            a[2] = 3.0;
            a[3] = -2.0;
            a[4] = (buttons::JUMP | buttons::SPRINT) as f32;
            a[5] = 1.25;
            a[6] = -0.3;
            a[7] = 2.0;
            a[9] = 7.0;
        }));
        assert_eq!((i.move_x, i.move_y), (0.5, -1.0));
        assert_eq!((i.look_dx, i.look_dy), (3.0, -2.0));
        assert_eq!(i.buttons, 5);
        assert_eq!(i.camera_yaw, 1.25);
        assert_eq!(i.camera_pitch, -0.3);
        assert_eq!(i.zoom, 2.0);
        assert_eq!(i.extra[1], 7.0);
        assert!(i.just_pressed(buttons::JUMP) && i.held(buttons::SPRINT));
    }

    #[test]
    fn latches_survive_multiple_calls_until_consumed() {
        let mut i = Input::default();
        // frame 1: press jump, look +2
        i.apply_raw(&raw(|a| {
            a[2] = 2.0;
            a[4] = buttons::JUMP as f32;
        }));
        // frame 2 (still no step): release jump, look +3
        i.apply_raw(&raw(|a| a[2] = 3.0));
        assert_eq!(i.buttons, 0);
        assert!(i.just_pressed(buttons::JUMP), "quick tap must not be lost");
        assert!(i.just_released(buttons::JUMP));
        assert_eq!(i.look_dx, 5.0);
        i.consume_latches();
        assert!(!i.just_pressed(buttons::JUMP) && !i.just_released(buttons::JUMP));
        assert_eq!(i.look_dx, 0.0);
    }

    #[test]
    fn held_button_is_not_re_pressed() {
        let mut i = Input::default();
        let a = raw(|a| a[4] = buttons::INTERACT as f32);
        i.apply_raw(&a);
        i.consume_latches();
        i.apply_raw(&a);
        assert!(i.held(buttons::INTERACT));
        assert!(!i.just_pressed(buttons::INTERACT));
    }

    #[test]
    fn sanitises_garbage_and_short_arrays() {
        let mut i = Input::default();
        i.apply_raw(&[f32::NAN, f32::INFINITY, f32::NAN, 1e30, -5.0, f32::NAN]);
        assert_eq!((i.move_x, i.move_y), (0.0, 0.0));
        assert_eq!(i.look_dx, 0.0);
        assert_eq!(i.look_dy, 10_000.0);
        assert_eq!(i.buttons, 0);
        assert_eq!(i.camera_yaw, 0.0);
        i.apply_raw(&[]);
        assert_eq!(i.move_x, 0.0);
        i.apply_raw(&[2.0, -2.0]);
        assert_eq!((i.move_x, i.move_y), (1.0, -1.0));
        // unknown button bits are masked off
        i.apply_raw(&raw(|a| a[4] = 4096.0 + 2.0));
        assert_eq!(i.buttons, buttons::INTERACT);
    }

    #[test]
    fn move_vec_is_clamped_to_unit_length() {
        let mut i = Input::default();
        i.apply_raw(&[1.0, 1.0]);
        assert!((i.move_vec().length() - 1.0).abs() < 1e-5);
        i.apply_raw(&[0.3, 0.0]);
        assert_eq!(i.move_vec().length(), 0.3);
    }
}
