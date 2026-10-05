/**
 * PLACEHOLDER creatures: three chunky species merged from lumpy blobs (not final art!) drawn with one
 * InstancedMesh each, positions interpolated from the `creatures` channel with the bridge's `lerpRows`.
 * Idle breathing / walk bounce / curious hop are faked from `anim_state`, `anim_t`, `emote`.
 */
import { Color, InstancedMesh, Matrix4, Object3D, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { Channel } from '../../engine/Bridge';
import type { Materials } from '../../engine/Materials';
import { blob, cone, merged, paint, tube } from './kit';

const C = (hex: string) => new Color(hex);

function puffbun(): BufferGeometry {
  const body = paint(merged([blob(0.34, 0.31, 0.34, 0, 0.34, 0, 0.05, 1, 12)]), C('#FFD2DE'), C('#FFF6EA'));
  const head = paint(merged([blob(0.27, 0.24, 0.25, 0, 0.66, 0.14, 0.04, 2, 12)]), C('#FFE6EC'), C('#FFF6EA'));
  const ear = (sx: number) => paint(merged([blob(0.07, 0.26, 0.055, sx * 0.12, 0.98, 0.04, 0.04, 3, 8)]), C('#FF9EC0'), C('#FFF0F4'));
  const cheek = (sx: number) => paint(merged([blob(0.055, 0.05, 0.03, sx * 0.19, 0.58, 0.35, 0.02, 1, 6)]), C('#FF8FB8'), C('#FFB3CF'));
  const tail = paint(merged([blob(0.11, 0.11, 0.11, 0, 0.36, -0.34, 0.03, 1, 8)]), C('#FFFFFF'), C('#FFFFFF'));
  const eye = (sx: number) =>
    merged([
      paint(blob(0.04, 0.05, 0.03, sx * 0.1, 0.69, 0.37, 0.0, 1, 7), C('#3A2D4A'), C('#3A2D4A')),
      paint(blob(0.014, 0.014, 0.01, sx * 0.1 + 0.012, 0.71, 0.395, 0.0, 1, 5), C('#FFFFFF'), C('#FFFFFF')),
    ]);
  const feet = [-1, 1].map((sx) => paint(merged([blob(0.09, 0.05, 0.11, sx * 0.15, 0.04, 0.1, 0.03, 1, 7)]), C('#FFC9D6'), C('#FFE6EC')));
  return merged([body, head, ear(-1), ear(1), cheek(-1), cheek(1), tail, eye(-1), eye(1), ...feet]);
}

function tidler(): BufferGeometry {
  const body = paint(merged([blob(0.38, 0.3, 0.44, 0, 0.32, 0, 0.05, 4, 12)]), C('#2FA8B5'), C('#63D8CF'));
  const belly = paint(merged([blob(0.3, 0.22, 0.28, 0, 0.24, 0.16, 0.03, 5, 10)]), C('#FFE9C9'), C('#FFF6EA'));
  const head = paint(merged([blob(0.25, 0.21, 0.26, 0, 0.56, 0.3, 0.04, 6, 12)]), C('#3DB9BE'), C('#79E3D6'));
  const snout = paint(merged([blob(0.14, 0.075, 0.12, 0, 0.5, 0.52, 0.03, 7, 8)]), C('#FFC83D'), C('#FFE27A'));
  const eye = (sx: number) =>
    merged([
      paint(blob(0.045, 0.05, 0.035, sx * 0.11, 0.68, 0.45, 0.0, 1, 7), C('#3A2D4A'), C('#3A2D4A')),
      paint(blob(0.016, 0.016, 0.012, sx * 0.11 + 0.012, 0.7, 0.48, 0.0, 1, 5), C('#FFFFFF'), C('#FFFFFF')),
    ]);
  const feet = [-1, 1].map((sx) => paint(merged([blob(0.13, 0.03, 0.16, sx * 0.2, 0.03, 0.22, 0.04, 1, 7)]), C('#FFB82E'), C('#FFD866')));
  const tailFin = paint(merged([blob(0.1, 0.07, 0.2, 0, 0.3, -0.5, 0.05, 1, 8)]), C('#2FA8B5'), C('#63D8CF'));
  return merged([body, belly, head, snout, eye(-1), eye(1), ...feet, tailFin]);
}

function sprigfox(): BufferGeometry {
  const body = paint(merged([blob(0.19, 0.2, 0.4, 0, 0.4, 0, 0.05, 8, 12)]), C('#F08A3A'), C('#FFB766'));
  const chest = paint(merged([blob(0.13, 0.14, 0.14, 0, 0.36, 0.26, 0.03, 1, 8)]), C('#FFF0DC'), C('#FFFFFF'));
  const head = paint(merged([blob(0.2, 0.18, 0.2, 0, 0.64, 0.4, 0.04, 9, 12)]), C('#F59A4A'), C('#FFC27A'));
  const snout = paint(merged([blob(0.075, 0.06, 0.11, 0, 0.6, 0.58, 0.02, 1, 7)]), C('#FFF0DC'), C('#FFFFFF'));
  const nose = paint(merged([blob(0.025, 0.02, 0.02, 0, 0.62, 0.68, 0.0, 1, 5)]), C('#3A2D4A'), C('#3A2D4A'));
  const ear = (sx: number) => paint(merged([cone(0.085, 0.24, sx * 0.1, 0.74, 0.36, 1, 0.6, -0.12, -sx * 0.18, 6)]), C('#F08A3A'), C('#3A2D4A'));
  const eye = (sx: number) =>
    merged([
      paint(blob(0.034, 0.045, 0.028, sx * 0.085, 0.67, 0.55, 0.0, 1, 7), C('#3A2D4A'), C('#3A2D4A')),
      paint(blob(0.012, 0.012, 0.01, sx * 0.085 + 0.01, 0.69, 0.575, 0.0, 1, 5), C('#FFFFFF'), C('#FFFFFF')),
    ]);
  const legs = [
    [-0.1, 0.2],
    [0.1, 0.2],
    [-0.1, -0.2],
    [0.1, -0.2],
  ].map(([x, z]) => paint(merged([tube(0.045, 0.035, 0.28, x!, 0, z!)]), C('#7A4A2B'), C('#B9783F'), 0, 0.28));
  const leaf = (a: number, len: number) => {
    const g = merged([blob(0.07, 0.05, len, 0, 0, len, 0.03, 1, 8)]);
    g.rotateX(-0.9 + a * 0.35);
    g.rotateY(a * 0.5);
    g.translate(0, 0.45, -0.38);
    return paint(g, C('#3FB36B'), C('#B5EC74'));
  };
  return merged([body, chest, head, snout, nose, ear(-1), ear(1), eye(-1), eye(1), ...legs, leaf(-1, 0.28), leaf(0, 0.34), leaf(1, 0.28)]);
}

export interface CreatureSystem {
  group: Object3D;
  update(alpha: number, bend: (x: number, y: number, z: number, r: number) => void): void;
  dispose(): void;
}

const VARIANT_TINT = [new Color(1, 1, 1), new Color(1.0, 0.88, 1.08), new Color(0.88, 1.06, 0.92)];

export function buildCreatures(ch: Channel, mats: Materials): CreatureSystem {
  const group = new Object3D();
  group.name = 'slice.creatures';
  const geos = [puffbun(), tidler(), sprigfox()];
  const mat = mats.clay('#ffffff', { vertexColors: true, name: 'creature', rim: 0.3 });
  const MAX = 64;
  const meshes = geos.map((g, i) => {
    const im = new InstancedMesh(g, mat, MAX);
    im.name = `slice.creature.${i}`;
    im.count = 0;
    im.frustumCulled = false;
    mats.prepare(im);
    group.add(im);
    return im;
  });
  const out = new Float32Array(MAX * 16);
  const counts = [0, 0, 0];
  const m4 = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();

  return {
    group,
    update(alpha, bend) {
      const stride = ch.stride || 16;
      const rows = Math.min(ch.lerpRows(alpha, out, { idField: 0, angleFields: [6], rows: MAX }), MAX);
      counts[0] = counts[1] = counts[2] = 0;
      for (let r = 0; r < rows; r++) {
        const o = r * stride;
        const sp = Math.min(2, Math.max(0, Math.round(out[o + 1]!)));
        const mesh = meshes[sp]!;
        const j = counts[sp]!++;
        const scale = out[o + 7]!;
        const state = out[o + 8]!;
        const t = out[o + 9]!;
        const emote = out[o + 11]!;
        // placeholder animation from anim_state (0 idle 1 walk 2 run 3 notice 4 sleep 5 happy 6 hop 7 swim) + emote
        let lift = 0;
        let sy = 1 + Math.sin(t * 2.1 + r) * 0.022;
        if (state === 1 || state === 2 || state === 7) {
          const ph = Math.abs(Math.sin(t * (state === 2 ? 11 : 8.5)));
          lift = ph * 0.07 * scale * (state === 7 ? 0.35 : 1);
          sy = 1 + (ph - 0.5) * 0.12;
        } else if (state === 3) {
          sy = 1.06 + Math.sin(t * 9) * 0.015; // notice: perk up
        } else if (state === 4) {
          sy = 0.8 + Math.sin(t * 1.6 + r) * 0.02; // asleep: low and slow
        } else if (state === 5 || state === 6 || emote === 1 || emote === 2 || emote === 6) {
          const hop = Math.max(0, Math.sin(t * 6.0));
          lift = hop * 0.1 * scale;
          sy *= 1 + hop * 0.08;
        }
        const sxz = 1 / Math.sqrt(sy);
        pos.set(out[o + 3]!, out[o + 4]! + lift, out[o + 5]!);
        q.setFromAxisAngle(up, out[o + 6]!);
        scl.set(scale * sxz, scale * sy, scale * sxz);
        m4.compose(pos, q, scl);
        mesh.setMatrixAt(j, m4);
        mesh.setColorAt(j, VARIANT_TINT[Math.round(out[o + 2]!) % 3]!);
        bend(pos.x, pos.y, pos.z, 0.9 * scale);
      }
      for (let s = 0; s < 3; s++) {
        const mesh = meshes[s]!;
        mesh.count = counts[s]!;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of meshes) m.dispose();
      mat.dispose();
    },
  };
}
