/**
 * Voxel-actor material: ToonLit (look module) + the same shader bevel / AO language as the voxel world blocks, but for
 * micro-voxels: palette-slot colours (16 slots x 3 variants, uniform array, selected per instance), baked per-vertex AO,
 * emissive marking voxels that pulse per instance, and a bevel that fades out when a voxel covers only a few pixels.
 * Chained onBeforeCompile on top of ctx.mats.toon -- same anchors as modules/voxel/materials.ts.
 */
import { Color, Vector3, type MeshToonMaterial } from 'three';
import type { Ctx } from '../../engine/types';

export const SLOTS = 16;
export const VARIANTS = 3;

const VERT_PARS = /* glsl */ `
attribute vec2 aUv;
attribute vec4 aVox;
attribute float aFace;
attribute float aInstVar;
attribute float aInstGlow;
varying vec2 vCrUv;
varying vec4 vCrVox;
varying vec3 vCrT;
varying vec3 vCrB;
varying float vCrGlow;
flat varying float vCrVar;
const vec3 crT[6] = vec3[6]( vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), vec3( -1.0, 0.0, 0.0 ) );
const vec3 crB[6] = vec3[6]( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ) );
`;

const VERT_MAIN = /* glsl */ `
#include <project_vertex>
{
  vCrUv = aUv;
  vCrVox = aVox;
  vCrVar = aInstVar;
  vCrGlow = aInstGlow;
  int crF = int( aFace + 0.5 );
  vec3 crTq = crT[ crF ];
  vec3 crBq = crB[ crF ];
  #ifdef USE_INSTANCING
    crTq = mat3( instanceMatrix ) * crTq;
    crBq = mat3( instanceMatrix ) * crBq;
  #endif
  vCrT = normalize( normalMatrix * crTq );
  vCrB = normalize( normalMatrix * crBq );
}
`;

const FRAG_PARS = /* glsl */ `
uniform vec3 uCrPal[${SLOTS * VARIANTS}];
uniform vec4 uCrFx; // x bevel width . y bevel strength . z edge darkening . w emissive gain
uniform float uCrNight;
varying vec2 vCrUv;
varying vec4 vCrVox;
varying vec3 vCrT;
varying vec3 vCrB;
varying float vCrGlow;
flat varying float vCrVar;
`;

const FRAG_COLOR = /* glsl */ `
vec3 crAlb = uCrPal[ int( vCrVar + 0.5 ) * ${SLOTS} + int( vCrVox.x + 0.5 ) ] * vCrVox.y;
float crAO = mix( 0.58, 1.0, vCrVox.z );
diffuseColor.rgb = crAlb * crAO;
`;

const FRAG_BEVEL = /* glsl */ `
#include <normal_fragment_maps>
{
  vec2 crE = min( vCrUv, 1.0 - vCrUv );
  float crFw = max( fwidth( vCrUv.x ), fwidth( vCrUv.y ) );
  float crFade = 1.0 - smoothstep( 0.2, 0.55, crFw );
  float crBt = ( 1.0 - smoothstep( 0.0, uCrFx.x, min( crE.x, crE.y ) ) ) * crFade;
  vec2 crD = vCrUv - 0.5;
  vec3 crOut = abs( crD.x ) > abs( crD.y ) ? vCrT * sign( crD.x ) : vCrB * sign( crD.y );
  normal = normalize( normal + crOut * ( crBt * uCrFx.y ) );
  diffuseColor.rgb *= 1.0 - uCrFx.z * crBt;
}
`;

const FRAG_EMIT = /* glsl */ `
#include <emissivemap_fragment>
{
  float crEm = vCrVox.w;
  float crG = crEm >= 0.0 ? crEm * vCrGlow : -crEm;
  totalEmissiveRadiance += crAlb * ( crG * uCrFx.w * ( 1.0 + 2.6 * uCrNight ) + 0.1 * uCrNight );
}
`;

function replaceOnce(src: string, needle: string, repl: string, label: string): string {
  if (!src.includes(needle)) {
    console.error(`[creatures] shader patch failed: "${needle}" not found (${label})`);
    return src;
  }
  return src.replace(needle, repl);
}

export interface ActorMaterial {
  material: MeshToonMaterial;
  pal: Vector3[];
  fx: { value: { x: number; y: number; z: number; w: number } };
  setPalette(variant: number, hex: string[]): void;
}

export function makeActorMaterial(ctx: Ctx, palettes: string[][], name: string): ActorMaterial {
  const material = ctx.mats.toon({
    cls: 'clay',
    color: '#ffffff',
    paint: 0,
    wobble: 0,
    edge: 0,
    rim: 0.32,
    shade: 0.2,
    bands: 3,
    softness: 0.2,
    weather: true,
    cloudShadow: true,
    name,
  });
  const pal = Array.from({ length: SLOTS * VARIANTS }, () => new Vector3(1, 0, 1));
  const c = new Color();
  const setPalette = (variant: number, hex: string[]): void => {
    for (let s = 0; s < SLOTS; s++) {
      c.set(hex[s] ?? '#ff00ff');
      pal[variant * SLOTS + s]!.set(c.r, c.g, c.b);
    }
  };
  palettes.forEach((p, v) => setPalette(v, p));
  // unused variants fall back to variant 0
  for (let v = palettes.length; v < VARIANTS; v++) setPalette(v, palettes[0] ?? []);
  const fx = { value: { x: 0.16, y: 0.5, z: 0.08, w: 0.8 } } as unknown as ActorMaterial['fx'];
  const fxVec = (fx.value as unknown) as { x: number; y: number; z: number; w: number };
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader: any, renderer: any) => {
    base.call(material, shader, renderer);
    shader.uniforms.uCrPal = { value: pal };
    shader.uniforms.uCrFx = fx;
    shader.uniforms.uCrNight = ctx.uniforms.uNight;
    shader.vertexShader = replaceOnce(shader.vertexShader, 'void main() {', VERT_PARS + '\nvoid main() {', 'vertex main');
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <project_vertex>', VERT_MAIN, 'project_vertex');
    let fs: string = shader.fragmentShader;
    fs = replaceOnce(fs, 'void main() {', FRAG_PARS + '\nvoid main() {', 'fragment main');
    fs = replaceOnce(fs, '#include <color_fragment>', FRAG_COLOR, 'color_fragment');
    fs = replaceOnce(fs, '#include <normal_fragment_maps>', FRAG_BEVEL, 'normal_fragment_maps');
    fs = replaceOnce(fs, '#include <emissivemap_fragment>', FRAG_EMIT, 'emissivemap_fragment');
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => 'gw-voxactor-1';
  void fxVec;
  return { material, pal, fx, setPalette };
}
