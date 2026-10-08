/**
 * In-world feedback for the gameplay slice: target-block outline, crack overlay, placement ghost and a small pool of
 * voxel-chip particles (break / place / befriend). One InstancedMesh for all particles, a handful of meshes in total.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  Object3D,
  SRGBColorSpace,
  type Scene,
} from 'three';

const MAX_PARTICLES = 220;
const CRACK_STAGES = 10;

function makeCrackTexture(): CanvasTexture {
  const T = 64;
  const cv = document.createElement('canvas');
  cv.width = T * CRACK_STAGES;
  cv.height = T;
  const g = cv.getContext('2d')!;
  // deterministic random walks from the centre, drawn as 4px texels; stage s shows the first (s+1)/N of every walk
  let seed = 1234567;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const walks: Array<Array<[number, number]>> = [];
  for (let w = 0; w < 7; w++) {
    let x = 8 + Math.floor(rnd() * 2) * 0;
    let y = 8;
    x += Math.floor((rnd() - 0.5) * 4);
    y += Math.floor((rnd() - 0.5) * 4);
    const ang = (w / 7) * Math.PI * 2 + rnd() * 0.5;
    let dx = Math.cos(ang);
    let dy = Math.sin(ang);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 12; i++) {
      pts.push([Math.round(x), Math.round(y)]);
      if (rnd() < 0.5) {
        dx += (rnd() - 0.5) * 1.1;
        dy += (rnd() - 0.5) * 1.1;
      }
      const m = Math.hypot(dx, dy) || 1;
      x += dx / m;
      y += dy / m;
    }
    walks.push(pts);
  }
  for (let s = 0; s < CRACK_STAGES; s++) {
    const frac = (s + 1) / CRACK_STAGES;
    for (const pts of walks) {
      const n = Math.max(1, Math.ceil(pts.length * frac));
      for (let i = 0; i < n; i++) {
        const [px, py] = pts[i]!;
        if (px < 0 || py < 0 || px > 15 || py > 15) continue;
        g.fillStyle = 'rgba(32,18,40,0.78)';
        g.fillRect(s * T + px * 4, py * 4, 4, 4);
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(s * T + px * 4 + 4, py * 4, 2, 4);
      }
    }
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.repeat.set(1 / CRACK_STAGES, 1);
  return tex;
}

export class GameFx {
  readonly root = new Group();
  private outline: LineSegments;
  private outlineHidden: LineSegments;
  private crack: Mesh;
  private crackTex: CanvasTexture;
  private ghost: Mesh;
  private ghostEdges: LineSegments;
  private particles: InstancedMesh;
  private pdata: Array<{ x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; spin: number; grav: number }> = [];
  private dummy = new Object3D();
  private tmpColor = new Color();
  private t = 0;
  private targetBlocked = false;

  constructor(scene: Scene) {
    this.root.name = 'gameplay-fx';
    const edges = new EdgesGeometry(new BoxGeometry(1.012, 1.012, 1.012));
    this.outline = new LineSegments(edges, new LineBasicMaterial({ color: 0xfff6e4, transparent: true, opacity: 0.95 }));
    this.outlineHidden = new LineSegments(edges, new LineBasicMaterial({ color: 0xfff6e4, transparent: true, opacity: 0.22, depthTest: false }));
    this.outline.renderOrder = 998;
    this.outlineHidden.renderOrder = 997;
    this.crackTex = makeCrackTexture();
    this.crack = new Mesh(
      new BoxGeometry(1.018, 1.018, 1.018),
      new MeshBasicMaterial({ map: this.crackTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.crack.renderOrder = 996;
    this.ghost = new Mesh(new BoxGeometry(0.97, 0.97, 0.97), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.34, depthWrite: false }));
    this.ghostEdges = new LineSegments(new EdgesGeometry(new BoxGeometry(0.99, 0.99, 0.99)), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    this.ghost.renderOrder = 995;
    this.ghostEdges.renderOrder = 995;
    for (const o of [this.outline, this.outlineHidden, this.crack, this.ghost, this.ghostEdges]) {
      o.visible = false;
      o.frustumCulled = false;
      this.root.add(o);
    }
    this.particles = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffffff }), MAX_PARTICLES);
    this.particles.instanceMatrix.setUsage(DynamicDrawUsage);
    this.particles.frustumCulled = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pdata.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0, spin: 0, grav: 12 });
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.particles.setMatrixAt(i, this.dummy.matrix);
      this.particles.setColorAt(i, this.tmpColor.set(0xffffff));
    }
    this.root.add(this.particles);
    scene.add(this.root);
  }

  /** target block cell (integer corner) or null; `progress` 0..1 drives the crack overlay */
  setTarget(cell: [number, number, number] | null, breakable: boolean, progress: number): void {
    this.targetBlocked = !breakable;
    for (const o of [this.outline, this.outlineHidden]) {
      o.visible = !!cell;
      if (cell) o.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
      (o.material as LineBasicMaterial).color.set(breakable ? 0xfff6e4 : 0xff8a80);
    }
    const showCrack = !!cell && progress > 0.02;
    this.crack.visible = showCrack;
    if (showCrack && cell) {
      this.crack.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
      const stage = Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES));
      this.crackTex.offset.x = stage / CRACK_STAGES;
      // a small shiver while chopping
      const j = 0.012 * progress;
      this.crack.position.x += Math.sin(this.t * 71) * j;
      this.crack.position.z += Math.cos(this.t * 63) * j;
    }
  }

  setGhost(cell: [number, number, number] | null, rgb?: [number, number, number]): void {
    this.ghost.visible = this.ghostEdges.visible = !!cell;
    if (!cell) return;
    this.ghost.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
    this.ghostEdges.position.copy(this.ghost.position);
    if (rgb) (this.ghost.material as MeshBasicMaterial).color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
  }

  /** chips flying out of a block */
  burst(x: number, y: number, z: number, rgb: [number, number, number], count = 14, speed = 3.2, size = 0.11): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, rgb, speed, size, 0.55 + Math.random() * 0.4, 14);
  }

  /** soft upward sparkles (befriend / goal), no gravity */
  sparkle(x: number, y: number, z: number, rgb: [number, number, number], count = 18): void {
    for (let i = 0; i < count; i++) {
      const jitter = (c: number) => Math.max(0, Math.min(255, c + (Math.random() - 0.5) * 70));
      this.spawn(x, y, z, [jitter(rgb[0]), jitter(rgb[1]), jitter(rgb[2])], 1.8, 0.07 + Math.random() * 0.06, 0.9 + Math.random() * 0.7, -1.2);
    }
  }

  private spawn(x: number, y: number, z: number, rgb: [number, number, number], speed: number, size: number, life: number, grav: number): void {
    let slot = this.pdata.findIndex((p) => p.life <= 0);
    if (slot < 0) slot = Math.floor(Math.random() * MAX_PARTICLES);
    const a = Math.random() * Math.PI * 2;
    const up = 0.5 + Math.random();
    const s = speed * (0.4 + Math.random() * 0.7);
    const p = this.pdata[slot]!;
    p.x = x + (Math.random() - 0.5) * 0.5;
    p.y = y + (Math.random() - 0.5) * 0.5;
    p.z = z + (Math.random() - 0.5) * 0.5;
    p.vx = Math.cos(a) * s;
    p.vz = Math.sin(a) * s;
    p.vy = up * s * (grav > 0 ? 1.1 : 0.9);
    p.life = p.max = life;
    p.size = size * (0.7 + Math.random() * 0.6);
    p.spin = Math.random() * 6;
    p.grav = grav;
    this.particles.setColorAt(slot, this.tmpColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace));
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  update(dt: number, time: number): void {
    this.t = time;
    // outline breathes
    const k = 0.78 + 0.22 * Math.sin(time * 6.5);
    (this.outline.material as LineBasicMaterial).opacity = this.targetBlocked ? 0.6 : k;
    if (this.ghost.visible) {
      (this.ghost.material as MeshBasicMaterial).opacity = 0.26 + 0.1 * Math.sin(time * 5);
      (this.ghostEdges.material as LineBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(time * 5);
    }
    if (dt <= 0) return;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pdata[i]!;
      if (p.life <= 0) continue;
      any = true;
      p.life -= dt;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.grav < 0) {
        p.vx *= 1 - 1.5 * dt;
        p.vz *= 1 - 1.5 * dt;
      }
      const f = Math.max(0, p.life / p.max);
      const sc = p.size * (p.grav < 0 ? Math.sin(f * Math.PI) : Math.min(1, f * 2.5));
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.spin + time * 4, p.spin * 1.7 + time * 3, 0);
      this.dummy.scale.setScalar(Math.max(0, sc));
      this.dummy.updateMatrix();
      this.particles.setMatrixAt(i, this.dummy.matrix);
      if (p.life <= 0) {
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.particles.setMatrixAt(i, this.dummy.matrix);
      }
    }
    if (any) this.particles.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
