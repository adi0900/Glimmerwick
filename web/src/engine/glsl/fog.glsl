#ifndef GW_FOG_GLSL
#define GW_FOG_GLSL
#include <gw_toon>
// gw_fog -- the project aerial perspective. Pure functions (no uniform declarations) so any material can use it:
//   col = gwFog(col, distance, worldY, viewDirWorld, uFogColor, uFogDensity, uSunDir, uSunColor, uNight);
// FogExp2 falloff (matches THREE.FogExp2 so built-in materials agree) + a gentle height falloff so valleys pool haze.
// The haze colour depends on the view direction (gwFogTint): warm and glowing toward the sun, a cool pale blue
// away from it, so the horizon never turns into one flat orange or grey band. The sky dome uses the SAME function
// for its horizon band, which keeps sea / terrain / sky seamless.

vec3 gwFogTint(vec3 fogColor, vec3 viewDir, vec3 sunDir, vec3 sunColor, float night) {
  float l = gwLuma(fogColor);
  vec3 cool = mix(fogColor, vec3(0.26, 0.50, 1.0) * (l * 0.98), 0.80);
  vec2 hv = viewDir.xz;
  vec2 hs = sunDir.xz;
  float az = dot(hv, hs) / max(length(hv) * length(hs), 1e-4);   // -1 away from the sun .. 1 toward it (horizontal)
  float k = smoothstep(-0.6, 0.9, az);
  vec3 base = mix(cool, fogColor, k);
  float scatter = pow(clamp(dot(viewDir, sunDir), 0.0, 1.0), 5.0) * (1.0 - night) * 0.45;
  vec3 warm = sunColor * 1.15 + fogColor * 0.35;
  return mix(base, warm, scatter);
}

vec3 gwFog(vec3 col, float dist, float worldY, vec3 viewDir, vec3 fogColor, float density, vec3 sunDir, vec3 sunColor, float night) {
  float d = dist * density;
  float f = 1.0 - exp(-d * d);
  f *= exp(-max(worldY, 0.0) * 0.010);
  vec3 fc = gwFogTint(fogColor, viewDir, sunDir, sunColor, night);
  return mix(col, fc, clamp(f, 0.0, 1.0));
}
#endif
