/**
 * Tiny procedural geometry kit for the placeholder slice: lumpy welded blobs, tubes, cones, vertex-colour
 * gradients and a merge helper (all geometry ends up position + normal + color, indexed or not).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Matrix4,
  Object3D,
  SphereGeometry,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';


export function vnoise3(x: number, y: number, z: number): number {
  // cheap smooth pseudo-noise from layered sines (deterministic, no tables)
  return (
    Math.sin(x * 1.7 + y * 2.3 + 1.3) * 0.5 +
    Math.sin(y * 2.9 - z * 1.9 + 4.1) * 0.3 +
    Math.sin(z * 2.3 + x * 3.1 - 2.2) * 0.2
  );
}

export function finish(geo: BufferGeometry): BufferGeometry {
  geo.deleteAttribute('uv');
  return geo;
}

export function paint(geo: BufferGeometry, bottom: Color, top: Color, y0?: number, y1?: number): BufferGeometry {
  const pos = geo.getAttribute('position');
  let lo = y0 ?? Infinity;
  let hi = y1 ?? -Infinity;
  if (y0 === undefined || y1 === undefined) {
    for (let i = 0; i < pos.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
    }
  }
  const col = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const t = hi > lo ? Math.min(1, Math.max(0, (pos.getY(i) - lo) / (hi - lo))) : 1;
    c.copy(bottom).lerp(top, t);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  return geo;
}

/** lumpy ellipsoid: welded sphere displaced by smooth noise, smooth normals */
export function blob(rx: number, ry: number, rz: number, x: number, y: number, z: number, jitter = 0.14, seed = 0, detail = 14): BufferGeometry {
  let g: BufferGeometry = new SphereGeometry(1, detail + 4, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i);
    const py = p.getY(i);
    const pz = p.getZ(i);
    const k = 1 + jitter * vnoise3(px * 2 + seed, py * 2 + seed * 0.7, pz * 2 - seed * 0.3);
    p.setXYZ(i, px * k * rx, py * k * ry, pz * k * rz);
  }
  g.translate(x, y, z);
  g.computeVertexNormals();
  return g;
}

export function tube(r0: number, r1: number, h: number, x: number, y: number, z: number, tiltX = 0, tiltZ = 0, seg = 9): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, h, seg, 2);
  g.translate(0, h / 2, 0);
  const m = new Matrix4().makeRotationFromEuler(new Object3D().rotation.set(tiltX, 0, tiltZ));
  g.applyMatrix4(m);
  g.translate(x, y, z);
  return finish(g);
}

export function cone(r: number, h: number, x: number, y: number, z: number, sx = 1, sz = 1, tiltX = 0, tiltZ = 0, seg = 12): BufferGeometry {
  const g = new ConeGeometry(r, h, seg, 1, false);
  g.translate(0, h / 2, 0);
  g.scale(sx, 1, sz);
  g.applyMatrix4(new Matrix4().makeRotationFromEuler(new Object3D().rotation.set(tiltX, 0, tiltZ)));
  g.translate(x, y, z);
  return finish(g);
}

export function merged(parts: BufferGeometry[]): BufferGeometry {
  // mergeGeometries needs identical attribute sets and index-ness: drop uv, expand indices (normals stay smooth)
  const prepared = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    g.deleteAttribute('uv');
    return g;
  });
  const g = mergeGeometries(prepared, false);
  if (!g) throw new Error('flora: mergeGeometries failed (attribute mismatch)');
  return g;
}

