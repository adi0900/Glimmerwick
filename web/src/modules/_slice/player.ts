/**
 * PLACEHOLDER player: a chibi built from lumpy blobs (head ~40 % of height), lit with ToonLit clay.
 * Drives itself from `bridge.player` (already interpolated). Final character art is the `characters` module's.
 */
import { Color, Group, Mesh, Vector3 } from 'three';
import type { PlayerState } from '../../engine/Bridge';
import type { Materials } from '../../engine/Materials';
import { blob, merged, paint, tube } from './kit';

const C = (hex: string) => new Color(hex);

export class PlayerAvatar {
  readonly group = new Group();
  private readonly body: Mesh;
  private t = 0;
  private lean = 0;
  private readonly vel = new Vector3();

  constructor(mats: Materials) {
    this.group.name = 'slice.player';
    const torso = paint(merged([blob(0.23, 0.3, 0.2, 0, 0.5, 0, 0.03, 1, 12)]), C('#E8554A'), C('#FF8F7F'));
    const head = paint(merged([blob(0.26, 0.24, 0.245, 0, 0.98, 0, 0.03, 2, 14)]), C('#FFC9A0'), C('#FFE0C4'));
    const hair = paint(merged([blob(0.285, 0.17, 0.27, 0, 1.12, -0.02, 0.04, 3, 12)]), C('#E8A21A'), C('#FFD35A'));
    const fringe = paint(merged([blob(0.2, 0.07, 0.1, 0, 1.06, 0.18, 0.03, 4, 8)]), C('#E8A21A'), C('#FFD35A'));
    const nose = paint(merged([blob(0.03, 0.025, 0.03, 0, 0.96, 0.24, 0.0, 1, 5)]), C('#FFB690'), C('#FFB690'));
    const eye = (sx: number) =>
      merged([
        paint(blob(0.04, 0.052, 0.03, sx * 0.1, 1.0, 0.225, 0.0, 1, 7), C('#3A2D4A'), C('#3A2D4A')),
        paint(blob(0.016, 0.016, 0.01, sx * 0.1 + 0.012, 1.025, 0.25, 0.0, 1, 5), C('#FFFFFF'), C('#FFFFFF')),
      ]);
    const cheek = (sx: number) => paint(merged([blob(0.045, 0.03, 0.02, sx * 0.17, 0.93, 0.2, 0.0, 1, 6)]), C('#FF8FA0'), C('#FFB3BD'));
    const arm = (sx: number) => paint(merged([blob(0.07, 0.15, 0.07, sx * 0.3, 0.52, 0.02, 0.03, 5, 8)]), C('#E8554A'), C('#FF8F7F'));
    const hand = (sx: number) => paint(merged([blob(0.06, 0.06, 0.06, sx * 0.32, 0.36, 0.04, 0.02, 6, 7)]), C('#FFC9A0'), C('#FFE0C4'));
    const leg = (sx: number) => paint(merged([tube(0.075, 0.07, 0.24, sx * 0.1, 0.06, 0)]), C('#4A5FC8'), C('#6AB8FF'), 0, 0.3);
    const shoe = (sx: number) => paint(merged([blob(0.085, 0.055, 0.13, sx * 0.1, 0.05, 0.04, 0.03, 7, 8)]), C('#7A4A2B'), C('#B9783F'));
    const geo = merged([torso, head, hair, fringe, nose, eye(-1), eye(1), cheek(-1), cheek(1), arm(-1), arm(1), hand(-1), hand(1), leg(-1), leg(1), shoe(-1), shoe(1)]);
    const mat = mats.clay('#ffffff', { vertexColors: true, name: 'player', rim: 0.32 });
    this.body = new Mesh(geo, mat);
    this.body.name = 'slice.player.body';
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body);
  }

  update(p: PlayerState, dt: number, sea: number): void {
    this.group.visible = p.valid;
    if (!p.valid) return;
    this.t += dt;
    this.group.position.copy(p.pos);
    this.group.rotation.y = p.yaw;
    const swimming = p.waterDepth > 0.45;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    // lean into the motion + walk bounce + breathing; volume-preserving squash/stretch on jumps
    this.vel.set(p.vel.x, p.vel.y, p.vel.z);
    const targetLean = Math.min(0.28, speed * 0.05);
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-10 * Math.max(dt, 1 / 120)));
    const bounce = p.grounded && speed > 0.3 ? Math.abs(Math.sin(this.t * (6 + speed * 1.2))) * 0.045 * Math.min(1, speed / 3) : 0;
    const air = p.grounded ? 0 : Math.max(-0.12, Math.min(0.2, p.vel.y * 0.022));
    const breathe = speed < 0.2 ? Math.sin(this.t * 2.0) * 0.012 : 0;
    const sy = 1 + air + breathe;
    const sxz = 1 / Math.sqrt(sy);
    this.body.scale.set(sxz, sy, sxz);
    this.body.rotation.x = this.lean;
    this.body.position.y = bounce + (swimming ? -0.35 + Math.sin(this.t * 2.2) * 0.03 : 0);
    if (swimming) this.group.position.y = Math.max(p.pos.y, sea - 0.25);
  }

  dispose(): void {
    this.body.geometry.dispose();
    (this.body.material as { dispose(): void }).dispose();
  }
}
