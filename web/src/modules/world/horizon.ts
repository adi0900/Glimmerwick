/**
 * Horizon (module `world`): a ring of far islands + a haze band so the sea edge is never empty. Unlit silhouettes
 * that fade into the fog / sky colours with distance (layered aerial perspective: nearer = darker, tops clearer).
 */
import { BufferAttribute, BufferGeometry, Group, Mesh, ShaderMaterial } from 'three';
import type { Ctx } from '../../engine/types';

const VERT = /* glsl */ `
attribute float aT;
varying float vT;
varying vec3 vW;
void main() {
  vT = aT;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vT;
varying vec3 vW;
uniform vec3 uFogColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHemiGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uHaze;
uniform float uNight;
void main() {
  vec3 body = mix( uSkyZenith * 0.62 + vec3( 0.03, 0.04, 0.10 ), uSkyZenith * 0.85 + vec3( 0.06, 0.07, 0.12 ), clamp( vT * 0.8, 0.0, 1.0 ) );
  vec3 haze = mix( uFogColor, uSkyZenith, 0.5 );
  vec3 vd = normalize( vW - cameraPosition );
  float sunSide = pow( clamp( dot( vd, normalize( uSunDir ) ), 0.0, 1.0 ), 6.0 ) * ( 1.0 - uNight );
  vec3 col = mix( body, haze, uHaze );
  col = mix( col, uSkyHorizon, 0.25 * ( 1.0 - vT ) );
  col += uSunColor * sunSide * 0.05;
  gl_FragColor = vec4( col, 1.0 );
}
`;

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u;
}

export function buildHorizon(ctx: Ctx, seed: number, worldHalf: number): { group: Group; dispose(): void } {
  const u = ctx.uniforms;
  const group = new Group();
  group.name = 'world.horizon';
  const geos: BufferGeometry[] = [];
  const mats: ShaderMaterial[] = [];
  const count = 9;
  for (let k = 0; k < count; k++) {
    const hs = seed * 13 + k * 17.31;
    // spread around the compass with jitter; distances layered 650..2100 m
    const ang = ((k + 0.25 + hash(hs) * 0.5) / count) * Math.PI * 2;
    const dist = Math.max(worldHalf * 2.4, 650 + hash(hs + 1) * 1450);
    const R = 150 + hash(hs + 2) * 360;
    const H = 14 + hash(hs + 3) * 48;
    const rings = 12;
    const segs = 44;
    const pos: number[] = [];
    const at: number[] = [];
    const idx: number[] = [];
    const cx = Math.cos(ang) * dist;
    const cz = Math.sin(ang) * dist;
    const stretch = 0.55 + hash(hs + 4) * 0.7;
    pos.push(cx, H, cz);
    at.push(1);
    for (let r = 1; r <= rings; r++) {
      const rr = r / rings;
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const wob = 0.7 + 0.5 * vnoise(a * 2.2 + hs, 5) + 0.25 * vnoise(a * 5.7 + hs, 9);
        const radius = R * rr * wob;
        const prof = Math.pow(Math.max(0, 1 - rr * rr), 0.8) * (0.62 + 0.55 * vnoise(a * 3.1 + rr * 4 + hs, 11));
        const y = Math.max(-30, H * prof - (rr > 0.97 ? 40 : 0));
        pos.push(cx + Math.cos(a) * radius * stretch, y, cz + Math.sin(a) * radius);
        at.push(Math.max(0, y / H));
      }
    }
    for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + ((s + 1) % segs));
    for (let r = 1; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = 1 + (r - 1) * segs + s;
        const b = 1 + (r - 1) * segs + ((s + 1) % segs);
        const c = a + segs;
        const d = b + segs;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aT', new BufferAttribute(new Float32Array(at), 1));
    geo.setIndex(idx);
    // keep faces visible from every side (cheap, silhouettes only)
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: 2,
      fog: false,
      uniforms: {
        uFogColor: u.uFogColor,
        uSkyZenith: u.uSkyZenith,
        uSkyHorizon: u.uSkyHorizon,
        uHemiGround: u.uHemiGround,
        uSunColor: u.uSunColor,
        uSunDir: u.uSunDir,
        uNight: u.uNight,
        uHaze: { value: 0.5 + 0.38 * Math.min(1, (dist - 650) / 1500) },
      },
    });
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = `world.horizon.${k}`;
    group.add(mesh);
    geos.push(geo);
    mats.push(mat);
  }
  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      group.removeFromParent();
    },
  };
}
