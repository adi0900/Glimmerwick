/**
 * Micro-voxel relief (texel-voxel look, stage 1b): real 1/16 m cubes -- the creatures' voxel size -- scattered on the ground
 * around the camera. ONE InstancedMesh, rebuilt when the camera has moved ~3 m:
 *   - grass tufts: 1-3 voxel tall columns (colour = random texels of the block's own tile, brighter tips),
 *   - sand / dirt / gravel / path: single pebbles, shell crumbs and short ridges,
 *   - cliff and ledge rims: a ragged lip of voxels that overhangs the 1 m step by one voxel, so the silhouette of every
 *     grass / sand / path edge stops being a razor-straight line.
 * Cubes sit exactly on the world 1/16 m grid (same grid as the ground texels). They shrink away between 12 and 18 m
 * (done in the vertex shader, so nothing pops). Placement is deterministic per block (hash), so stills are stable.
 */
import { BoxGeometry, Color, InstancedMesh, Object3D, SRGBColorSpace, Vector3, type Group, type MeshToonMaterial } from 'three';
import type { Ctx } from '../../engine/types';
import type { Atlas } from './atlas';
import { TEXEL } from './atlas';
import type { VoxInfo } from './mesher';

const MAX = 40000;
const R = 19; // window radius in columns
const W = 2 * R + 1;
/** relief placement grid = the ground texel grid: one cube per texel */
const G = TEXEL;
const V = 1 / G;
const FADE0 = 12;
const FADE1 = 18;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

interface BlockLite {
  id: number;
  name: string;
  tex: string[];
}

function hash(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface Relief {
  update(ctx: Ctx, dt: number): void;
  count(): number;
}

export function createRelief(ctx: Ctx, root: Group, info: VoxInfo, flags: Uint8Array, blocks: BlockLite[], atlas: Atlas): Relief {
  const { nx, ny, nz, originX, seaY, chunk: CH, ncx: NCX } = info;
  const CELLS = CH * CH * ny;
  // 0 none . 1 grass . 2 sand . 3 pebbly ground (gravel / path / dirt / mud / clay)
  const kinds = new Uint8Array(256);
  const layer0 = new Int32Array(256);
  const nvar = new Int32Array(256).fill(1);
  for (const b of blocks) {
    const n = b.name;
    kinds[b.id] = n.startsWith('grass') ? 1 : n === 'sand' ? 2 : n === 'gravel' || n === 'path' || n === 'packed_earth' || n === 'dirt' || n === 'mud' || n === 'clay' ? 3 : 0;
    const t = b.tex[0] ?? '';
    layer0[b.id] = atlas.index.get(t) ?? 0;
    nvar[b.id] = atlas.variants.get(t) ?? 1;
  }
  const originZ = info.originZ;
  const at = (data: Uint16Array, ix: number, l: number, iz: number): number => {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz || l < 0 || l >= ny) return 0;
    const c = Math.floor(iz / CH) * NCX + Math.floor(ix / CH);
    return data[c * CELLS + (((iz % CH) * CH + (ix % CH)) * ny + l)]!;
  };

  const geo = new BoxGeometry(V, V, V);
  {
    // no bottom face (never visible: every cube sits on the ground): 10 triangles instead of 12
    const ix = geo.getIndex()!;
    const keep: number[] = [];
    for (let q = 0; q < ix.count; q++) if (q < 18 || q >= 24) keep.push(ix.getX(q));
    geo.setIndex(keep);
  }
  const material = ctx.mats.toon({
    cls: 'stone',
    color: '#ffffff',
    paint: 0,
    wobble: 0,
    edge: 0,
    rim: 0.22,
    wrap: 0.5,
    shadeTint: '#A9B8F0',
    shade: 0.5,
    bands: 4,
    softness: 0.16,
    weather: true,
    cloudShadow: true,
    name: 'voxel.relief',
  }) as MeshToonMaterial;
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader: any, renderer: any) => {
    base.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'varying vec2 vRvUv;\nvoid main() {');
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  vRvUv = uv;
#ifdef USE_INSTANCING
  transformed *= 1.0 - smoothstep( ${FADE0}.0, ${FADE1}.0, distance( ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz, cameraPosition ) );
#endif`,
    );
    let fs: string = shader.fragmentShader;
    fs = fs.replace('void main() {', 'varying vec2 vRvUv;\n#include <gw_voxelcell>\nvoid main() {');
    // same edge darkening as the ground texels / creature voxels (0.08), faded when a cube covers only a few pixels
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 1.0 - 0.1 * gwCellEdge( vRvUv, 0.16 ) * gwCellFade( max( fwidth( vRvUv.x ), fwidth( vRvUv.y ) ) );');
    // the world block shader's violet-leaning light floor, so shaded tufts match the shaded ground (never near-black)
    fs = fs.replace(
      '#include <opaque_fragment>',
      `{
  float gwLitAmt = saturate( dot( reflectedLight.directDiffuse, vec3( 0.333 ) ) * 4.0 );
  outgoingLight += vec3( 0.014, 0.026, 0.050 ) * ( 1.0 - gwLitAmt ) * mix( 1.0, 0.6, uNight );
}
outgoingLight = max( outgoingLight, diffuseColor.rgb * vec3( 0.25, 0.24, 0.30 ) * mix( 1.0, 0.8, uNight ) + vec3( 0.004, 0.005, 0.012 ) );
#include <opaque_fragment>`,
    );
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => 'gw-voxel-relief-2';
  const mesh = new InstancedMesh(geo, material, MAX);
  mesh.name = 'voxel.relief';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.count = 0;
  root.add(mesh);
  ctx.mats.prepare(mesh);

  const dummy = new Object3D();
  const col = new Color();
  const topL = new Int16Array(W * W);
  const topI = new Uint8Array(W * W);
  const fwd = new Vector3();
  let lastX = 1e9;
  let lastZ = 1e9;
  let lastVer = -1;
  let lastT = -9;
  let n = 0;

  /** a random texel of the block's own tile -> instance colour (sRGB bytes -> linear working space) */
  function tileColor(id: number, key: number, bright: number): Color {
    const nv = nvar[id]!;
    const layer = layer0[id]! + (Math.floor(hash(key, 7, 3) * nv) % nv);
    const t = Math.floor(hash(key, 11, 5) * TEXEL * TEXEL);
    const o = (layer * TEXEL * TEXEL + t) * 4;
    const px = atlas.texels;
    col.setRGB(Math.min(1, (px[o]! / 255) * bright), Math.min(1, (px[o + 1]! / 255) * bright), Math.min(1, (px[o + 2]! / 255) * bright), SRGBColorSpace);
    return col;
  }

  function put(x: number, y: number, z: number, c: Color): void {
    if (n >= MAX) return;
    dummy.position.set(x, y, z);
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    mesh.setColorAt(n, c);
    n++;
  }

  function rebuild(ctx2: Ctx, cx: number, cz: number, camY: number): void {
    const data = ctx2.game.channel<Uint16Array>('vox.data').data;
    const ix0 = Math.floor(cx - originX) - R;
    const iz0 = Math.floor(cz - originZ) - R;
    const startL = Math.min(ny - 1, Math.ceil(camY + seaY) + 2);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        let tl = -1;
        let ti = 0;
        for (let l = startL; l >= 0; l--) {
          const id = at(data, ix0 + i, l, iz0 + j);
          if (id === 0) continue;
          const f = flags[id]!;
          if (f & 4) break; // water: nothing grows here
          if (f & (8 | 32) || !(f & 1)) continue; // foliage / plants / non-solid: look through to the ground below
          tl = l;
          ti = id;
          break;
        }
        topL[j * W + i] = tl;
        topI[j * W + i] = ti;
      }
    }
    n = 0;
    for (let j = 1; j < W - 1 && n < MAX; j++) {
      for (let i = 1; i < W - 1; i++) {
        const o = j * W + i;
        const l = topL[o]!;
        if (l < 0) continue;
        const id = topI[o]!;
        const k = kinds[id]!;
        if (k === 0) continue;
        const ix = ix0 + i;
        const iz = iz0 + j;
        const wx = ix + originX;
        const wz = iz + originZ;
        const top = l + 1 - seaY; // world y of the block's top face
        if (top < -0.05) continue; // under water
        if (at(data, ix, l + 1, iz) !== 0) continue; // something stands on it (plant / block)
        const hh = hash(ix, iz, 1);
        const kb = (ix * 73856093) ^ (iz * 19349663);
        if (k === 1) {
          // grass clumps: a centre column of 2-3 voxels plus up to four shorter neighbours (a tuft, not a single pillar)
          const nt = hh < 0.72 ? 1 + Math.floor(hash(ix, iz, 2) * 1.6) : 0;
          for (let t = 0; t < nt; t++) {
            const key = kb ^ (t * 83492791);
            const tx = 1 + Math.floor(hash(ix, iz, 10 + t) * (G - 2));
            const tz = 1 + Math.floor(hash(ix, iz, 30 + t) * (G - 2));
            const hc = 2 + Math.floor(hash(ix, iz, 50 + t) * 2.3);
            for (let q = 0; q < 5; q++) {
              const qx = q === 1 ? 1 : q === 2 ? -1 : 0;
              const qz = q === 3 ? 1 : q === 4 ? -1 : 0;
              if (q > 0 && hash(ix, iz, 70 + t * 5 + q) > 0.55) continue;
              const hv = q === 0 ? hc : Math.max(1, hc - 1 - Math.floor(hash(ix, iz, 120 + t * 5 + q) * 2));
              for (let s2 = 0; s2 < hv; s2++) put(wx + (tx + qx + 0.5) * V, top + (s2 + 0.5) * V, wz + (tz + qz + 0.5) * V, tileColor(id, key + q * 313 + s2 * 977, s2 === 0 ? 0.9 : 1.0 + 0.09 * s2));
            }
          }
        } else if (k === 2) {
          const np = hh < 0.55 ? 1 + Math.floor(hash(ix, iz, 3) * 3) : 0;
          for (let t = 0; t < np; t++) {
            const tx = Math.floor(hash(ix, iz, 10 + t) * (G - 1));
            const tz = Math.floor(hash(ix, iz, 30 + t) * G);
            const shell = hash(ix, iz, 90 + t) < 0.18;
            const c = tileColor(id, kb ^ (t * 83492791), shell ? 1.12 : 0.88);
            put(wx + (tx + 0.5) * V, top + 0.5 * V, wz + (tz + 0.5) * V, c);
            if (hash(ix, iz, 95 + t) < 0.5) put(wx + (tx + 1.5) * V, top + 0.5 * V, wz + (tz + 0.5) * V, c);
          }
          if (hash(ix, iz, 4) < 0.22) {
            // a short sand ridge (one voxel high, 3-6 long)
            const len = 3 + Math.floor(hash(ix, iz, 5) * 4);
            const tx = Math.floor(hash(ix, iz, 6) * (G - len));
            const tz = Math.floor(hash(ix, iz, 7) * G);
            for (let s = 0; s < len; s++) put(wx + (tx + s + 0.5) * V, top + 0.5 * V, wz + (tz + 0.5) * V, tileColor(id, kb ^ s, 1.06));
          }
        } else {
          const np = hh < 0.6 ? 1 + Math.floor(hash(ix, iz, 3) * 3) : 0;
          for (let t = 0; t < np; t++) {
            const tx = Math.floor(hash(ix, iz, 10 + t) * (G - 1));
            const tz = Math.floor(hash(ix, iz, 30 + t) * G);
            const c = tileColor(id, kb ^ (t * 83492791), hash(ix, iz, 99 + t) < 0.5 ? 0.74 : 1.12);
            put(wx + (tx + 0.5) * V, top + 0.5 * V, wz + (tz + 0.5) * V, c);
            if (hash(ix, iz, 95 + t) < 0.45) put(wx + (tx + 1.5) * V, top + 0.5 * V, wz + (tz + 0.5) * V, c);
          }
        }
        // ragged rim: where a neighbouring column is >= 1 m lower, voxels sit on the outer top voxel row and hang over the ledge
        for (let d = 0; d < 4; d++) {
          const dx = DIRS[d]![0];
          const dz = DIRS[d]![1];
          const nl = topL[(j + dz) * W + i + dx]!;
          if (nl >= l) continue; // neighbour as high (or higher): no ledge
          if (nl < 0 && at(data, ix + dx, l, iz + dz) !== 0) continue; // blocked sideways, not a ledge
          for (let t = 0; t < G; t++) {
            const run = hash(ix * 5 + d, iz, 200 + (t >> 1));
            if (run > 0.5) continue;
            const along = (t + 0.5) * V;
            const inX = dx !== 0 ? (dx > 0 ? 1 - V * 0.5 : V * 0.5) : along;
            const inZ = dz !== 0 ? (dz > 0 ? 1 - V * 0.5 : V * 0.5) : along;
            const key = ((ix * 31) ^ (iz * 17) ^ (d * 977)) + t;
            put(wx + inX, top + 0.5 * V, wz + inZ, tileColor(id, key, 0.92));
            if (run < 0.28) put(wx + inX + dx * V, top - 0.5 * V, wz + inZ + dz * V, tileColor(id, key + 3, 0.9));
            if (run < 0.1) put(wx + inX, top + 1.5 * V, wz + inZ, tileColor(id, key + 1, 1.12));
          }
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    count: () => n,
    update(ctx2) {
      const cam = ctx2.camera.position;
      ctx2.camera.getWorldDirection(fwd);
      const cx = cam.x + fwd.x * 7;
      const cz = cam.z + fwd.z * 7;
      const ver = ctx2.game.channel('vox.data').ver;
      const now = ctx2.uniforms.uTime.value as number;
      if (Math.hypot(cx - lastX, cz - lastZ) > 3 || (ver !== lastVer && Math.abs(now - lastT) > 0.4) || lastVer < 0) {
        rebuild(ctx2, cx, cz, cam.y);
        lastX = cx;
        lastZ = cz;
        lastVer = ver;
        lastT = now;
      }
    },
  };
}
