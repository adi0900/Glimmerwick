/**
 * Story world pieces built with the existing bridge commands only: a ground/solidity helper, the Glimmerlight
 * lighthouse (placed with `world.place_block`, rebuilt on load because the sim does not save edits yet), glow
 * markers for the lens pickups, and the lighthouse lamp / beam effect.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Sprite,
  SpriteMaterial,
  type Scene,
} from 'three';
import type { Ctx } from '../../engine/types';
import type { MarkerDef } from './engine';

export interface Ground {
  h: number;
  ok: boolean;
  biome: number;
  blockY: number;
}

export class Terrain {
  private readonly solid = new Set<number>();
  private readonly cache = new Map<string, { at: number; g: Ground }>();

  constructor(private readonly ctx: Ctx) {
    try {
      const reg = ctx.game.query('world.blocks', {}) as { blocks?: Array<{ id: number; solid: boolean }> } | Array<{ id: number; solid: boolean }>;
      const list = Array.isArray(reg) ? reg : (reg?.blocks ?? []);
      for (const b of list) if (b.solid) this.solid.add(b.id);
    } catch {
      /* fall back to "everything non-zero is solid" */
    }
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    try {
      const r = this.ctx.game.query('world.block', { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }) as { id?: number } | null;
      const id = r?.id ?? 0;
      return this.solid.size ? this.solid.has(id) : id !== 0;
    } catch {
      return false;
    }
  }

  /** natural ground height + "an NPC may stand here" (dry land, two free cells above the ground) */
  ground(x: number, z: number): Ground {
    const key = `${Math.floor(x * 2)},${Math.floor(z * 2)}`;
    const now = performance.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < 1500) return hit.g;
    let g: Ground = { h: 0, ok: false, biome: 0, blockY: 0 };
    try {
      const r = this.ctx.game.query('world.ground', { x, z }) as { height: number; block_y: number; biome: number } | null;
      if (r && typeof r.height === 'number') {
        const dry = r.biome > 1;
        const free = dry && !this.isSolidAt(x, r.block_y + 1, z) && !this.isSolidAt(x, r.block_y + 2, z);
        g = { h: r.height, ok: dry && free, biome: r.biome, blockY: r.block_y };
      }
    } catch {
      /* ignore */
    }
    this.cache.set(key, { at: now, g });
    if (this.cache.size > 600) this.cache.clear();
    return g;
  }

  /** nearest free standing spot to (x,z), spiralling outwards (for markers: never inside a trunk) */
  freeSpot(x: number, z: number, maxR = 14): { x: number; z: number; g: Ground } | null {
    const c = this.ground(x, z);
    for (let r = 0; r <= maxR; r += 1.5) {
      const n = r === 0 ? 1 : 10;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const g = this.ground(px, pz);
        if (g.ok && Math.abs(g.h - c.h) < 3.5) return { x: px, z: pz, g };
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ lighthouse

export interface LighthouseSite {
  x: number;
  z: number;
  baseY: number;
  /** unit vector from the lighthouse towards the village */
  vx: number;
  vz: number;
}

export function findLighthouseSite(terrain: Terrain, village: { x: number; z: number }): LighthouseSite {
  let best: LighthouseSite | null = null;
  for (let r = 26; r <= 96 && !best; r += 4) {
    for (let a = 0; a < 360 && !best; a += 12) {
      const rad = (a * Math.PI) / 180;
      const x = Math.floor(village.x + Math.cos(rad) * r) + 0.5;
      const z = Math.floor(village.z + Math.sin(rad) * r) + 0.5;
      const g = terrain.ground(x, z);
      if (g.biome !== 2 || g.h < 0.3 || g.h > 4.5) continue;
      // flat pad and open water not far to seaward
      let flat = true;
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
        const q = terrain.ground(x + dx, z + dz);
        if (!q.ok || Math.abs(q.h - g.h) > 1.1) flat = false;
      }
      const out = terrain.ground(x + Math.cos(rad) * 12, z + Math.sin(rad) * 12);
      if (!flat || !(out.biome <= 1)) continue;
      const d = Math.hypot(village.x - x, village.z - z);
      best = { x, z, baseY: g.blockY + 1, vx: (village.x - x) / d, vz: (village.z - z) / d };
    }
  }
  if (!best) {
    const x = Math.floor(village.x + 34) + 0.5;
    const z = Math.floor(village.z) + 0.5;
    const g = terrain.ground(x, z);
    best = { x, z, baseY: g.blockY + 1, vx: -1, vz: 0 };
  }
  return best;
}

type Cell = [number, number, number, string];

function lighthouseCells(s: LighthouseSite): { shell: Cell[]; lamp: Cell[]; pedestal: [number, number, number] } {
  const cx = Math.floor(s.x);
  const cz = Math.floor(s.z);
  const y0 = s.baseY;
  const shell: Cell[] = [];
  // footing 7x7 of cobble, one block high
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.abs(dx) + Math.abs(dz) < 6) shell.push([cx + dx, y0, cz + dz, 'cobble']);
  // the round-ish tower: 5x5 ring without corners, striped plaster / red tile
  for (let h = 1; h <= 11; h++) {
    const name = h <= 2 ? 'stone' : h % 4 < 2 ? 'plaster' : 'roof_tile';
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || (Math.abs(dx) === 2 && Math.abs(dz) === 2)) continue;
      if (h <= 2 && dx === 0 && dz === 2) continue; // doorway
      shell.push([cx + dx, y0 + h, cz + dz, name]);
    }
  }
  // gallery floor 7x7
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.abs(dx) + Math.abs(dz) < 6) shell.push([cx + dx, y0 + 12, cz + dz, 'stone']);
  // lamp room: glass ring around a free centre (two high), roof
  for (let h = 13; h <= 14; h++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx !== 0 || dz !== 0) shell.push([cx + dx, y0 + h, cz + dz, 'glass']);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) < 4) shell.push([cx + dx, y0 + 15, cz + dz, 'roof_tile']);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) shell.push([cx + dx, y0 + 16, cz + dz, 'roof_tile']);
  shell.push([cx, y0 + 17, cz, 'roof_tile']);
  // lit: lanterns in the lamp room + at the gallery corners
  const lamp: Cell[] = [[cx, y0 + 13, cz, 'lantern'], [cx, y0 + 14, cz, 'lantern']];
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) lamp.push([cx + dx, y0 + 13, cz + dz, 'lantern']);
  const px = cx + Math.round(s.vx * 5);
  const pz = cz + Math.round(s.vz * 5);
  return { shell, lamp, pedestal: [px, y0, pz] };
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,236,170,0.75)');
  gr.addColorStop(1, 'rgba(255,200,90,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

export class Lighthouse {
  readonly site: LighthouseSite;
  readonly pedestal: [number, number, number];
  readonly top: { x: number; y: number; z: number };
  lit = false;
  private queue: Cell[] = [];
  private built = false;
  private readonly cells: ReturnType<typeof lighthouseCells>;
  private readonly group = new Group();
  private readonly glow: Sprite;
  private readonly beam: Group;
  private readonly beamMat: MeshBasicMaterial;
  private readonly glowMat: SpriteMaterial;

  constructor(
    private readonly ctx: Ctx,
    scene: Scene,
    site: LighthouseSite,
  ) {
    this.site = site;
    this.cells = lighthouseCells(site);
    this.pedestal = this.cells.pedestal;
    this.top = { x: Math.floor(site.x) + 0.5, y: site.baseY + 13.9, z: Math.floor(site.z) + 0.5 };
    this.glowMat = new SpriteMaterial({ map: glowTexture(), color: 0xffe2a0, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
    this.glow = new Sprite(this.glowMat);
    this.glow.position.set(this.top.x, this.top.y, this.top.z);
    this.group.add(this.glow);
    this.beamMat = new MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false });
    const geo = new CylinderGeometry(0.2, 3.4, 46, 14, 1, true);
    geo.translate(0, 23, 0);
    geo.rotateZ(-Math.PI / 2);
    this.beam = new Group();
    const b1 = new Mesh(geo, this.beamMat);
    const b2 = new Mesh(geo, this.beamMat);
    b2.rotation.y = Math.PI;
    this.beam.add(b1, b2);
    this.beam.position.set(this.top.x, this.top.y, this.top.z);
    this.group.add(this.beam);
    scene.add(this.group);
  }

  /** is the tower already in the world (a previous load / another session)? */
  private alreadyBuilt(): boolean {
    const s = this.site;
    try {
      const r = this.ctx.game.query('world.block', { x: Math.floor(s.x) + 2, y: s.baseY + 5, z: Math.floor(s.z) }) as { id?: number } | null;
      return (r?.id ?? 0) !== 0;
    } catch {
      return false;
    }
  }

  /** queue the construction; `tick` places a few blocks per frame */
  startBuild(): void {
    if (this.built) return;
    this.built = true;
    if (this.alreadyBuilt()) return;
    this.queue = [...this.cells.shell, [...this.cells.pedestal, 'cobble'] as Cell];
  }

  /** returns true while there is still work */
  tick(budget = 36): boolean {
    let n = 0;
    while (this.queue.length && n++ < budget) {
      const [x, y, z, name] = this.queue.shift()!;
      this.ctx.game.command('world.place_block', { x, y, z, name });
    }
    return this.queue.length > 0;
  }

  get building(): boolean {
    return this.queue.length > 0;
  }

  setLit(on: boolean): void {
    if (on === this.lit) return;
    this.lit = on;
    if (on) for (const [x, y, z, name] of this.cells.lamp) this.ctx.game.command('world.place_block', { x, y, z, name });
  }

  update(t: number, dt: number): void {
    const night = this.ctx.uniforms.uNight.value as number;
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
    const s = this.lit ? 9 + pulse * 2.5 + night * 4 : 1.8 + 0.5 * Math.sin(t * 2.3);
    this.glow.scale.set(s, s, 1);
    this.glowMat.opacity = this.lit ? 0.85 : 0.22 * (0.4 + night);
    this.beam.rotation.y += dt * 0.55;
    this.beamMat.opacity = this.lit ? 0.025 + 0.26 * night : 0;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
  }
}

// ------------------------------------------------------------------------------------------------ markers

export class Marker {
  readonly group = new Group();
  readonly x: number;
  readonly y: number;
  readonly z: number;
  private readonly core: Mesh;
  private readonly col: Mesh;
  private readonly glow: Sprite;
  active = true;
  private sparkleT = 0;
  readonly rgb: [number, number, number];

  constructor(
    readonly id: string,
    readonly def: MarkerDef,
    scene: Scene,
    x: number,
    y: number,
    z: number,
  ) {
    this.x = x;
    this.y = y;
    this.z = z;
    const color = Number.parseInt(def.color.slice(1), 16);
    this.rgb = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    this.core = new Mesh(new OctahedronGeometry(0.3, 0), new MeshBasicMaterial({ color }));
    this.core.scale.set(0.8, 1.15, 0.8);
    this.col = new Mesh(
      new CylinderGeometry(0.22, 0.55, 9, 10, 1, true),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false }),
    );
    this.col.position.y = 3.6;
    const gm = new SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
    this.glow = new Sprite(gm);
    this.glow.scale.set(2.4, 2.4, 1);
    this.group.add(this.col, this.core, this.glow);
    this.group.position.set(x, y, z);
    scene.add(this.group);
  }

  update(t: number, dt: number, sparkle: (x: number, y: number, z: number, rgb: [number, number, number]) => void): void {
    this.group.visible = this.active;
    if (!this.active) return;
    this.core.position.y = 1.15 + Math.sin(t * 2) * 0.12;
    this.core.rotation.y = t * 1.4;
    this.glow.position.y = this.core.position.y;
    const k = 2.1 + Math.sin(t * 3.1) * 0.3;
    this.glow.scale.set(k, k, 1);
    this.sparkleT -= dt;
    if (this.sparkleT <= 0) {
      this.sparkleT = 0.9;
      sparkle(this.x, this.y + 1.2, this.z, this.rgb);
    }
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
  }
}
