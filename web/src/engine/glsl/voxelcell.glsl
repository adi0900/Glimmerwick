#ifndef GW_VOXELCELL
#define GW_VOXELCELL
// Voxel-cell shading shared by the micro-voxel actors (creatures / avatar) and the voxel world's 1/16 m texels, so a creature
// standing on the ground has the SAME voxel size, bevel and edge darkening as the ground texels.
//   f  = position inside ONE voxel face, [0, 1]^2
//   fw = footprint of that face in pixels^-1 (fwidth of the face-local uv: 0 = huge on screen, >= 0.55 = sub-pixel)
// Defaults used by both materials: bevel width 0.16, bevel strength 0.5, edge darkening 0.08.

// 1 -> full effect, 0 -> smooth shading (voxel only covers a few pixels: no moire)
float gwCellFade( float fw ) {
  return 1.0 - smoothstep( 0.2, 0.55, fw );
}

// rim amount: 1 on the very edge of the cell face, 0 inside
float gwCellEdge( vec2 f, float width ) {
  vec2 e = min( f, 1.0 - f );
  return 1.0 - smoothstep( 0.0, width, min( e.x, e.y ) );
}

// unit direction in the face plane pointing from the cell centre to the nearest edge (T = +u axis, B = +v axis)
vec3 gwCellOut( vec2 f, vec3 T, vec3 B ) {
  vec2 d = f - 0.5;
  return abs( d.x ) > abs( d.y ) ? T * sign( d.x ) : B * sign( d.y );
}
#endif
