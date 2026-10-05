/**
 * Lighting: sun/moon key light with fitted cascaded soft shadows, hemisphere bounce, project fog and the sky,
 * all driven by `Env` (time channel + photo overrides) through the ART_BIBLE §2 colour script.
 * Owner: look (first version by foundation-web).
 *
 *  - One key light (three's `SunLight`: 2 cascades fitted to the view frustum, texel-snapped, PCF + Vogel/IGN soft
 *    edges). By day it is the sun; at dusk/dawn the direction swaps to the moon while the intensity dips, so the
 *    swap is invisible. `uSunDir` always holds the key direction, `env.sunDir` the true sun.
 *  - Hemisphere light = coloured sky/ground bounce; ToonLit feeds it through the cool "shade colour" (shadows are
 *    never black, they are hue-shifted toward blue-violet).
 *  - Weather (kind 0-5 + intensity) greys/darkens the sky, thins the sun, thickens the fog, sets uRain/uSnow/uWetness.
 *  - Sky dome: gradient whose horizon band IS the ToonLit haze colour (gwFogTint: warm toward the sun, cool pale
 *    blue away from it), sun aureole + disc, moon, stars + milky way, painterly cumulus (gw_clouds: lobed puffs, self
 *    shadowed toward the sun, cool violet bellies, silver linings), high cirrus streaks and distant horizon banks.
 *  - The SAME cloud field is rendered top-down into a small render target every frame: `uCloudShadowTex`
 *    (+ `uCloudShadowParams`) so cloud shadows drift over the terrain exactly under the clouds you see.
 *  - `lookState` is the small shared blackboard Post reads (night, golden hour, DOF focus distance).
 */
import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  FogExp2,
  HemisphereLight,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { registerGlsl } from './glsl';
import type { Env, QualityPreset, SharedUniforms } from './types';

/** Written by Lighting every frame, read by Post (grade, DOF focus). Not a public API for other modules. */
export const lookState = {
  /** 0 day .. 1 deep night */
  night: 0,
  /** 0..1 how low/warm the sun is (golden hour, sunset, dawn) */
  golden: 0,
  sunElev: 1,
  /** camera-space distance (m) that depth of field keeps razor sharp (smoothed) */
  focus: 14,
  grey: 0,
};

/** altitude (m above sea level) of the main cumulus layer; the cloud-shadow pass projects through this plane */
const CLOUD_ALT = 1500;

// ------------------------------------------------------------------------------------------ colour script

interface Key {
  h: number;
  sun: string;
  sunI: number;
  zenith: string;
  horizon: string;
  hemiSky: string;
  hemiGround: string;
  fog: string;
  fogD: number;
  /** hemisphere intensity (not in the art bible table: tuned so shadows read ~30-40 % of lit) */
  hemiI: number;
}

// ART_BIBLE.md §2 (start values), plus a deep-night key so the night->dawn blend starts late.
const NIGHT: Omit<Key, 'h'> = { sun: '#8FB0FF', sunI: 0.55, zenith: '#141A48', horizon: '#2C3478', hemiSky: '#3A4590', hemiGround: '#20254F', fog: '#2A3470', fogD: 0.014, hemiI: 2.6 };
const SCRIPT: Key[] = [
  { h: 4.0, ...NIGHT },
  { h: 5.5, sun: '#FFB48A', sunI: 1.4, zenith: '#6E7FD8', horizon: '#FFC7A8', hemiSky: '#8FA6E8', hemiGround: '#6B5B7B', fog: '#F2B9A5', fogD: 0.012, hemiI: 1.5 },
  { h: 8.0, sun: '#FFE9C2', sunI: 2.6, zenith: '#62B0F5', horizon: '#D5EEFF', hemiSky: '#A7D2FF', hemiGround: '#8CB07A', fog: '#CFE8FF', fogD: 0.008, hemiI: 1.25 },
  { h: 12.0, sun: '#FFF6E0', sunI: 3.2, zenith: '#4FA3F0', horizon: '#CFEAFF', hemiSky: '#9CCBFF', hemiGround: '#9BC27E', fog: '#C8E6FF', fogD: 0.006, hemiI: 1.15 },
  { h: 16.5, sun: '#FFD08A', sunI: 2.8, zenith: '#5B9CE6', horizon: '#FFE2B8', hemiSky: '#9FB9F0', hemiGround: '#A5A06A', fog: '#FFE0B5', fogD: 0.009, hemiI: 1.3 },
  { h: 18.5, sun: '#FF9A5A', sunI: 1.8, zenith: '#6A5FD0', horizon: '#FFA97A', hemiSky: '#8A74C8', hemiGround: '#7C5A6A', fog: '#FFB08A', fogD: 0.014, hemiI: 1.6 },
  { h: 20.0, sun: '#C98AE6', sunI: 0.7, zenith: '#3B3F9C', horizon: '#E58AB0', hemiSky: '#5B5FB8', hemiGround: '#4A4A7A', fog: '#8C6AA0', fogD: 0.016, hemiI: 2.2 },
  { h: 23.0, ...NIGHT },
  { h: 28.0, ...NIGHT },
];

interface Frame {
  sun: Color;
  sunI: number;
  zenith: Color;
  horizon: Color;
  hemiSky: Color;
  hemiGround: Color;
  fog: Color;
  fogD: number;
  hemiI: number;
}

const KEYC = SCRIPT.map((k) => ({
  h: k.h,
  sun: new Color(k.sun),
  zenith: new Color(k.zenith),
  horizon: new Color(k.horizon),
  hemiSky: new Color(k.hemiSky),
  hemiGround: new Color(k.hemiGround),
  fog: new Color(k.fog),
  sunI: k.sunI,
  fogD: k.fogD,
  hemiI: k.hemiI,
}));

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** cubic Hermite with finite-difference tangents (C1: no "holds" at keyframes) */
function herm(p0: number, p1: number, m0: number, m1: number, t: number, dt: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 * dt + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1 * dt;
}

function sampleScalar(i: number, t: number, get: (k: (typeof KEYC)[number]) => number): number {
  const n = KEYC.length;
  const a = KEYC[i]!;
  const b = KEYC[i + 1]!;
  const pa = KEYC[Math.max(i - 1, 0)]!;
  const nb = KEYC[Math.min(i + 2, n - 1)]!;
  const dt = b.h - a.h;
  const m0 = (get(b) - get(pa)) / (b.h - pa.h || 1);
  const m1 = (get(nb) - get(a)) / (nb.h - a.h || 1);
  return herm(get(a), get(b), m0, m1, t, dt);
}

function sampleColor(out: Color, i: number, t: number, get: (k: (typeof KEYC)[number]) => Color): void {
  out.r = Math.max(0, sampleScalar(i, t, (k) => get(k).r));
  out.g = Math.max(0, sampleScalar(i, t, (k) => get(k).g));
  out.b = Math.max(0, sampleScalar(i, t, (k) => get(k).b));
}

function evalScript(hours: number, f: Frame): void {
  let h = hours;
  if (h < KEYC[0]!.h) h += 24;
  let i = 0;
  while (i < KEYC.length - 2 && h >= KEYC[i + 1]!.h) i++;
  const a = KEYC[i]!;
  const b = KEYC[i + 1]!;
  const t = Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)));
  sampleColor(f.sun, i, t, (k) => k.sun);
  sampleColor(f.zenith, i, t, (k) => k.zenith);
  sampleColor(f.horizon, i, t, (k) => k.horizon);
  sampleColor(f.hemiSky, i, t, (k) => k.hemiSky);
  sampleColor(f.hemiGround, i, t, (k) => k.hemiGround);
  sampleColor(f.fog, i, t, (k) => k.fog);
  f.sunI = Math.max(0, sampleScalar(i, t, (k) => k.sunI));
  f.fogD = Math.max(0.001, sampleScalar(i, t, (k) => k.fogD));
  f.hemiI = Math.max(0, sampleScalar(i, t, (k) => k.hemiI));
}

// ------------------------------------------------------------------------------------------ sky dome

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww; // pin to the far plane: always behind everything
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uSunTrue;      // true sun direction (may be below the horizon)
uniform vec3 uMoon;
uniform vec3 uSunCol;
uniform float uNightK;      // 0 day .. 1 night
uniform float uTimeS;
uniform float uCover;       // cloud coverage 0..1 (baseline + weather)
uniform float uGrey;        // desaturation 0..1 (weather)
uniform float uDark;        // darkening 0..1 (storm)
uniform float uDayK;        // 0..1 how much of the sun is visible
uniform vec2 uCloudDrift;   // accumulated wind drift of the cloud layer (m)
uniform float uCloudAlt;    // cloud layer altitude (m)
#include <gw_clouds>
#include <gw_hash>
#include <gw_toon>
#include <gw_fog>

void main() {
  vec3 d = normalize( vDir );
  float h = d.y;
  float hz = clamp( h, 0.0, 1.0 );
  float sunUp = smoothstep( -0.10, 0.06, uSunTrue.y );
  float lowSun = 1.0 - smoothstep( 0.15, 0.7, uSunTrue.y );
  float sd = max( dot( d, uSunTrue ), 0.0 );

  // ---- gradient dome: the horizon band IS the ToonLit haze colour (warm toward the sun, cool away from it)
  vec3 hor = gwFogTint( uFog, d, uSunTrue, uSunCol, uNightK );
  vec3 mid = gwSaturation( mix( hor, uZenith, 0.68 ), 1.0 + 0.35 * ( 1.0 - uNightK ) * ( 1.0 - 0.5 * lowSun ) );
  vec3 col = mix( hor, mid, smoothstep( 0.0, 0.10, hz ) );
  col = mix( col, uZenith, smoothstep( 0.06, 0.75, hz ) );

  // ---- sun aureole (broad warm glow + tight bloom); the disc itself is added after the clouds
  float halo = pow( sd, 5.0 ) * 0.30 + pow( sd, 24.0 ) * 0.30 + pow( sd, 240.0 ) * 0.9;
  vec3 glowC = mix( hor, uSunCol, 0.55 ) * 1.15;
  col = mix( col, glowC, smoothstep( 0.3, 1.0, sd ) * ( 0.2 + 0.65 * lowSun ) * sunUp * ( 1.0 - uGrey ) );
  col += uSunCol * halo * sunUp * ( 1.0 - uGrey * 0.6 );

  // ---- night: milky way + stars (clouds composite on top of them)
  if ( uNightK > 0.02 ) {
    float band = exp( -pow( dot( d, normalize( vec3( 0.35, 0.78, 0.52 ) ) ) * 3.2, 2.0 ) );
    float mw = gwFbm3( d * 5.0 + 3.0 );
    col += vec3( 0.30, 0.26, 0.60 ) * band * smoothstep( 0.35, 0.8, mw ) * 0.22 * uNightK * smoothstep( 0.0, 0.2, h ) * ( 1.0 - uCover * 0.8 );
    if ( h > -0.05 ) {
      vec3 sp = d * 150.0;
      vec3 ip = floor( sp );
      vec3 fp = fract( sp ) - 0.5;
      vec3 jit = ( gwHash33( ip ) - 0.5 ) * 0.55;
      float sh = gwHash13( ip + 7.7 );
      float star = smoothstep( 0.09, 0.0, length( fp - jit ) ) * step( 0.93, sh );
      float tw = 0.65 + 0.35 * sin( uTimeS * ( 1.5 + sh * 3.0 ) + sh * 40.0 );
      col += vec3( 0.85, 0.9, 1.0 ) * star * tw * 1.6 * uNightK * smoothstep( 0.0, 0.25, h ) * ( 1.0 - uCover );
    }
  }

  // ---- distant cloud banks hugging the horizon (depth cue; seam-free: noise over the direction vector)
  float bankN = gwFbm3( vec3( d.x * 2.4, h * 11.0, d.z * 2.4 ) + vec3( uCloudDrift.x * 0.00004, 0.0, uCloudDrift.y * 0.00004 ) + 4.0 );
  float bank = smoothstep( 0.50, 0.72, bankN ) * smoothstep( 0.0, 0.012, h ) * ( 1.0 - smoothstep( 0.035, 0.20, h ) );
  float sunSide = pow( max( dot( normalize( vec3( d.x, 0.0, d.z ) + 1e-5 ), normalize( vec3( uSunTrue.x, 0.0, uSunTrue.z ) + 1e-5 ) ), 0.0 ), 2.0 );
  vec3 bankC = mix( mix( hor, uZenith, 0.22 ), mix( vec3( 1.0 ), uSunCol, 0.65 ), 0.50 * sunUp * ( 0.35 + 0.65 * sunSide ) );
  bankC = mix( bankC, vec3( 0.16, 0.18, 0.36 ), uNightK * 0.8 );
  col = mix( col, bankC, bank * 0.32 * ( 1.0 - uNightK * 0.4 ) );

  // ---- main cumulus layer: painterly, lobed puffs; self-shadowed toward the sun (lit tops, cool violet bellies)
  float alpha = 0.0;
  vec3 cloudCol = vec3( 0.0 );
  if ( h > 0.004 ) {
    float hc = max( h, 0.02 );
    vec2 p = cameraPosition.xz + d.xz * ( ( uCloudAlt - cameraPosition.y ) / hc ) + uCloudDrift;
    float dens = gwCloudDensity( p, uCover );
    if ( dens > 0.003 ) {
      vec2 sx = normalize( uSunTrue.xz + vec2( 1e-4, 0.0 ) );
      float stepM = 320.0 + 520.0 * ( 1.0 - clamp( uSunTrue.y * 1.5, 0.0, 1.0 ) );
      float t1 = gwCloudDensityLite( p + sx * stepM, uCover );
      float t2 = gwCloudDensityLite( p + sx * stepM * 2.3, uCover );
      float occl = dens * 0.85 + t1 * 0.95 + t2 * 0.65;
      float L = exp( -occl * 1.05 );
      float band3 = smoothstep( 0.12, 0.34, L ) * 0.45 + smoothstep( 0.40, 0.80, L ) * 0.55;   // soft 3-tone ramp
      L = mix( L, band3, 0.7 );
      vec3 litC = mix( vec3( 1.0 ), uSunCol, 0.55 + 0.35 * lowSun ) * ( 1.05 + 0.15 * uDayK );
      vec3 shadeC = mix( uZenith, vec3( 0.45, 0.40, 0.78 ), 0.50 ) * 0.80 + hor * 0.20;
      shadeC = mix( shadeC, mix( hor, vec3( 0.50, 0.22, 0.45 ), 0.55 ) * 0.78, lowSun * ( 0.35 + 0.65 * sd * sd ) );        // cool saturated belly
      vec3 cc = mix( shadeC, litC, L );
      float thin = ( 1.0 - dens ) * smoothstep( 0.0, 0.30, dens );
      cc += uSunCol * pow( thin, 1.3 ) * pow( sd, 4.0 ) * 3.2 * sunUp;                          // silver lining
      cc += hor * 0.10 * ( 1.0 - L );                                                            // bounce from the glowing horizon
      vec3 nightC = mix( vec3( 0.05, 0.07, 0.17 ), vec3( 0.23, 0.28, 0.50 ), L );
      cc = mix( cc, nightC, uNightK );
      cc = mix( cc, hor, ( 1.0 - smoothstep( 0.0, 0.32, h ) ) * 0.6 );                           // aerial perspective
      alpha = smoothstep( 0.02, 0.36, dens ) * smoothstep( 0.0, 0.10, h );
      cloudCol = cc;
    }
  }
  col = mix( col, cloudCol, alpha );

  // ---- high wispy layer (cirrus streaks)
  if ( h > 0.03 ) {
    vec2 p2 = cameraPosition.xz + d.xz * ( ( 7000.0 - cameraPosition.y ) / max( h, 0.03 ) ) + uCloudDrift * 2.2;
    vec2 q2 = vec2( p2.x * 0.00035, p2.y * 0.0016 );
    float c2 = gwFbm2( q2 + gwNoise2( q2 * 2.3 ) * 0.8 );
    float w2 = smoothstep( 0.55, 0.82, c2 ) * smoothstep( 0.03, 0.2, h ) * ( 1.0 - alpha );
    vec3 wc = mix( mix( vec3( 1.0 ), uSunCol, 0.5 ), hor, 0.15 );
    col = mix( col, wc, w2 * 0.17 * ( 1.0 - uNightK * 0.85 ) );
  }

  // ---- sun disc + moon (occluded by the clouds)
  float vis = ( 1.0 - alpha ) * ( 1.0 - uGrey * 0.7 );
  float disc = smoothstep( 0.99945, 0.99978, sd ) * sunUp;
  col += uSunCol * disc * 9.0 * vis;
  float md = max( dot( d, uMoon ), 0.0 );
  float moonUp = smoothstep( -0.05, 0.08, uMoon.y );
  col += vec3( 0.45, 0.55, 0.95 ) * ( pow( md, 40.0 ) * 0.28 + pow( md, 8.0 ) * 0.06 ) * moonUp * uNightK * vis;
  float moonDisc = smoothstep( 0.99935, 0.99965, md );
  if ( moonDisc > 0.0 ) {
    float maria = gwFbm3( d * 38.0 ) * 0.5 + 0.5;
    col += vec3( 0.86, 0.92, 1.0 ) * ( 0.75 + 0.25 * maria ) * moonDisc * 3.2 * moonUp * vis;
  }

  // ---- weather grading
  float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  col = mix( col, vec3( l ) * vec3( 0.95, 0.98, 1.05 ), uGrey );
  col *= 1.0 - uDark;

  // below the horizon the dome melts into the (tinted) fog colour: matches the sea/terrain haze
  col = mix( col, hor * ( 1.0 - uDark ), smoothstep( 0.012, -0.10, h ) );
  gl_FragColor = vec4( col, 1.0 );
}
`;

// ------------------------------------------------------------------------------------------ cloud shadow pass

const CLOUD_SHADOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const CLOUD_SHADOW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uCenter;   // world xz of the window centre (m)
uniform float uSize;    // window size (m)
uniform vec2 uDrift;    // same drift the sky uses
uniform vec2 uShift;    // sun parallax: where the cloud that shades a ground point sits on the layer plane
uniform float uCover;
#include <gw_clouds>
void main() {
  vec2 w = uCenter + ( vUv - 0.5 ) * uSize;
  float dens = gwCloudDensity( w + uShift + uDrift, uCover );
  float s = smoothstep( 0.28, 0.85, dens );
  vec2 e = min( vUv, 1.0 - vUv );
  float edge = smoothstep( 0.0, 0.08, min( e.x, e.y ) );   // fade to "no shadow" at the window border (clamp-to-edge)
  float lit = 1.0 - s * edge;
  gl_FragColor = vec4( vec3( lit ), 1.0 );
}
`;

// ------------------------------------------------------------------------------------------ Lighting

interface WeatherState {
  cover: number;
  grey: number;
  dark: number;
  sunK: number;
  fogK: number;
  rain: number;
  snow: number;
  wet: number;
}

export class Lighting {
  readonly sun: SunLight;
  readonly hemi: HemisphereLight;
  readonly sky: Mesh;
  readonly fog: FogExp2;
  /** shared cloud-field state: the sky dome and the ground cloud-shadow pass read the same drift / cover / altitude */
  readonly cloud = { drift: new Vector2(), cover: 0.3, alt: CLOUD_ALT };
  /** tweakables for the look pass / lil-gui */
  tuning = {
    exposure: 1.0,
    shadowBias: -0.0003,
    shadowNormalBias: 0.045,
    /** day multipliers on the colour-script intensities (calibrated so shadows read ~45 % of lit) */
    sunScale: 0.72,
    hemiScale: 2.0,
    /** night multipliers (moonlight must stay readable: night is beautiful, not dark) */
    nightSun: 2.3,
    nightHemi: 2.2,
    /** the art-bible fog densities assume a tighter scene; this scales them for a 300 m island */
    fogScale: 0.24,
    /** peak strength of the drifting cloud shadows on the ground (0 = off) */
    cloudShadow: 0.34,
  };

  private readonly skyMat: ShaderMaterial;
  private readonly cloudRT: WebGLRenderTarget;
  private readonly cloudScene = new Scene();
  private readonly cloudCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly cloudMat: ShaderMaterial;
  private readonly f: Frame = {
    sun: new Color(),
    sunI: 1,
    zenith: new Color(),
    horizon: new Color(),
    hemiSky: new Color(),
    hemiGround: new Color(),
    fog: new Color(),
    fogD: 0.01,
    hemiI: 1,
  };
  private readonly w: WeatherState = { cover: 0, grey: 0, dark: 0, sunK: 1, fogK: 1, rain: 0, snow: 0, wet: 0 };
  private readonly keyDir = new Vector3(0, 1, 0);
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private inited = false;
  private lastDt = 0.016;
  private lastSnap = true;
  private q: QualityPreset;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly u: SharedUniforms,
    quality: QualityPreset,
  ) {
    this.q = quality;
    renderer.shadowMap.type = PCFShadowMap;

    this.sun = new SunLight(0xfff0d0, 3);
    this.sun.name = 'gw.sun';
    this.sun.castShadow = quality.shadows;
    scene.add(this.sun);

    this.hemi = new HemisphereLight(0xa7d2ff, 0x8cb07a, 1.2);
    this.hemi.name = 'gw.hemi';
    scene.add(this.hemi);

    this.fog = new FogExp2(0xcfe8ff, 0.008);
    scene.fog = this.fog;
    scene.background = null;

    // the sky shader and the cloud-shadow shader `#include` gw_ chunks: make sure they are registered first
    registerGlsl();

    const geo = new SphereGeometry(100, 40, 28);
    this.skyMat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: u.uSkyZenith,
        uHorizon: u.uSkyHorizon,
        uFog: u.uFogColor,
        uSunTrue: { value: new Vector3(0, 1, 0) },
        uMoon: { value: new Vector3(0, -1, 0) },
        uSunCol: u.uSunColor,
        uNightK: u.uNight,
        uTimeS: u.uTime,
        uCover: { value: 0.3 },
        uGrey: { value: 0 },
        uDark: { value: 0 },
        uDayK: { value: 1 },
        uCloudDrift: { value: this.cloud.drift },
        uCloudAlt: { value: CLOUD_ALT },
      },
    });
    this.sky = new Mesh(geo, this.skyMat);
    this.sky.name = 'gw.sky';
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // cloud-shadow render target: top-down view of the same cloud field, sampled by ToonLit (uCloudShadowTex)
    this.cloudRT = new WebGLRenderTarget(256, 256, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.cloudRT.texture.wrapS = this.cloudRT.texture.wrapT = ClampToEdgeWrapping;
    this.cloudRT.texture.name = 'gw.cloudShadow';
    this.cloudMat = new ShaderMaterial({
      vertexShader: CLOUD_SHADOW_VERT,
      fragmentShader: CLOUD_SHADOW_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCenter: { value: new Vector2() },
        uSize: { value: 512 },
        uDrift: { value: this.cloud.drift },
        uShift: { value: new Vector2() },
        uCover: { value: 0.3 },
      },
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.cloudMat);
    quad.frustumCulled = false;
    this.cloudScene.add(quad);
    u.uCloudShadowTex.value = this.cloudRT.texture;

    this.setQuality(quality);
  }

  setQuality(q: QualityPreset): void {
    this.q = q;
    const s = this.sun.shadow;
    const wasOn = this.sun.castShadow;
    this.sun.castShadow = q.shadows;
    if (s.mapSize.x !== q.shadowMap) {
      s.mapSize.set(q.shadowMap, q.shadowMap);
      if (s.map) {
        s.map.dispose();
        s.map = null as any;
      }
    }
    s.camera.far = q.shadowDistance;
    s.radius = q.shadowRadius;
    s.bias = this.tuning.shadowBias;
    s.normalBias = this.tuning.shadowNormalBias;
    if (wasOn !== q.shadows) this.scene.traverse((o) => {
      const mat = (o as any).material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m: any) => (m.needsUpdate = true));
    });
    this.renderer.shadowMap.enabled = q.shadows;
  }

  /** advance the look to `env` (call once per frame, before modules' update) */
  update(env: Env, camera: PerspectiveCamera, dt: number, snap: boolean): void {
    const u = this.u;
    const f = this.f;
    evalScript(env.hours, f);

    // ---- weather targets
    const i = env.weatherIntensity;
    const k = env.weatherKind;
    const tgt: WeatherState = { cover: 0, grey: 0, dark: 0, sunK: 1, fogK: 1, rain: 0, snow: 0, wet: 0 };
    if (k === 1) Object.assign(tgt, { cover: 0.7 * i, grey: 0.5 * i, sunK: 1 - 0.45 * i, fogK: 1 + 0.4 * i });
    else if (k === 2) Object.assign(tgt, { cover: 0.9 * i, grey: 0.68 * i, dark: 0.1 * i, sunK: 1 - 0.6 * i, fogK: 1 + 0.8 * i, rain: i, wet: i });
    else if (k === 3) Object.assign(tgt, { cover: 1.0 * i, grey: 0.82 * i, dark: 0.32 * i, sunK: 1 - 0.78 * i, fogK: 1 + 1.2 * i, rain: i, wet: i });
    else if (k === 4) Object.assign(tgt, { cover: 0.85 * i, grey: 0.42 * i, sunK: 1 - 0.45 * i, fogK: 1 + 0.9 * i, snow: i, wet: 0.2 * i });
    else if (k === 5) Object.assign(tgt, { cover: 0.5 * i, grey: 0.4 * i, sunK: 1 - 0.5 * i, fogK: 1 + 5.0 * i });
    const w = this.w;
    const a = snap || !this.inited ? 1 : 1 - Math.exp(-Math.max(dt, 1 / 120) / 1.4);
    for (const key of Object.keys(w) as (keyof WeatherState)[]) w[key] += (tgt[key] - w[key]) * a;

    // ---- day / night split from the TRUE sun elevation
    const sunDir = env.sunDir;
    const dayW = smoothstep(-0.16, -0.02, sunDir.y);
    const night = 1 - smoothstep(-0.32, 0.02, sunDir.y);

    // ---- key light direction: sun (clamped above the horizon) <-> moon; intensity dips during the swap
    const sunC = this.tmpA.copy(sunDir);
    sunC.y = Math.max(sunC.y, 0.13);
    sunC.normalize();
    const moonC = this.tmpB.set(-sunDir.x, -sunDir.y, -sunDir.z);
    moonC.y = Math.max(moonC.y, 0.3);
    moonC.normalize();
    this.keyDir.copy(moonC).lerp(sunC, dayW).normalize();
    const swap = 1 - Math.abs(2 * dayW - 1); // 0 at the ends, 1 mid-swap
    const dip = 1 - 0.8 * swap * swap;

    // ---- colours (weather-graded)
    const grey = w.grey;
    const grade = (c: Color, dark = 0, tint = 1) => {
      const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
      c.r += (l * 0.96 * tint - c.r) * grey;
      c.g += (l * 0.99 * tint - c.g) * grey;
      c.b += (l * 1.06 * tint - c.b) * grey;
      c.multiplyScalar(1 - dark);
    };
    const zen = u.uSkyZenith.value.copy(f.zenith);
    const hor = u.uSkyHorizon.value.copy(f.horizon);
    const hs = u.uHemiSky.value.copy(f.hemiSky);
    const hg = u.uHemiGround.value.copy(f.hemiGround);
    const fg = u.uFogColor.value.copy(f.fog);
    grade(zen, w.dark);
    grade(hor, w.dark * 0.8);
    grade(hs, w.dark * 0.6);
    grade(hg, w.dark * 0.4);
    grade(fg, w.dark * 0.7);
    u.uSunColor.value.copy(f.sun);
    u.uSunDir.value.copy(this.keyDir);
    const T = this.tuning;
    const sunMul = T.sunScale + (T.nightSun - T.sunScale) * night;
    const hemiMul = T.hemiScale + (T.nightHemi - T.hemiScale) * night;
    const sunI = f.sunI * w.sunK * dip * sunMul;
    u.uSunIntensity.value = sunI;
    u.uNight.value = night;
    u.uFogDensity.value = f.fogD * w.fogK * this.tuning.fogScale;
    u.uRain.value = w.rain;
    u.uSnow.value = w.snow;
    u.uWetness.value = w.wet;
    u.uTimeOfDay.value = env.hours;
    u.uSeason.value = env.season;
    u.uSeasonT.value = env.seasonT;
    u.uWind.value.set(env.windX, env.windZ);

    // ---- lights
    this.sun.color.copy(f.sun);
    this.sun.intensity = sunI;
    this.sun.position.copy(this.keyDir).multiplyScalar(100);
    this.sun.shadow.intensity = 1 - 0.3 * night;
    this.hemi.color.copy(hs);
    this.hemi.groundColor.copy(hg);
    this.hemi.intensity = f.hemiI * hemiMul * (1 + 0.15 * w.cover);
    this.fog.color.copy(fg);
    this.fog.density = u.uFogDensity.value;
    this.renderer.toneMappingExposure = this.tuning.exposure;

    // ---- clouds: one shared field (baseline scattered cumulus + weather cover), advected by the wind. Frozen = static.
    const cl = this.cloud;
    cl.cover = 0.33 + 0.67 * w.cover;
    if (!snap) {
      cl.drift.x += (env.windX * 7 + 1.2) * dt;
      cl.drift.y += env.windZ * 7 * dt;
    }

    // ---- sky
    const su = this.skyMat.uniforms;
    (su.uSunTrue!.value as Vector3).copy(sunDir);
    (su.uMoon!.value as Vector3).set(-sunDir.x, -sunDir.y, -sunDir.z).normalize();
    su.uCover!.value = cl.cover;
    su.uGrey!.value = w.grey;
    su.uDark!.value = w.dark;
    su.uDayK!.value = dayW * (1 - w.cover * 0.5);

    this.updateCloudShadow(env, night, w.cover);

    // ---- blackboard for Post
    lookState.night = night;
    lookState.sunElev = sunDir.y;
    lookState.golden = (1 - smoothstep(0.12, 0.8, sunDir.y)) * smoothstep(-0.14, 0.04, sunDir.y);
    lookState.grey = w.grey;

    this.lastDt = dt;
    this.lastSnap = snap;
    this.inited = true;
    void camera;
  }

  /** render the cloud field top-down into `uCloudShadowTex` and publish `uCloudShadowParams` */
  private updateCloudShadow(env: Env, night: number, weatherCover: number): void {
    const u = this.u;
    const ws = u.uWorldSize.value; // (sizeX, sizeZ, originX, originZ)
    const size = Math.max(512, Math.max(ws.x, ws.y) * 1.6);
    const cx = ws.z + ws.x * 0.5;
    const cz = ws.w + ws.y * 0.5;
    const strength = this.tuning.cloudShadow * (1 - night) * smoothstep(0.03, 0.22, env.sunDir.y) * (1 - 0.7 * weatherCover);
    u.uCloudShadowParams.value.set(size, size * 0.5 - cx, size * 0.5 - cz, strength);
    if (strength < 0.004) return;
    const cu = this.cloudMat.uniforms;
    (cu.uCenter!.value as Vector2).set(cx, cz);
    cu.uSize!.value = size;
    const ky = Math.max(env.sunDir.y, 0.28);
    (cu.uShift!.value as Vector2).set((env.sunDir.x / ky) * CLOUD_ALT, (env.sunDir.z / ky) * CLOUD_ALT);
    cu.uCover!.value = this.cloud.cover - 0.05;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.cloudRT);
    r.render(this.cloudScene, this.cloudCam);
    r.setRenderTarget(prev);
  }

  /** keep the dome centred on the camera, and track the depth-of-field focus (call after the camera is placed) */
  follow(camera: PerspectiveCamera): void {
    this.sky.position.copy(camera.position);
    const far = camera.far * 0.5;
    this.sky.scale.setScalar(far / 100);
    this.sky.updateMatrixWorld();

    // focus distance: the player if it is roughly where the camera looks, else where the view ray meets the ground
    camera.updateMatrixWorld();
    const fwd = this.tmpA.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const toP = this.tmpB.copy(this.u.uPlayerPos.value);
    toP.y += 0.9;
    toP.sub(camera.position);
    const dist = toP.length();
    const along = toP.dot(fwd);
    let target: number;
    if (dist < 140 && along > 0.5 && along / Math.max(dist, 1e-3) > 0.9) target = along;
    else if (fwd.y < -0.03) target = Math.min(400, Math.max(6, (camera.position.y - 0.5) / -fwd.y));
    else target = 60;
    const a = this.lastSnap ? 1 : 1 - Math.exp(-5 * Math.max(this.lastDt, 1 / 120));
    lookState.focus += (target - lookState.focus) * a;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.cloudRT.dispose();
    this.cloudMat.dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}
