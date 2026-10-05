//! Terrain access for crates that must not depend on `sim_world`.
//!
//! `sim_player`, `sim_creatures`, `sim_build`, ... query the ground through the [`HeightQuery`]
//! resource. `sim_core` installs a flat default ([`FlatTerrain`]) so every crate compiles and is
//! unit-testable on its own; `sim_world` replaces the resource with the real island sampler
//! (`app.insert_resource(HeightQuery::new(MyTerrain { .. }))`) and publishes the player start in
//! [`SpawnPoints`](crate::SpawnPoints).
//!
//! All sampling is by **world metres** `(x, z)`; implementations must be total (any finite
//! input returns something sensible, outside the playable area returns a deep-sea floor) and
//! deterministic.

use crate::math::Vec3;
use bevy_ecs::prelude::Resource;

/// Well-known biome ids shared by `world.biome` (u8 per cell) and every sampler.
/// `sim_world` may add ids >= 6; existing ids never change meaning.
pub mod biome {
    pub const DEEP_WATER: u8 = 0;
    pub const SHALLOW_WATER: u8 = 1;
    pub const BEACH: u8 = 2;
    pub const MEADOW: u8 = 3;
    pub const FOREST: u8 = 4;
    pub const ROCK: u8 = 5;
    /// Names indexed by id (also published in `world.info`).
    pub const NAMES: [&str; 6] = ["deep_water", "shallow_water", "beach", "meadow", "forest", "rock"];

    pub fn name(id: u8) -> &'static str {
        NAMES.get(usize::from(id)).copied().unwrap_or("unknown")
    }

    pub fn is_water(id: u8) -> bool {
        id == DEEP_WATER || id == SHALLOW_WATER
    }
}

/// Axis-aligned playable area in world metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainBounds {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

impl TerrainBounds {
    pub fn contains(&self, x: f32, z: f32) -> bool {
        x >= self.min_x && x <= self.max_x && z >= self.min_z && z <= self.max_z
    }

    pub fn clamp(&self, x: f32, z: f32) -> (f32, f32) {
        (x.clamp(self.min_x, self.max_x), z.clamp(self.min_z, self.max_z))
    }
}

/// Implemented by the world crate (and by [`FlatTerrain`] / test stubs).
pub trait Terrain: Send + Sync + 'static {
    /// Ground height in metres at `(x, z)` (bilinear or better; continuous).
    fn height(&self, x: f32, z: f32) -> f32;
    /// Unit surface normal (`y > 0`) at `(x, z)`.
    fn normal(&self, x: f32, z: f32) -> Vec3;
    /// Biome id (see [`biome`]) at `(x, z)`.
    fn biome(&self, x: f32, z: f32) -> u8;
    /// Sea level in metres.
    fn sea_level(&self) -> f32;
    /// Playable bounds.
    fn bounds(&self) -> TerrainBounds;
}

/// Flat dry plane: the default [`HeightQuery`].
#[derive(Clone, Copy, Debug)]
pub struct FlatTerrain {
    pub height: f32,
    pub sea_level: f32,
    pub half_extent: f32,
}

impl Default for FlatTerrain {
    fn default() -> Self {
        Self { height: 0.0, sea_level: -1000.0, half_extent: 1024.0 }
    }
}

impl Terrain for FlatTerrain {
    fn height(&self, _x: f32, _z: f32) -> f32 {
        self.height
    }
    fn normal(&self, _x: f32, _z: f32) -> Vec3 {
        Vec3::Y
    }
    fn biome(&self, _x: f32, _z: f32) -> u8 {
        biome::MEADOW
    }
    fn sea_level(&self) -> f32 {
        self.sea_level
    }
    fn bounds(&self) -> TerrainBounds {
        TerrainBounds { min_x: -self.half_extent, min_z: -self.half_extent, max_x: self.half_extent, max_z: self.half_extent }
    }
}

/// Resource wrapping the active [`Terrain`] with convenient derived queries.
#[derive(Resource)]
pub struct HeightQuery {
    inner: Box<dyn Terrain>,
}

impl Default for HeightQuery {
    fn default() -> Self {
        Self::new(FlatTerrain::default())
    }
}

impl HeightQuery {
    pub fn new(terrain: impl Terrain) -> Self {
        Self { inner: Box::new(terrain) }
    }

    #[inline]
    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.inner.height(x, z)
    }

    #[inline]
    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        self.inner.normal(x, z)
    }

    #[inline]
    pub fn biome(&self, x: f32, z: f32) -> u8 {
        self.inner.biome(x, z)
    }

    #[inline]
    pub fn sea_level(&self) -> f32 {
        self.inner.sea_level()
    }

    #[inline]
    pub fn bounds(&self) -> TerrainBounds {
        self.inner.bounds()
    }

    /// Angle of the ground from horizontal at `(x, z)`, radians (0 = flat, PI/2 = wall).
    pub fn slope(&self, x: f32, z: f32) -> f32 {
        crate::math::acos(self.inner.normal(x, z).y.clamp(-1.0, 1.0))
    }

    /// Depth of water above the ground at `(x, z)` in metres (0 on dry land).
    pub fn water_depth(&self, x: f32, z: f32) -> f32 {
        (self.inner.sea_level() - self.inner.height(x, z)).max(0.0)
    }

    pub fn is_water(&self, x: f32, z: f32) -> bool {
        self.water_depth(x, z) > 0.0
    }

    pub fn contains(&self, x: f32, z: f32) -> bool {
        self.inner.bounds().contains(x, z)
    }

    /// Clamps a horizontal position into the playable bounds.
    pub fn clamp(&self, x: f32, z: f32) -> (f32, f32) {
        self.inner.bounds().clamp(x, z)
    }
}

/// Where things start. `sim_world` fills it in; consumers read it in `Startup`.
#[derive(Resource, Clone, Copy, Debug, PartialEq)]
pub struct SpawnPoints {
    /// Player start (x, y, z). `y` is re-grounded by `sim_player`.
    pub player: Vec3,
}

impl Default for SpawnPoints {
    fn default() -> Self {
        Self { player: Vec3::ZERO }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_defaults_are_dry_and_level() {
        let q = HeightQuery::default();
        assert_eq!(q.height(3.0, 4.0), 0.0);
        assert_eq!(q.normal(0.0, 0.0), Vec3::Y);
        assert!(!q.is_water(0.0, 0.0));
        assert_eq!(q.water_depth(0.0, 0.0), 0.0);
        assert!(q.slope(1.0, 1.0).abs() < 1e-3);
        assert!(q.contains(10.0, 10.0) && !q.contains(5000.0, 0.0));
        assert_eq!(q.clamp(5000.0, -5000.0), (1024.0, -1024.0));
    }

    #[test]
    fn biome_names() {
        assert_eq!(biome::name(biome::FOREST), "forest");
        assert_eq!(biome::name(200), "unknown");
        assert!(biome::is_water(biome::SHALLOW_WATER) && !biome::is_water(biome::BEACH));
    }
}
