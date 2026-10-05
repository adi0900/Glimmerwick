/**
 * Water (module `world`): sea plane + pond disc + stream ribbons, one shader.
 *
 * Depth comes from the sim's height grid (R32F texture, bilinear in-shader) so the colour gradient (shallow
 * turquoise -> deep blue), the soft shore fade and the animated foam bands all trace the *real* shoreline.
 * Each surface is flat/ramped at its own level (`vWorld.y`): the sea at `sea_level`, the pond at `pond.level`,
 * stream ribbons follow the monotone `level` profile the sim publishes in `world.info.water`.
 *
 *  - sky reflection with Fresnel, twinkling sun glitter, two drifting micro-normal layers + two swells
 *  - foam: three bands that run up the beach and recede (depth contours moving with time, lace-broken by noise)
 *    + a permanent lace line at the waterline; streams get whitewater where the bed drops
 *  - ripples: `addRipple(x, z, strength)` feeds `uRipple[8]` (expanding rings that perturb the normal)
 *  - transparent: the terrain shader paints the seabed + caustics underneath
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector4, type IUniform } from 'three';
import type { Ctx } from '../../engine/types';
import type { TerrainGrid, TerrainTextures } from './terrain';

const VERT = /* glsl */ `
varying vec3 vWorld;
#ifdef STREAM
attribute vec3 aFlow;
varying vec3 vFlow;
#endif
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  #ifdef STREAM
  vFlow = aFlow;
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
varying vec3 vWorld;
#ifdef STREAM
varying vec3 vFlow;
#endif
uniform sampler2D uHeight;
uniform vec4 uGrid;       // nx, nz, originX, originZ
uniform float uCell;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec4 uRipple[8];
uniform float uCalm;      // 1 = sea, <1 calmer (pond), >1 livelier (stream)
#include <gw_fbm>
#include <gw_toon>
#include <gw_fog>

float terrainH( vec2 xz ) {
  vec2 g = ( xz - uGrid.zw ) / uCell;
  if ( g.x < 0.0 || g.y < 0.0 || g.x > uGrid.x - 1.0 || g.y > uGrid.y - 1.0 ) return -14.0;
  ivec2 i0 = ivec2( floor( g ) );
  vec2 f = fract( g );
  ivec2 mx = ivec2( int( uGrid.x ) - 1, int( uGrid.y ) - 1 );
  float h00 = texelFetch( uHeight, clamp( i0, ivec2( 0 ), mx ), 0 ).r;
  float h10 = texelFetch( uHeight, clamp( i0 + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 ).r;
  float h01 = texelFetch( uHeight, clamp( i0 + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 ).r;
  float h11 = texelFetch( uHeight, clamp( i0 + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 ).r;
  return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );
}

float foamBands( float depth, vec2 xz, float t ) {
  float lace = gwFbm2( xz * 0.7 + vec2( t * 0.04, - t * 0.03 ) );
  float acc = 0.0;
  for ( int k = 0; k < 3; k ++ ) {
    float ph = fract( t * 0.085 + float( k ) * 0.3333 + 0.08 * sin( xz.x * 0.05 + xz.y * 0.04 + float( k ) ) );
    float front = 0.85 * ( 1.0 - ph * ph );
    float thick = 0.05 + 0.09 * ph;
    float band = 1.0 - smoothstep( 0.0, thick, abs( depth - front ) );
    float wash = ( 1.0 - smoothstep( front - 0.35 * ph, front, depth ) ) * step( depth, front ) * ph * 0.5;
    float life = sin( ph * 3.14159 );
    acc += ( band * 0.9 + wash ) * life * smoothstep( 0.30, 0.62, lace + 0.3 * ph );
  }
  float edge = 1.0 - smoothstep( 0.02, 0.2 + 0.1 * lace, depth );
  return clamp( acc * 0.95 + edge, 0.0, 1.0 );
}

void main() {
  vec2 xz = vWorld.xz;
  float depth = vWorld.y - terrainH( xz );
  if ( depth < -0.03 ) discard;
  float t = uTime;
  float dayK = 1.0 - uNight;
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 L = normalize( uSunDir );

  // ---- surface normal: two drifting noise layers + two swells + ripples
  #ifdef STREAM
    vec2 fq = vec2( vFlow.x * 1.3, vFlow.y * 0.55 - t * 1.05 );
    vec2 q1 = fq;
    vec2 q2 = fq * 2.3 + vec2( 3.1, - t * 0.7 );
  #else
    vec2 q1 = xz * 0.55 + vec2( t * 0.18, t * 0.11 );
    vec2 q2 = xz * 1.35 - vec2( t * 0.13, t * 0.21 );
  #endif
  float e = 0.06;
  float n1 = gwNoise2( q1 );
  vec2 g1 = vec2( gwNoise2( q1 + vec2( e, 0.0 ) ) - n1, gwNoise2( q1 + vec2( 0.0, e ) ) - n1 ) / e;
  float n2 = gwNoise2( q2 );
  vec2 g2 = vec2( gwNoise2( q2 + vec2( e, 0.0 ) ) - n2, gwNoise2( q2 + vec2( 0.0, e ) ) - n2 ) / e;
  vec2 slope = ( g1 * 0.16 + g2 * 0.10 ) * uCalm;
  vec2 d1 = vec2( 0.94, 0.33 );
  vec2 d2 = vec2( -0.41, 0.91 );
  float swell = smoothstep( 0.0, 1.4, depth ) * 0.7 + 0.3;
  slope += ( d1 * cos( dot( xz, d1 ) * 0.19 - t * 0.85 ) * 0.019 + d2 * cos( dot( xz, d2 ) * 0.31 - t * 1.05 ) * 0.014 ) * swell * uCalm;
  float ripF = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    vec4 r = uRipple[ i ];
    float age = t - r.z;
    if ( r.w > 0.0 && age > 0.0 && age < 3.5 ) {
      vec2 dv = xz - r.xy;
      float d = length( dv );
      float front = age * 2.2;
      float w = exp( - abs( d - front ) * 2.6 ) * exp( - age * 0.8 ) * r.w;
      slope += ( dv / max( d, 1e-3 ) ) * cos( ( d - front ) * 9.0 ) * w * 0.35;
      ripF += w;
    }
  }
  slope *= mix( 1.0, 0.2, smoothstep( 35.0, 420.0, length( vWorld - cameraPosition ) ) );
  vec3 N = normalize( vec3( - slope.x, 1.0, - slope.y ) );

  // ---- colour: depth gradient, tinted by day / night
  float t1 = smoothstep( 0.0, 2.0, depth );
  float t2 = smoothstep( 1.6, 9.0, depth );
  vec3 col = mix( mix( uShallow, uMid, t1 ), uDeep, t2 );
  col *= mix( vec3( 0.15, 0.19, 0.36 ), vec3( 1.0 ), dayK );

  // sky reflection (Fresnel)
  vec3 R = reflect( - V, N );
  vec3 sky = mix( uSkyHorizon, uSkyZenith, smoothstep( 0.0, 0.65, R.y ) );
  float fres = 0.04 + 0.96 * pow( 1.0 - max( dot( N, V ), 0.0 ), 5.0 );
  col = mix( col, sky, clamp( fres * 1.15, 0.0, 0.88 ) * mix( 0.55, 1.0, t1 ) );

  // sun glitter: tight highlight on the micro normals, twinkling
  vec3 H = normalize( L + V );
  float nh = max( dot( N, H ), 0.0 );
  float tw = 0.55 + 0.9 * gwNoise2( xz * 2.3 + vec2( t * 0.9, - t * 0.7 ) );
  float glit = ( pow( nh, 420.0 ) * 9.0 * tw + pow( nh, 36.0 ) * 0.16 ) * smoothstep( 0.0, 0.2, L.y );
  col += uSunColor * glit * ( 0.55 + 0.45 * dayK ) * smoothstep( 0.0, 0.5, depth + 0.15 ) * ( 1.0 - 0.75 * smoothstep( 120.0, 700.0, length( vWorld - cameraPosition ) ) );

  // foam
  #ifdef STREAM
    float foam = 1.0 - smoothstep( 0.02, 0.16 + 0.1 * gwFbm2( xz * 1.1 ), depth );
    foam += smoothstep( 0.012, 0.05, vFlow.z ) * smoothstep( 0.42, 0.7, gwFbm2( vec2( vFlow.x * 2.2, vFlow.y * 0.9 - t * 1.6 ) ) ) * 0.9;
    foam = clamp( foam, 0.0, 1.0 );
  #else
    float foam = foamBands( depth, xz, t ) * smoothstep( 0.0, 0.1, depth + 0.02 );
  #endif
  foam = clamp( foam + ripF * 0.35, 0.0, 1.0 );
  #ifdef INLAND
    foam *= 0.5;
  #endif
  col = mix( col, uFoam * mix( 0.55, 1.0, dayK ), foam * 0.95 );

  // translucency: the seabed shows through shallow water
  #ifdef INLAND
    float alpha = mix( 0.5, 0.93, smoothstep( 0.0, 0.8, depth ) );
  #else
    float alpha = mix( 0.28, 0.96, smoothstep( 0.0, 3.2, depth ) );
  #endif
  alpha = max( alpha, foam );
  alpha *= smoothstep( -0.02, 0.05, depth );

  vec3 vd = vWorld - cameraPosition;
  float dist = length( vd );
  col = gwFog( col, dist, vWorld.y, vd / max( dist, 1e-4 ), uFogColor, uFogDensity, uSunDir, uSunColor, uNight );
  gl_FragColor = vec4( col, alpha );
}
`;

export interface WaterSystem {
  group: Group;
  addRipple(x: number, z: number, strength: number): void;
  update(): void;
  dispose(): void;
}

interface WaterInfo {
  pond?: { x: number; z: number; rx: number; rz: number; rot: number; level: number };
  streams?: { pts: number[][] }[];
}

export function buildWater(ctx: Ctx, g: TerrainGrid, tex: TerrainTextures, water: WaterInfo | undefined): WaterSystem {
  const u = ctx.uniforms;
  const ripples: Vector4[] = [];
  for (let i = 0; i < 8; i++) ripples.push(new Vector4(0, 0, -100, 0));
  let ripIdx = 0;
  const shared: Record<string, IUniform> = {
    uHeight: { value: tex.height },
    uGrid: { value: new Vector4(g.nx, g.nz, g.ox, g.oz) },
    uCell: { value: g.cell },
    uTime: u.uTime,
    uSunDir: u.uSunDir,
    uSunColor: u.uSunColor,
    uSkyHorizon: u.uSkyHorizon,
    uSkyZenith: u.uSkyZenith,
    uFogColor: u.uFogColor,
    uFogDensity: u.uFogDensity,
    uNight: u.uNight,
    uFoam: { value: new Color('#F4FFFB') },
    uRipple: { value: ripples },
  };
  const mk = (name: string, defines: Record<string, string>, shallow: string, mid: string, deep: string, calm: number): ShaderMaterial => {
    const m = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      defines,
      uniforms: { ...shared, uShallow: { value: new Color(shallow) }, uMid: { value: new Color(mid) }, uDeep: { value: new Color(deep) }, uCalm: { value: calm } },
    });
    m.name = name;
    return m;
  };
  const group = new Group();
  group.name = 'world.water';
  const geos: BufferGeometry[] = [];
  const mats: ShaderMaterial[] = [];

  // ---- sea
  const seaMat = mk('world.water.sea', {}, '#6EE7D8', '#2BB8D9', '#2563C7', 1.0);
  const seaGeo = new PlaneGeometry(3600, 3600, 1, 1);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new Mesh(seaGeo, seaMat);
  sea.position.y = g.sea;
  sea.renderOrder = 10;
  sea.frustumCulled = false;
  sea.name = 'world.water.sea';
  group.add(sea);
  geos.push(seaGeo);
  mats.push(seaMat);

  // ---- pond
  const pond = water?.pond;
  if (pond) {
    const segs = 72;
    const pos: number[] = [pond.x, pond.level, pond.z];
    const idx: number[] = [];
    const cs = Math.cos(pond.rot);
    const sn = Math.sin(pond.rot);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const lx = Math.cos(a) * pond.rx * 1.5;
      const lz = Math.sin(a) * pond.rz * 1.5;
      pos.push(pond.x + lx * cs - lz * sn, pond.level, pond.z + lx * sn + lz * cs);
      idx.push(0, 1 + ((i + 1) % segs), 1 + i);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    const mat = mk('world.water.pond', { INLAND: '' }, '#8FEBCF', '#45BFB6', '#2C8BA0', 0.42);
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 11;
    mesh.frustumCulled = false;
    mesh.name = 'world.water.pond';
    group.add(mesh);
    geos.push(geo);
    mats.push(mat);
  }

  // ---- streams (ribbons along the polylines; y follows the published water level)
  const streamMat = mk('world.water.stream', { INLAND: '', STREAM: '' }, '#8FEBCF', '#4CC4B8', '#2F95A8', 1.15);
  mats.push(streamMat);
  for (const st of water?.streams ?? []) {
    const p = st.pts;
    if (p.length < 2) continue;
    const pos: number[] = [];
    const flow: number[] = [];
    const idx: number[] = [];
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(i - 1, 0)]!;
      const b = p[Math.min(i + 1, p.length - 1)]!;
      const dx = b[0]! - a[0]!;
      const dz = b[1]! - a[1]!;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      if (i > 0) s += Math.hypot(p[i]![0]! - p[i - 1]![0]!, p[i]![1]! - p[i - 1]![1]!);
      const w = p[i]![2]! + 1.0;
      const y = p[i]![3]!;
      const slope = Math.max(0, (a[3]! - b[3]!) / l);
      pos.push(p[i]![0]! + nx * w, y, p[i]![1]! + nz * w, p[i]![0]! - nx * w, y, p[i]![1]! - nz * w);
      flow.push(-1, s, slope, 1, s, slope);
      if (i < p.length - 1) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aFlow', new BufferAttribute(new Float32Array(flow), 3));
    geo.setIndex(idx);
    const mesh = new Mesh(geo, streamMat);
    mesh.renderOrder = 11;
    mesh.frustumCulled = false;
    mesh.name = 'world.water.stream';
    group.add(mesh);
    geos.push(geo);
  }

  return {
    group,
    addRipple(x: number, z: number, strength: number) {
      const r = ripples[ripIdx]!;
      ripIdx = (ripIdx + 1) % ripples.length;
      r.set(x, z, u.uTime.value as number, Math.min(Math.max(strength, 0.05), 2));
    },
    update() {
      const now = u.uTime.value as number;
      for (const r of ripples) if (r.w > 0 && now - r.z > 3.6) r.w = 0;
    },
    dispose() {
      for (const gm of geos) gm.dispose();
      for (const m of mats) m.dispose();
      group.removeFromParent();
    },
  };
}
