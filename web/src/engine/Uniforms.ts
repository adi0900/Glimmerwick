/**
 * Shared shader uniforms (contract: docs/WORLD_CONTRACT.md). The `{value}` holder objects are created once and
 * live for the whole page: materials capture the holders by reference, so updating `.value` is seen everywhere.
 * `Lighting` (look) and the engine fill them every frame; nobody else should write to them.
 */
import { Color, DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector2, Vector3, Vector4 } from 'three';
import type { SharedUniforms } from './types';

export const MAX_BENDERS = 16;

function whiteTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = t.minFilter = LinearFilter;
  t.needsUpdate = true;
  t.name = 'gw.white1x1';
  return t;
}

export function createSharedUniforms(): SharedUniforms {
  const benders: Vector4[] = [];
  for (let i = 0; i < MAX_BENDERS; i++) benders.push(new Vector4(0, 0, 0, 0));
  return {
    uTime: { value: 0 },
    uSunDir: { value: new Vector3(-0.58, 0.55, 0.6).normalize() },
    uSunColor: { value: new Color('#FFD08A') },
    uSunIntensity: { value: 2.8 },
    uSkyZenith: { value: new Color('#5B9CE6') },
    uSkyHorizon: { value: new Color('#FFE2B8') },
    uHemiSky: { value: new Color('#9FB9F0') },
    uHemiGround: { value: new Color('#A5A06A') },
    uFogColor: { value: new Color('#FFE0B5') },
    uFogDensity: { value: 0.009 },
    uWind: { value: new Vector2(0.8, 0.45) },
    uWindTime: { value: 0 },
    uPlayerPos: { value: new Vector3() },
    uTimeOfDay: { value: 16.5 },
    uNight: { value: 0 },
    uSeason: { value: 1 },
    uSeasonT: { value: 0.3 },
    uRain: { value: 0 },
    uSnow: { value: 0 },
    uWetness: { value: 0 },
    uCloudShadowTex: { value: whiteTexture() },
    uCloudShadowParams: { value: new Vector4(180, 0, 0, 0) },
    uWorldSize: { value: new Vector4(256, 256, -128, -128) },
    uBenders: { value: benders },
  };
}

/** Collects up to 16 benders per frame; keeps the ones nearest to the player (uPlayerPos). */
export class Benders {
  private count = 0;
  private readonly d2 = new Float32Array(MAX_BENDERS);

  constructor(private readonly u: SharedUniforms) {}

  /** called by the engine at the start of every frame */
  clear(): void {
    this.count = 0;
    const arr = this.u.uBenders.value;
    for (let i = 0; i < MAX_BENDERS; i++) arr[i]!.w = 0;
  }

  add(x: number, y: number, z: number, radius: number): void {
    const p = this.u.uPlayerPos.value;
    const d2 = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
    const arr = this.u.uBenders.value;
    if (this.count < MAX_BENDERS) {
      const i = this.count++;
      arr[i]!.set(x, y, z, radius);
      this.d2[i] = d2;
      return;
    }
    // full: replace the farthest if this one is nearer
    let far = 0;
    for (let i = 1; i < MAX_BENDERS; i++) if (this.d2[i]! > this.d2[far]!) far = i;
    if (d2 < this.d2[far]!) {
      arr[far]!.set(x, y, z, radius);
      this.d2[far] = d2;
    }
  }
}
