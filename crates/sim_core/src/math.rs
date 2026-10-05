//! Deterministic math helpers + world-space conventions.
//!
//! # Why this module exists
//! `f32::sin()` & friends call the platform libm, whose last-bit results differ between native
//! (MSVC / glibc) and `wasm32` (Rust's bundled libm). Sim code **must** use the wrappers below
//! (backed by the pure-Rust `libm` crate, identical everywhere) so that the same seed + inputs give
//! byte-identical channels on every target. `sqrt`, `floor`, `ceil`, `abs`, `min`, `max` are
//! correctly-rounded IEEE operations and are safe to call directly. Avoid `mul_add` (FMA fusion
//! is target dependent).
//!
//! # World conventions (shared with the three.js side)
//! * Right-handed, **Y up**, metres. `+X` = east, `-Z` = north (the default three.js camera looks
//!   down `-Z`), so `+Z` = south.
//! * **Entity yaw** (`Yaw`, channel `yaw` columns): rotation about +Y such that
//!   `facing = (sin yaw, 0, cos yaw)`; i.e. a model whose front is `+Z` uses
//!   `mesh.rotation.y = yaw`.
//! * **Camera yaw** (`Input.camera_yaw`): three.js `camera.rotation.y`; the camera looks along
//!   `(-sin yaw, 0, -cos yaw)` and its right vector is `(cos yaw, 0, -sin yaw)`.

pub use glam::{Vec2, Vec3};

pub const PI: f32 = core::f32::consts::PI;
pub const TAU: f32 = core::f32::consts::TAU;

#[inline]
pub fn sin(x: f32) -> f32 {
    libm::sinf(x)
}
#[inline]
pub fn cos(x: f32) -> f32 {
    libm::cosf(x)
}
#[inline]
pub fn sin_cos(x: f32) -> (f32, f32) {
    (libm::sinf(x), libm::cosf(x))
}
#[inline]
pub fn atan2(y: f32, x: f32) -> f32 {
    libm::atan2f(y, x)
}
#[inline]
pub fn acos(x: f32) -> f32 {
    libm::acosf(x)
}
#[inline]
pub fn exp(x: f32) -> f32 {
    libm::expf(x)
}
#[inline]
pub fn ln(x: f32) -> f32 {
    libm::logf(x)
}
#[inline]
pub fn powf(x: f32, y: f32) -> f32 {
    libm::powf(x, y)
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
pub fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Hermite smoothstep; `edge0 > edge1` gives an inverted ramp (1 -> 0), which is handy for masks.
#[inline]
pub fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp01((x - edge0) / (edge1 - edge0));
    t * t * (3.0 - 2.0 * t)
}

/// Wraps an angle to `[-PI, PI)`.
#[inline]
pub fn wrap_pi(a: f32) -> f32 {
    let mut a = a;
    if !a.is_finite() {
        return 0.0;
    }
    // Branch loops are fine here: inputs are always within a few turns of the range.
    while a >= PI {
        a -= TAU;
    }
    while a < -PI {
        a += TAU;
    }
    a
}

/// Shortest signed rotation (radians) that takes yaw `from` to yaw `to`.
#[inline]
pub fn angle_diff(from: f32, to: f32) -> f32 {
    wrap_pi(to - from)
}

/// Moves `current` toward `target` by at most `max_delta`.
#[inline]
pub fn approach(current: f32, target: f32, max_delta: f32) -> f32 {
    let d = target - current;
    if d.abs() <= max_delta { target } else { current + max_delta.copysign(d) }
}

/// Exponential smoothing factor for a given `rate` (1/s) and `dt`, in `[0, 1)`.
/// `x += (target - x) * damp_factor(rate, dt)` is frame-rate independent.
#[inline]
pub fn damp_factor(rate: f32, dt: f32) -> f32 {
    1.0 - exp(-rate * dt)
}

/// Entity facing direction on the XZ plane for a yaw (see module docs).
#[inline]
pub fn yaw_to_dir(yaw: f32) -> Vec3 {
    let (s, c) = sin_cos(yaw);
    Vec3::new(s, 0.0, c)
}

/// Inverse of [`yaw_to_dir`] for a horizontal vector (`y` is ignored).
#[inline]
pub fn dir_to_yaw(dir: Vec3) -> f32 {
    atan2(dir.x, dir.z)
}

/// Camera forward vector on the XZ plane for a camera yaw (see module docs).
#[inline]
pub fn camera_forward(camera_yaw: f32) -> Vec3 {
    let (s, c) = sin_cos(camera_yaw);
    Vec3::new(-s, 0.0, -c)
}

/// Camera right vector on the XZ plane for a camera yaw (see module docs).
#[inline]
pub fn camera_right(camera_yaw: f32) -> Vec3 {
    let (s, c) = sin_cos(camera_yaw);
    Vec3::new(c, 0.0, -s)
}

/// Horizontal (XZ) distance squared between two points.
#[inline]
pub fn dist2_xz(a: Vec3, b: Vec3) -> f32 {
    let dx = a.x - b.x;
    let dz = a.z - b.z;
    dx * dx + dz * dz
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaw_dir_roundtrip() {
        for i in -8..8 {
            let yaw = i as f32 * 0.37;
            let back = dir_to_yaw(yaw_to_dir(yaw));
            assert!(angle_diff(yaw, back).abs() < 1e-5, "yaw {yaw} -> {back}");
        }
    }

    #[test]
    fn camera_basis_matches_threejs() {
        // yaw = 0: camera looks down -Z, right is +X.
        let f = camera_forward(0.0);
        let r = camera_right(0.0);
        assert!((f - Vec3::new(0.0, 0.0, -1.0)).length() < 1e-6);
        assert!((r - Vec3::new(1.0, 0.0, 0.0)).length() < 1e-6);
        // yaw = +90 deg (counter-clockwise from above): looks toward -X.
        let f = camera_forward(PI / 2.0);
        assert!((f - Vec3::new(-1.0, 0.0, 0.0)).length() < 1e-5);
    }

    #[test]
    fn wrap_and_approach() {
        assert!((wrap_pi(3.0 * PI) - -PI).abs() < 1e-4 || (wrap_pi(3.0 * PI) - PI).abs() < 1e-4);
        assert_eq!(approach(0.0, 1.0, 0.25), 0.25);
        assert_eq!(approach(0.9, 1.0, 0.25), 1.0);
        assert_eq!(approach(1.0, 0.0, 0.25), 0.75);
        assert_eq!(wrap_pi(f32::NAN), 0.0);
    }

    #[test]
    fn smoothstep_bounds() {
        assert_eq!(smoothstep(0.0, 1.0, -1.0), 0.0);
        assert_eq!(smoothstep(0.0, 1.0, 2.0), 1.0);
        assert_eq!(smoothstep(1.0, 0.0, 2.0), 0.0);
        assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
    }
}
