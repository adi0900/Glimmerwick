#ifndef GW_FBM_GLSL
#define GW_FBM_GLSL
#include <gw_noise>
// gw_fbm -- fractal sums of gw_noise. Output [0,1] unless noted. Octave counts are fixed (cheap, unrollable).

float gwFbm2(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gwNoise2(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s / 0.9375;
}

float gwFbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gwNoise3(p);
    p = p * 2.03 + vec3(17.1, 9.2, 4.7);
    a *= 0.5;
  }
  return s / 0.9375;
}

// 2 octaves: use where a full fbm is too costly (per-pixel on big surfaces).
float gwFbm3Lite(vec3 p) {
  return (gwNoise3(p) * 0.65 + gwNoise3(p * 2.11 + vec3(5.3, 1.7, 8.1)) * 0.35);
}

// Ridged fbm (crests at 1): rock strata, cracks, bark.
float gwRidge3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(2.0 * gwNoise3(p) - 1.0);
    s += a * n * n;
    p = p * 2.07 + vec3(3.1, 7.7, 1.3);
    a *= 0.5;
  }
  return s / 0.9375;
}

// Domain-warped fbm: painterly swirls for hand-painted looks. `amt` ~ 0.3..1.5.
float gwWarp3(vec3 p, float amt) {
  vec3 q = vec3(gwNoise3(p), gwNoise3(p + vec3(5.2, 1.3, 8.3)), gwNoise3(p + vec3(2.7, 9.1, 3.9)));
  return gwFbm3(p + (q - 0.5) * 2.0 * amt);
}
#endif
