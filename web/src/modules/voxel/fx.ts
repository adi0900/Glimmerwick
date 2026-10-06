/**
 * Voxel ambient motion: leaves / petals drifting down from the foliage near the camera, and chimney smoke puffs.
 * One InstancedMesh of small tumbling quads (no per-frame allocation). Particles are spawned only where a leaf block
 * really has air below it, so they always come from visible canopies. dt = 0 while the sim is frozen (stills stay stable).
 */
import { Color, DoubleSide, InstancedMesh, MeshBasicMaterial, Object3D, PlaneGeometry, type Group } from 'three';
import type { Ctx } from '../../engine/types';
import type { VoxInfo } from './mesher';

const N = 110;
const SMOKE_N = 26;

export interface VoxFx {
  update(ctx: Ctx, dt: number): void;
  dispose(): void;
}

export function createFx(root: Group, info: VoxInfo, flags: Uint8Array, colors: Uint8Array, ): VoxFx {
  let chimneys: Array<[number, number, number]> = [];
  let scanned = false;
  const geo = new PlaneGeometry(0.2, 0.2);
  const mat = new MeshBasicMaterial({ side: DoubleSide, transparent: true, depthWrite: false });
  const mesh = new InstancedMesh(geo, mat, N + SMOKE_N);
  mesh.frustumCulled = false;
  mesh.name = 'voxel.fx';
  mesh.renderOrder = 5;
  root.add(mesh);
  const dummy = new Object3D();
  const col = new Color();
  // state: x y z . vx vz . phase . life (<= 0: dead) . kind (0 leaf, 1 smoke) . size
  const st = new Float32Array((N + SMOKE_N) * 9);
  for (let i = 0; i < N + SMOKE_N; i++) {
    dummy.position.set(0, -500, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, col.set('#ffffff'));
  }
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const { nx, ny, nz, originX, originZ, seaY } = info;
  const NCX = info.ncx;
  const CH = info.chunk;
  const CELLS = CH * CH * ny;
  const at = (data: Uint16Array, ix: number, l: number, iz: number): number => {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz || l < 0 || l >= ny) return 0;
    const c = Math.floor(iz / CH) * NCX + Math.floor(ix / CH);
    return data[c * CELLS + (((iz % CH) * CH + (ix % CH)) * ny + l)]!;
  };
  let lastT = -1;
  let smokeAcc = 0;
  let tmpColor = new Color();

  function spawnLeaf(data: Uint16Array, cx: number, cz: number): void {
    const a = rnd() * Math.PI * 2;
    const r = 3 + Math.sqrt(rnd()) * 42;
    const ix = Math.floor(cx + Math.cos(a) * r - originX);
    const iz = Math.floor(cz + Math.sin(a) * r - originZ);
    for (let l = ny - 2; l > seaY; l--) {
      const id = at(data, ix, l, iz);
      if (id === 0) continue;
      if (!(flags[id]! & 8)) return; // the topmost block is not foliage: nothing falls here
      // lowest leaf of this crown column that has air below: leaves fall from the underside
      let ll = l;
      while (ll > seaY && flags[at(data, ix, ll - 1, iz)]! & 8) ll--;
      if (at(data, ix, ll - 1, iz) !== 0) return;
      for (let i = 0; i < N; i++) {
        const b = i * 9;
        if (st[b + 7]! > 0) continue;
        st[b] = ix + originX + rnd();
        st[b + 1] = ll - seaY + 0.1;
        st[b + 2] = iz + originZ + rnd();
        st[b + 3] = (rnd() - 0.5) * 0.3;
        st[b + 4] = (rnd() - 0.5) * 0.3;
        st[b + 5] = rnd() * 6.28;
        st[b + 6] = 0;
        st[b + 7] = 6 + rnd() * 5;
        st[b + 8] = 0.7 + rnd() * 0.7;
        const o = id * 3;
        // leaf colour from the block average, brightened a little so it reads against the lawn
        col.setRGB(colors[o]! / 255, colors[o + 1]! / 255, colors[o + 2]! / 255, 'srgb').multiplyScalar(1.1);
        mesh.setColorAt(i, col);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        return;
      }
      return;
    }
  }

  function spawnSmoke(k: number): void {
    for (let i = N; i < N + SMOKE_N; i++) {
      const b = i * 9;
      if (st[b + 7]! > 0) continue;
      const c = chimneys[k]!;
      st[b] = c[0] + 0.5 + (rnd() - 0.5) * 0.25;
      st[b + 1] = c[1] + 0.9;
      st[b + 2] = c[2] + 0.5 + (rnd() - 0.5) * 0.25;
      st[b + 3] = 0;
      st[b + 4] = 0;
      st[b + 5] = rnd() * 6.28;
      st[b + 6] = 0;
      st[b + 7] = 3.4 + rnd() * 1.2;
      st[b + 8] = 0.3;
      st[b + 6] = 1;
      mesh.setColorAt(i, col.set('#f2eee8'));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      return;
    }
  }

  return {
    update(ctx, dt) {
      const data = ctx.game.channel<Uint16Array>('vox.data').data;
      if (!data || data.length === 0) return;
      const t = ctx.uniforms.uTime.value as number;
      if (!scanned) {
        scanned = true;
        // chimney caps: warm-stone block (id 4) with air above and two cobble blocks below
        for (let i = 2; i < data.length - 1; i++) {
          if (data[i] !== 4 || data[i + 1] !== 0 || data[i - 1] !== 34 || data[i - 2] !== 34) continue;
          const c = Math.floor(i / CELLS);
          const r = i - c * CELLS;
          const l = r % ny;
          const colI = (r - l) / ny;
          const ix = (c % NCX) * CH + (colI % CH);
          const iz = Math.floor(c / NCX) * CH + Math.floor(colI / CH);
          chimneys.push([ix + originX, l + 1 - seaY, iz + originZ]);
        }
      }
      if (lastT < 0) lastT = t;
      const step = dt > 0 ? Math.min(dt, 0.1) : Math.max(0, Math.min(t - lastT, 0.1));
      lastT = t;
      const cam = ctx.camera.position;
      const night = ctx.uniforms.uNight.value as number;
      // night: darker leaves; smoke catches the moon/lantern light a bit
      mat.color.setScalar(1 - 0.62 * night);
      if (step > 0) {
        for (let k = 0; k < 4; k++) if (rnd() < 0.55) spawnLeaf(data, cam.x, cam.z);
        smokeAcc += step;
        while (smokeAcc > 0.35 && chimneys.length) {
          smokeAcc -= 0.35;
          spawnSmoke(Math.floor(rnd() * chimneys.length));
        }
      }
      const wx = (ctx.uniforms as any).uWind?.value;
      const windX = wx ? wx.x : 0.6;
      const windZ = wx ? wx.y : 0.2;
      for (let i = 0; i < N + SMOKE_N; i++) {
        const b = i * 9;
        if (st[b + 7]! <= 0) {
          continue;
        }
        const smoke = st[b + 6] === 1;
        const age = step;
        st[b + 7]! -= age;
        st[b + 5]! += age * (smoke ? 0.6 : 2.4);
        const ph = st[b + 5]!;
        if (smoke) {
          st[b + 1]! += age * 0.8;
          st[b]! += (windX * 0.6 + Math.sin(ph) * 0.15) * age;
          st[b + 2]! += (windZ * 0.6 + Math.cos(ph * 0.8) * 0.15) * age;
          st[b + 8]! += age * 0.32;
        } else {
          st[b + 1]! -= age * (0.55 + 0.25 * Math.sin(ph * 0.7));
          st[b]! += (windX * 0.8 + Math.sin(ph) * 0.55) * age;
          st[b + 2]! += (windZ * 0.8 + Math.cos(ph * 1.3) * 0.45) * age;
          // landed: block at the particle position is solid
          const l = Math.floor(st[b + 1]! + seaY);
          const id = at(data, Math.floor(st[b]! - originX), l, Math.floor(st[b + 2]! - originZ));
          if (id !== 0 && flags[id]! & 1) st[b + 7] = Math.min(st[b + 7]!, 0.0);
        }
        const life = st[b + 7]!;
        if (life <= 0) {
          dummy.position.set(0, -500, 0);
          dummy.scale.setScalar(0.001);
        } else {
          dummy.position.set(st[b]!, st[b + 1]!, st[b + 2]!);
          if (smoke) {
            dummy.rotation.set(0, 0, 0);
            dummy.quaternion.copy(ctx.camera.quaternion);
            const f = Math.min(1, life / 1.2);
            dummy.scale.setScalar(st[b + 8]! * 1.4 * f);
          } else {
            dummy.rotation.set(ph * 0.9, ph * 0.6, ph * 0.4);
            dummy.scale.setScalar(st[b + 8]! * Math.min(1, life * 2));
          }
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      void tmpColor;
    },
    dispose() {
      root.remove(mesh);
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
