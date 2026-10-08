// Objective orientation / controls playtest (headless, frozen clock, scripted input). Reports numbers, not opinions:
//  A. avatar: for 8 camera headings x {forward, back, strafe left, strafe right}: velocity direction vs the expected
//     camera-relative direction, and the avatar's published facing yaw vs its velocity direction;
//  B. creatures: heading from successive positions vs the published yaw (fraction facing the wrong way);
//  C. camera: whether mouse-right turns the view right (yaw sign) and the pitch direction.
// Usage: node tools/playtest-orientation.mjs   (starts a private vite on a free port)
import { launchBrowser, startPrivateServer } from './lib/browser.mjs';

const srv = await startPrivateServer();
const { browser, close } = await launchBrowser({ width: 960, height: 540 });
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => Math.round((r * 180) / Math.PI);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${srv.url}/?view=game&time=16.3&freeze=1&w=960&h=540&q=low`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game && window.__game.ready', { timeout: 240000 });
  const q = (n, a = {}) => page.evaluate((n, a) => { const r = window.__gw.bridge.query(n, a); return typeof r === 'string' ? JSON.parse(r) : r; }, n, a);
  const cmd = (n, a = {}) => page.evaluate((n, a) => window.__gw.bridge.command(n, a), n, a);
  await cmd('sys.set_time_scale', { scale: 0 });
  const drive = (mx, my, yaw, n) => page.evaluate(([mx, my, yaw, n]) => { for (let i = 0; i < n; i++) { window.__gw.bridge.setInputParts({ moveX: mx, moveY: my, yaw, pitch: 0.3 }); window.__game.step(1); } }, [mx, my, yaw, n]);
  const info = () => q('player.info');

  // ---- A. avatar ----
  console.log('A. AVATAR  (camera yaw -> expected move dir = (-sin yaw, -cos yaw); avatar yaw should equal atan2(vx, vz))');
  const rows = [];
  const spots = [[-14, 40], [20, 60], [30, 30]];
  let spot = 0;
  for (const camYaw of [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180)) {
    for (const [name, mx, my] of [['W fwd', 0, 1], ['S back', 0, -1], ['A left', -1, 0], ['D right', 1, 0]]) {
      const [sx, sz] = spots[spot++ % spots.length];
      await cmd('debug.teleport', { x: sx, z: sz });
      await drive(0, 0, camYaw, 50);
      await drive(mx, my, camYaw, 70);
      const p = await info();
      const speed = Math.hypot(p.vel[0], p.vel[2]);
      if (speed < 0.5) { rows.push({ camYaw: deg(camYaw), name, note: 'blocked/slow' }); continue; }
      const fwd = [-Math.sin(camYaw), -Math.cos(camYaw)], right = [Math.cos(camYaw), -Math.sin(camYaw)];
      const want = [fwd[0] * my + right[0] * mx, fwd[1] * my + right[1] * mx];
      const moveErr = wrap(Math.atan2(p.vel[0], p.vel[2]) - Math.atan2(want[0], want[1]));
      const faceErr = wrap(p.yaw - Math.atan2(p.vel[0], p.vel[2]));
      rows.push({ camYaw: deg(camYaw), name, speed: +speed.toFixed(2), moveDirErrDeg: deg(moveErr), facingErrDeg: deg(faceErr) });
    }
  }
  console.table(rows);

  // ---- C. camera / look sign ----
  console.log('C. LOOK  (engine input path: lookDx>0 = mouse moved right)');
  const look = await page.evaluate(() => {
    const e = window.__gw.engine, inp = e.input;
    const y0 = inp.yaw, p0 = inp.pitch; inp.lookEnabled = true; inp.enabled = true;
    inp.lookDx = 100; inp.lookDy = 0; inp.poll(0.016, new Float32Array(16));
    const dyaw = inp.yaw - y0;
    const y1 = inp.yaw, p1 = inp.pitch; inp.lookDx = 0; inp.lookDy = 100; inp.poll(0.016, new Float32Array(16));
    return { mouseRight_dYaw: +dyaw.toFixed(4), mouseDown_dPitch: +(inp.pitch - p1).toFixed(4), sens: inp.lookSensitivity, invertY: inp.invertY };
  }).catch((e) => String(e));
  console.log(JSON.stringify(look));

  // ---- B. creatures ----
  console.log('B. CREATURES  (heading from motion vs published yaw)');
  await cmd('debug.teleport', { x: 56, z: 0 });
  await drive(0, 0, 0, 60);
  for (let s = 0; s < 3; s++) for (let k = 0; k < 3; k++) await cmd('debug.spawn_creature', { species: s, x: 52 + s * 4 + k, z: 6 + k * 3, count: 1 });
  const snap = () => page.evaluate(() => { const ch = window.__gw.bridge.channel('creatures'); const d = ch.data, s = ch.stride, n = Math.floor(ch.len / s); const out = []; for (let i = 0; i < n; i++) out.push({ id: Math.round(d[i * s]), sp: Math.round(d[i * s + 1]), x: d[i * s + 3], z: d[i * s + 5], yaw: d[i * s + 6], st: Math.round(d[i * s + 8]) }); return out; });
  const stat = { n: 0, bad: 0, sumAbs: 0, perSpecies: [{ n: 0, bad: 0 }, { n: 0, bad: 0 }, { n: 0, bad: 0 }] };
  let prev = await snap();
  for (let step = 0; step < 900; step += 15) {
    await drive(0, 0, 0, 15);
    const cur = await snap();
    for (const c of cur) {
      const p = prev.find((x) => x.id === c.id); if (!p) continue;
      const dx = c.x - p.x, dz = c.z - p.z, sp = Math.hypot(dx, dz) / 0.25;
      if (sp < 0.35 || c.st === 4) continue;
      const err = Math.abs(wrap(c.yaw - Math.atan2(dx, dz)));
      stat.n++; stat.sumAbs += err; stat.perSpecies[c.sp].n++;
      if (err > Math.PI / 4) { stat.bad++; stat.perSpecies[c.sp].bad++; }
    }
    prev = cur;
  }
  console.log(JSON.stringify({ samples: stat.n, meanAbsErrDeg: stat.n ? deg(stat.sumAbs / stat.n) : null, facingWrongFraction: stat.n ? +(stat.bad / stat.n).toFixed(3) : null, perSpecies: stat.perSpecies }));
  if (errors.length) console.log('page errors:', errors.slice(0, 3));
} finally {
  await close();
  srv.stop();
}
