/**
 * atmosphere -- the look module's gallery + service layer.
 *
 * The heavy lifting lives in the engine files the look owner controls: sky + clouds + cloud-shadow pass
 * (engine/Lighting.ts, engine/glsl/clouds.glsl), final image (engine/Post.ts), ToonLit (engine/Materials.ts).
 * This module provides:
 *   - gallery cameras (hero / sunset / dawn / clouds / material / player) derived from the real world data, used by
 *     `node tools/shot.mjs --pack atmosphere --round N` (shots.json) -- run with `with=_slice` until the world module lands
 *   - sun-aware cameras: `sunset`, `dawn` and `clouds` re-aim at the real sun (or the moon at night) azimuth for the
 *     first seconds, so the shots work whatever azimuth the sim uses
 *   - `ctx.api.atmosphere`: the shared cloud-field state (drift / cover / altitude) for weather / fx modules
 *   - (round 2+) weather particles, fireflies, lightning
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import type { Ctx, GalleryCam, Vec3 } from '../../engine/types';
import { defineModule } from '../../engine/types';

// defaults for the 256 m mock island; `gallery.setup` replaces them with cams derived from the real world
const cams: Record<string, GalleryCam> = {
  hero: { pos: [14, 46, 128], target: [-6, 2, 8], fov: 50 },
  sunset: { pos: [52, 12, 0], target: [-230, 14, 8], fov: 55 },
  dawn: { pos: [-52, 12, 0], target: [230, 12, 8], fov: 55 },
  clouds: { pos: [-6, 2, 34], target: [-130, 90, 44], fov: 62 },
  material: { pos: [-3.9, 2.0, 37], target: [-6, 1.0, 34], fov: 46 },
  player: { pos: [-3.2, 4.9, 41.6], target: [-6, 1.9, 34], fov: 52 },
};

interface Frame {
  cx: number;
  cz: number;
  S: number;
  sx: number;
  sz: number;
  ground: (x: number, z: number) => number;
}
let F: Frame | null = null;

function derive(ctx: Ctx): void {
  const w = ctx.game.world;
  if (!w.ready || !w.info) return;
  const info = w.info as Record<string, any>;
  const ex = w.extentX || 256;
  const ez = w.extentZ || 256;
  const S = Math.max(ex, ez);
  const cx = (info.origin_x ?? -ex / 2) + ex / 2;
  const cz = (info.origin_z ?? -ez / 2) + ez / 2;
  const ground = (x: number, z: number) => Math.max(w.sample(x, z), w.seaLevel);
  let sx = cx;
  let sz = cz + 0.13 * S;
  const sp = info.spawn;
  if (sp && Array.isArray(sp.player)) {
    sx = sp.player[0];
    sz = sp.player[1];
  } else if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.z)) {
    sx = sp.x;
    sz = sp.z;
  }
  ctx.game.command('debug.teleport', { x: sx, z: sz }, true);
  F = { cx, cz, S, sx, sz, ground };
  const g = ground(sx, sz);
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  cams.hero = { pos: v(cx + 0.055 * S, 0.18 * S, cz + 0.5 * S), target: v(cx - 0.023 * S, 2, cz + 0.03 * S), fov: 50 };
  cams.sunset = { pos: v(cx + 0.2 * S, ground(cx + 0.2 * S, cz) + 11, cz - 0.02 * S), target: v(cx - 0.9 * S, 0.055 * S, cz + 0.03 * S), fov: 55 };
  cams.dawn = { pos: v(cx - 0.2 * S, ground(cx - 0.2 * S, cz) + 11, cz - 0.02 * S), target: v(cx + 0.9 * S, 0.05 * S, cz + 0.03 * S), fov: 55 };
  cams.clouds = { pos: v(sx, g + 1.8, sz), target: v(sx - 0.5 * S, g + 0.34 * S, sz + 0.04 * S), fov: 62 };
  cams.material = { pos: v(sx + 2.1, g + 1.25, sz + 2.9), target: v(sx, g + 0.7, sz), fov: 46 };
  cams.player = { pos: v(sx + 2.6, g + 3.2, sz + 7.2), target: v(sx, g + 1.2, sz), fov: 52 };
}

/** re-aim the sun-facing cameras at the real sun azimuth (moon when the sun is below the horizon) */
function aim(ctx: Ctx): void {
  const name = ctx.view.params.cam;
  if (!F || (name !== 'sunset' && name !== 'dawn' && name !== 'clouds')) return;
  const sd = ctx.env.sunDir;
  const night = ctx.env.hours > 21 || ctx.env.hours < 4.5;
  const k = name === 'clouds' && night ? -1 : 1; // sunset / dawn always face the sun, the cloud cam faces the moon at night
  const l = Math.hypot(sd.x, sd.z) || 1;
  const hx = (sd.x / l) * k;
  const hz = (sd.z / l) * k;
  const { cx, cz, S, sx, sz, ground } = F;
  let cam: GalleryCam;
  if (name === 'clouds') {
    const y = ground(sx, sz) + 1.8;
    cam = { pos: [sx, y, sz], target: [sx + hx * 0.5 * S, y + 0.3 * S, sz + hz * 0.5 * S], fov: 62 };
  } else {
    const px = cx - hx * 0.22 * S;
    const pz = cz - hz * 0.22 * S;
    const y = ground(px, pz) + 11;
    cam = { pos: [px, y, pz], target: [cx + hx * 0.9 * S, y + 0.03 * S, cz + hz * 0.9 * S], fov: 55 };
  }
  (window as any).__game?.setCam?.(cam);
}

// ---- fireflies: a few dozen soft glowing motes around the player at night (all motion in the vertex shader: zero CPU per frame)
const FF_N = 48;
const FF_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform float uTime;
uniform float uNight;
uniform vec3 uPlayer;
varying float vA;
void main() {
  vec3 s = aSeed;
  float t = uTime * ( 0.18 + s.z * 0.22 );
  vec2 base = ( s.xy - 0.5 ) * 40.0;
  vec2 o = base + vec2( sin( t * 1.7 + s.x * 40.0 ), cos( t * 1.3 + s.y * 40.0 ) ) * 2.4;
  vec3 p = vec3( uPlayer.x + o.x, uPlayer.y + 0.45 + s.z * 2.4 + sin( t * 3.1 + s.y * 20.0 ) * 0.35, uPlayer.z + o.y );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float blink = pow( 0.5 + 0.5 * sin( uTime * ( 1.1 + s.x * 1.6 ) + s.y * 31.0 ), 2.5 );
  vA = ( 0.25 + 0.75 * blink ) * uNight;
  gl_PointSize = clamp( 300.0 / max( -mv.z, 2.0 ), 3.0, 22.0 );
}
`;
const FF_FRAG = /* glsl */ `
precision highp float;
varying float vA;
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float core = smoothstep( 1.0, 0.0, d );
  float a = core * core * vA;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( vec3( 1.0, 0.86, 0.40 ) * ( a * 2.6 ), a );
}
`;

function makeFireflies(ctx: Ctx): void {
  const geo = new BufferGeometry();
  const seeds = new Float32Array(FF_N * 3);
  let h = 12345;
  const rnd = (): number => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
  for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(FF_N * 3), 3));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 3));
  const mat = new ShaderMaterial({
    uniforms: { uTime: ctx.uniforms.uTime, uNight: ctx.uniforms.uNight, uPlayer: ctx.uniforms.uPlayerPos },
    vertexShader: FF_VERT,
    fragmentShader: FF_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const pts = new Points(geo, mat);
  pts.name = 'gw.fireflies';
  pts.frustumCulled = false;
  pts.renderOrder = 10;
  ctx.scene.add(pts);
}

export default defineModule({
  name: 'atmosphere',
  order: 5,
  init(ctx) {
    ctx.api.atmosphere = { cloud: ctx.lighting.cloud };
    try {
      makeFireflies(ctx);
    } catch (e) {
      console.warn('[atmosphere] fireflies disabled', e);
    }
    ctx.debug.line('clouds', () => `cover ${ctx.lighting.cloud.cover.toFixed(2)} drift ${ctx.lighting.cloud.drift.x.toFixed(0)},${ctx.lighting.cloud.drift.y.toFixed(0)}`);
  },
  update(ctx) {
    if (ctx.clock.frame < 900) aim(ctx);
  },
  gallery: {
    cams,
    setup(ctx) {
      derive(ctx);
    },
  },
});
