/**
 * Gallery / photo camera: named presets (from `module.gallery.cams`), free cameras, and mouse orbit.
 *
 * When `active` the engine overwrites `ctx.camera` after all modules have updated, so a module's own follow camera
 * keeps running underneath (no cooperation needed) and `setCam('game')` simply hands the camera back.
 *
 * Mouse (only while a preset/free camera is active): left-drag orbit · right-drag / shift-drag pan · wheel dolly.
 */
import { Vector3, type PerspectiveCamera } from 'three';
import type { GalleryCam, Vec3 } from './types';

export const DEFAULT_FOV = 52;

export class GalleryCamera {
  active = false;
  /** name of the active preset, 'custom' for a free camera, null when inactive */
  current: string | null = null;
  readonly pos = new Vector3(0, 10, 18);
  readonly target = new Vector3(0, 2, 0);
  fov = DEFAULT_FOV;
  /**
   * Preset sources are kept BY REFERENCE: a module may mutate / extend its `gallery.cams` record at any time
   * (e.g. `gallery.setup` framing a camera on something that only exists at runtime).
   */
  private sources: { cams: Record<string, GalleryCam>; prefix: string }[] = [];

  /** the preset names in registration order */
  get names(): string[] {
    const out: string[] = [];
    for (const s of this.sources) for (const k of Object.keys(s.cams)) out.push(s.prefix + k);
    return out;
  }

  addPresets(cams: Record<string, GalleryCam>, prefix = ''): void {
    this.sources.push({ cams, prefix });
  }

  private lookup(name: string): GalleryCam | undefined {
    for (const s of this.sources) {
      if (name.startsWith(s.prefix)) {
        const v = s.cams[name.slice(s.prefix.length)];
        if (v) return v;
      }
    }
    // short name of a namespaced preset ("close" -> "other:close")
    for (const s of this.sources) {
      if (s.prefix) {
        const v = s.cams[name];
        if (v) return v;
      }
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  /** activate a preset by name, or a free camera. Returns false for unknown names. */
  set(cam: string | { pos: Vec3; target: Vec3; fov?: number }): boolean {
    if (typeof cam === 'string') {
      if (cam === 'game' || cam === 'follow' || cam === 'none') {
        this.release();
        return true;
      }
      const p = this.lookup(cam);
      if (!p) return false;
      this.pos.set(...p.pos);
      this.target.set(...p.target);
      this.fov = p.fov ?? DEFAULT_FOV;
      this.current = cam;
    } else {
      this.pos.set(...cam.pos);
      this.target.set(...cam.target);
      this.fov = cam.fov ?? DEFAULT_FOV;
      this.current = 'custom';
    }
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
    this.current = null;
  }

  /** write the override into the render camera (call after module updates) */
  apply(camera: PerspectiveCamera): void {
    if (!this.active) return;
    camera.position.copy(this.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  // ---- interactive orbit ------------------------------------------------------------------

  orbit(dx: number, dy: number): void {
    const off = this.pos.clone().sub(this.target);
    const r = off.length();
    let theta = Math.atan2(off.x, off.z);
    let phi = Math.acos(Math.min(1, Math.max(-1, off.y / (r || 1))));
    theta -= dx * 0.0055;
    phi = Math.min(Math.PI - 0.04, Math.max(0.04, phi - dy * 0.0055));
    off.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)).multiplyScalar(r);
    this.pos.copy(this.target).add(off);
    this.current = 'custom';
  }

  dolly(deltaY: number): void {
    const off = this.pos.clone().sub(this.target);
    const r = Math.min(900, Math.max(0.15, off.length() * Math.exp(deltaY * 0.0012)));
    this.pos.copy(this.target).add(off.setLength(r));
    this.current = 'custom';
  }

  pan(dx: number, dy: number): void {
    const off = this.pos.clone().sub(this.target);
    const r = off.length();
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), off).normalize();
    const up = new Vector3().crossVectors(off, right).normalize();
    const k = r * 0.0016;
    // "grab" panning: the scene follows the cursor, so the camera moves opposite to the drag
    const d = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
    this.pos.add(d);
    this.target.add(d);
    this.current = 'custom';
  }
}
