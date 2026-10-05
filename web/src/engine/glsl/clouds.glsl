#ifndef GW_CLOUDS_GLSL
#define GW_CLOUDS_GLSL
#include <gw_fbm>
#include <gw_worley>
// gw_clouds -- the ONE cloud field shared by the sky dome and the ground cloud-shadow pass, so the shadows that
// drift over the island match the clouds you see overhead.
//   p     = metres on the cloud-layer plane (xz, wind drift already added)
//   cover = 0..1 (0 = a few puffs, 1 = overcast)
// Painterly cumulus: big wind-warped masses whose edges are lobed by cellular puffs (round, cauliflower
// silhouettes instead of smoky fbm). Returns density 0..1.

float gwCloudDensityLite(vec2 p, float cover) {
  vec2 q = p * (1.0 / 1250.0);
  vec2 w = vec2(gwNoise2(q * 1.7 + 4.3), gwNoise2(q * 1.7 + 11.9)) - 0.5;
  vec2 qw = q + w * 0.45;
  float macro = gwFbm2(qw * 0.85 + 2.7);
  vec2 wv = gwWorley2(qw * 2.6);
  float lobes = 1.0 - smoothstep(0.0, 0.9, wv.x);
  float shape = macro + (lobes - 0.45) * 0.30;
  float thr = mix(0.70, 0.36, cover);
  return clamp((shape - thr) / 0.22, 0.0, 1.0);
}

float gwCloudDensity(vec2 p, float cover) {
  vec2 q = p * (1.0 / 1250.0);
  vec2 w = vec2(gwNoise2(q * 1.7 + 4.3), gwNoise2(q * 1.7 + 11.9)) - 0.5;
  vec2 qw = q + w * 0.45;
  float macro = gwFbm2(qw * 0.85 + 2.7);
  vec2 wv = gwWorley2(qw * 2.6);
  float lobes = 1.0 - smoothstep(0.0, 0.9, wv.x);
  float detail = gwFbm2(qw * 6.5 + 9.1);
  float shape = macro + (lobes - 0.45) * 0.30 + (detail - 0.5) * 0.17;
  float thr = mix(0.70, 0.36, cover);
  return clamp((shape - thr) / 0.22, 0.0, 1.0);
}
#endif
