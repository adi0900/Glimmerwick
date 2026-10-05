#ifndef GW_FOG_GLSL
#define GW_FOG_GLSL
#include <gw_toon>
// gw_fog -- the project's aerial perspective. Pure functions (no uniform declarations) so any material can use it:
//   col = gwFog(col, distance, worldY, viewDirWorld, uFogColor, uFogDensity, uSunDir, uSunColor, uNight);
// FogExp2 falloff (matches THREE.FogExp2 so built-in materials agree), a gentle height falloff so valleys pool
// haze, and a warm in-scatter glow toward the sun. Fog colour comes from the ART_BIBLE colour script.

vec3 gwFog(vec3 col, float dist, float worldY, vec3 viewDir, vec3 fogColor, float density, vec3 sunDir, vec3 sunColor, float night) {
  float d = dist * density;
  float f = 1.0 - exp(-d * d);
  f *= exp(-max(worldY, 0.0) * 0.010);
  float scatter = pow(clamp(dot(viewDir, sunDir), 0.0, 1.0), 5.0) * (1.0 - night) * 0.45;
  vec3 fc = mix(fogColor, sunColor * 1.15 + fogColor * 0.35, scatter);
  return mix(col, fc, clamp(f, 0.0, 1.0));
}
#endif
