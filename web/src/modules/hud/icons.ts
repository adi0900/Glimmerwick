/**
 * Procedural icons: voxel-cube item icons (drawn from the block registry colour, texel-noised so they read like the
 * world's blocks), treat icons, and SVG Glimmer portraits / silhouettes for the Glimmerdex.
 * Everything is cached; nothing here touches WebGL.
 */
import { ITEMS } from './data';
import type { VariantInfo } from './data';

const INK = '#3a2a35';

type RGB = [number, number, number];

const cache = new Map<string, string>();

function hash(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

const css = (c: RGB, k = 1, a = 1): string =>
  `rgba(${Math.min(255, Math.round(c[0] * k))},${Math.min(255, Math.round(c[1] * k))},${Math.min(255, Math.round(c[2] * k))},${a})`;

function poly(g: CanvasRenderingContext2D, pts: Array<[number, number]>): void {
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
  g.closePath();
}

interface CubeStyle {
  c: RGB;
  /** lines across each face (planks, roof rows), parallel to the face's horizontal edge */
  rows?: number;
  /** lines across each side face parallel to the vertical edge (bark grooves, frame bars) */
  cols?: number;
  /** line colour (default: darker base) */
  line?: string;
  /** texel speckles: [dark, light] counts per face */
  speck?: [number, number];
  /** concentric growth rings on the top face (log) */
  ring?: RGB;
  glass?: boolean;
  glow?: boolean;
}

/** per-item look: the registry colours are all near-grey at icon size, so every item gets its own authored palette */
const STYLE: Record<string, CubeStyle> = {
  log: { c: [128, 88, 54], cols: 4, line: 'rgba(52,30,16,0.55)', speck: [6, 3], ring: [214, 168, 104] },
  planks: { c: [226, 172, 98], rows: 4, line: 'rgba(120,70,28,0.6)', speck: [3, 3] },
  stone: { c: [158, 160, 172], speck: [8, 6] },
  cobble: { c: [132, 134, 146], rows: 3, cols: 3, line: 'rgba(40,40,56,0.55)', speck: [12, 8] },
  dirt: { c: [150, 98, 60], speck: [12, 8] },
  sand: { c: [244, 222, 148], speck: [8, 8] },
  gravel: { c: [168, 156, 148], speck: [14, 10] },
  clay: { c: [204, 150, 138], speck: [5, 5] },
  leaves: { c: [82, 184, 84], speck: [10, 12] },
  glass: { c: [168, 226, 250], glass: true },
  plaster: { c: [250, 238, 204], speck: [3, 3] },
  roof_tile: { c: [214, 88, 62], rows: 4, line: 'rgba(100,28,22,0.6)', speck: [3, 3] },
  lantern: { c: [255, 214, 104], cols: 2, rows: 2, line: 'rgba(70,40,20,0.7)', glow: true },
  glowcap: { c: [120, 238, 216], speck: [3, 6], glow: true },
};

/** `n` lines across a quad (a b c d, clockwise): `across` = from edge a-d to edge b-c, else from a-b to d-c */
function faceLines(g: CanvasRenderingContext2D, q: Array<[number, number]>, n: number, across: boolean): void {
  const [a, b, c, d] = q as [[number, number], [number, number], [number, number], [number, number]];
  const L = (p: [number, number], r: [number, number], t: number): [number, number] => [p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t];
  g.beginPath();
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const s0 = across ? L(a, d, t) : L(a, b, t);
    const s1 = across ? L(b, c, t) : L(d, c, t);
    g.moveTo(s0[0], s0[1]);
    g.lineTo(s1[0], s1[1]);
  }
  g.stroke();
}

function cubeIcon(key: string, c: RGB, st: CubeStyle = { c }): string {
  const S = 96;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const r = hash(key);
  const k = S / 64;
  g.scale(k, k);
  const P = {
    top: [32, 6], ur: [55, 19], lr: [55, 45], bot: [32, 58], ll: [9, 45], ul: [9, 19], c: [32, 32],
  } as Record<string, [number, number]>;
  const faces: Array<{ pts: Array<[number, number]>; shade: number; top?: boolean }> = [
    { pts: [P.top!, P.ur!, P.c!, P.ul!], shade: 1.16, top: true },
    { pts: [P.ul!, P.c!, P.bot!, P.ll!], shade: 0.93 },
    { pts: [P.c!, P.ur!, P.lr!, P.bot!], shade: 0.72 },
  ];
  const glass = !!st.glass;
  // contact shadow
  g.fillStyle = 'rgba(40,24,50,0.22)';
  g.beginPath();
  g.ellipse(32, 59, 21, 4.2, 0, 0, Math.PI * 2);
  g.fill();
  for (const f of faces) {
    g.save();
    poly(g, f.pts);
    g.fillStyle = glass ? css(c, f.shade, 0.6) : css(c, f.shade);
    g.fill();
    g.clip();
    const [dk, lt] = st.speck ?? [14, 8];
    for (let i = 0; i < dk + lt; i++) {
      const x = 4 + r() * 54;
      const y = 4 + r() * 52;
      const z = 2 + Math.floor(r() * 2) * 1.5;
      g.fillStyle = i < dk ? 'rgba(40,16,40,0.2)' : 'rgba(255,255,255,0.26)';
      g.fillRect(x, y, z, z);
    }
    g.strokeStyle = st.line ?? 'rgba(40,16,40,0.35)';
    g.lineWidth = 1.3;
    if (st.rows) faceLines(g, f.pts, f.top ? Math.max(2, st.rows - 1) : st.rows, true);
    if (st.cols && !f.top) faceLines(g, f.pts, st.cols, false);
    if (st.ring && f.top) {
      // growth rings: concentric diamonds in the top face
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const sc = 0.78 - i * 0.24;
        g.strokeStyle = i === 2 ? css(st.ring, 0.62) : css(st.ring, 0.78);
        g.fillStyle = i === 2 ? css(st.ring, 0.92) : 'rgba(0,0,0,0)';
        g.beginPath();
        g.ellipse(32, 19, 22 * sc, 12 * sc, 0, 0, Math.PI * 2);
        if (i === 2) g.fill();
        g.stroke();
      }
    }
    g.restore();
  }
  if (glass) {
    for (const [pts, a] of [[faces[0]!.pts, 0.9], [faces[1]!.pts, 0.7]] as Array<[Array<[number, number]>, number]>) {
      g.save();
      poly(g, pts);
      g.clip();
      g.strokeStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = 3;
      g.beginPath();
      if (pts === faces[0]!.pts) { g.moveTo(20, 24); g.lineTo(34, 14); } else { g.moveTo(14, 28); g.lineTo(14, 40); g.moveTo(19, 34); g.lineTo(19, 43); }
      g.stroke();
      g.restore();
    }
  }
  if (st.glow) {
    const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    rg.addColorStop(0, 'rgba(255,244,176,0.85)');
    rg.addColorStop(1, 'rgba(255,244,176,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 64, 64);
  }
  // top-edge highlight + ink outline
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(P.ul![0] + 1, P.ul![1] + 1);
  g.lineTo(P.top![0], P.top![1] + 1.5);
  g.lineTo(P.ur![0] - 1, P.ur![1] + 1);
  g.stroke();
  g.strokeStyle = INK;
  g.lineWidth = 2.4;
  g.lineJoin = 'round';
  poly(g, [P.top!, P.ur!, P.lr!, P.bot!, P.ll!, P.ul!]);
  g.stroke();
  g.lineWidth = 1.4;
  g.globalAlpha = 0.55;
  g.beginPath();
  g.moveTo(P.ul![0], P.ul![1]);
  g.lineTo(P.c![0], P.c![1]);
  g.lineTo(P.ur![0], P.ur![1]);
  g.moveTo(P.c![0], P.c![1]);
  g.lineTo(P.bot![0], P.bot![1]);
  g.stroke();
  return cv.toDataURL('image/png');
}

function treatIcon(kind: 'berry' | 'apple' | 'orange' | 'cookie'): string {
  const S = 96;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.scale(S / 64, S / 64);
  g.fillStyle = 'rgba(40,24,50,0.22)';
  g.beginPath();
  g.ellipse(32, 56, 18, 4, 0, 0, Math.PI * 2);
  g.fill();
  const ball = (x: number, y: number, rad: number, col: string, hi = 'rgba(255,255,255,0.55)') => {
    g.fillStyle = col;
    g.strokeStyle = INK;
    g.lineWidth = 2.4;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = hi;
    g.beginPath();
    g.ellipse(x - rad * 0.35, y - rad * 0.4, rad * 0.26, rad * 0.16, -0.6, 0, Math.PI * 2);
    g.fill();
  };
  const leaf = (x: number, y: number, rot: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = '#58c46a';
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(0, 0, 9, 4.6, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  };
  if (kind === 'berry') {
    ball(24, 38, 13, '#e8446a');
    ball(42, 36, 14, '#d63a62');
    ball(33, 22, 12, '#ee5578');
    leaf(36, 11, -0.4);
  } else if (kind === 'apple') {
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(32, 18);
    g.lineTo(34, 9);
    g.stroke();
    ball(32, 36, 19, '#e9473f');
    leaf(42, 12, -0.5);
  } else if (kind === 'orange') {
    ball(32, 36, 19, '#ff9a2e');
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const [x, y] of [[26, 40], [38, 44], [34, 30], [24, 30]]) g.fillRect(x!, y!, 3, 3);
    leaf(37, 14, -0.3);
  } else {
    ball(32, 36, 20, '#e0a45e');
    g.fillStyle = '#6b3b24';
    for (const [x, y, w] of [[24, 30, 6], [38, 32, 6], [30, 44, 7], [42, 44, 5], [22, 42, 5]]) {
      g.beginPath();
      g.roundRect(x!, y!, w!, w!, 2);
      g.fill();
    }
  }
  return cv.toDataURL('image/png');
}

/** data-URL icon for an item key; `blockColor` is the registry colour of its block (cubes). */
export function itemIcon(item: string, blockColor?: RGB): string {
  const hit = cache.get(item);
  if (hit) return hit;
  const def = ITEMS[item];
  let url: string;
  if (def?.icon) url = treatIcon(def.icon);
  else {
    const st = STYLE[item];
    const c: RGB = def?.color ?? st?.c ?? blockColor ?? [200, 200, 200];
    url = cubeIcon(item, c, st ? { ...st, c } : { c });
  }
  cache.set(item, url);
  return url;
}

// ------------------------------------------------------------------------------------------------ portraits

/** Glimmer portrait as an inline SVG string. `silhouette` = undiscovered (flat dark shape, no face). */
export function portraitSVG(species: number, v: VariantInfo, silhouette = false): string {
  const ink = INK;
  const main = silhouette ? '#5a4868' : v.main;
  const accent = silhouette ? '#5a4868' : v.accent;
  const belly = silhouette ? '#5a4868' : v.belly;
  const stroke = silhouette ? '#46354f' : ink;
  const face = (ex: [number, number], ey: number, gap: number) =>
    silhouette
      ? ''
      : `<circle cx="${ex[0]}" cy="${ey}" r="3.8" fill="${ink}"/><circle cx="${ex[1]}" cy="${ey}" r="3.8" fill="${ink}"/>
         <circle cx="${ex[0] + 1.2}" cy="${ey - 1.3}" r="1.3" fill="#fff"/><circle cx="${ex[1] + 1.2}" cy="${ey - 1.3}" r="1.3" fill="#fff"/>
         <path d="M${(ex[0] + ex[1]) / 2 - 3} ${ey + gap} q3 3.2 6 0" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>
         <ellipse cx="${ex[0] - 6}" cy="${ey + 5}" rx="4" ry="2.6" fill="${accent}" opacity=".45"/><ellipse cx="${ex[1] + 6}" cy="${ey + 5}" rx="4" ry="2.6" fill="${accent}" opacity=".45"/>`;
  const sw = `stroke="${stroke}" stroke-width="3" stroke-linejoin="round"`;
  let body = '';
  if (species === 0) {
    body = `
      <ellipse cx="33" cy="22" rx="8" ry="17" transform="rotate(-10 33 22)" fill="${main}" ${sw}/>
      <ellipse cx="67" cy="22" rx="8" ry="17" transform="rotate(10 67 22)" fill="${main}" ${sw}/>
      ${silhouette ? '' : `<ellipse cx="33" cy="24" rx="3.6" ry="10" transform="rotate(-10 33 24)" fill="${accent}" opacity=".55"/><ellipse cx="67" cy="24" rx="3.6" ry="10" transform="rotate(10 67 24)" fill="${accent}" opacity=".55"/>`}
      <circle cx="50" cy="60" r="31" fill="${main}" ${sw}/>
      <ellipse cx="50" cy="71" rx="19" ry="14" fill="${belly}" ${silhouette ? '' : 'opacity=".9"'}/>
      <ellipse cx="34" cy="90" rx="9" ry="5" fill="${main}" ${sw}/><ellipse cx="66" cy="90" rx="9" ry="5" fill="${main}" ${sw}/>
      ${silhouette ? '' : `<path d="M50 38 l2.6 5 5.4.8 -3.9 3.8 .9 5.4 -5 -2.6 -5 2.6 .9 -5.4 -3.9 -3.8 5.4 -.8z" fill="${accent}" opacity=".9" transform="translate(0 -4) scale(1)"/>`}
      ${face([40, 60], 58, 8)}`;
  } else if (species === 1) {
    body = `
      <path d="M72 62 q22 -2 22 16 q-6 8 -16 -2z" fill="${main}" ${sw}/>
      <ellipse cx="52" cy="64" rx="36" ry="25" fill="${main}" ${sw}/>
      <ellipse cx="48" cy="73" rx="22" ry="12" fill="${belly}"/>
      <ellipse cx="30" cy="38" rx="9" ry="12" transform="rotate(-25 30 38)" fill="${accent}" ${sw}/>
      <ellipse cx="46" cy="32" rx="8" ry="12" transform="rotate(-5 46 32)" fill="${accent}" ${sw}/>
      <ellipse cx="62" cy="36" rx="7" ry="11" transform="rotate(20 62 36)" fill="${accent}" ${sw}/>
      <circle cx="40" cy="56" r="21" fill="${main}" ${sw}/>
      <ellipse cx="36" cy="88" rx="7" ry="4.5" fill="${main}" ${sw}/><ellipse cx="62" cy="88" rx="7" ry="4.5" fill="${main}" ${sw}/>
      ${face([31, 49], 54, 8)}`;
  } else {
    body = `
      <path d="M70 70 q28 -6 24 -34 q-26 4 -34 30z" fill="${main}" ${sw}/>
      ${silhouette ? '' : `<path d="M88 42 q4 -8 2 -8 q-10 2 -14 12z" fill="${belly}"/>`}
      <path d="M26 16 l-6 30 24 -8z" fill="${main}" ${sw}/><path d="M74 16 l6 30 -24 -8z" fill="${main}" ${sw}/>
      ${silhouette ? '' : `<path d="M25 18 l-3 12 8 -3z M75 18 l3 12 -8 -3z" fill="${ink}" opacity=".75"/>`}
      <ellipse cx="50" cy="66" rx="28" ry="24" fill="${main}" ${sw}/>
      <ellipse cx="50" cy="52" rx="29" ry="24" fill="${main}" ${sw}/>
      <ellipse cx="50" cy="60" rx="17" ry="12" fill="${belly}"/>
      <path d="M50 30 q-4 -14 -16 -14 q2 12 16 14z" fill="${accent}" ${sw}/><path d="M50 30 q4 -14 16 -14 q-2 12 -16 14z" fill="${accent}" ${sw}/>
      ${silhouette ? '' : `<ellipse cx="50" cy="59" rx="3" ry="2.2" fill="${ink}"/>`}
      <ellipse cx="34" cy="90" rx="8" ry="4.5" fill="${main}" ${sw}/><ellipse cx="66" cy="90" rx="8" ry="4.5" fill="${main}" ${sw}/>
      ${face([38, 62], 50, 14)}`;
  }
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}
