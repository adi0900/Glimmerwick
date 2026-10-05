/**
 * Post: the pmndrs `postprocessing` stack. Owner: look (first version by foundation-web).
 *
 * Pipeline (each stage is quality-gated, see QualityPreset):
 *   RenderPass (HDR half-float buffer, MSAA 0/2/4/8)
 *   -> [high+] EffectPass: TiltShift (subtle miniature feel; blurs the HDR image so bloom/AO stay consistent)
 *   -> [high+] AOPass (custom, half-res, depth-only Alchemy-style AO + bilateral blur; no extra scene pass)
 *   -> EffectPass: AO composite · Bloom (emissives/sun only) · ToneMapping (Neutral by default) · Grade (violet
 *      vignette, saturation, black floor) -- dithered to kill sky banding
 *   -> [low] FXAA / [ultra] SMAA as a last pass
 *
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
  EffectComposer,
  EffectPass,
  FXAAEffect,
  KernelSize,
  Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  TiltShiftEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
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
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  // gentle contrast around mid grey (display-referred after tone mapping)
  c = (c - 0.18) * uContrast + 0.18;
  // never pure black: lift toward blue-violet (ART_BIBLE §1: darkest shadow >= ~12 % luminance)
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
        ['uVigOffset', new Uniform(0.38)],
        ['uVigDark', new Uniform(0.3)],
        ['uVigTint', new Uniform(new Color('#7C6CB8'))],
        ['uSat', new Uniform(1.1)],
        ['uContrast', new Uniform(1.06)],
        ['uFloor', new Uniform(new Color(0.018, 0.012, 0.042))],
      ]),
    });
  }
  u<T = number>(name: string): Uniform<T> {
    return this.uniforms.get(name) as Uniform<T>;
  }
}

// ------------------------------------------------------------------------------------------ AO

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
uniform vec2 texel;
uniform mat4 projInv;
uniform float focalPx;       // projection scale in pixels at unit distance
uniform float radius;        // world metres
uniform float intensity;
uniform float bias;

vec3 viewPos( vec2 uv ) {
  float d = texture2D( depthBuffer, uv ).r;
  vec4 v = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return v.xyz / v.w;
}

float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

void main() {
  float d0 = texture2D( depthBuffer, vUv ).r;
  if ( d0 >= 0.99999 ) { gl_FragColor = vec4( 1.0 ); return; } // sky
  vec3 P = viewPos( vUv );
  vec3 Pr = viewPos( vUv + vec2( texel.x, 0.0 ) );
  vec3 Pl = viewPos( vUv - vec2( texel.x, 0.0 ) );
  vec3 Pu = viewPos( vUv + vec2( 0.0, texel.y ) );
  vec3 Pd = viewPos( vUv - vec2( 0.0, texel.y ) );
  vec3 dx = abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ? Pr - P : P - Pl;
  vec3 dy = abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ? Pu - P : P - Pd;
  vec3 N = normalize( cross( dx, dy ) );
  if ( dot( N, P ) > 0.0 ) N = -N;

  float rpx = clamp( radius * focalPx / max( -P.z, 0.1 ), 2.5, 90.0 );
  float ang0 = ign( gl_FragCoord.xy ) * 6.2831853;
  const int NS = 14;
  float occ = 0.0;
  for ( int i = 0; i < NS; i ++ ) {
    float fi = float( i );
    float r = sqrt( ( fi + 0.5 ) / float( NS ) );
    float a = ang0 + fi * 2.3999632;
    vec2 off = vec2( cos( a ), sin( a ) ) * r * rpx * texel;
    vec3 S = viewPos( vUv + off );
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
uniform vec2 dir;       // texel step along the blur axis
uniform float near;
uniform float far;
float lz( vec2 uv ) { return -perspectiveDepthToViewZ( texture2D( depthBuffer, uv ).r, near, far ); }
void main() {
  float z0 = lz( vUv );
  float sum = texture2D( aoMap, vUv ).r * 0.2;
  float wsum = 0.2;
  for ( int i = 1; i <= 3; i ++ ) {
    float fi = float( i );
    float w = exp( -fi * fi * 0.18 );
    for ( int s = -1; s <= 1; s += 2 ) {
      vec2 uv = vUv + dir * fi * float( s );
      float z = lz( uv );
      float wz = exp( -abs( z - z0 ) / max( z0 * 0.02, 0.02 ) );
      sum += texture2D( aoMap, uv ).r * w * wz * 0.2;
      wsum += w * wz * 0.2;
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
        texel: { value: new Vector2() },
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
    this.target.setSize(w, h);
    this.tmp.setSize(w, h);
    (this.aoMat.uniforms.texel!.value as Vector2).set(1 / w, 1 / h);
  }

  override render(renderer: WebGLRenderer): void {
    if (!this.depthTex) return;
    const cam = this.cam;
    const u = this.aoMat.uniforms;
    u.projInv!.value = cam.projectionMatrixInverse;
    u.focalPx!.value = 0.5 * this.size.y * cam.projectionMatrix.elements[5]!;
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
    (b.dir!.value as Vector2).set(1 / this.size.x, 0);
    renderer.setRenderTarget(this.tmp);
    renderer.render(this.scene, this.camera);
    b.aoMap!.value = this.tmp.texture;
    (b.dir!.value as Vector2).set(0, 1 / this.size.y);
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
  tilt: TiltShiftEffect | null = null;
  tone: ToneMappingEffect | null = null;
  grade: GradeEffect | null = null;
  ao: AOPass | null = null;
  aoComposite: AOCompositeEffect | null = null;

  /** tweakables (applied on build and live through `apply()`) */
  params = {
    toneMapping: 'neutral' as ToneMapName,
    bloomIntensity: 0.55,
    bloomThreshold: 0.92,
    bloomSmoothing: 0.35,
    bloomRadius: 0.8,
    aoRadius: 0.9,
    aoIntensity: 1.35,
    aoStrength: 0.85,
    tiltOffset: -0.02,
    tiltFocus: 1.0,
    tiltFeather: 0.3,
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
    this.bloom = this.tilt = this.tone = this.grade = this.aoComposite = null;
    this.ao = null;
    c.multisampling = Math.min(q.msaa, this.msaaMax);

    c.addPass(new RenderPass(this.scene, this.camera));

    if (q.tiltShift) {
      this.tilt = new TiltShiftEffect({
        offset: this.params.tiltOffset,
        rotation: 0,
        focusArea: this.params.tiltFocus,
        feather: this.params.tiltFeather,
        kernelSize: KernelSize.SMALL,
        resolutionScale: 0.5,
      });
      c.addPass(new EffectPass(this.camera, this.tilt));
    }

    const fx: Effect[] = [];
    if (q.ao) {
      this.ao = new AOPass(this.camera, 0.5);
      c.addPass(this.ao);
      this.aoComposite = new AOCompositeEffect(this.ao.texture);
      fx.push(this.aoComposite);
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
      this.tilt.offset = p.tiltOffset;
      this.tilt.focusArea = p.tiltFocus;
      this.tilt.feather = p.tiltFeather;
    }
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
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
