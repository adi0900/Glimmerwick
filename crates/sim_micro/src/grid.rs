//! Read-only view of the 1 m block grid (`vox.data`, see docs/BRIDGE_API.md): plain slice + descriptor.

/// Layout of `vox.data`. [`GridDesc::GLIMMERWICK`] matches `sim_world::voxel` (a test asserts that).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridDesc {
    pub nx: i32,
    pub ny: i32,
    pub nz: i32,
    /// chunk edge in columns
    pub ch: i32,
    pub origin_x: i32,
    pub origin_z: i32,
    pub sea_y: i32,
}

impl GridDesc {
    pub const GLIMMERWICK: GridDesc = GridDesc { nx: 352, ny: 56, nz: 288, ch: 16, origin_x: -160, origin_z: -136, sea_y: 14 };

    pub const fn total_cells(&self) -> usize {
        (self.nx * self.ny * self.nz) as usize
    }

    /// Block id at **world** block coordinates (integer metres, `y` may be negative). Below layer 0: bedrock; outside: air.
    #[inline]
    pub fn block(&self, blocks: &[u16], x: i32, y: i32, z: i32) -> u16 {
        let (ix, iy, iz) = (x - self.origin_x, y + self.sea_y, z - self.origin_z);
        if iy < 0 {
            return crate::blocks::BEDROCK as u16;
        }
        if iy >= self.ny || ix < 0 || iz < 0 || ix >= self.nx || iz >= self.nz {
            return 0;
        }
        let ncx = self.nx / self.ch;
        let chunk = (iz / self.ch) * ncx + ix / self.ch;
        let idx = chunk * (self.ch * self.ch * self.ny) + ((iz % self.ch) * self.ch + ix % self.ch) * self.ny + iy;
        blocks.get(idx as usize).copied().unwrap_or(0)
    }
}
