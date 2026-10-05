//! 60 Hz fixed-step driver.
//!
//! JS calls `Game::tick(dt)` once per rendered frame with the real frame time; [`FixedStep`]
//! converts that into `0..=MAX_STEPS_PER_TICK` whole simulation steps and keeps the remainder so
//! the renderer can interpolate (`alpha`). Time is accumulated as **integer nanoseconds**, so a
//! stream of `dt = 1/60` ticks yields *exactly* one step per tick forever (no float drift).
//!
//! * `dt` is sanitised (NaN / negative -> 0) and clamped to [`MAX_TICK_DT`].
//! * At most [`MAX_STEPS_PER_TICK`] steps run per call; any surplus time beyond one step is dropped
//!   (spiral-of-death protection) while the sub-step phase is preserved.

use bevy_ecs::prelude::Resource;

/// Simulation rate.
pub const STEP_HZ: u32 = 60;
/// One step in nanoseconds (1e9 / 60, rounded to nearest).
pub const STEP_NS: i64 = 16_666_667;
/// One step in seconds, as used by sim math. A compile-time constant => identical on every target.
pub const SIM_DT: f32 = 1.0 / 60.0;
/// Hard cap on steps executed by a single `tick`.
pub const MAX_STEPS_PER_TICK: u32 = 5;
/// `dt` passed to `tick` is clamped to this many seconds.
pub const MAX_TICK_DT: f32 = 0.1;

/// Accumulator state of the fixed-step loop.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FixedStep {
    acc_ns: i64,
    dropped_ns: i64,
}

impl FixedStep {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds `dt` seconds and returns how many fixed steps the caller must now run (`0..=5`).
    pub fn advance(&mut self, dt: f32) -> u32 {
        let dt = if dt.is_finite() && dt > 0.0 { dt.min(MAX_TICK_DT) } else { 0.0 };
        self.acc_ns += (f64::from(dt) * 1e9).round() as i64;

        let mut steps = 0;
        while self.acc_ns >= STEP_NS && steps < MAX_STEPS_PER_TICK {
            self.acc_ns -= STEP_NS;
            steps += 1;
        }
        if self.acc_ns >= STEP_NS {
            // Too far behind: drop whole steps, keep the phase.
            let phase = self.acc_ns % STEP_NS;
            self.dropped_ns += self.acc_ns - phase;
            self.acc_ns = phase;
        }
        steps
    }

    /// Progress (`0.0..1.0`) between the last executed step and the next one.
    pub fn alpha(&self) -> f32 {
        (self.acc_ns as f64 / STEP_NS as f64).clamp(0.0, 0.999_999) as f32
    }

    /// Time (seconds) discarded because the caller fell behind, since the last call to this method.
    pub fn take_dropped_secs(&mut self) -> f32 {
        let s = self.dropped_ns as f64 * 1e-9;
        self.dropped_ns = 0;
        s as f32
    }

    /// Raw accumulator (nanoseconds), stored in save files so `alpha` continues seamlessly.
    pub fn acc_ns(&self) -> i64 {
        self.acc_ns
    }

    pub fn set_acc_ns(&mut self, acc_ns: i64) {
        self.acc_ns = acc_ns.clamp(0, STEP_NS - 1);
    }
}

/// Simulation clock (resource). Advanced once per step by `CorePlugin`.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq)]
pub struct SimClock {
    /// Number of fixed steps executed so far (first step = 1).
    pub tick: u64,
}

impl SimClock {
    /// Fixed delta time of one step, seconds (constant).
    pub const DT: f32 = SIM_DT;

    /// Seconds of simulated time since the world was created.
    pub fn seconds(&self) -> f64 {
        self.tick as f64 / f64::from(STEP_HZ)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_dt_gives_exactly_one_step_per_tick() {
        let mut f = FixedStep::new();
        let mut total = 0;
        for _ in 0..6000 {
            let n = f.advance(1.0 / 60.0);
            assert_eq!(n, 1);
            total += n;
        }
        assert_eq!(total, 6000);
        assert!(f.alpha() < 0.01, "alpha drifted: {}", f.alpha());
    }

    #[test]
    fn slow_frames_run_multiple_steps_and_keep_remainder() {
        let mut f = FixedStep::new();
        // 40 ms = 2.4 steps -> 2 steps, remainder 0.4 step.
        assert_eq!(f.advance(0.040), 2);
        let a = f.alpha();
        assert!((a - 0.4).abs() < 0.01, "alpha {a}");
        // another 40 ms: 0.4 + 2.4 = 2.8 -> 2 steps, remainder 0.8.
        assert_eq!(f.advance(0.040), 2);
        assert!((f.alpha() - 0.8).abs() < 0.01);
        // another 40 ms: 0.8 + 2.4 = 3.2 -> 3 steps.
        assert_eq!(f.advance(0.040), 3);
    }

    #[test]
    fn fast_frames_run_zero_steps_then_catch_up() {
        let mut f = FixedStep::new();
        let mut steps = 0;
        // 240 Hz display: 4 ticks per step.
        for _ in 0..240 {
            steps += f.advance(1.0 / 240.0);
        }
        assert!((59..=60).contains(&steps), "{steps}");
    }

    #[test]
    fn max_five_steps_and_overrun_drops_time() {
        let mut f = FixedStep::new();
        // A huge dt is clamped to 0.1 s (= 5.99 steps) -> 5 steps, nothing to drop yet.
        assert_eq!(f.advance(10.0), 5);
        assert!(f.alpha() > 0.99 && f.alpha() < 1.0);
        assert_eq!(f.take_dropped_secs(), 0.0);
        // With a leftover phase of ~1 step the same call needs 6.99 steps: run 5, drop one,
        // keep the sub-step phase.
        assert_eq!(f.advance(10.0), 5);
        let dropped = f.take_dropped_secs();
        assert!(dropped > 0.0 && dropped < 0.05, "{dropped}");
        assert!(f.alpha() < 1.0);
        assert_eq!(f.take_dropped_secs(), 0.0);
        // Next small tick still behaves.
        assert_eq!(f.advance(0.0), 0);
    }

    #[test]
    fn garbage_dt_is_ignored() {
        let mut f = FixedStep::new();
        assert_eq!(f.advance(f32::NAN), 0);
        assert_eq!(f.advance(f32::INFINITY), 0);
        assert_eq!(f.advance(-1.0), 0);
        assert_eq!(f.advance(f32::NEG_INFINITY), 0);
    }

    #[test]
    fn alpha_is_always_in_unit_range() {
        let mut f = FixedStep::new();
        for i in 0..2000 {
            let dt = 0.001 + (i % 17) as f32 * 0.003;
            f.advance(dt);
            let a = f.alpha();
            assert!((0.0..1.0).contains(&a), "alpha {a}");
        }
    }

    #[test]
    fn chunking_does_not_change_total_steps() {
        // Same wall-clock total fed in different chunk sizes gives the same step count (±1).
        let run = |chunk: f32| {
            let mut f = FixedStep::new();
            let mut n = 0;
            let mut t = 0.0f32;
            while t < 2.0 {
                n += f.advance(chunk);
                t += chunk;
            }
            n
        };
        let a = run(1.0 / 60.0) as i64;
        let b = run(1.0 / 144.0) as i64;
        let c = run(1.0 / 30.0) as i64;
        assert!((a - b).abs() <= 2 && (a - c).abs() <= 2, "{a} {b} {c}");
    }

    #[test]
    fn clock_seconds() {
        let c = SimClock { tick: 120 };
        assert!((c.seconds() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn set_acc_clamps() {
        let mut f = FixedStep::new();
        f.set_acc_ns(1_000_000_000);
        assert!(f.acc_ns() < STEP_NS);
        f.set_acc_ns(-5);
        assert_eq!(f.acc_ns(), 0);
    }
}
