#ifndef GW_PAINT_GLSL
#define GW_PAINT_GLSL
#include <gw_fbm>
#include <gw_toon>
// gw_paint -- the procedural "hand-painted" albedo layer (ART_BIBLE §3). Works in 3D (world or object space) so it
// never tiles, never stretches, and needs no UVs.
//   * macro drift   : low-frequency hue/value variation (+-10 % value, hue +-0.15 rad) that kills repetition
//   * brush strokes : two scales of posterised noise, squashed along Y on walls so strokes run vertically
//   * grain         : fine canvas grain, faded per-pixel (fwidth) so it never shimmers
// (Edge/crevice tint lives in ToonLit itself: it needs screen-space derivatives of the normal.)
// `#define GW_PAINT_LITE` drops the second brush octave + grain (low quality preset).
// p = position the pattern is evaluated at, n = world normal, s = strength 0..1, sc = scale multiplier (1 ~ 1 m).
// `pxFootprint` = length(fwidth(p)) (metres per pixel) lets each octave fade out before it aliases.

float gwOctaveFade(float freq, float pxFootprint) {
  return 1.0 - smoothstep(0.30, 0.75, pxFootprint * freq);
}

vec3 gwPaint(vec3 albedo, vec3 p, vec3 n, float s, float sc, float pxFootprint) {
  vec3 q = p * sc;

  // ---- macro drift
  float m1 = gwNoise3(q * 0.045 + 3.1);
  float m2 = gwNoise3(q * 0.16 + 11.7);
  float m3 = gwNoise3(q * 0.55 + 21.3);
  vec3 c = gwHueShift(albedo, ((m1 - 0.5) * 0.3 + (m2 - 0.5) * 0.12) * s);
  c *= 1.0 + ((m1 - 0.5) * 0.2 + (m2 - 0.5) * 0.12 + (m3 - 0.5) * 0.08) * s;

  // ---- brush strokes (vertical on walls, diagonal sweeps on floors)
  float vert = 1.0 - abs(n.y);
  vec3 sq = vec3(1.0, mix(1.0, 0.38, vert), 1.0);
  vec3 qd = vec3(q.x * 0.82 + q.z * 0.57, q.y, q.z * 0.82 - q.x * 0.57); // rotate strokes off the grid axes
  float f1 = 0.9 * sc;
  float b1 = clamp(0.5 + 0.5 * gwGradNoise3(qd * sq * vec3(0.9, 0.9, 2.1) + vec3(1.7, 4.1, 9.3)), 0.0, 1.0);
  float st1 = smoothstep(0.30, 0.70, b1) - 0.5;
  float fade1 = gwOctaveFade(f1 * 2.1, pxFootprint);
  float tone = st1 * 0.10 * fade1;
  float hueNudge = st1 * fade1;

#ifndef GW_PAINT_LITE
  float f2 = 3.6 * sc;
  float b2 = clamp(0.5 + 0.5 * gwGradNoise3(qd * sq * vec3(3.6, 3.6, 7.5) + vec3(8.2, 2.6, 5.5)), 0.0, 1.0);
  float st2 = smoothstep(0.28, 0.72, b2) - 0.5;
  float fade2 = gwOctaveFade(f2 * 2.1, pxFootprint);
  tone += st2 * 0.06 * fade2;
  hueNudge += st2 * fade2 * 0.6;
#endif

  c *= 1.0 + tone * s;
  // painted tone variation also nudges hue a hair: warm in the lights, cool in the darks
  c = gwHueShift(c, clamp(hueNudge * s, -1.0, 1.0) * 0.05);

#ifndef GW_PAINT_LITE
  // ---- grain
  float grain = gwNoise3(q * 46.0) - 0.5;
  c *= 1.0 + grain * 0.05 * s * gwOctaveFade(46.0 * sc, pxFootprint);
#endif

  return max(c, vec3(0.0));
}
#endif
