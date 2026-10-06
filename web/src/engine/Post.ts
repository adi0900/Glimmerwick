/**
 * Post: the pmndrs `postprocessing` stack. Owner: look (first version by foundation-web).
 *
 * Pipeline (each stage is quality-gated, see QualityPreset):
 *   RenderPass (HDR half-float buffer, MSAA 0/2/4/8)
 *   -> [high+] EffectPass: DofEffect (depth-based DOF whose focus follows the player / the view-ray ground hit, plus a
 *      subtle tilt-shift band; the in-focus range is wide so the island and the player stay crisp, only the far
 *      sea/sky and the extreme foreground soften). Runs in HDR so bloom / AO stay consistent.
 *   -> [high+] AOPass (custom, half-res, depth-only Alchemy-style AO + bilateral blur; no extra scene pass).
 *      Depth is fetched with texelFetch at explicit full-res texel coordinates: sampling the full-res depth texture
 *      at half-res texel centres lands exactly on texel borders, and the nearest-texel flip along that border made
 *      thin horizontal stripes across the ground (the "banding" seen in round 0).
 *   -> EffectPass: AO composite · depth outlines (coloured, distance-faded) · Bloom (emissives/sun only) ·
 *      ToneMapping (Neutral by default) · Grade (split-tone, saturation, violet vignette, black floor) -- dithered
 *   -> [low] FXAA / [ultra] SMAA as a last pass
 *
 * AA choice: MSAA on the HDR buffer (4x high / 8x ultra) -- no temporal shimmer on foliage / grass, resolve happens
 * before post so DOF / AO / outlines see clean edges. SMAA on ultra only cleans the remaining post-process edges.
 * Tone mapping: Khronos PBR Neutral keeps hues saturated and joyful; AgX is a softer alternative
 * (`post.setToneMapping('agx')`, or `?tm=agx`). Exposure lives in `renderer.toneMappingExposure` (Lighting).
 */
import {
  Color,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  NoToneMapping,
  NeutralToneMapping,
  type Camera,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type WebGLRenderer,
  Uniform,
} from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { lookState } from './Lighting';
import type { QualityPreset } from './types';

export type ToneMapName = 'neutral' | 'agx' | 'aces' | 'linear';

const TM: Record<ToneMapName, number> = {
  neutral: ToneMappingMode.NEUTRAL,
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
  linear: ToneMappingMode.LINEAR,
};

// ------------------------------------------------------------------------------------------ Grade effect

const GRADE_FRAG = /* glsl */ `
uniform float uVigOffset;
uniform float uVigDark;
uniform vec3 uVigTint;
uniform float uSat;
uniform float uContrast;
uniform vec3 uFloor;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uGain;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat) * uGain;
  // split-tone: cool saturated shadows, warm lights (the first-party toy-light tell)
  c *= mix(uShadowTint, uHighTint, smoothstep(0.04, 0.7, l));
  // gentle contrast around mid grey (display-referred after tone mapping)
  c = (c - 0.18) * uContrast + 0.18;
  // never pure black: lift toward blue-violet (ART_BIBLE section 1: darkest shadow >= ~12 % luminance)
  c = max(c, uFloor) + uFloor * 0.5 * (1.0 - clamp(c * 4.0, 0.0, 1.0));
  // soft violet vignette (not black)
  vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
  float d = length(q) / (0.5 * sqrt(aspect * aspect + 1.0));
  float v = smoothstep(uVigOffset, uVigOffset + 0.55, d);
  c = mix(c, c * uVigTint, v * uVigDark);
  outputColor = vec4(max(c, vec3(0.0)), inputColor.a);
}
`;

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['uVigOffset', new Uniform(0.4)],
        ['uVigDark', new Uniform(0.26)],
        ['uVigTint', new Uniform(new Color('#7C6CB8'))],
        ['uSat', new Uniform(1.14)],
        ['uContrast', new Uniform(1.07)],
        ['uFloor', new Uniform(new Color(0.018, 0.012, 0.042))],
        ['uShadowTint', new Uniform(new Color(0.95, 0.965, 1.07))],
        ['uHighTint', new Uniform(new Color(1.03, 1.0, 0.97))],
        ['uGain', new Uniform(1.0)],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

// ------------------------------------------------------------------------------------------ DOF (+ subtle tilt-shift)

const DOF_FRAG = /* glsl */ `
uniform float uFocus;        // view-space distance (m) kept razor sharp
uniform float uMaxCoc;       // max blur radius in px at 720p
uniform float uNear;
uniform float uFar;
uniform float uTiltArea;     // fraction of the screen height kept crisp by the tilt-shift term (centred)
uniform float uTiltFeather;
uniform float uTiltOffset;
uniform float uTiltStrength; // 0..1 of the max blur reached at the very top / bottom of the frame
uniform float uDofStrength;

float gwDofLin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

float gwDofCoc(vec2 uv, float d) {
  float z = gwDofLin(d);
  float f = max(uFocus, 1.0);
  float farK = smoothstep(max(f * 1.6, 16.0), f * 7.0 + 30.0, z);
  if (d >= 0.99999) farK *= 0.35;                       // keep sky and clouds soft but legible
  float nearK = (1.0 - smoothstep(0.4, clamp(f * 0.15, 1.5, 5.0), z)) * 0.8;   // only the very near foreground softens
  float depthC = max(farK * 0.65, nearK) * uDofStrength;
  float ty = abs(uv.y - 0.5 - uTiltOffset) * 2.0;       // 0 centre .. 1 edge
  float area = mix(0.97, uTiltArea, smoothstep(6.0, 40.0, f));   // close focus: (almost) no tilt-shift band
  float tilt = smoothstep(area, area + uTiltFeather, ty) * uTiltStrength;
  if (d >= 0.99999) tilt *= 0.25;                          // keep the clouds crisp
  return clamp(max(depthC, tilt), 0.0, 1.0);
}

float gwDofIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float scale = uMaxCoc * resolution.y / 720.0;
  float R = gwDofCoc(uv, depth) * scale;
  if (R < 0.6) {
    outputColor = inputColor;
    return;
  }
  vec3 acc = inputColor.rgb;
  float wsum = 1.0;
  float rot = gwDofIgn(gl_FragCoord.xy) * 6.2831853;
  for (int i = 0; i < 20; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 20.0);
    float a = rot + fi * 2.3999632;
    vec2 off = vec2(cos(a), sin(a)) * r * R;
    vec2 suv = uv + off * texelSize;
    float dS = readDepth(suv);
    float cS = gwDofCoc(suv, dS) * scale;
    float w = clamp(cS - r * R + 1.0, 0.0, 1.0);        // a sample only contributes if its own blur reaches this pixel
    acc += texture2D(inputBuffer, suv).rgb * w;
    wsum += w;
  }
  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

class DofEffect extends Effect {
  constructor() {
    super('DofEffect', DOF_FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ['uFocus', new Uniform(14)],
        ['uMaxCoc', new Uniform(6)],
        ['uNear', new Uniform(0.15)],
        ['uFar', new Uniform(1500)],
        ['uTiltArea', new Uniform(0.62)],
        ['uTiltFeather', new Uniform(0.38)],
        ['uTiltOffset', new Uniform(0)],
        ['uTiltStrength', new Uniform(0.5)],
        ['uDofStrength', new Uniform(1)],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

// ------------------------------------------------------------------------------------------ Outlines

const OUTLINE_FRAG = /* glsl */ `
uniform float uOutline;
uniform float uOutNear;
uniform float uOutFar;
uniform vec3 uOutTint;

float gwOutLin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uOutNear * uOutFar / (uOutFar + uOutNear - z * (uOutFar - uOutNear));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (depth >= 0.99999 || uOutline <= 0.001) return;
  float z0 = gwOutLin(depth);
  vec2 t = texelSize * max(1.0, resolution.y / 900.0);
  float zl = gwOutLin(readDepth(uv - vec2(t.x, 0.0)));
  float zr = gwOutLin(readDepth(uv + vec2(t.x, 0.0)));
  float zu = gwOutLin(readDepth(uv + vec2(0.0, t.y)));
  float zd = gwOutLin(readDepth(uv - vec2(0.0, t.y)));
  float e = max(abs(zl + zr - 2.0 * z0), abs(zu + zd - 2.0 * z0));      // depth cliff (silhouette), not slope
  float nearer = step(0.0, (zl + zr + zu + zd) * 0.25 - z0);             // draw on the object side only
  float edge = smoothstep(1.0, 2.2, e / (z0 * 0.035 + 0.04)) * nearer;
  float fade = 1.0 - smoothstep(70.0, 260.0, z0);                        // distance-faded
  outputColor.rgb = mix(inputColor.rgb, inputColor.rgb * uOutTint, edge * fade * uOutline);
}
`;

class OutlineEffect extends Effect {
  constructor() {
    super('OutlineEffect', OUTLINE_FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uOutline', new Uniform(0.55)],
        ['uOutNear', new Uniform(0.15)],
        ['uOutFar', new Uniform(1500)],
        // hue-shifted darker, never black: cool violet-brown
        ['uOutTint', new Uniform(new Color(0.5, 0.42, 0.66))],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

// ------------------------------------------------------------------------------------------ AO

// ------------------------------------------------------------------------------------------ Sun shafts + sun-side veil

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const SHAFT_FRAG = /* glsl */ `
uniform vec2 uSunUv;
uniform vec3 uSunTint;
uniform vec3 uCamF;
uniform vec3 uCamR;
uniform vec3 uCamU;
uniform vec2 uTanHalf;
uniform vec3 uSunW;
uniform float uShaft;
uniform float uVeil;
uniform float uShNear;
uniform float uShFar;

float gwShIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
vec3 gwShDir(vec2 p) {
  return normalize(uCamF + (p.x * 2.0 - 1.0) * uTanHalf.x * uCamR + (p.y * 2.0 - 1.0) * uTanHalf.y * uCamU);
}
float gwShLin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uShNear * uShFar / (uShFar + uShNear - z * (uShFar - uShNear));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (uShaft > 0.001) {
    const int N = 16;
    vec2 stp = (uSunUv - uv) * (0.96 / float(N));
    vec2 p = uv + stp * gwShIgn(gl_FragCoord.xy);
    float acc = 0.0;
    float w = 1.0;
    float ws = 0.0;
    for (int i = 0; i < N; i++) {
      vec2 pc = clamp(p, vec2(0.003), vec2(0.997));
      float sky = step(0.99999, readDepth(pc));
      float g = pow(max(dot(gwShDir(pc), uSunW), 0.0), 12.0);
      acc += sky * g * w;
      ws += w;
      w *= 0.95;
      p += stp;
    }
    c += uSunTint * ((acc / ws) * uShaft * 2.4);
  }
  if (uVeil > 0.001 && depth < 0.99999) {
    float sd = max(dot(gwShDir(uv), uSunW), 0.0);
    float dd = gwShLin(depth);
    float z = smoothstep(30.0, 420.0, dd) * (1.0 - smoothstep(500.0, 1300.0, dd));
    c += uSunTint * (pow(sd, 5.0) * z * uVeil);
  }
  outputColor = vec4(c, inputColor.a);
}
`;

class ShaftEffect extends Effect {
  constructor() {
    super('ShaftEffect', SHAFT_FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uSunUv', new Uniform(new Vector2(0.5, 0.8))],
        ['uSunTint', new Uniform(new Color(1, 0.8, 0.5))],
        ['uCamF', new Uniform(new Vector3(0, 0, -1))],
        ['uCamR', new Uniform(new Vector3(1, 0, 0))],
        ['uCamU', new Uniform(new Vector3(0, 1, 0))],
        ['uTanHalf', new Uniform(new Vector2(1, 0.5))],
        ['uSunW', new Uniform(new Vector3(0, 1, 0))],
        ['uShaft', new Uniform(0)],
        ['uVeil', new Uniform(0)],
        ['uShNear', new Uniform(0.15)],
        ['uShFar', new Uniform(1500)],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

const AO_FRAG = /* glsl */ `
precision highp float;
#include <common>
varying vec2 vUv;
uniform sampler2D depthBuffer;
uniform mat4 projInv;
uniform float focalPx;       // projection scale in FULL-res pixels at unit distance
uniform float radius;        // world metres
uniform float intensity;
uniform float bias;

const float BAYER4[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );

// explicit full-res texel fetch (never sample the depth texture on a texel border)
vec3 gwViewPos( ivec2 p, ivec2 fs ) {
  p = clamp( p, ivec2( 0 ), fs - ivec2( 1 ) );
  float d = texelFetch( depthBuffer, p, 0 ).r;
  vec2 uv = ( vec2( p ) + 0.5 ) / vec2( fs );
  vec4 v = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return v.xyz / v.w;
}

void main() {
  ivec2 fs = textureSize( depthBuffer, 0 );
  ivec2 c = clamp( ivec2( gl_FragCoord.xy ) * 2 + ivec2( 1 ), ivec2( 0 ), fs - ivec2( 1 ) );
  float d0 = texelFetch( depthBuffer, c, 0 ).r;
  if ( d0 >= 0.99999 ) { gl_FragColor = vec4( 1.0 ); return; } // sky
  vec3 P = gwViewPos( c, fs );
  vec3 Pr = gwViewPos( c + ivec2( 1, 0 ), fs );
  vec3 Pl = gwViewPos( c - ivec2( 1, 0 ), fs );
  vec3 Pu = gwViewPos( c + ivec2( 0, 1 ), fs );
  vec3 Pd = gwViewPos( c - ivec2( 0, 1 ), fs );
  vec3 dx = abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ? Pr - P : P - Pl;
  vec3 dy = abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ? Pu - P : P - Pd;
  vec3 N = normalize( cross( dx, dy ) );
  if ( dot( N, P ) > 0.0 ) N = -N;

  float rpx = clamp( radius * focalPx / max( -P.z, 0.1 ), 3.0, 180.0 );
  ivec2 hp = ivec2( gl_FragCoord.xy );
  float ang0 = ( BAYER4[ ( hp.y & 3 ) * 4 + ( hp.x & 3 ) ] + 0.5 ) / 16.0 * 6.2831853;
  const int NS = 16;
  float occ = 0.0;
  for ( int i = 0; i < NS; i ++ ) {
    float fi = float( i );
    float r = sqrt( ( fi + 0.5 ) / float( NS ) );
    float a = ang0 + fi * 2.3999632;
    ivec2 sp = c + ivec2( floor( vec2( cos( a ), sin( a ) ) * r * rpx + 0.5 ) );
    vec3 S = gwViewPos( sp, fs );
    vec3 v = S - P;
    float vv = dot( v, v );
    float vn = dot( v, N ) - bias * -P.z * 0.02;
    float range = smoothstep( 0.0, 1.0, radius / max( abs( P.z - S.z ), 1e-3 ) );
    occ += max( vn, 0.0 ) / ( vv + 0.0004 ) * range;
  }
  float ao = clamp( 1.0 - intensity * radius * occ / float( NS ) * 1.6, 0.0, 1.0 );
  gl_FragColor = vec4( vec3( ao ), 1.0 );
}
`;

const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
#include <common>
#include <packing>
varying vec2 vUv;
uniform sampler2D aoMap;
uniform sampler2D depthBuffer;
uniform vec2 dir;       // unit step along the blur axis, in half-res texels
uniform vec2 texel;     // 1 / half-res size
uniform float near;
uniform float far;
float gwLz( ivec2 p, ivec2 fs ) {
  p = clamp( p, ivec2( 0 ), fs - ivec2( 1 ) );
  return -perspectiveDepthToViewZ( texelFetch( depthBuffer, p, 0 ).r, near, far );
}
void main() {
  ivec2 fs = textureSize( depthBuffer, 0 );
  ivec2 c = ivec2( gl_FragCoord.xy ) * 2 + ivec2( 1 );
  ivec2 stp = ivec2( dir ) * 2;
  float z0 = gwLz( c, fs );
  float sum = texture2D( aoMap, vUv ).r;
  float wsum = 1.0;
  for ( int i = 1; i <= 4; i ++ ) {
    float fi = float( i );
    float w = exp( -fi * fi * 0.10 );
    for ( int s = -1; s <= 1; s += 2 ) {
      vec2 uv = vUv + dir * texel * fi * float( s );
      float z = gwLz( c + stp * i * s, fs );
      float wz = exp( -abs( z - z0 ) / max( z0 * 0.02, 0.02 ) );
      float ww = w * wz;
      sum += texture2D( aoMap, uv ).r * ww;
      wsum += ww;
    }
  }
  gl_FragColor = vec4( vec3( sum / wsum ), 1.0 );
}
`;

class AOPass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly tmp: WebGLRenderTarget;
  private readonly aoMat: ShaderMaterial;
  private readonly blurMat: ShaderMaterial;
  private depthTex: Texture | null = null;
  radius = 0.9;
  intensity = 1.0;
  bias = 0.4;
  private readonly size = new Vector2(1, 1);
  private fullH = 1;

  constructor(
    private cam: PerspectiveCamera,
    private readonly scale = 0.5,
  ) {
    super('AOPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    const mk = () =>
      new WebGLRenderTarget(1, 1, { depthBuffer: false, type: UnsignedByteType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter });
    this.target = mk();
    this.tmp = mk();
    this.aoMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AO_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        depthBuffer: { value: null },
        projInv: { value: cam.projectionMatrixInverse },
        focalPx: { value: 1 },
        radius: { value: this.radius },
        intensity: { value: this.intensity },
        bias: { value: this.bias },
      },
    });
    this.blurMat = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: AO_BLUR_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        aoMap: { value: null },
        depthBuffer: { value: null },
        dir: { value: new Vector2() },
        texel: { value: new Vector2() },
        near: { value: cam.near },
        far: { value: cam.far },
      },
    });
    this.fullscreenMaterial = this.aoMat;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  override set mainCamera(c: Camera) {
    this.cam = c as PerspectiveCamera;
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.depthTex = depthTexture;
    this.aoMat.uniforms.depthBuffer!.value = depthTexture;
    this.blurMat.uniforms.depthBuffer!.value = depthTexture;
  }

  override getDepthTexture(): Texture {
    return this.depthTex as Texture;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(2, Math.floor(width * this.scale));
    const h = Math.max(2, Math.floor(height * this.scale));
    this.size.set(w, h);
    this.fullH = height;
    this.target.setSize(w, h);
    this.tmp.setSize(w, h);
    (this.blurMat.uniforms.texel!.value as Vector2).set(1 / w, 1 / h);
  }

  override render(renderer: WebGLRenderer): void {
    if (!this.depthTex) return;
    const cam = this.cam;
    const u = this.aoMat.uniforms;
    u.projInv!.value = cam.projectionMatrixInverse;
    u.focalPx!.value = 0.5 * this.fullH * cam.projectionMatrix.elements[5]!;
    u.radius!.value = this.radius;
    u.intensity!.value = this.intensity;
    u.bias!.value = this.bias;
    this.fullscreenMaterial = this.aoMat;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);

    const b = this.blurMat.uniforms;
    b.near!.value = cam.near;
    b.far!.value = cam.far;
    this.fullscreenMaterial = this.blurMat;
    b.aoMap!.value = this.target.texture;
    (b.dir!.value as Vector2).set(1, 0);
    renderer.setRenderTarget(this.tmp);
    renderer.render(this.scene, this.camera);
    b.aoMap!.value = this.tmp.texture;
    (b.dir!.value as Vector2).set(0, 1);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
}

const AO_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D aoMap;
uniform vec3 uAoTint;
uniform float uAoStrength;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float ao = texture2D(aoMap, uv).r;
  vec3 k = mix(uAoTint, vec3(1.0), ao);
  outputColor = vec4(inputColor.rgb * mix(vec3(1.0), k, uAoStrength), inputColor.a);
}
`;

class AOCompositeEffect extends Effect {
  constructor(map: Texture) {
    super('AOCompositeEffect', AO_COMPOSITE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['aoMap', new Uniform(map)],
        ['uAoTint', new Uniform(new Color(0.42, 0.38, 0.62))],
        ['uAoStrength', new Uniform(1.0)],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

// ------------------------------------------------------------------------------------------ Post

export class Post {
  readonly composer: EffectComposer;
  enabled = true;
  /** live handles (rebuilt on quality change) */
  bloom: BloomEffect | null = null;
  /** depth-of-field + tilt-shift effect (kept under its old name for compatibility) */
  tilt: DofEffect | null = null;
  tone: ToneMappingEffect | null = null;
  grade: GradeEffect | null = null;
  ao: AOPass | null = null;
  aoComposite: AOCompositeEffect | null = null;
  outline: OutlineEffect | null = null;
  /** radial light shafts + warm sun-side veil (low sun only) */
  shafts: ShaftEffect | null = null;
  private readonly vR = new Vector3();
  private readonly vU = new Vector3();
  private readonly vF = new Vector3();

  /** tweakables (applied on build and live through `apply()`) */
  params = {
    toneMapping: 'neutral' as ToneMapName,
    bloomIntensity: 0.8,
    bloomThreshold: 0.92,
    bloomSmoothing: 0.35,
    bloomRadius: 0.8,
    aoRadius: 0.9,
    aoIntensity: 1.0,
    aoStrength: 0.55,
    /** tilt-shift band: fraction of the frame height kept crisp (centred), feather, offset, strength of the edge blur */
    tiltOffset: 0.0,
    tiltFocus: 0.62,
    tiltFeather: 0.38,
    tiltStrength: 0.5,
    /** depth of field: strength (0 = off) and max blur radius in px at 720p */
    dofStrength: 1.0,
    dofMaxCoc: 6,
    /** coloured, distance-faded silhouette outlines (0 = off) */
    outline: 0.55,
    saturation: 1.0,
    contrast: 1.07,
  };

  private q: QualityPreset;
  private msaaMax = 8;

  constructor(
    private readonly renderer: WebGLRenderer,
    private scene: Scene,
    private camera: PerspectiveCamera,
    quality: QualityPreset,
  ) {
    this.q = quality;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.msaaMax = Math.min(8, (gl.getParameter(gl.MAX_SAMPLES) as number) || 4);
    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: Math.min(quality.msaa, this.msaaMax),
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.build();
  }

  get quality(): QualityPreset {
    return this.q;
  }

  /** (re)create the pass chain for the current quality + params */
  private build(): void {
    const c = this.composer;
    const q = this.q;
    for (const p of c.passes) p.dispose();
    c.removeAllPasses();
    this.bloom = this.tilt = this.tone = this.grade = this.aoComposite = this.outline = this.shafts = null;
    this.ao = null;
    c.multisampling = Math.min(q.msaa, this.msaaMax);

    c.addPass(new RenderPass(this.scene, this.camera));

    if (q.tiltShift) {
      this.tilt = new DofEffect();
      c.addPass(new EffectPass(this.camera, this.tilt));
    }

    const fx: Effect[] = [];
    if (q.ao) {
      this.ao = new AOPass(this.camera, 0.5);
      c.addPass(this.ao);
      this.aoComposite = new AOCompositeEffect(this.ao.texture);
      fx.push(this.aoComposite);
    }
    if (q.detail >= 1) {
      this.shafts = new ShaftEffect();
      fx.push(this.shafts);
      this.outline = new OutlineEffect();
      fx.push(this.outline);
    }
    if (q.bloom) {
      this.bloom = new BloomEffect({
        intensity: this.params.bloomIntensity,
        luminanceThreshold: this.params.bloomThreshold,
        luminanceSmoothing: this.params.bloomSmoothing,
        mipmapBlur: true,
        radius: this.params.bloomRadius,
        levels: q.name === 'ultra' ? 8 : 6,
      });
      fx.push(this.bloom);
    }
    this.tone = new ToneMappingEffect({ mode: TM[this.params.toneMapping] });
    fx.push(this.tone);
    this.grade = new GradeEffect();
    fx.push(this.grade);
    const main = new EffectPass(this.camera, ...fx);
    main.dithering = true;
    c.addPass(main);

    if (q.smaa) c.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
    else if (q.fxaa) c.addPass(new EffectPass(this.camera, new FXAAEffect()));

    this.apply();
  }

  /** push `params` into the live effects */
  apply(): void {
    const p = this.params;
    if (this.bloom) {
      this.bloom.intensity = p.bloomIntensity;
      this.bloom.luminanceMaterial.threshold = p.bloomThreshold;
      this.bloom.luminanceMaterial.smoothing = p.bloomSmoothing;
      this.bloom.mipmapBlurPass.radius = p.bloomRadius;
    }
    if (this.tone && this.tone.mode !== TM[p.toneMapping]) this.tone.mode = TM[p.toneMapping];
    if (this.ao) {
      this.ao.radius = p.aoRadius;
      this.ao.intensity = p.aoIntensity;
    }
    if (this.aoComposite) this.aoComposite.u('uAoStrength').value = p.aoStrength;
    if (this.tilt) {
      this.tilt.u('uMaxCoc').value = p.dofMaxCoc;
      this.tilt.u('uDofStrength').value = p.dofStrength;
      this.tilt.u('uTiltArea').value = p.tiltFocus;
      this.tilt.u('uTiltFeather').value = p.tiltFeather;
      this.tilt.u('uTiltOffset').value = p.tiltOffset;
      this.tilt.u('uTiltStrength').value = p.tiltStrength;
    }
    if (this.outline) this.outline.u('uOutline').value = p.outline;
    if (this.grade) this.grade.u('uContrast').value = p.contrast;
  }

  /** per-frame look state: DOF focus, camera planes, time-of-day grade (warm lights at golden hour, cool at night) */
  private sync(): void {
    const L = lookState;
    const cam = this.camera;
    if (this.tilt) {
      this.tilt.u('uFocus').value = L.focus;
      this.tilt.u('uNear').value = cam.near;
      this.tilt.u('uFar').value = cam.far;
    }
    if (this.outline) {
      this.outline.u('uOutNear').value = cam.near;
      this.outline.u('uOutFar').value = cam.far;
    }
    if (this.grade) {
      const warm = L.golden;
      const night = L.night;
      this.grade.u<Color>('uHighTint').value.setRGB(1.03 + 0.10 * warm, 1.0 + 0.025 * warm, 0.97 - 0.14 * warm + 0.07 * night);
      this.grade.u<Color>('uShadowTint').value.setRGB(0.95 - 0.10 * night - 0.02 * warm, 0.965 - 0.05 * night - 0.035 * warm, 1.07 + 0.14 * night + 0.05 * warm);
      this.grade.u('uGain').value = 1.0 + 0.10 * night + 0.03 * warm;
      this.grade.u('uSat').value = this.params.saturation + 0.05 * warm - 0.28 * night - 0.15 * L.grey;
    }
  }

  /** sun position on screen + strengths for the shaft / veil effect (low sun, sun roughly in front of the camera) */
  private syncShafts(): void {
    const s = this.shafts;
    if (!s) return;
    const L = lookState;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const r = this.vR.set(e[0]!, e[1]!, e[2]!);
    const u = this.vU.set(e[4]!, e[5]!, e[6]!);
    const f = this.vF.set(-e[8]!, -e[9]!, -e[10]!);
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    const asp = cam.aspect;
    const sun = L.sunDir;
    const df = f.dot(sun);
    let sx = 0.5;
    let sy = 0.5;
    if (df > 0.02) {
      sx = 0.5 + (0.5 * sun.dot(r)) / df / (tanH * asp);
      sy = 0.5 + (0.5 * sun.dot(u)) / df / tanH;
    }
    const low = 1 - sstep(0.3, 0.52, L.sunElev);
    const up = sstep(-0.02, 0.06, L.sunElev);
    const front = sstep(0.04, 0.4, df);
    const vis = L.sunVis * (1 - L.grey);
    s.u('uShaft').value = 0.3 * low * up * front * vis;
    s.u('uVeil').value = 0.17 * L.golden * vis;
    s.u<Vector2>('uSunUv').value.set(sx, sy);
    s.u<Vector3>('uCamF').value.copy(f);
    s.u<Vector3>('uCamR').value.copy(r);
    s.u<Vector3>('uCamU').value.copy(u);
    s.u<Vector2>('uTanHalf').value.set(tanH * asp, tanH);
    s.u<Vector3>('uSunW').value.copy(sun);
    s.u<Color>('uSunTint').value.copy(L.sunCol);
    s.u('uShNear').value = cam.near;
    s.u('uShFar').value = cam.far;
  }

  setToneMapping(name: ToneMapName): void {
    this.params.toneMapping = name;
    this.apply();
  }

  setQuality(q: QualityPreset): void {
    this.q = q;
    this.build();
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  /** CSS-px size -> drawing buffer is handled by the renderer's pixel ratio */
  render(dt: number): void {
    if (!this.enabled) {
      this.renderer.toneMapping = NeutralToneMapping;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this.renderer.toneMapping = NoToneMapping;
      return;
    }
    this.sync();
    this.syncShafts();
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
