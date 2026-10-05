/**
 * PLACEHOLDER flora for the reference slice: one InstancedMesh per (kind, material class), built from welded,
 * lumpy primitives with vertex-colour gradients. Proves the `flora` channel, ToonLit foliage (wind, translucency),
 * instancing and shadow casting. The real flora (grass, proper trees, LOD) is the `flora` module's job.
 */
import { BufferGeometry, Color, InstancedMesh, Matrix4, Object3D, Quaternion, Vector3, type Material } from 'three';
import { blob, cone, merged, paint, tube } from './kit';
import type { Channel } from '../../engine/Bridge';
import type { Materials } from '../../engine/Materials';
import type { Rng } from '../../engine/Rng';

const C = (hex: string) => new Color(hex);

// ---------------------------------------------------------------------------------------------- kind builders

interface KindGeo {
  leaf?: BufferGeometry;
  wood?: BufferGeometry;
  stone?: BufferGeometry;
  glow?: BufferGeometry;
  /** sway height for the foliage material */
  sway?: number;
  /** colour jitter strength for instance colours (0 = none) */
  jitter?: number;
  /** footprint radius used for grass-bender registration (0 = none) */
  bendR?: number;
}

const WOOD_DARK = C('#7A4A2B');
const WOOD = C('#B9783F');
const BIRCH = C('#F1EBDD');

function canopy(lobes: [number, number, number, number, number?][], bottom: string, top: string, jitter = 0.16): BufferGeometry {
  const parts = lobes.map(([x, y, z, r, sy], i) => blob(r, r * (sy ?? 0.88), r, x, y, z, jitter, i * 3.7 + 1));
  const g = merged(parts);
  return paint(g, C(bottom), C(top));
}

function trunk(h: number, r0: number, r1: number, bend = 0, dark = WOOD_DARK, light = WOOD): BufferGeometry {
  const parts = [tube(r0, r1, h, 0, 0, 0, 0, bend), tube(r0 * 1.7, r0 * 1.05, 0.34, 0, -0.04, 0)];
  const g = merged(parts);
  return paint(g, dark, light, 0, h);
}

function buildKind(kind: number): KindGeo {
  switch (kind) {
    case 0: // oak-puff
      return {
        wood: trunk(1.5, 0.27, 0.17),
        leaf: canopy([[0, 2.55, 0, 1.25], [0.95, 2.2, 0.2, 0.85], [-0.8, 2.25, -0.4, 0.9], [0.1, 2.15, 0.95, 0.8], [-0.2, 3.15, -0.1, 0.85], [0.1, 2.0, -0.95, 0.75]], '#2E9E6B', '#A5E866'),
        sway: 3.5,
        jitter: 0.1,
        bendR: 0.8,
      };
    case 1: // tall puff
      return {
        wood: trunk(2.6, 0.24, 0.14),
        leaf: canopy([[0, 3.1, 0, 1.0, 1.15], [0.1, 4.0, 0.05, 0.82, 1.1], [-0.05, 4.8, 0, 0.6, 1.1], [0.55, 2.7, 0.2, 0.55, 1], [-0.5, 2.8, -0.2, 0.55, 1]], '#2A8F66', '#8EDD62'),
        sway: 5,
        jitter: 0.09,
        bendR: 0.6,
      };
    case 2: {
      // pine tiers
      const cones = [cone(1.55, 1.5, 0, 1.0, 0), cone(1.2, 1.4, 0, 1.95, 0), cone(0.9, 1.3, 0, 2.85, 0), cone(0.55, 1.2, 0, 3.7, 0)];
      return { wood: trunk(1.2, 0.2, 0.14), leaf: paint(merged(cones), C('#1F7A5A'), C('#5CC98A')), sway: 5, jitter: 0.08, bendR: 0.7 };
    }
    case 3: // blossom
      return {
        wood: trunk(1.4, 0.26, 0.16, 0.06),
        leaf: canopy([[0, 2.5, 0, 1.2], [0.9, 2.15, 0.2, 0.85], [-0.85, 2.25, -0.35, 0.9], [0.1, 2.1, 0.95, 0.8], [-0.1, 3.1, 0, 0.8], [0.15, 2.0, -0.9, 0.75]], '#E56FA2', '#FFC4DC'),
        sway: 3.5,
        jitter: 0.1,
        bendR: 0.8,
      };
    case 4: {
      // palm
      const trunkParts = [tube(0.2, 0.17, 1.1, 0, 0, 0, 0, 0.12), tube(0.17, 0.14, 1.1, -0.13, 1.08, 0, 0, 0.18), tube(0.14, 0.12, 1.0, -0.5, 2.1, 0, 0, 0.1)];
      const fronds: BufferGeometry[] = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const fr = cone(0.34, 1.9, -0.62, 3.0, 0, 1, 0.34, 0, 0, 6);
        fr.applyMatrix4(new Matrix4().makeTranslation(0.62, -3.0, 0));
        fr.applyMatrix4(new Matrix4().makeRotationFromEuler(new Object3D().rotation.set(0, a, -1.18)));
        fr.applyMatrix4(new Matrix4().makeTranslation(-0.62, 3.0, 0));
        fronds.push(fr);
      }
      return { wood: paint(merged(trunkParts), C('#8C6A4A'), C('#C9A27A')), leaf: paint(merged(fronds), C('#2E9E6B'), C('#8EDD62')), sway: 3.2, jitter: 0.08, bendR: 0.5 };
    }
    case 5: // willow
      return {
        wood: trunk(1.6, 0.28, 0.2),
        leaf: canopy([[0, 2.7, 0, 1.2], [1.1, 2.0, 0, 0.85, 1.4], [-1.1, 2.0, 0.1, 0.85, 1.4], [0, 2.0, 1.1, 0.85, 1.4], [0.05, 2.0, -1.1, 0.85, 1.4], [0.9, 1.3, 0.8, 0.5, 1.6], [-0.9, 1.3, -0.8, 0.5, 1.6]], '#4FBF7E', '#B5EC74'),
        sway: 3.5,
        jitter: 0.08,
        bendR: 0.8,
      };
    case 6: // birch
      return {
        wood: trunk(2.2, 0.17, 0.11, 0.03, C('#CFC7B0'), BIRCH),
        leaf: canopy([[0, 3.0, 0, 0.95, 1.1], [0.55, 2.6, 0.1, 0.6, 1], [-0.5, 2.7, -0.15, 0.6, 1], [0, 3.7, 0, 0.6, 1]], '#6FC46A', '#C5F07A'),
        sway: 4.5,
        jitter: 0.1,
        bendR: 0.5,
      };
    case 7: // maple (autumn)
      return {
        wood: trunk(1.5, 0.27, 0.17),
        leaf: canopy([[0, 2.55, 0, 1.25], [0.95, 2.2, 0.2, 0.85], [-0.8, 2.25, -0.4, 0.9], [0.1, 2.15, 0.95, 0.8], [-0.2, 3.15, -0.1, 0.85], [0.1, 2.0, -0.95, 0.75]], '#D8472F', '#FFB347'),
        sway: 3.5,
        jitter: 0.1,
        bendR: 0.8,
      };
    case 8: {
      // giant glowcap mushroom tree
      const cap = blob(1.7, 0.95, 1.7, 0, 3.2, 0, 0.06, 2, 16);
      return {
        wood: paint(merged([tube(0.5, 0.32, 3.2, 0, 0, 0)]), C('#E8D2B0'), C('#FFF3E0'), 0, 3.2),
        glow: paint(merged([cap]), C('#2BB8D9'), C('#8FF7E0')),
        jitter: 0.05,
        bendR: 0.9,
      };
    }
    case 9: // dead tree
      return {
        wood: paint(merged([tube(0.24, 0.12, 2.6, 0, 0, 0, 0, 0.05), tube(0.12, 0.05, 1.3, 0.1, 1.6, 0, 0, -0.9), tube(0.1, 0.04, 1.1, -0.1, 2.0, 0, 0, 0.8), tube(0.08, 0.03, 0.9, 0, 2.4, 0.1, 0.7, 0)]), C('#5E4A44'), C('#9A8478'), 0, 3.4),
        jitter: 0.04,
      };
    case 10: // apple
    case 11: {
      // orange
      const fruit = kind === 10 ? '#E2433A' : '#FF9A2E';
      const leafG = canopy([[0, 2.2, 0, 1.1], [0.8, 1.95, 0.2, 0.75], [-0.7, 2.0, -0.35, 0.8], [0.1, 1.9, 0.85, 0.7], [-0.1, 2.75, 0, 0.7]], '#2E9E6B', '#9BE564');
      const dots: BufferGeometry[] = [];
      const pts: [number, number, number][] = [[0.9, 2.5, 0.5], [-0.6, 2.7, 0.7], [0.2, 3.1, -0.6], [-0.9, 2.0, -0.5], [0.8, 1.9, -0.7], [0.0, 1.7, 0.9]];
      for (const [x, y, z] of pts) dots.push(paint(blob(0.13, 0.13, 0.13, x, y, z, 0.02, 1, 6), C(fruit), C(fruit)));
      return { wood: trunk(1.2, 0.24, 0.15), leaf: merged([leafG, ...dots]), sway: 3, jitter: 0.08, bendR: 0.7 };
    }
    case 16: // round bush
    case 17: // berry bush
      return {
        leaf: kind === 16 ? canopy([[0, 0.45, 0, 0.55], [0.4, 0.35, 0.1, 0.4], [-0.35, 0.35, -0.1, 0.42]], '#2E9E6B', '#8EDD62') : merged([canopy([[0, 0.45, 0, 0.55], [0.4, 0.35, 0.1, 0.4], [-0.35, 0.35, -0.1, 0.42]], '#2E9E6B', '#8EDD62'), ...[[0.3, 0.7, 0.3], [-0.3, 0.6, 0.35], [0.1, 0.85, -0.2]].map(([x, y, z]) => paint(blob(0.07, 0.07, 0.07, x!, y!, z!, 0.02, 1, 6), C('#E2433A'), C('#E2433A')))]),
        sway: 0.9,
        jitter: 0.1,
        bendR: 0.45,
      };
    case 18: {
      // fern: fan of flat cones
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const f = cone(0.16, 0.95, 0, 0.05, 0, 1, 0.35, 0, 0, 5);
        f.applyMatrix4(new Matrix4().makeRotationFromEuler(new Object3D().rotation.set(0, a, 0)));
        const lean = new Matrix4().makeRotationAxis(new Vector3(Math.cos(a), 0, -Math.sin(a)), 0.9);
        f.applyMatrix4(lean);
        parts.push(f);
      }
      return { leaf: paint(merged(parts), C('#2E9E6B'), C('#9BE564')), sway: 0.8, jitter: 0.12, bendR: 0.4 };
    }
    case 32: case 33: case 34: case 35: case 36: case 37: case 38: case 39: {
      const colors: Record<number, [string, string]> = {
        32: ['#FFFFFF', '#FFD84D'], 33: ['#FF5A6B', '#FF9AA6'], 34: ['#9A7BFF', '#C9B6FF'], 35: ['#FFC21A', '#FF9A1A'],
        36: ['#5A9BFF', '#9AC4FF'], 37: ['#FF4A3A', '#FF8A5A'], 38: ['#FFFFFF', '#FFB7D5'], 39: ['#F4FFFB', '#9BE564'],
      };
      const [petal, core] = colors[kind]!;
      const big = kind === 35;
      const stem = paint(merged([tube(0.025, 0.02, big ? 0.9 : 0.42, 0, 0, 0)]), C('#2E9E6B'), C('#5CC95A'), 0, big ? 0.9 : 0.42);
      const hy = big ? 0.92 : 0.45;
      const head = merged([paint(blob(big ? 0.2 : 0.1, big ? 0.07 : 0.06, big ? 0.2 : 0.1, 0, hy, 0, 0.05, 1, 8), C(petal), C(petal)), paint(blob(big ? 0.09 : 0.045, 0.05, big ? 0.09 : 0.045, 0, hy + 0.045, 0, 0.02, 1, 6), C(core), C(core))]);
      return { leaf: merged([stem, head]), sway: big ? 0.9 : 0.45, jitter: 0.12, bendR: 0.3 };
    }
    case 48: case 49: case 50: {
      const glowing = kind === 49;
      const capCol = glowing ? ['#2BB8D9', '#8FF7E0'] : kind === 48 ? ['#D8472F', '#FF7A5A'] : ['#9A6A3A', '#C99A62'];
      const stemG = paint(merged([tube(0.07, 0.05, 0.28, 0, 0, 0)]), C('#E8D2B0'), C('#FFF3E0'), 0, 0.28);
      const capG = paint(merged([blob(0.2, 0.12, 0.2, 0, 0.3, 0, 0.04, 3, 10)]), C(capCol[0]!), C(capCol[1]!));
      return glowing ? { wood: stemG, glow: capG, jitter: 0.1 } : { wood: stemG, leaf: capG, sway: 0.3, jitter: 0.1 };
    }
    case 64: case 65: case 66: case 67: case 69: {
      const mossy = kind === 67;
      const g = kind === 69
        ? merged([blob(0.55, 1.6, 0.5, 0, 1.5, 0, 0.22, 7, 12), blob(0.4, 0.8, 0.4, 0.5, 0.7, 0.2, 0.22, 9, 10)])
        : kind === 65
          ? merged([blob(0.9, 0.28, 0.7, 0, 0.2, 0, 0.2, 2, 12)])
          : kind === 66
            ? merged([blob(0.18, 0.1, 0.16, 0, 0.06, 0, 0.2, 1, 7), blob(0.13, 0.08, 0.12, 0.3, 0.05, 0.1, 0.2, 2, 7), blob(0.15, 0.08, 0.13, -0.2, 0.05, 0.22, 0.2, 3, 7)])
            : merged([blob(0.8, 0.62, 0.7, 0, 0.45, 0, 0.24, 4, 12)]);
      const top = mossy ? '#8EDD62' : '#C9BAD9';
      return { stone: paint(g, C('#8A7BA3'), C(top)), jitter: 0.06 };
    }
    case 68: {
      // crystal cluster
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        const a = i * 1.7;
        const h = 0.5 + (i % 3) * 0.28;
        parts.push(cone(0.13, h, Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2, 1, 1, Math.sin(a) * 0.35, Math.cos(a) * 0.35, 6));
      }
      return { glow: paint(merged(parts), C('#7A5BFF'), C('#C9B6FF')), jitter: 0.0 };
    }
    case 80: case 82: {
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const a = i * 1.1;
        parts.push(paint(cone(0.04, 1.0 + (i % 3) * 0.25, Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14, 1, 1, Math.sin(a) * 0.12, Math.cos(a) * 0.12, 4), C('#2E9E6B'), C('#9BE564'), 0, 1.4));
        if (kind === 82 && i % 2 === 0) parts.push(paint(tube(0.05, 0.05, 0.22, Math.cos(a) * 0.14, 0.9 + (i % 3) * 0.12, Math.sin(a) * 0.14), C('#6B4423'), C('#8C5A2F'), 0, 3));
      }
      return { leaf: merged(parts), sway: 1.1, jitter: 0.08, bendR: 0.3 };
    }
    case 81: // lily pad
      return { leaf: paint(merged([blob(0.45, 0.025, 0.45, 0, 0.0, 0, 0.04, 1, 10)]), C('#2E9E6B'), C('#7AD35A')), jitter: 0.1 };
    case 96: case 97:
      return { stone: paint(merged([blob(kind === 96 ? 0.12 : 0.2, 0.05, kind === 96 ? 0.1 : 0.2, 0, 0.03, 0, 0.1, 1, 8)]), C(kind === 96 ? '#F2B8C6' : '#FF9A5A'), C(kind === 96 ? '#FFF3E0' : '#FFC27A')), jitter: 0.05 };
    case 98: case 113: case 114:
      return { wood: paint(merged([tube(0.14, 0.11, 1.6, -0.8, 0.14, 0, 0, -Math.PI / 2, 8)]), WOOD_DARK, kind === 114 ? C('#8EDD62') : WOOD, 0.0, 0.3), jitter: 0.05 };
    case 99:
      return { leaf: paint(merged([cone(0.08, 0.6, 0, 0, 0, 1, 1, 0.1, 0.1, 4), cone(0.07, 0.5, 0.1, 0, 0.05, 1, 1, -0.2, 0.3, 4), cone(0.07, 0.55, -0.1, 0, -0.05, 1, 1, 0.3, -0.2, 4)]), C('#BFD66A'), C('#EAF28A'), 0, 0.6), sway: 0.6, jitter: 0.1 };
    case 112:
      return { wood: paint(merged([tube(0.32, 0.27, 0.5, 0, 0, 0, 0, 0, 10)]), WOOD_DARK, C('#D6A26A'), 0, 0.5), jitter: 0.05 };
    default:
      return { stone: paint(merged([blob(0.15, 0.15, 0.15, 0, 0.15, 0, 0.1, 1, 6)]), C('#8A7BA3'), C('#C9BAD9')) };
  }
}

// ---------------------------------------------------------------------------------------------- system

export interface FloraSystem {
  group: Object3D;
  meshes: InstancedMesh[];
  count: number;
  /** register bender footprints near `x,z` is not needed for static flora; kept for the real module's API sketch */
  dispose(): void;
}

/** the early sim publishes coarse kinds named in `world.info.flora_kinds`; map them onto WORLD_CONTRACT.md kinds */
function remapKind(raw: number, variant: number, names?: string[]): number {
  const n = names?.[raw];
  if (!n) return raw;
  const v = Math.floor(variant);
  switch (n) {
    case 'tree':
      return [0, 1, 2, 3, 6, 7, 0, 1][v % 8]!;
    case 'flower':
      return 32 + (v % 8);
    case 'rock':
      return [64, 65, 67, 66][v % 4]!;
    case 'bush':
      return v % 5 === 0 ? 17 : 16;
    default:
      return raw;
  }
}

export function buildFlora(ch: Channel, mats: Materials, rng: Rng, kindNames?: string[]): FloraSystem {
  const group = new Object3D();
  group.name = 'slice.flora';
  const data = ch.data;
  const stride = ch.stride || 8;
  const n = Math.floor(ch.len / stride);
  const byKind = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = remapKind(data[i * stride]!, data[i * stride + 6]!, kindNames);
    let a = byKind.get(k);
    if (!a) byKind.set(k, (a = []));
    a.push(i);
  }
  const meshes: InstancedMesh[] = [];
  const m4 = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();
  const color = new Color();
  const materials: Material[] = [];

  for (const [kind, idxs] of byKind) {
    const spec = buildKind(kind);
    const mk = (geo: BufferGeometry, mat: Material, name: string) => {
      const im = new InstancedMesh(geo, mat, idxs.length);
      im.name = `slice.flora.${kind}.${name}`;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false; // bounding sphere of instances is not maintained here; cheap enough for the slice
      for (let j = 0; j < idxs.length; j++) {
        const i = idxs[j]!;
        const o = i * stride;
        pos.set(data[o + 1]!, data[o + 2]!, data[o + 3]!);
        q.setFromAxisAngle(up, data[o + 4]!);
        const s = data[o + 5]!;
        scl.set(s, s, s);
        m4.compose(pos, q, scl);
        im.setMatrixAt(j, m4);
        const variant = data[o + 6]!;
        const jit = spec.jitter ?? 0.08;
        const r = (((variant * 2654435761) >>> 0) % 1000) / 1000;
        const r2 = (((variant * 40503 + 17) >>> 0) % 1000) / 1000;
        // multiplicative tint: brightness + a hair of hue via per-channel jitter
        color.setRGB(1 - jit * 0.5 + r * jit, 1 - jit * 0.5 + r2 * jit, 1 - jit * 0.5 + ((r + r2) * 0.5) * jit);
        im.setColorAt(j, color);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      mats.prepare(im);
      group.add(im);
      meshes.push(im);
    };
    if (spec.leaf) {
      const m = mats.foliage('#ffffff', { vertexColors: true, wind: { amp: 0.13, height: spec.sway ?? 3, speed: 1 }, name: `k${kind}` });
      materials.push(m);
      mk(spec.leaf, m, 'leaf');
    }
    if (spec.wood) {
      const m = mats.wood('#ffffff', { vertexColors: true, name: `k${kind}` });
      materials.push(m);
      mk(spec.wood, m, 'wood');
    }
    if (spec.stone) {
      const m = mats.stone('#ffffff', { vertexColors: true, name: `k${kind}` });
      materials.push(m);
      mk(spec.stone, m, 'stone');
    }
    if (spec.glow) {
      const m = mats.glow('#ffffff', { vertexColors: true, emissiveIntensity: 1.8, name: `k${kind}` });
      materials.push(m);
      mk(spec.glow, m, 'glow');
    }
  }
  void rng;
  return {
    group,
    meshes,
    count: n,
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.dispose();
      }
      for (const m of materials) m.dispose();
    },
  };
}
