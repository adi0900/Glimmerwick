/**
 * PLACEHOLDER water: one big plane at sea level, shaded from the heightfield texture (depth gradient, shoreline
 * foam bands, sun glitter, sky fresnel, fog). The real water (waves, refraction, caustics, ripples) is `world`'s.
 */
import {
  Color,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { HeightField } from '../../engine/HeightField';
import type { SharedUniforms } from '../../engine/types';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
varying vec3 vWorld;
uniform sampler2D uHeight;
uniform vec4 uGrid;       // nx, nz, originX, originZ
uniform float uCell;
uniform float uSea;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
#include <gw_fbm>
#include <gw_toon>
#include <gw_fog>

float terrainHeight( vec2 xz ) {
  vec2 g = ( xz - uGrid.zw ) / uCell;
  if ( g.x < 0.0 || g.y < 0.0 || g.x > uGrid.x - 1.0 || g.y > uGrid.y - 1.0 ) return uSea - 14.0;
  ivec2 i0 = ivec2( floor( g ) );
  vec2 f = fract( g );
  ivec2 mx = ivec2( int( uGrid.x ) - 1, int( uGrid.y ) - 1 );
  float h00 = texelFetch( uHeight, clamp( i0, ivec2( 0 ), mx ), 0 ).r;
  float h10 = texelFetch( uHeight, clamp( i0 + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 ).r;
  float h01 = texelFetch( uHeight, clamp( i0 + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 ).r;
  float h11 = texelFetch( uHeight, clamp( i0 + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 ).r;
  return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );
}

void main() {
  vec2 xz = vWorld.xz;
  float depth = uSea - terrainHeight( xz );
  float dayK = 1.0 - uNight;

  // animated micro-normal (two drifting noise layers)
  vec2 q1 = xz * 0.55 + vec2( uTime * 0.18, uTime * 0.11 );
  vec2 q2 = xz * 1.35 - vec2( uTime * 0.13, uTime * 0.21 );
  float e = 0.06;
  float n1 = gwNoise2( q1 );
  vec2 g1 = vec2( gwNoise2( q1 + vec2( e, 0.0 ) ) - n1, gwNoise2( q1 + vec2( 0.0, e ) ) - n1 ) / e;
  float n2 = gwNoise2( q2 );
  vec2 g2 = vec2( gwNoise2( q2 + vec2( e, 0.0 ) ) - n2, gwNoise2( q2 + vec2( 0.0, e ) ) - n2 ) / e;
  vec3 N = normalize( vec3( -( g1.x * 0.16 + g2.x * 0.1 ), 1.0, -( g1.y * 0.16 + g2.y * 0.1 ) ) );
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 L = normalize( uSunDir );

  // depth gradient
  float t1 = smoothstep( 0.0, 1.8, depth );
  float t2 = smoothstep( 1.4, 9.0, depth );
  vec3 col = mix( mix( uShallow, uMid, t1 ), uDeep, t2 );
  col *= mix( vec3( 0.16, 0.2, 0.38 ), vec3( 1.0 ), dayK );

  // sky fresnel
  float fres = pow( 1.0 - max( dot( N, V ), 0.0 ), 4.0 );
  col = mix( col, uSkyHorizon * 0.9, fres * 0.42 );

  // sun glitter
  vec3 H = normalize( L + V );
  float nh = max( dot( N, H ), 0.0 );
  float glit = pow( nh, 260.0 ) * 6.0 + pow( nh, 22.0 ) * 0.12;
  col += uSunColor * glit * smoothstep( 0.0, 0.18, L.y ) * ( 0.6 + 0.4 * dayK );

  // shoreline foam: thin edge line + breathing second band, broken up by noise
  float wob = gwFbm2( xz * 0.4 + uTime * 0.05 ) * 0.22 + sin( xz.x * 0.7 + uTime * 1.2 ) * 0.04;
  float edge = 1.0 - smoothstep( 0.04, 0.34 + wob, depth );
  float breathe = 0.78 + 0.22 * sin( uTime * 0.8 + xz.x * 0.09 + xz.y * 0.07 );
  float dashes = smoothstep( 0.42, 0.66, gwFbm2( xz * 0.75 + vec2( 0.0, uTime * 0.04 ) ) );
  float band = ( 1.0 - smoothstep( 0.0, 0.12, abs( depth - breathe ) ) ) * 0.6 * dashes;
  float foam = clamp( edge + band, 0.0, 1.0 ) * step( 0.0, depth );
  col = mix( col, uFoam * mix( 0.55, 1.0, dayK ), foam );

  float alpha = mix( 0.4, 0.93, smoothstep( 0.0, 2.4, depth ) );
  alpha = max( alpha, foam );
  alpha *= smoothstep( -0.02, 0.06, depth ); // no water over dry land

  vec3 vd = vWorld - cameraPosition;
  float dist = length( vd );
  col = gwFog( col, dist, vWorld.y, vd / max( dist, 1e-4 ), uFogColor, uFogDensity, uSunDir, uSunColor, uNight );
  gl_FragColor = vec4( col, alpha );
}
`;

export interface Water {
  mesh: Mesh;
  /** re-upload the height texture after a terrain edit */
  refresh(world: HeightField): void;
  dispose(): void;
}

export function buildWater(world: HeightField, u: SharedUniforms): Water {
  const info = world.info!;
  const nx = world.nx;
  const nz = world.nz;
  const tex = new DataTexture(new Float32Array(world.data.subarray(0, nx * nz)), nx, nz, RedFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uHeight: { value: tex },
      uGrid: { value: new Vector4(nx, nz, info.origin_x + (world.centered ? info.cell * 0.5 : 0), info.origin_z + (world.centered ? info.cell * 0.5 : 0)) },
      uCell: { value: info.cell },
      uSea: { value: info.sea_level },
      uTime: u.uTime,
      uSunDir: u.uSunDir,
      uSunColor: u.uSunColor,
      uSkyHorizon: u.uSkyHorizon,
      uFogColor: u.uFogColor,
      uFogDensity: u.uFogDensity,
      uNight: u.uNight,
      uShallow: { value: new Color('#6EE7D8') },
      uMid: { value: new Color('#2BB8D9') },
      uDeep: { value: new Color('#1E78C8') },
      uFoam: { value: new Color('#F4FFFB') },
    },
  });
  mat.name = 'slice.water';
  const geo = new PlaneGeometry(2600, 2600, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, mat);
  mesh.name = 'slice.water';
  mesh.position.y = info.sea_level;
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return {
    mesh,
    refresh(w: HeightField) {
      (tex.image.data as Float32Array).set(w.data.subarray(0, nx * nz));
      tex.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
