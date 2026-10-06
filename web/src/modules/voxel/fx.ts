/**
 * Voxel ambient motion: leaves / petals drifting down from the foliage near the camera, and chimney smoke puffs.
 * One InstancedMesh of small tumbling quads (no per-frame allocation). Particles are spawned only where a leaf block
 * really has air below it, so they always come from visible canopies. dt = 0 while the sim is frozen (stills stay stable).
 */
import { CanvasTexture, Color, DoubleSide, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, Object3D, PlaneGeometry, ShaderMaterial, Vector3, type Group } from 'three';
import type { Ctx } from '../../engine/types';
import type { VoxInfo } from './mesher';

const N = 150;
const SMOKE_N = 96;
const BF_N = 12;

export interface VoxFx {
  update(ctx: Ctx, dt: number): void;
  dispose(): void;
}

export function createFx(root: Group, info: VoxInfo, flags: Uint8Array, colors: Uint8Array, ): VoxFx {
  let chimneys: Array<[number, number, number]> = [];
  let scanned = false;
  const geo = new PlaneGeometry(0.2, 0.2);
  const mat = new MeshBasicMaterial({ side: DoubleSide, transparent: true, depthWrite: false });
  const mesh = new InstancedMesh(geo, mat, N);
  mesh.frustumCulled = false;
  mesh.name = 'voxel.fx';
  mesh.renderOrder = 5;
  root.add(mesh);
  const dummy = new Object3D();
  const col = new Color();
  // state: x y z . vx vz . phase . life (<= 0: dead) . kind (0 leaf, 1 smoke) . size
  const st = new Float32Array((N + SMOKE_N) * 9);
  // ---- smoke: soft round billboards with per-instance alpha (aA)
  const sgeo = new PlaneGeometry(1, 1);
  const aA = new InstancedBufferAttribute(new Float32Array(SMOKE_N), 1);
  sgeo.setAttribute('aA', aA);
  const smat = new ShaderMaterial({
    uniforms: { uCol: { value: new Color('#f1ede8') } },
    vertexShader: 'attribute float aA; varying float vA; varying vec2 vUv;\nvoid main(){ vUv = uv; vA = aA; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4( position, 1.0 ); }',
    fragmentShader: 'uniform vec3 uCol; varying float vA; varying vec2 vUv;\nvoid main(){ vec2 q = vUv - 0.5; float d = length( q ) * 2.0; float a = smoothstep( 1.0, 0.25, d ); a *= a * ( 0.85 + 0.15 * sin( q.x * 23.0 + q.y * 17.0 ) ); gl_FragColor = vec4( uCol, a * vA ); }',
    transparent: true,
    depthWrite: false,
  });
  const smesh = new InstancedMesh(sgeo, smat, SMOKE_N);
  smesh.frustumCulled = false;
  smesh.name = 'voxel.smoke';
  smesh.renderOrder = 6;
  root.add(smesh);
  // ---- butterflies
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g2 = cv.getContext('2d')!;
  g2.clearRect(0, 0, 64, 64);
  for (const [cx2, sg] of [[22, -1], [42, 1]] as const) {
    g2.fillStyle = '#ffffff';
    g2.strokeStyle = '#4a3a52';
    g2.lineWidth = 3;
    g2.beginPath();
    g2.ellipse(cx2 + sg * 3, 24, 13, 17, sg * 0.5, 0, Math.PI * 2);
    g2.fill();
    g2.stroke();
    g2.beginPath();
    g2.ellipse(cx2 + sg * 1, 44, 9, 11, -sg * 0.3, 0, Math.PI * 2);
    g2.fill();
    g2.stroke();
  }
  g2.fillStyle = '#3a2c40';
  g2.fillRect(30, 12, 4, 44);
  const bmat = new MeshBasicMaterial({ map: new CanvasTexture(cv), side: DoubleSide, transparent: true, alphaTest: 0.4 });
  const bmesh = new InstancedMesh(new PlaneGeometry(1, 1), bmat, BF_N);
  bmesh.frustumCulled = false;
  bmesh.name = 'voxel.butterflies';
  root.add(bmesh);
  const BFC = ['#ff9a3c', '#ffe45a', '#f6f2ff', '#ff7fb0', '#8cc8ff', '#ffb347'];
  const bf = new Float32Array(BF_N * 7); // x y z heading speed flap baseY
  let bfInit = false;
  const camDir = new Vector3();
  for (let i = 0; i < SMOKE_N; i++) {
    dummy.position.set(0, -500, 0);
    dummy.updateMatrix();
    smesh.setMatrixAt(i, dummy.matrix);
  }
  for (let i = 0; i < BF_N; i++) {
    dummy.position.set(0, -500, 0);
    dummy.updateMatrix();
    bmesh.setMatrixAt(i, dummy.matrix);
    bmesh.setColorAt(i, col.set(BFC[i % BFC.length]!));
  }
  for (let i = 0; i < N; i++) {
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
  let near: number[] = [];
  let nearT = -9;

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
      st[b + 7] = 4.2 + rnd() * 1.2;
      st[b + 8] = 0.3 + rnd() * 0.1;
      st[b + 6] = 1;
      return;
    }
  }

  return {
    update(ctx, dt) {
      const data = ctx.game.channel<Uint16Array>('vox.data').data;
      if (!data || data.length === 0) return;
      const t = ctx.uniforms.uTime.value as number;
      // gallery: the `sunset` / `night` cameras face the real sun / moon so the disc and halo are in frame
      if (ctx.clock.frame < 600) {
        const nm = (ctx.view as any).params?.cam;
        const sd = ctx.env.sunDir;
        const vil = (globalThis as any).__gwVillage as number[] | undefined;
        const gm = (window as any).__game;
        if (nm === 'sunset' && gm?.setCam) {
          const bp = ((globalThis as any).__gwCams?.sunset?.pos as number[] | undefined) ?? [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z];
          const c = { x: bp[0]!, y: bp[1]!, z: bp[2]! };
          const l = Math.hypot(sd.x, sd.z) || 1;
          const el = Math.asin(Math.max(-1, Math.min(1, sd.y)));
          gm.setCam({ pos: [c.x, c.y, c.z], target: [c.x + (sd.x / l) * 100, c.y + Math.tan(Math.max(el, 0.02) * 0.8) * 100 - 6, c.z + (sd.z / l) * 100], fov: 56 });
        } else if (nm === 'night' && vil && gm?.setCam) {
          const mx = -sd.x;
          const mz = -sd.z;
          const l = Math.hypot(mx, mz) || 1;
          const el = Math.asin(Math.max(-1, Math.min(1, -sd.y)));
          const hx = mx / l;
          const hz = mz / l;
          const px = vil[0]! - hx * 26;
          const pz = vil[1]! - hz * 26;
          const py = ctx.camera.position.y;
          gm.setCam({ pos: [px, py, pz], target: [px + hx * 30, py + 30 * Math.tan(0.14), pz + hz * 30], fov: 70 });
        }
      }
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
        if (!near.length || t - nearT > 1) {
          nearT = t;
          near = [];
          for (let k = 0; k < chimneys.length; k++) if (Math.hypot(chimneys[k]![0] - cam.x, chimneys[k]![2] - cam.z) < 110) near.push(k);
        }
        while (smokeAcc > 0.1 && near.length) {
          smokeAcc -= 0.1;
          spawnSmoke(near[Math.floor(rnd() * near.length)]!);
        }
      }
      const wx = (ctx.uniforms as any).uWind?.value;
      const windX = wx ? wx.x : 0.6;
      const windZ = wx ? wx.y : 0.2;
      for (let i = 0; i < N + SMOKE_N; i++) {
        const b = i * 9;
        const smoke = i >= N;
        if (st[b + 7]! <= 0) {
          if (smoke && aA.array[i - N] !== 0) {
            aA.array[i - N] = 0;
            dummy.position.set(0, -500, 0);
            dummy.scale.setScalar(0.001);
            dummy.updateMatrix();
            smesh.setMatrixAt(i - N, dummy.matrix);
          }
          continue;
        }
        const age = step;
        st[b + 7]! -= age;
        st[b + 5]! += age * (smoke ? 0.6 : 2.4);
        const ph = st[b + 5]!;
        if (smoke) {
          st[b + 1]! += age * 0.85;
          st[b]! += (windX * 0.55 + Math.sin(ph) * 0.18) * age;
          st[b + 2]! += (windZ * 0.55 + Math.cos(ph * 0.8) * 0.18) * age;
          st[b + 8]! += age * 0.2;
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
            // 0.3 m puff growing to ~1.1 m over its life; alpha 0.55 -> 0 (fade in over the first 0.4 s)
            const f = life / 4.8;
            dummy.scale.setScalar(st[b + 8]! * 2.4);
            aA.array[i - N] = 0.55 * Math.min(1, f) * Math.min(1, (5.4 - life) * 2.5) * (1 - night * 0.45);
          } else {
            dummy.rotation.set(ph * 0.9, ph * 0.6, ph * 0.4);
            dummy.scale.setScalar(st[b + 8]! * Math.min(1, life * 2));
          }
        }
        dummy.updateMatrix();
        if (smoke) smesh.setMatrixAt(i - N, dummy.matrix);
        else mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      smesh.instanceMatrix.needsUpdate = true;
      aA.needsUpdate = true;
      // smoke tint follows the light (warm at dusk, dim at night)
      {
        const sc = (ctx.uniforms as any).uSunColor?.value;
        const sr = sc ? (sc.r ?? sc.x ?? 1) : 1;
        const sg2 = sc ? (sc.g ?? sc.y ?? 1) : 1;
        const sb = sc ? (sc.b ?? sc.z ?? 1) : 1;
        const k = 1 - 0.7 * night;
        (smat.uniforms.uCol!.value as Color).setRGB((0.62 + 0.38 * Math.min(1, sr)) * k * 0.95 + 0.04, (0.62 + 0.38 * Math.min(1, sg2)) * k * 0.95 + 0.04, (0.62 + 0.38 * Math.min(1, sb)) * k * 0.95 + 0.07);
      }
      // ---- butterflies (day only): wander over land within ~35 m of the camera, wings flap
      {
        const w = ctx.game.world;
        const sea = w.seaLevel ?? 0;
        ctx.camera.getWorldDirection(camDir);
        const spawnBf = (i: number, ahead: boolean): void => {
          for (let tries = 0; tries < 8; tries++) {
            const a = ahead ? Math.atan2(camDir.z, camDir.x) + (rnd() - 0.5) * 1.8 : rnd() * 6.283;
            const r = 4 + rnd() * 20;
            const x = cam.x + Math.cos(a) * r;
            const z = cam.z + Math.sin(a) * r;
            const gh = w.sample(x, z);
            if (!(gh > sea + 0.4)) continue;
            const o = i * 7;
            bf[o] = x;
            bf[o + 2] = z;
            bf[o + 6] = gh + 0.9 + rnd() * 1.2;
            bf[o + 1] = bf[o + 6]!;
            bf[o + 3] = rnd() * 6.283;
            bf[o + 4] = 0.9 + rnd() * 0.8;
            bf[o + 5] = rnd() * 6.283;
            return;
          }
        };
        if (!bfInit && w.ready) {
          bfInit = true;
          for (let i = 0; i < BF_N; i++) spawnBf(i, true);
        }
        const vis = night < 0.3 && (ctx.uniforms.uSunDir.value as Vector3).y > 0.12 ? 1 : 0;
        const bs = Math.min(0.4, step);
        for (let i = 0; i < BF_N; i++) {
          const o = i * 7;
          bf[o + 3]! += (Math.sin(t * 0.9 + i * 2.1) * 1.3 + Math.sin(t * 2.3 + i) * 0.6) * bs;
          bf[o]! += Math.cos(bf[o + 3]!) * bf[o + 4]! * bs;
          bf[o + 2]! += Math.sin(bf[o + 3]!) * bf[o + 4]! * bs;
          bf[o + 5]! += bs * 24;
          const gh = w.sample(bf[o]!, bf[o + 2]!);
          const yy = Math.max(bf[o + 6]!, gh + 0.7) + Math.sin(bf[o + 5]! * 0.12) * 0.22;
          if (Math.hypot(bf[o]! - cam.x, bf[o + 2]! - cam.z) > 38 || gh < sea + 0.2) spawnBf(i, false);
          const flap = Math.abs(Math.sin(bf[o + 5]!));
          dummy.position.set(bf[o]!, yy, bf[o + 2]!);
          dummy.rotation.order = 'YXZ';
          dummy.rotation.set(-1.2 + 0.2 * Math.sin(bf[o + 5]! * 0.05), -bf[o + 3]! + Math.PI / 2, 0);
          dummy.scale.set(0.42 * (0.25 + 0.75 * flap) * vis + 0.0001, 0.34 * vis + 0.0001, 1);
          dummy.updateMatrix();
          bmesh.setMatrixAt(i, dummy.matrix);
          dummy.rotation.order = 'XYZ';
        }
        bmesh.instanceMatrix.needsUpdate = true;
        if (bmesh.instanceColor) bmesh.instanceColor.needsUpdate = true;
      }
      void tmpColor;
    },
    dispose() {
      root.remove(mesh);
      root.remove(smesh);
      root.remove(bmesh);
      smat.dispose();
      sgeo.dispose();
      bmat.dispose();
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
