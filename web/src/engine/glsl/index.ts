/**
 * Shared GLSL snippet library (owner: look; first version by foundation-web).
 *
 * Every snippet is registered in THREE.ShaderChunk under gw_<name>, so ANY material can use it:
 *
 *     #include <gw_noise>      // gwNoise2/3, gwGradNoise3
 *     #include <gw_fbm>        // gwFbm2/3, gwFbm3Lite, gwRidge3, gwWarp3
 *     #include <gw_worley>     // gwWorley2/3 -> (F1, F2)
 *     #include <gw_curl>       // gwCurl2/3
 *     #include <gw_toon>       // gwToonRamp, gwShadeColor, gwHueShift, gwSaturation, gwLuma, gwRim
 *     #include <gw_hash>       // gwHash11..33
 *     #include <gw_fog>        // gwFog(...), gwFogTint(...)  (direction-dependent haze colour, matches the sky)
 *     #include <gw_paint>      // gwPaint(...) hand-painted albedo layer
  *     #include <gw_clouds>     // gwCloudDensity(p, cover): the cloud field shared by sky + cloud shadows
 *     #include <gw_voxelcell>  // gwCellFade / gwCellEdge / gwCellOut: micro-voxel bevel shared by actors + world texels
 *
 * Snippets are include-guarded and include their own dependencies, so include order does not matter.
 * registerGlsl() is idempotent and is called by the engine before any material is created.
 */
import { ShaderChunk } from 'three';
import hash from './hash.glsl?raw';
import noise from './noise.glsl?raw';
import fbm from './fbm.glsl?raw';
import worley from './worley.glsl?raw';
import curl from './curl.glsl?raw';
import toon from './toon.glsl?raw';
import fog from './fog.glsl?raw';
import paint from './paint.glsl?raw';
import clouds from './clouds.glsl?raw';
import voxelcell from './voxelcell.glsl?raw';

export const GLSL = { hash, noise, fbm, worley, curl, toon, fog, paint, clouds, voxelcell } as const;

let registered = false;

export function registerGlsl(): void {
  if (registered) return;
  registered = true;
  const chunks = ShaderChunk as unknown as Record<string, string>;
  for (const [name, src] of Object.entries(GLSL)) chunks[`gw_${name}`] = src;
}
