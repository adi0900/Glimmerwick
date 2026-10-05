/**
 * Terrain (module `world`): chunked LOD meshes + a painterly splat shader.
 *
 *  - Data: the sim's `world.height` / `world.biome` grids are copied once per world version, turned into
 *    (a) an R32F height texture (water depth), (b) two RGBA8 splat textures (8 ground classes @ 1 m, box-filtered
 *    over 2.5 m so the shader can re-sharpen them with a noise-warped lookup => organic borders, no grid steps)
 *    and (c) a cavity/lip texture (AO-ish darkening at cliff bases, warm lift on rounded lips).
 *  - Meshes: 32 m chunks, 4 LODs (0.5 / 1 / 2 / 4 m), skirts hide LOD cracks, normals come from the global
 *    heightfield (no chunk seams), chunks entirely under deep sea are skipped. Geometry is built lazily within a
 *    per-frame time budget, nearest first.
 *  - Shading: ToonLit "ground" material (cool shadows, cloud shadows, paint layer, fog) patched with the splat
 *    albedo (grass / forest floor / highland / flower meadow / sand / dirt / rock / mud + seabed with caustics),
 *    world-space 3D noise for rock strata (no UVs => no stretching, no tiling), wet sand near the waterline and
 *    softened toon banding (no contour stripes on gentle slopes).
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  Group,
  LinearFilter,
  Mesh,
  NearestFilter,
  RGBAFormat,
  RedFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  Vector4,
  type MeshToonMaterial,
} from 'three';
import type { HeightField } from '../../engine/HeightField';
import type { Ctx } from '../../engine/types';

export interface TerrainGrid {
  nx: number;
  nz: number;
  cell: number;
  /** world position of sample (0, 0) */
  ox: number;
  oz: number;
  heights: Float32Array;
  biomes: Uint8Array;
  sea: number;
  /** cells per chunk edge */
  chunk: number;
}

export interface TerrainTextures {
  height: DataTexture;
  splatA: DataTexture;
  splatB: DataTexture;
  data: DataTexture;
  /** metres per splat texel */
  texel: number;
  /** splat texture width/height in texels */
  tw: number;
  th: number;
  dispose(): void;
}

export function readGrid(world: HeightField): TerrainGrid | null {
  const info = world.info;
  if (!info || !world.ready) return null;
  const cell = info.cell || 1;
  const off = world.centered ? 0.5 * cell : 0;
  const n = world.nx * world.nz;
  return {
    nx: world.nx,
    nz: world.nz,
    cell,
    ox: info.origin_x + off,
    oz: info.origin_z + off,
    heights: new Float32Array(world.data.subarray(0, n)),
    biomes: new Uint8Array(world.biomes.subarray(0, n)),
    sea: info.sea_level,
    chunk: Math.max(8, Math.round(info.chunk || 32)),
  };
}

// ------------------------------------------------------------------------------------------------- data textures

export function buildTextures(g: TerrainGrid): TerrainTextures {
  const { nx, nz, cell, heights: H, biomes: B } = g;
  const step = Math.max(1, Math.round(1 / cell)); // fine cells per 1 m splat texel
  const texel = step * cell;
  const tw = Math.floor((nx - 1) / step) + 1;
  const th = Math.floor((nz - 1) / step) + 1;
  const rad = Math.max(1, Math.ceil(1.1 / cell)); // box window radius (fine cells) ~ 2.5 m wide for 0.5 m cells

  const A = new Uint8Array(tw * th * 4);
  const Bt = new Uint8Array(tw * th * 4);
  const D = new Uint8Array(tw * th * 4);
  const cnt = new Float32Array(16);
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      cnt.fill(0);
      const ci = i * step;
      const cj = j * step;
      let n = 0;
      for (let dj = -rad; dj <= rad; dj++) {
        const jj = Math.min(Math.max(cj + dj, 0), nz - 1);
        for (let di = -rad; di <= rad; di++) {
          const ii = Math.min(Math.max(ci + di, 0), nx - 1);
          cnt[B[jj * nx + ii]! & 15]!++;
          n++;
        }
      }
      const k = (j * tw + i) * 4;
      const inv = 255 / n;
      // A: grass(3) + half the clearing(10), forest(4), highland(5), flower meadow(9)
      A[k] = Math.min(255, (cnt[3]! + cnt[11]! + 0.5 * cnt[10]!) * inv);
      A[k + 1] = Math.min(255, cnt[4]! * inv);
      A[k + 2] = Math.min(255, cnt[5]! * inv);
      A[k + 3] = Math.min(255, cnt[9]! * inv);
      // B: sand + seabed (0,1,2), dirt (7 + half the clearing), cliff rock (6), pond bank / mud (8)
      Bt[k] = Math.min(255, (cnt[0]! + cnt[1]! + cnt[2]!) * inv);
      Bt[k + 1] = Math.min(255, (cnt[7]! + 0.5 * cnt[10]!) * inv);
      Bt[k + 2] = Math.min(255, cnt[6]! * inv);
      Bt[k + 3] = Math.min(255, cnt[8]! * inv);

      // cavity (AO) + convex lip from ring means at 2 / 4 / 7 m
      const h0 = H[cj * nx + ci]!;
      let occ = 0;
      let lip = 0;
      if (h0 > g.sea - 0.5) {
        for (let r = 0; r < 3; r++) {
          const dist = [2, 4, 7][r]!;
          const rr = Math.max(1, Math.round(dist / cell));
          let sum = 0;
          for (let a = 0; a < 8; a++) {
            const ang = a * 0.7853982;
            const ii = Math.min(Math.max(ci + Math.round(Math.cos(ang) * rr), 0), nx - 1);
            const jj = Math.min(Math.max(cj + Math.round(Math.sin(ang) * rr), 0), nz - 1);
            sum += H[jj * nx + ii]!;
          }
          const d = sum / 8 - h0; // > 0: surroundings higher (concave)
          const w = [0.5, 0.35, 0.25][r]!;
          occ += w * Math.max(0, d - 0.12 * dist);
          lip += w * Math.max(0, -d - 0.1 * dist);
        }
      }
      D[k] = Math.round(255 * (1 - Math.min(1, occ / 2.2)));
      D[k + 1] = Math.round(255 * Math.min(1, lip / 1.8));
      D[k + 2] = 0;
      D[k + 3] = 255;
    }
  }
  const mk = (data: Uint8Array): DataTexture => {
    const t = new DataTexture(data, tw, th, RGBAFormat, UnsignedByteType);
    t.magFilter = t.minFilter = LinearFilter;
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const height = new DataTexture(g.heights, nx, nz, RedFormat, FloatType);
  height.magFilter = height.minFilter = NearestFilter;
  height.wrapS = height.wrapT = ClampToEdgeWrapping;
  height.generateMipmaps = false;
  height.needsUpdate = true;
  const splatA = mk(A);
  const splatB = mk(Bt);
  const data = mk(D);
  return {
    height,
    splatA,
    splatB,
    data,
    texel,
    tw,
    th,
    dispose() {
      height.dispose();
      splatA.dispose();
      splatB.dispose();
      data.dispose();
    },
  };
}

// ------------------------------------------------------------------------------------------------- chunk geometry

function chunkGeometry(g: TerrainGrid, cx: number, cz: number, lod: number): BufferGeometry {
  const stride = 1 << lod;
  const cc = g.chunk;
  const n = Math.max(1, Math.floor(cc / stride)); // quads per side
  const vn = n + 1;
  const baseI = cx * cc;
  const baseJ = cz * cc;
  const maxI = g.nx - 1;
  const maxJ = g.nz - 1;
  const H = g.heights;
  const nxs = g.nx;
  const hAt = (i: number, j: number): number => H[Math.min(Math.max(j, 0), maxJ) * nxs + Math.min(Math.max(i, 0), maxI)]!;
  const skirt = 0.5 + stride * g.cell * 0.6;
  const nTop = vn * vn;
  const total = nTop + vn * 4;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  const inv2 = 1 / (2 * stride * g.cell);
  for (let j = 0; j < vn; j++) {
    for (let i = 0; i < vn; i++) {
      const gi = baseI + i * stride;
      const gj = baseJ + j * stride;
      const y = hAt(gi, gj);
      const k = (j * vn + i) * 3;
      pos[k] = g.ox + Math.min(gi, maxI) * g.cell;
      pos[k + 1] = y;
      pos[k + 2] = g.oz + Math.min(gj, maxJ) * g.cell;
      const sx = (hAt(gi + stride, gj) - hAt(gi - stride, gj)) * inv2;
      const sz = (hAt(gi, gj + stride) - hAt(gi, gj - stride)) * inv2;
      const il = 1 / Math.hypot(sx, 1, sz);
      nor[k] = -sx * il;
      nor[k + 1] = il;
      nor[k + 2] = -sz * il;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // skirts: copies of the four border rows, dropped by `skirt`
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < vn; k++) {
    edges[0]!.push(k); // north (j = 0)
    edges[1]!.push(n * vn + k); // south
    edges[2]!.push(k * vn); // west
    edges[3]!.push(k * vn + n); // east
  }
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < vn; k++) {
      const src = edges[e]![k]! * 3;
      const dst = (nTop + e * vn + k) * 3;
      pos[dst] = pos[src]!;
      pos[dst + 1] = pos[src + 1]! - skirt;
      pos[dst + 2] = pos[src + 2]!;
      nor[dst] = nor[src]!;
      nor[dst + 1] = nor[src + 1]!;
      nor[dst + 2] = nor[src + 2]!;
    }
  }
  const idx = new Uint16Array(n * n * 6 + 4 * n * 12);
  let q = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * vn + i;
      const b = a + 1;
      const c = a + vn;
      const d = c + 1;
      const ha = pos[a * 3 + 1]!;
      const hb = pos[b * 3 + 1]!;
      const hc = pos[c * 3 + 1]!;
      const hd = pos[d * 3 + 1]!;
      if (Math.abs(ha - hd) < Math.abs(hb - hc)) {
        idx[q++] = a; idx[q++] = c; idx[q++] = d;
        idx[q++] = a; idx[q++] = d; idx[q++] = b;
      } else {
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
  }
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < n; k++) {
      const t0 = edges[e]![k]!;
      const t1 = edges[e]![k + 1]!;
      const b0 = nTop + e * vn + k;
      const b1 = b0 + 1;
      idx[q++] = t0; idx[q++] = b0; idx[q++] = t1;
      idx[q++] = t1; idx[q++] = b0; idx[q++] = b1;
      idx[q++] = t0; idx[q++] = t1; idx[q++] = b0;
      idx[q++] = t1; idx[q++] = b1; idx[q++] = b0;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  const x0 = g.ox + baseI * g.cell;
  const z0 = g.oz + baseJ * g.cell;
  const box = new Box3(new Vector3(x0, minY - skirt, z0), new Vector3(x0 + cc * g.cell, maxY, z0 + cc * g.cell));
  geo.boundingBox = box;
  geo.boundingSphere = box.getBoundingSphere(new Sphere());
  return geo;
}

// ------------------------------------------------------------------------------------------------- shader

const PAL_HEX = [
  '#9BE564', // 0 meadow light
  '#5CC95A', // 1 meadow mid
  '#2E9E6B', // 2 meadow shadow (teal)
  '#D6E063', // 3 dry grass
  '#3E8E5A', // 4 forest floor
  '#F6E2B3', // 5 sand
  '#D9B98A', // 6 wet sand
  '#B8A9C9', // 7 rock lavender
  '#C9A98C', // 8 cliff warm
  '#6C5B7B', // 9 rock crevice
  '#D2AE80', // 10 dirt / path
  '#A58B5E', // 11 mud
  '#8FD65A', // 12 highland
  '#C9B27C', // 13 clearing dirt
  '#FF8FB8', // 14 flower pink
  '#FFD84A', // 15 flower yellow
  '#FFF3E0', // 16 flower white
  '#B49CFF', // 17 flower lavender
  '#FF9A5A', // 18 flower orange
  '#6AB8FF', // 19 flower blue
  '#3F86A6', // 20 seabed deep
  '#E8CE96', // 21 seabed shallow
  '#B5D66B', // 22 clearing lawn
  '#7A4A2B', // 23 wood dark (litter)
];

const FRAG_PARS = /* glsl */ `
uniform sampler2D tSplatA;
uniform sampler2D tSplatB;
uniform sampler2D tTData;
uniform vec4 uTerr;          // originX, originZ, texel (m), texture size (texels)
uniform float uSeaY;
uniform float uTerrainSmooth;
uniform vec3 uPal[24];
#include <gw_worley>

float trFade( float fp, float freq ) { return 1.0 - smoothstep( 0.30, 0.78, fp * freq ); }

vec3 trGrass( vec2 p, float fp ) {
  float n1 = gwFbm2( p * 0.040 + 3.1 );
  float n2 = gwFbm2( p * 0.17 + 11.7 );
  float t = clamp( 0.16 + n1 * 0.95 + ( n2 - 0.5 ) * 0.45, 0.0, 1.0 );
  vec3 c = mix( uPal[2], uPal[1], smoothstep( 0.10, 0.5, t ) );
  c = mix( c, uPal[0], smoothstep( 0.48, 0.92, t ) );
  c = mix( c, uPal[3], smoothstep( 0.60, 0.82, gwFbm2( p * 0.021 + 40.0 ) ) * 0.5 );
  float fd = trFade( fp, 2.2 );
  vec2 w = gwWorley2( p * 2.1 );
  c *= 1.0 + ( 0.5 - w.x ) * 0.24 * fd;
  c = mix( c, uPal[0] * 1.06, smoothstep( 0.62, 0.9, gwNoise2( p * 6.5 ) ) * 0.2 * fd );
  return c;
}

vec3 trForest( vec2 p, float fp ) {
  float n1 = gwFbm2( p * 0.07 + 7.7 );
  vec3 c = mix( uPal[4] * 0.8, uPal[2] * 0.95, smoothstep( 0.25, 0.7, n1 ) );
  float fd = trFade( fp, 2.0 );
  float litter = smoothstep( 0.56, 0.78, gwFbm2( p * 0.85 + 21.0 ) );
  c = mix( c, uPal[23] * 0.9 + uPal[11] * 0.25, litter * 0.55 * fd );
  float dap = smoothstep( 0.52, 0.75, gwFbm2( p * 0.2 + 2.2 ) );
  c *= 0.84 + 0.32 * dap;
  c = mix( c, uPal[0] * 0.7, smoothstep( 0.7, 0.9, gwNoise2( p * 5.0 ) ) * 0.18 * fd );
  return c;
}

vec3 trHighland( vec2 p, float fp ) {
  float n = gwFbm2( p * 0.05 + 33.0 );
  vec3 c = mix( uPal[12], uPal[3], smoothstep( 0.35, 0.8, n ) * 0.65 );
  c = mix( c, uPal[0], ( 1.0 - smoothstep( 0.2, 0.5, gwFbm2( p * 0.13 + 4.0 ) ) ) * 0.3 );
  float streak = gwNoise2( vec2( p.x * 0.55 + p.y * 0.2, p.y * 0.07 ) );
  c *= 0.93 + 0.14 * streak * trFade( fp, 1.2 );
  return c;
}

vec3 trFlowers( vec2 p, float fp ) {
  vec3 c = mix( trGrass( p, fp ), uPal[0], 0.35 );
  float fd = trFade( fp, 3.0 );
  vec2 q = p * 1.15;
  vec2 ci = floor( q );
  vec2 cf = fract( q ) - 0.5;
  float h = gwHash12( ci );
  vec2 off = ( gwHash22( ci + 3.7 ) - 0.5 ) * 0.55;
  float dab = smoothstep( 0.2, 0.09, length( cf - off ) ) * step( 0.28, h );
  vec3 fc = uPal[ 14 + int( fract( h * 7.3 ) * 5.99 ) ];
  c = mix( c, fc, dab * 0.85 * fd );
  return c;
}

vec3 trSand( vec2 p, float fp ) {
  vec3 c = mix( uPal[5], uPal[5] * vec3( 1.03, 0.97, 0.88 ), gwFbm2( p * 0.06 + 2.0 ) );
  float fd = trFade( fp, 1.6 );
  float rip = gwNoise2( vec2( p.x * 0.45 + gwNoise2( p * 0.09 ) * 3.5, p.y * 1.9 ) );
  c *= 1.0 - 0.07 * smoothstep( 0.42, 0.8, rip ) * fd;
  c = mix( c, uPal[5] * 0.82, step( 0.94, gwNoise2( p * 8.5 + 4.0 ) ) * 0.5 * fd );
  return c;
}

vec3 trDirt( vec2 p, float fp ) {
  vec3 c = mix( uPal[10], uPal[13], gwFbm2( p * 0.12 + 5.0 ) );
  float fd = trFade( fp, 2.0 );
  c *= 0.93 + 0.13 * gwNoise2( p * 1.3 );
  c = mix( c, uPal[8] * 0.92, smoothstep( 0.7, 0.86, gwNoise2( p * 5.5 + 3.0 ) ) * 0.4 * fd );
  return c;
}

vec3 trMud( vec2 p, float fp ) {
  vec3 c = mix( uPal[11] * 0.78, uPal[2] * 0.72, smoothstep( 0.3, 0.75, gwFbm2( p * 0.25 + 9.0 ) ) );
  c *= 0.9 + 0.2 * gwNoise2( p * 2.2 );
  return c;
}

vec3 trRock( vec3 p, vec3 n, float fp ) {
  float warp = gwFbm3( p * vec3( 0.11, 0.05, 0.11 ) + 7.0 );
  float strata = gwNoise3( vec3( p.x * 0.05, p.y * 0.62 + warp * 3.2, p.z * 0.05 ) );
  float band = smoothstep( 0.32, 0.68, strata );
  vec3 c = mix( uPal[8], uPal[7], band * 0.7 );
  float steep = 1.0 - n.y;
  float streak = gwNoise3( vec3( p.x * 0.8, p.y * 0.1, p.z * 0.8 ) );
  c = mix( c, uPal[9], smoothstep( 0.55, 0.85, streak ) * 0.4 * steep );
  float fd = trFade( fp, 1.5 );
  c *= 0.9 + 0.2 * mix( 0.5, gwNoise3( p * 1.6 ), fd );
  float moss = smoothstep( 0.62, 0.9, n.y ) * smoothstep( 0.5, 0.72, gwFbm3( p * 0.33 ) );
  c = mix( c, uPal[4] * 1.2, moss * 0.5 );
  return c;
}

float trCaustic( vec2 p, float t ) {
  vec2 a = p * 0.46 + vec2( t * 0.07, t * 0.05 );
  vec2 b = p * 0.71 - vec2( t * 0.05, -t * 0.08 );
  float c1 = 1.0 - clamp( gwWorley2( a ).x * 1.25, 0.0, 1.0 );
  float c2 = 1.0 - clamp( gwWorley2( b ).x * 1.25, 0.0, 1.0 );
  return pow( c1 * c2, 1.7 ) * 4.0;
}
`;

const FRAG_ALBEDO = /* glsl */ `
{
  vec3 trP = vGwWorld;
  vec2 trXZ = trP.xz;
  vec3 trN = normalize( inverseTransformDirection( normalize( vNormal ), viewMatrix ) );
  float trFp = length( fwidth( trP ) );
  vec2 trWarp = ( vec2( gwNoise2( trXZ * 0.42 ), gwNoise2( trXZ * 0.42 + 19.7 ) ) - 0.5 ) * 2.6;
  vec2 trUV = ( ( trXZ + trWarp - uTerr.xy ) / uTerr.z + 0.5 ) / uTerr.w;
  vec4 trA = smoothstep( 0.2, 0.8, texture2D( tSplatA, trUV ) );
  vec4 trB = smoothstep( 0.2, 0.8, texture2D( tSplatB, trUV ) );
  vec4 trD = texture2D( tTData, ( ( trXZ - uTerr.xy ) / uTerr.z + 0.5 ) / uTerr.w );
  float trTot = dot( trA, vec4( 1.0 ) ) + dot( trB, vec4( 1.0 ) ) + 1e-3;
  trA /= trTot;
  trB /= trTot;
  float trDepth = uSeaY - trP.y;

  vec3 trG = vec3( 0.0 );
  if ( trA.x > 0.01 ) trG += trA.x * trGrass( trXZ, trFp );
  if ( trA.y > 0.01 ) trG += trA.y * trForest( trXZ, trFp );
  if ( trA.z > 0.01 ) trG += trA.z * trHighland( trXZ, trFp );
  if ( trA.w > 0.01 ) trG += trA.w * trFlowers( trXZ, trFp );
  if ( trB.x > 0.01 ) trG += trB.x * trSand( trXZ, trFp );
  if ( trB.y > 0.01 ) trG += trB.y * trDirt( trXZ, trFp );
  if ( trB.w > 0.01 ) trG += trB.w * trMud( trXZ, trFp );
  trG /= max( 1.0 - trB.z, 0.02 );
  // trampled lawn: the clearing is half grass / half dirt in the splat; tint it toward the lawn colour
  trG = mix( trG, uPal[22], 0.18 * trB.y * trA.x * 4.0 );

  // wet sand / dirt just above the waterline (breathing with the tide), darker + a touch more saturated
  float trAbove = trP.y - uSeaY;
  float trWet = ( 1.0 - smoothstep( 0.0, 0.5 + 0.1 * sin( uTime * 0.35 + trXZ.x * 0.02 ), trAbove ) ) * step( 0.0, trAbove );
  trG = mix( trG, uPal[6] * vec3( 0.86, 0.8, 0.78 ), trWet * clamp( trB.x + 0.6 * trB.y, 0.0, 1.0 ) );

  // seabed seen through the water
  if ( trDepth > 0.0 ) {
    vec3 sb = mix( trSand( trXZ, trFp ) * 0.95, uPal[20], smoothstep( 0.2, 7.0, trDepth ) );
    trG = mix( trG, sb, smoothstep( 0.0, 0.12, trDepth ) );
  }

  // rock: biome cliff cells + steep faces, ragged edge so grass tufts bleed over the lip
  float trSlope = 1.0 - smoothstep( 0.60, 0.80, trN.y + ( gwNoise2( trXZ * 0.3 ) - 0.5 ) * 0.1 );
  float trRockW = max( trB.z, trSlope );
  trRockW = smoothstep( 0.32, 0.68, trRockW + ( gwNoise2( trXZ * 2.3 + 8.0 ) - 0.5 ) * 0.34 * trFade( trFp, 1.6 ) );
  vec3 trCol = trG;
  if ( trRockW > 0.01 ) trCol = mix( trG, trRock( trP, trN, trFp ), trRockW );
  if ( trDepth > 0.0 ) trCol = mix( trCol, mix( trCol, uPal[20], 0.45 ), smoothstep( 0.0, 6.0, trDepth ) * trRockW );

  // cavity AO (violet crevices) + warm lip highlight
  trCol = mix( trCol * vec3( 0.60, 0.58, 0.80 ), trCol, trD.r );
  trCol = mix( trCol, trCol * vec3( 1.18, 1.1, 0.92 ) + 0.012, trD.g * ( 0.35 + 0.65 * trRockW ) );

  // caustics dance on the shallow seabed
  if ( trDepth > 0.12 && trDepth < 6.5 ) {
    float cs = trCaustic( trXZ, uTime ) * smoothstep( 0.12, 0.7, trDepth ) * ( 1.0 - smoothstep( 2.5, 6.5, trDepth ) );
    trCol += uSunColor * cs * 0.16 * ( 1.0 - uNight );
  }

  // macro variation + altitude warmth
  float trMacro = gwFbm2( trXZ * 0.011 + 5.0 );
  trCol = gwHueShift( trCol, ( trMacro - 0.5 ) * 0.2 ) * ( 0.94 + 0.12 * gwFbm2( trXZ * 0.006 + 60.0 ) );
  trCol = mix( trCol, trCol * vec3( 1.06, 1.03, 0.9 ), smoothstep( 7.0, 20.0, trP.y ) );
  diffuseColor.rgb = trCol;
}
`;

export interface TerrainMaterial {
  material: MeshToonMaterial;
  uniforms: Record<string, { value: unknown }>;
}

export function makeTerrainMaterial(ctx: Ctx, g: TerrainGrid, tex: TerrainTextures): TerrainMaterial {
  const mat = ctx.mats.ground({ vertexColors: false, paint: 0.55, paintScale: 1.5, shade: 0.85, softness: 0.14, name: 'world.terrain' });
  const uniforms = {
    tSplatA: { value: tex.splatA },
    tSplatB: { value: tex.splatB },
    tTData: { value: tex.data },
    uTerr: { value: new Vector4(g.ox, g.oz, tex.texel, tex.tw) },
    uSeaY: { value: g.sea },
    uTerrainSmooth: { value: 0.8 },
    uPal: { value: PAL_HEX.map((h) => new Color(h)) },
  };
  // vec4 uniform: three accepts any {x,y,z,w}
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    let fs = shader.fragmentShader;
    const patch = (needle: string, repl: string, label: string): void => {
      if (!fs.includes(needle)) {
        console.error(`[world] terrain shader patch failed: ${label}`);
        return;
      }
      fs = fs.replace(needle, repl);
    };
    patch('#include <gw_fog>', '#include <gw_fog>\n' + FRAG_PARS, 'pars');
    patch('#include <color_fragment>', FRAG_ALBEDO, 'albedo');
    patch('ramp = mix( ramp, saturate( ndl ), 0.12 );', 'ramp = mix( ramp, smoothstep( -0.25, 0.95, ndl ), uTerrainSmooth );', 'ramp');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'gw-terrain-1';
  return { material: mat, uniforms };
}

// ------------------------------------------------------------------------------------------------- chunk manager

interface Chunk {
  cx: number;
  cz: number;
  mx: number;
  mz: number;
  midY: number;
  mesh: Mesh | null;
  lod: number;
}

export class TerrainSystem {
  readonly group = new Group();
  readonly material: MeshToonMaterial;
  private readonly chunks: Chunk[] = [];
  private readonly lodDist: number[];
  private readonly maxLod: number;
  private budgetMs = 5;
  stats = { chunks: 0, built: 0, tris: 0 };

  constructor(private readonly g: TerrainGrid, mat: MeshToonMaterial, quality: { drawDistance: number; detail: number }) {
    this.group.name = 'world.terrain';
    this.material = mat;
    const cc = g.chunk;
    let maxLod = 0;
    while (maxLod < 3 && cc % (2 << maxLod) === 0 && cc / (2 << maxLod) >= 4) maxLod++;
    this.maxLod = maxLod;
    const f = Math.max(0.6, quality.drawDistance);
    this.lodDist = [50 * f, 115 * f, 230 * f];
    const ncx = Math.ceil((g.nx - 1) / cc);
    const ncz = Math.ceil((g.nz - 1) / cc);
    const H = g.heights;
    for (let cz = 0; cz < ncz; cz++) {
      for (let cx = 0; cx < ncx; cx++) {
        let maxH = -Infinity;
        let minH = Infinity;
        const i1 = Math.min(g.nx - 1, (cx + 1) * cc);
        const j1 = Math.min(g.nz - 1, (cz + 1) * cc);
        for (let j = cz * cc; j <= j1; j += 2) for (let i = cx * cc; i <= i1; i += 2) {
          const h = H[j * g.nx + i]!;
          if (h > maxH) maxH = h;
          if (h < minH) minH = h;
        }
        if (maxH < g.sea - 5.5) continue; // deep sea: the water shader draws its own depth, no seabed needed
        this.chunks.push({
          cx,
          cz,
          mx: g.ox + (cx + 0.5) * cc * g.cell,
          mz: g.oz + (cz + 0.5) * cc * g.cell,
          midY: 0.5 * (maxH + minH),
          mesh: null,
          lod: -1,
        });
      }
    }
    this.stats.chunks = this.chunks.length;
  }

  private desired(c: Chunk, cam: Vector3): number {
    const dx = cam.x - c.mx;
    const dz = cam.z - c.mz;
    const dy = cam.y - c.midY;
    const half = this.g.chunk * this.g.cell * 0.5;
    let d = Math.max(0, Math.hypot(dx, dy * 0.6, dz) - half);
    if (c.lod >= 0) d *= 1; // hysteresis applied below
    let lod = 0;
    while (lod < this.maxLod && lod < this.lodDist.length && d > this.lodDist[lod]!) lod++;
    if (c.lod >= 0 && lod !== c.lod) {
      // hysteresis: stay at the current lod unless clearly outside its band
      const lo = c.lod === 0 ? 0 : this.lodDist[c.lod - 1]! * 0.9;
      const hi = c.lod >= this.lodDist.length ? Infinity : this.lodDist[c.lod]! * 1.1;
      if (d >= lo && d <= hi) lod = c.lod;
    }
    return Math.min(lod, this.maxLod);
  }

  /** Pick LODs for the camera and build pending geometry within the time budget (all of it when `all`). */
  update(cam: Vector3, all = false): void {
    const pending: { c: Chunk; lod: number; d: number }[] = [];
    for (const c of this.chunks) {
      const lod = this.desired(c, cam);
      if (lod !== c.lod) pending.push({ c, lod, d: Math.hypot(cam.x - c.mx, cam.z - c.mz) });
    }
    if (pending.length === 0) return;
    pending.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const p of pending) {
      if (!all && performance.now() - t0 > this.budgetMs && p.c.mesh) break;
      const geo = chunkGeometry(this.g, p.c.cx, p.c.cz, p.lod);
      if (p.c.mesh) {
        p.c.mesh.geometry.dispose();
        p.c.mesh.geometry = geo;
      } else {
        const m = new Mesh(geo, this.material);
        m.name = `terrain.${p.c.cx}.${p.c.cz}`;
        m.castShadow = true;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        this.group.add(m);
        p.c.mesh = m;
      }
      p.c.lod = p.lod;
      this.stats.built++;
    }
    let tris = 0;
    for (const c of this.chunks) if (c.mesh) tris += c.mesh.geometry.index!.count / 3;
    this.stats.tris = tris;
  }

  dispose(): void {
    for (const c of this.chunks) c.mesh?.geometry.dispose();
    this.group.removeFromParent();
  }
}
