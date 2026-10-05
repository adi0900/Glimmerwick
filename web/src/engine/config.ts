/** Engine-wide constants and URL-parameter parsing (single place to change defaults). */
import type { QualityName, QualityPreset, ViewInfo } from './types';

/** Seed used when `?seed=` is absent. The "hero island" is whatever the world owner tunes this to. */
export const DEFAULT_SEED = 1;

/** Default quality when `?q=` is absent. */
export const DEFAULT_QUALITY: QualityName = 'high';

/** Fixed sim step (must match the Rust accumulator, ARCHITECTURE.md §3). */
export const FIXED_DT = 1 / 60;

/** Default time of day (hero look = 16:30 golden hour). */
export const DEFAULT_HOURS = 16.5;

/** Weather kinds (time channel index 4). */
export const WEATHER_NAMES = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'] as const;

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low',
    dprCap: 1,
    msaa: 0,
    smaa: false,
    fxaa: true,
    shadows: true,
    shadowMap: 1024,
    shadowDistance: 40,
    shadowRadius: 2,
    bloom: false,
    ao: false,
    tiltShift: false,
    grassDensity: 0.35,
    drawDistance: 0.6,
    particleScale: 0.4,
    waterQuality: 1,
    detail: 0,
  },
  med: {
    name: 'med',
    dprCap: 1.5,
    msaa: 2,
    smaa: false,
    fxaa: false,
    shadows: true,
    shadowMap: 1536,
    shadowDistance: 55,
    shadowRadius: 2.5,
    bloom: true,
    ao: false,
    tiltShift: false,
    grassDensity: 0.65,
    drawDistance: 0.8,
    particleScale: 0.7,
    waterQuality: 2,
    detail: 1,
  },
  high: {
    name: 'high',
    dprCap: 2,
    msaa: 4,
    smaa: false,
    fxaa: false,
    shadows: true,
    shadowMap: 2048,
    shadowDistance: 70,
    shadowRadius: 3,
    bloom: true,
    ao: true,
    tiltShift: true,
    grassDensity: 1,
    drawDistance: 1,
    particleScale: 1,
    waterQuality: 3,
    detail: 2,
  },
  ultra: {
    name: 'ultra',
    dprCap: 2,
    msaa: 8,
    smaa: true,
    fxaa: false,
    shadows: true,
    shadowMap: 4096,
    shadowDistance: 90,
    shadowRadius: 3.5,
    bloom: true,
    ao: true,
    tiltShift: true,
    grassDensity: 1.4,
    drawDistance: 1.3,
    particleScale: 1.3,
    waterQuality: 3,
    detail: 2,
  },
};

export function parseQuality(v: string | null | undefined): QualityName {
  return v === 'low' || v === 'med' || v === 'high' || v === 'ultra' ? v : DEFAULT_QUALITY;
}

/** "16:30" | "16.5" | "16" -> 16.5 (null when absent/invalid) */
export function parseHours(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  const h = m ? Number(m[1]) + Number(m[2]) / 60 : Number(v);
  if (!Number.isFinite(h)) return null;
  return ((h % 24) + 24) % 24;
}

/** "rain" | "2" | "rain:0.7" | "2:0.7" -> {kind, intensity} (null when absent/invalid) */
export function parseWeather(v: string | null | undefined, intensityParam?: string | null) {
  if (v == null || v === '') return null;
  const [k, i] = v.split(':');
  let kind = WEATHER_NAMES.indexOf(k as (typeof WEATHER_NAMES)[number]);
  if (kind < 0) kind = Number(k);
  if (!Number.isInteger(kind) || kind < 0 || kind >= WEATHER_NAMES.length) return null;
  let intensity = i !== undefined ? Number(i) : intensityParam != null ? Number(intensityParam) : kind === 0 ? 0 : 0.85;
  if (!Number.isFinite(intensity)) intensity = 0.85;
  return { kind, intensity: Math.min(1, Math.max(0, intensity)) };
}

export function parseVec3(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const p = v.split(',').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
  return [p[0]!, p[1]!, p[2]!];
}

export function readParams(search = window.location.search): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => (out[k] = v));
  return out;
}

export function buildViewInfo(params: Record<string, string>): ViewInfo {
  const name = params.view && params.view !== '' ? params.view : 'game';
  const w = Number(params.w);
  const h = Number(params.h);
  const seed = params.seed !== undefined && Number.isFinite(Number(params.seed)) ? Number(params.seed) >>> 0 : DEFAULT_SEED;
  const flag = (k: string) => params[k] === '1' || params[k] === 'true';
  return {
    name,
    isGame: name === 'game',
    isGallery: name !== 'game',
    primary: name === 'game' ? null : name,
    seed,
    params,
    fixedSize: w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null,
    automated: typeof navigator !== 'undefined' && navigator.webdriver === true,
    mock: flag('mock'),
  };
}
