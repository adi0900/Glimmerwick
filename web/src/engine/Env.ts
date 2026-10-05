/**
 * Effective time-of-day / weather (`ctx.env`): the sim's `time` channel with the photo-API overrides layered on top.
 * Visual modules should read `ctx.env` / `ctx.uniforms`, not the raw channel, so galleries can pin the hour.
 */
import { Vector3 } from 'three';
import type { Bridge } from './Bridge';
import { DEFAULT_HOURS } from './config';
import type { Env } from './types';

export function createEnv(): Env {
  return {
    hours: DEFAULT_HOURS,
    dayIndex: 0,
    season: 1,
    seasonT: 0.3,
    weatherKind: 0,
    weatherIntensity: 0,
    windX: 0.8,
    windZ: 0.45,
    sunDir: new Vector3(-0.8, 0.43, 0.25).normalize(),
    override: {},
  };
}

/** Fallback sun direction when the sim has no `time.sun_dir`: rises east (+x), peaks south (+z), sets west. */
export function sunDirFromHours(hours: number, out: Vector3): Vector3 {
  const th = (Math.PI * (hours - 5.67)) / 13;
  const tilt = (30 * Math.PI) / 180;
  return out.set(Math.cos(th), Math.sin(th) * Math.cos(tilt), Math.sin(th) * Math.sin(tilt)).normalize();
}

function hourDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 24;
  if (d > 12) d = 24 - d;
  return d;
}

export function updateEnv(env: Env, bridge: Bridge): void {
  const t = bridge.time;
  const o = env.override;
  const has = t.valid;
  env.hours = o.hours ?? (has ? t.hours : DEFAULT_HOURS);
  if (has) {
    env.dayIndex = t.dayIndex;
    env.season = t.season;
    env.seasonT = t.seasonT;
    env.windX = t.windX;
    env.windZ = t.windZ;
  }
  env.weatherKind = o.weatherKind ?? (has ? t.weatherKind : 0);
  env.weatherIntensity = o.weatherIntensity ?? (has ? t.weatherIntensity : 0);
  if (has && (o.hours === undefined || hourDiff(t.hours, o.hours) < 0.02)) env.sunDir.copy(t.sunDir);
  else sunDirFromHours(env.hours, env.sunDir);
}
