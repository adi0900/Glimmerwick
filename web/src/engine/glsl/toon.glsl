#ifndef GW_TOON_GLSL
#define GW_TOON_GLSL
// gw_toon -- toon ramp + colour helpers shared by ToonLit and custom materials (water, sky, particles, UI previews).

float gwLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 gwSaturation(vec3 c, float s) {
  return mix(vec3(gwLuma(c)), c, s);
}

// Rotate hue about the grey axis (radians). + moves red -> green -> blue.
vec3 gwHueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735026);
  float ca = cos(a);
  float sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

// Soft multi-band ramp. ndl in [-1,1]; bands in {2,3,4}; soft = width of each band edge as a fraction of the
// (wrapped) N.L range, art bible: 0.08 .. 0.12. Returns 0..1 (0 = darkest band, 1 = fully lit band).
float gwToonRamp(float ndl, float bands, float soft) {
  float h = clamp((ndl + 0.2) / 1.2, 0.0, 1.0); // wrapped lambert: the terminator never goes dead black
  float acc = 0.0;
  for (int k = 1; k < 4; k++) {
    float fk = float(k);
    if (fk >= bands) break;
    float t = fk / bands;
    acc += smoothstep(t - 0.5 * soft, t + 0.5 * soft, h);
  }
  return acc / max(bands - 1.0, 1.0);
}

// Shade colour: the albedo seen in shadow. Cooler (tint), more saturated, never black. amt 0..1.
vec3 gwShadeColor(vec3 albedo, float amt, vec3 tint) {
  vec3 s = gwSaturation(albedo, 1.0 + 0.35 * amt);
  return s * mix(vec3(1.0), tint, amt);
}

// Warm Fresnel rim. power 2.5..3.5, returns 0..1
float gwRim(vec3 n, vec3 v, float power) {
  return pow(1.0 - clamp(dot(n, v), 0.0, 1.0), power);
}
#endif
