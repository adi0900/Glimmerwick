/**
 * Voxel materials. The block material is a ToonLit (look module) material extended through a chained `onBeforeCompile`:
 * it keeps ToonLit's lighting ramp, cascaded shadows, fog, weather, cloud shadows and leaf wind (`aSway`), and adds
 *   - atlas lookup from a texture array (`aTF` = tile * 8 + face, corner uv from `gl_VertexID & 3`),
 *   - per-block colour jitter, per-vertex AO + skylight, underwater caustics / tint,
 *   - the shader bevel: the normal is tilted towards the nearest block edge so every block catches light,
 *   - emissive tiles (glowcap, lantern).
 * Anchors patched (all stock three chunks): `void main() {`, `#include <project_vertex>`, `#include <color_fragment>`,
 * `#include <normal_fragment_maps>`, `#include <emissivemap_fragment>` (the last one is re-emitted by ToonLit).
 * The water is a separate translucent ShaderMaterial (depth gradient, animated normals, foam, sky + sun reflection,
 * shared haze via `gwFog`, ripple rings).
 */
import { Color, FrontSide, ShaderMaterial, Vector4, type DataArrayTexture, type MeshToonMaterial } from 'three';
import type { Ctx } from '../../engine/types';

const VERT_PARS = /* glsl */ `
attribute float aTF;
attribute vec4 aLight;
varying vec2 vVoxUv;
varying vec4 vVoxLight;
flat varying float vVoxTF;
`;

const VERT_MAIN = /* glsl */ `
#include <project_vertex>
{
  int gwc = gl_VertexID & 3;
  vVoxUv = vec2( ( gwc == 1 || gwc == 2 ) ? 1.0 : 0.0, ( gwc >= 2 ) ? 1.0 : 0.0 );
  vVoxLight = aLight;
  vVoxTF = aTF;
}
`;

const FRAG_PARS = /* glsl */ `
uniform highp sampler2DArray uBlockTiles;
uniform vec4 uVox; // x bevel width . y bevel strength . z water surface y (m) . w time
varying vec2 vVoxUv;
varying vec4 vVoxLight;
flat varying float vVoxTF;
const vec3 gwVN[6] = vec3[6]( vec3( 1.0, 0.0, 0.0 ), vec3( -1.0, 0.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, -1.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 0.0, -1.0 ) );
const vec3 gwVT[6] = vec3[6]( vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( -1.0, 0.0, 0.0 ) );
const vec3 gwVB[6] = vec3[6]( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ) );
float gwVoxH( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
`;

const FRAG_COLOR = /* glsl */ `
float gwTile = floor( vVoxTF / 8.0 );
int gwFace = int( vVoxTF - gwTile * 8.0 + 0.5 );
vec4 gwT = texture( uBlockTiles, vec3( vVoxUv, gwTile ) );
vec3 gwBP = floor( vGwWorld - gwVN[ gwFace ] * 0.5 );
float gwJ = gwVoxH( gwBP );
vec3 gwAlb = gwT.rgb * ( 0.93 + 0.14 * gwJ );
gwAlb *= mix( vec3( 1.0 ), vec3( 1.04, 1.0, 0.94 ), gwJ - 0.5 );
float gwAOv = mix( 0.5, 1.0, vVoxLight.x );
float gwSkyv = mix( 0.55, 1.0, vVoxLight.y );
diffuseColor.rgb *= gwAlb * gwAOv * gwSkyv;
float gwDepthM = uVox.z - vGwWorld.y;
if ( gwDepthM > 0.0 ) {
  vec2 cp = vGwWorld.xz * 0.8;
  float c1 = sin( cp.x * 1.3 + cp.y * 0.7 + uVox.w * 0.8 );
  float c2 = sin( cp.x * -0.9 + cp.y * 1.4 - uVox.w * 0.6 );
  float c3 = sin( cp.x * 2.1 - cp.y * 1.7 + uVox.w * 1.1 );
  float caus = pow( clamp( 1.0 - abs( c1 + c2 + c3 ) * 0.45, 0.0, 1.0 ), 5.0 );
  diffuseColor.rgb *= 1.0 + caus * 0.45 * exp( -gwDepthM * 0.5 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.03, 0.2, 0.32 ), 1.0 - exp( -gwDepthM * 0.05 ) );
}
`;

const FRAG_BEVEL = /* glsl */ `
#include <normal_fragment_maps>
{
  vec3 gwN0 = gwVN[ gwFace ];
  vec2 gwE2 = min( vVoxUv, 1.0 - vVoxUv );
  float gwBt = 1.0 - smoothstep( 0.0, uVox.x, min( gwE2.x, gwE2.y ) );
  vec2 gwD = vVoxUv - 0.5;
  vec3 gwOut = abs( gwD.x ) > abs( gwD.y ) ? gwVT[ gwFace ] * sign( gwD.x ) : gwVB[ gwFace ] * sign( gwD.y );
  vec3 gwNW = normalize( gwN0 + gwOut * ( gwBt * uVox.y ) );
  normal = normalize( ( viewMatrix * vec4( gwNW, 0.0 ) ).xyz );
  diffuseColor.rgb *= 1.0 - 0.12 * gwBt;
}
`;

const FRAG_EMIT = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += gwT.rgb * ( vVoxLight.z * 1.8 );
`;

function replaceOnce(src: string, needle: string, repl: string, label: string): string {
  if (!src.includes(needle)) {
    console.error(`[voxel] block shader patch failed: "${needle}" not found (${label})`);
    return src;
  }
  return src.replace(needle, repl);
}

export interface BlockMaterial {
  material: MeshToonMaterial;
  /** x bevel width (face fraction) . y bevel strength . z water surface y . w time */
  vox: Vector4;
}

export function makeBlockMaterial(ctx: Ctx, tiles: DataArrayTexture, waterY: number): BlockMaterial {
  const material = ctx.mats.toon({
    cls: 'stone',
    color: '#ffffff',
    paint: 0,
    wobble: 0,
    edge: 0,
    rim: 0.1,
    shade: 0.5,
    bands: 4,
    softness: 0.16,
    weather: true,
    cloudShadow: true,
    wind: { amp: 0.09, speed: 1.0, attr: true },
    name: 'voxel',
  });
  const vox = new Vector4(0.075, 0.55, waterY, 0);
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader: any, renderer: any) => {
    base.call(material, shader, renderer);
    shader.uniforms.uBlockTiles = { value: tiles };
    shader.uniforms.uVox = { value: vox };
    shader.vertexShader = replaceOnce(shader.vertexShader, 'void main() {', VERT_PARS + '\nvoid main() {', 'vertex main');
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <project_vertex>', VERT_MAIN, 'project_vertex');
    let fs: string = shader.fragmentShader;
    fs = replaceOnce(fs, 'void main() {', FRAG_PARS + '\nvoid main() {', 'fragment main');
    fs = replaceOnce(fs, '#include <color_fragment>', FRAG_COLOR, 'color_fragment');
    fs = replaceOnce(fs, '#include <normal_fragment_maps>', FRAG_BEVEL, 'normal_fragment_maps');
    fs = replaceOnce(fs, '#include <emissivemap_fragment>', FRAG_EMIT, 'emissivemap_fragment');
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => 'gw-voxel-1';
  return { material, vox };
}

const WATER_VERT = /* glsl */ `
attribute vec2 aWater;
varying vec3 vWorld;
varying vec2 vW;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vW = aWater;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec4 uRipples[8];
varying vec3 vWorld;
varying vec2 vW;
#include <gw_fog>
vec2 wg( vec2 p, vec2 d, float k, float sp, float amp ) {
  return d * ( cos( dot( p, d ) * k + uTime * sp ) * k * amp );
}
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );
  vec2 p = vWorld.xz;
  vec2 g = wg( p, normalize( vec2( 1.0, 0.35 ) ), 0.55, 1.0, 0.10 )
         + wg( p, normalize( vec2( -0.45, 1.0 ) ), 0.95, 1.4, 0.07 )
         + wg( p, normalize( vec2( 0.75, -0.7 ) ), 1.9, 1.9, 0.045 )
         + wg( p, normalize( vec2( -1.0, -0.25 ) ), 3.3, 2.6, 0.03 )
         + wg( p, normalize( vec2( 0.1, 1.0 ) ), 6.1, 3.4, 0.018 );
  g *= 1.0 / ( 1.0 + dist * 0.012 );
  for ( int i = 0; i < 8; i++ ) {
    vec4 r = uRipples[ i ];
    float age = uTime - r.z;
    if ( age > 0.0 && age < 3.5 ) {
      vec2 dv = p - r.xy;
      float rr = length( dv );
      float front = age * 2.0;
      float w = sin( ( rr - front ) * 8.0 ) * exp( -abs( rr - front ) * 2.5 ) * exp( -age * 0.8 ) * r.w;
      g += dv / max( rr, 1e-3 ) * w * 0.35;
    }
  }
  vec3 n = normalize( vec3( -g.x, 1.0, -g.y ) );
  float d = vW.x;
  vec3 body = mix( uShallow, uMid, smoothstep( 0.0, 2.4, d ) );
  body = mix( body, uDeep, smoothstep( 2.2, 9.0, d ) );
  float sunUp = clamp( uSunDir.y, 0.0, 1.0 );
  body *= mix( 0.32, 1.0, smoothstep( 0.0, 0.5, sunUp ) ) * mix( 1.0, 0.6, uNight );
  float ndv = clamp( dot( n, V ), 0.0, 1.0 );
  float fres = 0.03 + 0.97 * pow( 1.0 - ndv, 4.0 );
  vec3 R = reflect( -V, n );
  vec3 sky = mix( uSkyHorizon, uSkyZenith, pow( clamp( R.y, 0.0, 1.0 ), 0.55 ) );
  vec3 H = normalize( V + uSunDir );
  float nh = clamp( dot( n, H ), 0.0, 1.0 );
  float spec = pow( nh, 260.0 ) * 3.0 + pow( nh, 28.0 ) * 0.12;
  vec3 col = mix( body, sky, clamp( fres, 0.0, 1.0 ) );
  col += uSunColor * spec * ( 1.0 - uNight * 0.7 ) * step( 0.0, uSunDir.y );
  float fn = 0.5 + 0.25 * sin( p.x * 2.1 + uTime * 0.7 ) + 0.25 * sin( p.y * 2.7 - uTime * 0.9 + p.x * 0.6 );
  float foam = smoothstep( 0.30, 0.62, clamp( vW.y * ( 0.4 + 0.9 * fn ), 0.0, 1.0 ) + vW.y * 0.2 );
  col = mix( col, vec3( 0.95, 1.0, 0.98 ) * mix( 1.0, 0.6, uNight ), foam * 0.85 );
  float alpha = mix( 0.30, 0.92, smoothstep( 0.0, 2.8, d ) );
  alpha = max( alpha, fres );
  alpha = max( alpha, foam * 0.9 );
  col = gwFog( col, dist, vWorld.y, -V, uFogColor, uFogDensity, uSunDir, uSunColor, uNight );
  gl_FragColor = vec4( col, alpha );
}
`;

export interface WaterMaterial {
  material: ShaderMaterial;
  ripples: Vector4[];
}

export function makeWaterMaterial(ctx: Ctx): WaterMaterial {
  const u = ctx.uniforms;
  const ripples = Array.from({ length: 8 }, () => new Vector4(0, 0, -100, 0));
  const material = new ShaderMaterial({
    uniforms: {
      uTime: u.uTime,
      uSunDir: u.uSunDir,
      uSunColor: u.uSunColor,
      uSkyZenith: u.uSkyZenith,
      uSkyHorizon: u.uSkyHorizon,
      uFogColor: u.uFogColor,
      uFogDensity: u.uFogDensity,
      uNight: u.uNight,
      uShallow: { value: new Color('#6EE7D8') },
      uMid: { value: new Color('#2BB8D9') },
      uDeep: { value: new Color('#1E57B8') },
      uRipples: { value: ripples },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  });
  material.name = 'voxel.water';
  return { material, ripples };
}
