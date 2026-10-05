#ifndef GW_NOISE_GLSL
#define GW_NOISE_GLSL
#include <gw_hash>
// gw_noise -- value noise (output [0,1]) and gradient noise (output [-1,1]), quintic interpolation.

float gwNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = gwHash12(i);
  float b = gwHash12(i + vec2(1.0, 0.0));
  float c = gwHash12(i + vec2(0.0, 1.0));
  float d = gwHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float gwNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = gwHash13(i);
  float n100 = gwHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = gwHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = gwHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = gwHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = gwHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = gwHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = gwHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

// Gradient (Perlin-style) noise: smoother, no grid-aligned blockiness. Output ~[-1,1].
float gwGradNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float r[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 g = gwHash33(i + o) * 2.0 - 1.0;
    r[k] = dot(g, f - o);
  }
  return mix(
    mix(mix(r[0], r[1], u.x), mix(r[2], r[3], u.x), u.y),
    mix(mix(r[4], r[5], u.x), mix(r[6], r[7], u.x), u.y),
    u.z) * 1.6;
}
#endif
