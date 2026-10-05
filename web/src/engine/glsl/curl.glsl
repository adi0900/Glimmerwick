#ifndef GW_CURL_GLSL
#define GW_CURL_GLSL
#include <gw_noise>
// gw_curl -- divergence-free flow fields (finite differences of gw_noise potentials).
// Use for drifting particles (leaves, fireflies, pollen), cloud advection, water swirl.

// 2D curl of a scalar potential. Magnitude ~[0,~2.5].
vec2 gwCurl2(vec2 p) {
  const float e = 0.05;
  float dy = gwNoise2(p + vec2(0.0, e)) - gwNoise2(p - vec2(0.0, e));
  float dx = gwNoise2(p + vec2(e, 0.0)) - gwNoise2(p - vec2(e, 0.0));
  return vec2(dy, -dx) / (2.0 * e);
}

vec3 gwPotential3(vec3 p) {
  return vec3(gwNoise3(p), gwNoise3(p + vec3(31.4, 17.9, 5.3)), gwNoise3(p + vec3(7.1, 53.2, 22.7))) - 0.5;
}

// 3D curl noise: 18 noise taps per call (particles / vertex shaders, not per-pixel).
vec3 gwCurl3(vec3 p) {
  const float e = 0.05;
  vec3 dx = gwPotential3(p + vec3(e, 0.0, 0.0)) - gwPotential3(p - vec3(e, 0.0, 0.0));
  vec3 dy = gwPotential3(p + vec3(0.0, e, 0.0)) - gwPotential3(p - vec3(0.0, e, 0.0));
  vec3 dz = gwPotential3(p + vec3(0.0, 0.0, e)) - gwPotential3(p - vec3(0.0, 0.0, e));
  return vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) / (2.0 * e);
}
#endif
