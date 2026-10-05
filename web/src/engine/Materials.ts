/**
 * Materials: the shared `ToonLit` look (ART_BIBLE §3). Owner: look (first version by foundation-web).
 *
 * ToonLit = a patched three `MeshToonMaterial`, so shadows (incl. SunLight cascades), hemisphere + point lights
 * (lanterns), vertex colours, instancing (`InstancedMesh`, `instanceColor`), batching and fog all keep working.
 * What the patch adds (see the GLSL strings below):
 *   - soft multi-band ramp (3-4 bands, edges smoothstepped over ~8-12 % of N.L) instead of the 2-tone default
 *   - cool "shade colour" (albedo seen in shadow: hue-cooled + more saturated) fed by the hemisphere light
 *   - warm Fresnel rim, stylised specular (lacquer), foliage back-light translucency
 *   - procedural hand-painted albedo layer (gw_paint: macro drift, 2-scale brush strokes, grain), bevel edge tint
 *   - project fog (gw_fog: FogExp2 + height falloff + sun in-scatter) and weather hooks (wetness, snow, cloud shadows)
 *   - world-space wind sway + grass benders (vertex) with a matching shadow depth material
 *
 * Usage:   const m = ctx.mats.clay('#FF9A5A');  mesh.material = m;  ctx.mats.prepare(mesh);
 *          ctx.mats.toon({ cls: 'foliage', color: '#5CC95A', wind: { amp: 0.15, height: 5 } })
 * Shared uniforms (WORLD_CONTRACT.md) are bound by reference; per-material knobs live in `m.userData.gw.uniforms`.
 */
import {
  Color,
  DoubleSide,
  MeshDepthMaterial,
  MeshToonMaterial,
  Vector4,
  type ColorRepresentation,
  type Material,
  type Mesh,
  type Object3D,
  type Side,
  type Texture,
} from 'three';
import { registerGlsl } from './glsl';
import type { QualityPreset, SharedUniforms } from './types';

export type ToonClass = 'clay' | 'foliage' | 'stone' | 'wood' | 'lacquer' | 'glow' | 'ground';

export interface WindOptions {
  /** displacement amplitude at full weight (m) */
  amp?: number;
  /** height (object space, m) over which the sway weight ramps 0 -> 1 (ignored with `attr`) */
  height?: number;
  /** gust speed multiplier */
  speed?: number;
  /** read the per-vertex weight from geometry attribute `aSway` (float, 0..1) instead of height */
  attr?: boolean;
}

export interface ToonOptions {
  cls?: ToonClass;
  color?: ColorRepresentation;
  map?: Texture | null;
  vertexColors?: boolean;
  emissive?: ColorRepresentation;
  emissiveIntensity?: number;
  side?: Side;
  alphaTest?: number;
  alphaToCoverage?: boolean;
  transparent?: boolean;
  opacity?: number;
  /** hand-painted layer strength 0..1 */
  paint?: number;
  /** pattern scale multiplier (1 ~ 1 m features) */
  paintScale?: number;
  /** 'world' (static scenery, never swims) or 'object' (moving things: creatures, characters, props) */
  paintSpace?: 'world' | 'object';
  /** ramp band count 2..4 */
  bands?: number;
  /** band edge softness as a fraction of N.L (0.08..0.12) */
  softness?: number;
  /** 0..1: how far the shade colour departs from the albedo (cooler + more saturated) */
  shade?: number;
  shadeTint?: ColorRepresentation;
  /** rim strength 0.15..0.35 */
  rim?: number;
  rimPower?: number;
  rimColor?: ColorRepresentation;
  /** stylised specular strength (lacquer) */
  spec?: number;
  specPower?: number;
  /** back-light translucency (foliage) 0..1 */
  translucency?: number;
  /** bevel / hard-edge warm lift 0..1 */
  edge?: number;
  /** emissive pulse amount (glow) 0..1 */
  pulse?: number;
  /** wind sway: true/{...} to enable (foliage default) */
  wind?: boolean | WindOptions;
  /** react to uBenders (grass bends away from the player / creatures); weight follows the `wind` height/attr */
  bend?: boolean;
  /** react to the cloud-shadow texture */
  cloudShadow?: boolean;
  /** wetness / snow weather hooks (default true) */
  weather?: boolean;
  fog?: boolean;
  name?: string;
}

const LAVENDER = new Color('#B7B0F0');
const COOL = new Color('#A9B6F2');
const WARM_RIM = new Color('#FFD7A0');

const CLASS_DEFAULTS: Record<ToonClass, ToonOptions> = {
  // characters / creatures: soft felt-clay, strong warm rim, painterly but gentle
  clay: { paint: 0.7, paintScale: 1.0, paintSpace: 'object', shade: 0.65, rim: 0.28, bands: 3, softness: 0.11, edge: 0.45 },
  // leaves: back-lit translucency + wind
  foliage: { paint: 0.9, paintScale: 1.3, paintSpace: 'world', shade: 0.75, rim: 0.22, bands: 3, softness: 0.12, translucency: 0.55, edge: 0, wind: { amp: 0.12, height: 4, speed: 1 } },
  // rock: bigger brush, lavender shadows, hard bevel highlights
  stone: { paint: 1.0, paintScale: 1.5, paintSpace: 'world', shade: 0.85, shadeTint: LAVENDER, rim: 0.12, bands: 4, softness: 0.09, edge: 0.9 },
  // timber: stretched grain strokes
  wood: { paint: 0.85, paintScale: 1.1, paintSpace: 'object', shade: 0.7, rim: 0.18, bands: 3, softness: 0.1, edge: 0.6 },
  // glossy toys / eyes
  lacquer: { paint: 0.3, paintSpace: 'object', shade: 0.6, rim: 0.34, bands: 3, softness: 0.1, spec: 1.0, specPower: 48, edge: 0.3 },
  // luminous things (bloom picks these up)
  glow: { paint: 0.25, paintSpace: 'object', shade: 0.25, rim: 0.4, bands: 2, softness: 0.25, emissiveIntensity: 2.4, pulse: 0.25, edge: 0 },
  // terrain & other big ground surfaces (use with vertexColors)
  ground: { paint: 1.0, paintScale: 0.9, paintSpace: 'world', shade: 0.8, rim: 0, bands: 3, softness: 0.12, edge: 0, cloudShadow: true },
};

// ------------------------------------------------------------------------------------------------- GLSL

const VERT_PARS = (varyings: boolean) => /* glsl */ `
${varyings ? 'varying vec3 vGwWorld;\nvarying vec3 vGwLocal;' : ''}
#include <gw_hash>
#if defined( GW_WIND ) || defined( GW_BEND )
  uniform vec2 uWind;
  uniform float uWindTime;
  uniform vec4 uGwWindCfg; // x amplitude (m) . y sway height (m) . z speed
  #ifdef GW_SWAY_ATTR
    attribute float aSway;
  #endif
  #ifdef GW_BEND
    uniform vec4 uBenders[16];
  #endif
  vec3 gwDisplace( vec3 wp, float w, vec3 origin ) {
    vec3 d = vec3( 0.0 );
    #ifdef GW_WIND
      vec2 wd = uWind;
      float ws = length( wd );
      vec2 wdn = wd / max( ws, 1e-4 );
      float spd = uGwWindCfg.z;
      float ph = dot( wp.xz, wdn ) * 0.22 - uWindTime * 1.35 * spd;
      float gust = 0.5 + 0.5 * sin( ph + 0.8 * sin( ph * 0.37 + wp.z * 0.11 ) );
      float seed = gwHash12( origin.xz );
      float ph2 = uWindTime * ( 1.9 + 0.7 * spd ) + seed * 6.2831853;
      float flutter = sin( ph2 ) * 0.6 + sin( ph2 * 2.3 + 1.7 ) * 0.4;
      float amp = uGwWindCfg.x;
      d.xz += wd * ( 0.3 + 0.7 * gust ) * amp * w;
      d.xz += vec2( -wdn.y, wdn.x ) * flutter * amp * 0.3 * min( ws, 1.5 ) * w;
      d.y -= length( d.xz ) * 0.25;
    #endif
    #ifdef GW_BEND
      for ( int i = 0; i < 16; i ++ ) {
        vec4 b = uBenders[ i ];
        if ( b.w > 0.001 ) {
          vec2 off = wp.xz - b.xz;
          float dist = length( off );
          float f = 1.0 - smoothstep( 0.0, b.w, dist );
          d.xz += ( off / max( dist, 0.05 ) ) * ( f * b.w * 0.45 * w );
          d.y -= f * 0.18 * w;
        }
      }
    #endif
    return d;
  }
#endif
`;

const VERT_BEGIN = (varyings: boolean) => /* glsl */ `
#include <begin_vertex>
vec4 gwWp0 = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  gwWp0 = batchingMatrix * gwWp0;
#endif
#ifdef USE_INSTANCING
  gwWp0 = instanceMatrix * gwWp0;
#endif
gwWp0 = modelMatrix * gwWp0;
${
  varyings
    ? `vGwWorld = gwWp0.xyz;
vGwLocal = position;
#ifdef USE_INSTANCING
  vGwLocal += instanceMatrix[ 3 ].xyz * 0.37;
#endif`
    : ''
}
#if defined( GW_WIND ) || defined( GW_BEND )
  #ifdef GW_SWAY_ATTR
    float gwW = aSway;
  #else
    float gwW = pow( clamp( position.y / uGwWindCfg.y, 0.0, 1.0 ), 1.5 );
  #endif
  vec3 gwOrigin = modelMatrix[ 3 ].xyz;
  #ifdef USE_INSTANCING
    gwOrigin = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
  #endif
  vec3 gwD = gwDisplace( gwWp0.xyz, gwW, gwOrigin );
  mat3 gwM = mat3( modelMatrix );
  #ifdef USE_INSTANCING
    gwM = gwM * mat3( instanceMatrix );
  #endif
  transformed += ( transpose( gwM ) * gwD ) / max( dot( gwM[ 0 ], gwM[ 0 ] ), 1e-6 );
#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vGwWorld;
varying vec3 vGwLocal;
uniform float uGwPaint;
uniform float uGwPaintScale;
uniform float uGwShade;
uniform vec3 uGwShadeTint;
uniform float uGwBands;
uniform float uGwSoft;
uniform float uGwRim;
uniform float uGwRimPower;
uniform vec3 uGwRimColor;
uniform float uGwSpec;
uniform float uGwSpecPower;
uniform float uGwTrans;
uniform float uGwEdge;
uniform float uGwPulse;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uWetness;
uniform float uSnow;
uniform sampler2D uCloudShadowTex;
uniform vec4 uCloudShadowParams;
#include <gw_toon>
#include <gw_paint>
#include <gw_fog>
`;

const FRAG_LIGHTS_PARS = /* glsl */ `
varying vec3 vViewPosition;

struct ToonMaterial {
  vec3 diffuseColor;
  vec3 shadeColor;
  float specular;
  float specPower;
};

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  float ndl = dot( geometryNormal, directLight.direction );
  float ramp = gwToonRamp( ndl, uGwBands, uGwSoft );
  ramp = mix( ramp, saturate( ndl ), 0.12 );
  reflectedLight.directDiffuse += ramp * directLight.color * BRDF_Lambert( material.diffuseColor );
  #ifdef GW_SPEC
    vec3 hv = normalize( directLight.direction + geometryViewDir );
    float nh = saturate( dot( geometryNormal, hv ) );
    float sp = smoothstep( 0.42, 0.5, pow( nh, material.specPower ) ) * step( 0.0, ndl );
    reflectedLight.directSpecular += directLight.color * ( sp * material.specular * 0.35 );
  #endif
}

void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.shadeColor );
}

#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`;

const FRAG_LIGHTS_BEGIN = /* glsl */ `
ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.shadeColor = gwShadeColor( diffuseColor.rgb, uGwShade, uGwShadeTint );
material.specular = uGwSpec * ( 1.0 + uWetness * 2.0 );
material.specPower = uGwSpecPower * ( 1.0 + uWetness );
`;

const FRAG_PAINT = /* glsl */ `
#include <emissivemap_fragment>
vec3 gwWN = normalize( inverseTransformDirection( normal, viewMatrix ) );
float gwFp = length( fwidth( vGwWorld ) );
#ifdef GW_PAINT
  #ifdef GW_PAINT_OBJECT
    vec3 gwPP = vGwLocal;
  #else
    vec3 gwPP = vGwWorld;
  #endif
  diffuseColor.rgb = gwPaint( diffuseColor.rgb, gwPP, gwWN, uGwPaint, uGwPaintScale, gwFp );
#endif
#ifdef GW_EDGE
  float gwCurv = length( fwidth( gwWN ) ) / max( gwFp, 1e-5 );
  float gwEdgeAmt = smoothstep( 6.0, 26.0, gwCurv );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.18, 1.1, 0.92 ) + 0.02, gwEdgeAmt * uGwEdge );
#endif
#ifdef GW_WEATHER
  float gwWet = uWetness * ( 0.4 + 0.6 * smoothstep( -0.2, 0.9, gwWN.y ) );
  diffuseColor.rgb *= mix( 1.0, 0.68, gwWet );
  float gwSnowAmt = uSnow * smoothstep( 0.45, 0.85, gwWN.y );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.9, 1.0 ), gwSnowAmt * 0.92 );
#endif
`;

const FRAG_COMPOSE = /* glsl */ `
vec3 gwDirect = reflectedLight.directDiffuse;
#ifdef GW_CLOUDSHADOW
  float gwCloud = texture2D( uCloudShadowTex, ( vGwWorld.xz + uCloudShadowParams.yz ) / uCloudShadowParams.x ).r;
  gwDirect *= mix( 1.0, gwCloud, uCloudShadowParams.w );
#endif
#if defined( GW_EMISSIVE_VCOLOR ) && defined( USE_COLOR )
  totalEmissiveRadiance *= vColor.rgb;
#endif
#ifdef GW_PULSE
  totalEmissiveRadiance *= 1.0 + uGwPulse * 0.5 * sin( uTime * 2.4 + dot( vGwWorld, vec3( 1.3, 0.7, 1.1 ) ) );
#endif
vec3 outgoingLight = gwDirect + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;
vec3 gwSunV = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
#ifdef GW_RIM
  float gwRimF = gwRim( normal, geometryViewDir, uGwRimPower );
  float gwRimMask = 0.4 + 0.6 * saturate( dot( normal, gwSunV ) * 0.5 + 0.5 );
  vec3 gwRimCol = mix( uGwRimColor, uSunColor, 0.35 ) * mix( 1.0, 0.45, uNight );
  outgoingLight += gwRimCol * ( gwRimF * uGwRim * gwRimMask );
#endif
#ifdef GW_TRANS
  float gwBack = pow( saturate( dot( geometryViewDir, -gwSunV ) ), 3.0 ) * saturate( 0.5 - 0.5 * dot( normal, gwSunV ) );
  outgoingLight += diffuseColor.rgb * uSunColor * ( gwBack * uGwTrans * 0.9 );
#endif
`;

const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
  vec3 gwVd = vGwWorld - cameraPosition;
  float gwDist = length( gwVd );
  gl_FragColor.rgb = gwFog( gl_FragColor.rgb, gwDist, vGwWorld.y, gwVd / max( gwDist, 1e-4 ), uFogColor, uFogDensity, uSunDir, uSunColor, uNight );
#endif
`;

function replaceOnce(src: string, needle: string, repl: string, label: string): string {
  if (!src.includes(needle)) {
    console.error(`[Materials] ToonLit patch failed: "${needle}" not found (${label}). three changed its toon shader?`);
    return src;
  }
  return src.replace(needle, repl);
}

type ShaderParams = Parameters<Material['onBeforeCompile']>[0];

// ------------------------------------------------------------------------------------------------- class

interface GwData {
  uniforms: Record<string, { value: any }>;
  cls: ToonClass;
  opts: ToonOptions;
  windOn: boolean;
  bend: boolean;
  swayAttr: boolean;
  depth?: MeshDepthMaterial;
}

export class Materials {
  private readonly registry = new Set<MeshToonMaterial>();
  private q: QualityPreset;
  /** the shared `{value}` holders (same objects as `ctx.uniforms`) */
  readonly shared: SharedUniforms;

  constructor(shared: SharedUniforms, quality: QualityPreset) {
    registerGlsl();
    this.shared = shared;
    this.q = quality;
  }

  // ---- factories ---------------------------------------------------------------------------

  clay(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'clay', color });
  }
  foliage(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'foliage', color });
  }
  stone(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'stone', color });
  }
  wood(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'wood', color });
  }
  lacquer(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'lacquer', color });
  }
  glow(color: ColorRepresentation, o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ ...o, cls: 'glow', color });
  }
  /** big ground surfaces, intended for `vertexColors` */
  ground(o: ToonOptions = {}): MeshToonMaterial {
    return this.toon({ vertexColors: true, ...o, cls: 'ground' });
  }

  /** The ToonLit factory. */
  toon(o: ToonOptions = {}): MeshToonMaterial {
    const cls: ToonClass = o.cls ?? 'clay';
    const d: ToonOptions = { ...CLASS_DEFAULTS[cls] };
    for (const k of Object.keys(o) as (keyof ToonOptions)[]) if (o[k] !== undefined) (d as any)[k] = o[k];

    const color = new Color(d.color ?? 0xffffff);
    const params: Record<string, unknown> = {
      color,
      vertexColors: d.vertexColors ?? false,
      alphaTest: d.alphaTest ?? 0,
      transparent: d.transparent ?? false,
      opacity: d.opacity ?? 1,
      fog: d.fog ?? true,
    };
    if (d.map) params.map = d.map;
    if (d.side !== undefined) params.side = d.side;
    const m = new MeshToonMaterial(params);
    if (d.alphaToCoverage) m.alphaToCoverage = true;
    if (d.emissive !== undefined || d.emissiveIntensity !== undefined || cls === 'glow') {
      m.emissive = new Color(d.emissive ?? color);
      m.emissiveIntensity = d.emissiveIntensity ?? 1;
    }
    m.name = `toon.${cls}${d.name ? '.' + d.name : ''}`;

    const windObj: WindOptions = typeof d.wind === 'object' ? d.wind : {};
    const windOn = !!d.wind;
    const u: GwData['uniforms'] = {
      uGwPaint: { value: d.paint ?? 0.7 },
      uGwPaintScale: { value: d.paintScale ?? 1 },
      uGwShade: { value: d.shade ?? 0.65 },
      uGwShadeTint: { value: new Color(d.shadeTint ?? COOL) },
      uGwBands: { value: d.bands ?? 3 },
      uGwSoft: { value: d.softness ?? 0.11 },
      uGwRim: { value: d.rim ?? 0.25 },
      uGwRimPower: { value: d.rimPower ?? 3.0 },
      uGwRimColor: { value: new Color(d.rimColor ?? WARM_RIM) },
      uGwSpec: { value: d.spec ?? 0 },
      uGwSpecPower: { value: d.specPower ?? 40 },
      uGwTrans: { value: d.translucency ?? 0 },
      uGwEdge: { value: d.edge ?? 0 },
      uGwPulse: { value: d.pulse ?? 0 },
      // x amplitude (m, 0 = wind off) . y sway height (m) . z gust speed
      uGwWindCfg: { value: new Vector4(windOn ? (windObj.amp ?? 0.12) : 0, Math.max(windObj.height ?? 4, 1e-3), windObj.speed ?? 1, 0) },
    };

    const gw: GwData = { uniforms: u, cls, opts: d, windOn, bend: !!d.bend, swayAttr: !!windObj.attr };
    m.userData.gw = gw;
    this.applyDefines(m);

    const shared = this.shared;
    m.onBeforeCompile = (shader: ShaderParams) => {
      Object.assign(shader.uniforms, u);
      shader.uniforms.uTime = shared.uTime;
      shader.uniforms.uSunDir = shared.uSunDir;
      shader.uniforms.uSunColor = shared.uSunColor;
      shader.uniforms.uNight = shared.uNight;
      shader.uniforms.uFogColor = shared.uFogColor;
      shader.uniforms.uFogDensity = shared.uFogDensity;
      shader.uniforms.uWetness = shared.uWetness;
      shader.uniforms.uSnow = shared.uSnow;
      shader.uniforms.uCloudShadowTex = shared.uCloudShadowTex;
      shader.uniforms.uCloudShadowParams = shared.uCloudShadowParams;
      shader.uniforms.uWind = shared.uWind;
      shader.uniforms.uWindTime = shared.uWindTime;
      shader.uniforms.uBenders = shared.uBenders;

      let vs = shader.vertexShader;
      vs = replaceOnce(vs, '#include <common>', '#include <common>\n' + VERT_PARS(true), 'vertex common');
      vs = replaceOnce(vs, '#include <begin_vertex>', VERT_BEGIN(true), 'vertex begin_vertex');
      shader.vertexShader = vs;

      let fs = shader.fragmentShader;
      fs = replaceOnce(fs, '#include <common>', '#include <common>\n' + FRAG_PARS, 'fragment common');
      fs = replaceOnce(fs, '#include <lights_toon_pars_fragment>', FRAG_LIGHTS_PARS, 'lights_toon_pars_fragment');
      fs = replaceOnce(fs, '#include <lights_toon_fragment>', FRAG_LIGHTS_BEGIN, 'lights_toon_fragment');
      fs = replaceOnce(fs, '#include <emissivemap_fragment>', FRAG_PAINT, 'emissivemap_fragment');
      fs = replaceOnce(
        fs,
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        FRAG_COMPOSE,
        'outgoingLight',
      );
      fs = replaceOnce(fs, '#include <fog_fragment>', FRAG_FOG, 'fog_fragment');
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => 'gw-toon-1';

    this.registry.add(m);
    m.addEventListener('dispose', () => this.registry.delete(m));
    return m;
  }

  /** (re)compute the `#define` flags of a ToonLit material from its options and the quality preset */
  private applyDefines(m: MeshToonMaterial): void {
    const gw = m.userData.gw as GwData;
    const d = gw.opts;
    const q = this.q;
    const defs: Record<string, string> = { TOON: '' };
    if ((d.paint ?? 0) > 0) defs.GW_PAINT = '';
    if (d.paintSpace === 'object') defs.GW_PAINT_OBJECT = '';
    if (q.detail === 0) defs.GW_PAINT_LITE = '';
    if ((d.edge ?? 0) > 0 && q.detail >= 1) defs.GW_EDGE = '';
    if ((d.rim ?? 0) > 0) defs.GW_RIM = '';
    if ((d.spec ?? 0) > 0) defs.GW_SPEC = '';
    if ((d.translucency ?? 0) > 0) defs.GW_TRANS = '';
    if ((d.pulse ?? 0) > 0) defs.GW_PULSE = '';
    if (d.weather !== false) defs.GW_WEATHER = '';
    if (d.cloudShadow) defs.GW_CLOUDSHADOW = '';
    if (d.vertexColors && (d.emissive !== undefined || gw.cls === 'glow')) defs.GW_EMISSIVE_VCOLOR = '';
    if (gw.windOn) defs.GW_WIND = '';
    if (gw.bend) defs.GW_BEND = '';
    if ((gw.windOn || gw.bend) && gw.swayAttr) defs.GW_SWAY_ATTR = '';
    const cur = ((m as any).defines ?? {}) as Record<string, string>;
    const same = Object.keys(defs).length === Object.keys(cur).length && Object.keys(defs).every((k) => k in cur);
    (m as any).defines = defs;
    if (!same) m.needsUpdate = true;
  }

  /** change quality: re-derives defines of every live ToonLit material */
  setQuality(q: QualityPreset): void {
    this.q = q;
    for (const m of this.registry) this.applyDefines(m);
  }

  /**
   * Shadow depth material that sways with the same wind/benders as `material` (otherwise shadows of moving
   * foliage would stay still). Returns undefined for non-moving materials.
   */
  depthFor(material: Material | Material[]): MeshDepthMaterial | undefined {
    const m = Array.isArray(material) ? material[0] : material;
    const gw = m?.userData?.gw as GwData | undefined;
    if (!gw || (!gw.windOn && !gw.bend)) return undefined;
    if (gw.depth) return gw.depth;
    const dm = new MeshDepthMaterial();
    dm.name = `${m!.name}.depth`;
    const tm = m as MeshToonMaterial;
    dm.map = tm.map;
    dm.alphaTest = tm.alphaTest;
    const defs: Record<string, string> = {};
    if (gw.windOn) defs.GW_WIND = '';
    if (gw.bend) defs.GW_BEND = '';
    if (gw.swayAttr) defs.GW_SWAY_ATTR = '';
    (dm as any).defines = { ...((dm as any).defines ?? {}), ...defs };
    const shared = this.shared;
    const u = gw.uniforms;
    dm.onBeforeCompile = (shader: ShaderParams) => {
      shader.uniforms.uWind = shared.uWind;
      shader.uniforms.uWindTime = shared.uWindTime;
      shader.uniforms.uBenders = shared.uBenders;
      shader.uniforms.uGwWindCfg = u.uGwWindCfg!;
      let vs = shader.vertexShader;
      vs = replaceOnce(vs, '#include <common>', '#include <common>\n' + VERT_PARS(false), 'depth common');
      vs = replaceOnce(vs, '#include <begin_vertex>', VERT_BEGIN(false), 'depth begin_vertex');
      shader.vertexShader = vs;
    };
    dm.customProgramCacheKey = () => 'gw-depth-1';
    gw.depth = dm;
    return dm;
  }

  /**
   * One-stop setup for a mesh / group: shadow flags + wind-aware shadow depth material.
   * `cast`/`receive` default to true. Call after assigning materials.
   */
  prepare(root: Object3D, o: { cast?: boolean; receive?: boolean } = {}): void {
    const cast = o.cast ?? true;
    const receive = o.receive ?? true;
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      const dm = this.depthFor(mesh.material);
      if (dm) mesh.customDepthMaterial = dm;
    });
  }
}

export { DoubleSide };
