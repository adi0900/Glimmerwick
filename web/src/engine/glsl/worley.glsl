#ifndef GW_WORLEY_GLSL
#define GW_WORLEY_GLSL
#include <gw_hash>
// gw_worley -- cellular noise. Returns (F1, F2): distances to the nearest and second-nearest feature point,
// in cell units. F2 - F1 gives crisp cell borders (cracks, scales, foam bubbles); F1 gives blobs / pebbles.

vec2 gwWorley2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 d = g + gwHash22(i + g) - f;
      float dd = dot(d, d);
      if (dd < f1) { f2 = f1; f1 = dd; }
      else if (dd < f2) { f2 = dd; }
    }
  }
  return sqrt(vec2(f1, f2));
}

// 27 cells per call: expensive, use sparingly (stone, crystals).
vec2 gwWorley3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 d = g + gwHash33(i + g) - f;
        float dd = dot(d, d);
        if (dd < f1) { f2 = f1; f1 = dd; }
        else if (dd < f2) { f2 = dd; }
      }
    }
  }
  return sqrt(vec2(f1, f2));
}
#endif
