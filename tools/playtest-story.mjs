// Story slice 2 playtest (headless Chrome, private vite server, REAL clock + real key presses):
//   intro -> Pip talks (typewriter, choices) -> quest steps 1-6 advance -> village level 1 -> Bram arrives -> Bram talks
//   -> progress persists after a page reload. Wood gathering is simulated through the HUD store (the real chopping loop is
//   covered by tools/playtest-gameplay.mjs); crafting, building (60 blocks), befriending and every dialogue use the real code paths.
// Usage: node tools/playtest-story.mjs [--out shots/story/r1] [--size 1280x720] [--q med]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, startPrivateServer, repoRoot } from './lib/browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const outDir = path.resolve(repoRoot, arg('--out', 'shots/story/r1'));
const [W, H] = arg('--size', '1280x720').split('x').map(Number);
const quality = arg('--q', 'med');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

const srv = await startPrivateServer();
const { browser, close } = await launchBrowser({ width: W, height: H });
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `${srv.url}/?view=game&time=11&ui=1&q=${quality}&w=${W}&h=${H}`;
  const boot = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__game && window.__game.ready && window.__gameplay && window.__story', { timeout: 300000 });
  };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const shot = async (name) => { await page.screenshot({ path: path.join(outDir, name + '.png') }); };
  const q = (n, a = {}) => ev((n, a) => { const r = window.__gw.bridge.query(n, a); return typeof r === 'string' ? JSON.parse(r) : r; }, n, a);
  const cmd = (n, a = {}) => ev((n, a) => window.__gw.bridge.command(n, a), n, a);
  const st = () => ev(() => { const s = window.__story.state(); return { step: s.step, level: s.level, flags: s.flags, told: s.told, goal: s.goal && { title: s.goal.title, p: s.goal.progress, n: s.goal.target }, placedVillage: window.__gameplay.store.stats.placedVillage }; });
  const dlgText = () => ev(() => document.querySelector('#gw-dlg .txt')?.textContent ?? '');
  const dlgOpen = () => ev(() => window.__story.dlg.open);
  const press = async (code, wait = 120) => { await page.keyboard.press(code); await sleep(wait); };
  /** advance the open dialogue to its end (E to finish typing, E to advance; first choice when offered) */
  const runDialogue = async (maxBoxes = 14) => {
    let boxes = 0;
    while (await dlgOpen() && boxes++ < maxBoxes) {
      await sleep(260);
      await press('KeyE', 100); // finish typing
      const hasChoice = await ev(() => document.querySelectorAll('#gw-dlg .choices button').length);
      if (hasChoice) await press('Digit1', 200); else await press('KeyE', 200);
    }
    return boxes;
  };
  const waitFor = async (fn, ms = 8000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(fn)) return true; await sleep(step); } return false; };

  await boot();
  await cmd('sys.set_time_scale', { scale: 0 });
  await cmd('sys.set_weather', { kind: 0, intensity: 0 });

  // ------------------------------------------------------------------ world pieces
  await sleep(500);
  const lh = await ev(() => window.__story.lighthouseInfo());
  console.log('   lighthouse:', JSON.stringify(lh));
  await waitFor(() => !window.__story.lighthouseInfo().building, 6000);
  const lhBlock = await q('world.block', { x: Math.floor(lh.site.x) + 2, y: lh.site.baseY + 5, z: Math.floor(lh.site.z) });
  check('lighthouse tower exists in the world', lhBlock && lhBlock.id !== 0, `block@tower id=${lhBlock?.id}`);

  // ------------------------------------------------------------------ intro (fresh profile)
  const introRan = await waitFor(() => window.__story.introActive, 6000, 100);
  check('intro starts on a fresh profile', introRan);
  await sleep(1100);
  await shot('01_intro_shore');
  await sleep(3000);
  await shot('02_intro_lighthouse');
  await sleep(2600);
  await shot('03_intro_pip');
  const introEnded = await waitFor(() => !window.__story.introActive, 12000, 200);
  check('intro finishes and releases the camera', introEnded);
  const opened = await waitFor(() => window.__story.dlg.open, 5000, 100);
  check("Pip's first lines open after the intro", opened);
  await sleep(450);
  const partial = await dlgText();
  await shot('04_dialogue_typing');
  await press('KeyE', 150);
  const full = await dlgText();
  check('typewriter: text is partial first, E taps to finish', partial.length < full.length && full.length > 40, `${partial.length} -> ${full.length} chars`);
  await shot('05_dialogue_full');
  await press('KeyE', 300); // next box (choices)
  await sleep(500);
  await press('KeyE', 300); // tap to finish typing -> choices appear
  await sleep(300);
  const choices = await ev(() => [...document.querySelectorAll('#gw-dlg .choices button')].map((b) => b.textContent));
  check('dialogue offers up to two friendly choices', choices.length === 2, JSON.stringify(choices));
  await shot('06_dialogue_choices');
  await runDialogue();
  await sleep(500);
  let s = await st();
  check('step 1 (talk to Pip) completes -> step 2 active', s.step >= 1 && /Sawdust/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  await sleep(2600);
  await shot('07_goal_card_step2');

  // ------------------------------------------------------------------ Pip "!" bubble + press E to talk
  await cmd('debug.teleport', { x: 54, z: 6 });
  await sleep(900);
  await ev(() => window.__gw.engine.input.setLook(Math.atan2(-(56.2 - 54), -(1.3 - 6)), 0.18, 0.22));
  await sleep(900);
  const pip = await ev(() => window.__story.npcInfo('pip'));
  check('Pip stands on the village green with a "!" for the next goal', pip.present && pip.bang, JSON.stringify(pip));
  await shot('08_pip_bang');
  await cmd('debug.teleport', { x: pip.x - 1.6, z: pip.z + 0.5 });
  await sleep(500);
  await press('KeyE', 400);
  check('E near Pip opens the dialogue box', await dlgOpen());
  await sleep(300);
  await shot('09_dialogue_pip_step2');
  await press('Escape', 300);
  check('Esc closes the dialogue', !(await dlgOpen()));
  await press('KeyE', 400);
  await runDialogue();
  check('player input is restored after dialogue', await ev(() => window.__gw.ctx.input.enabled));

  // ------------------------------------------------------------------ step 2: wood (simulated chopping), step 3: planks, step 4: build
  await ev(() => window.__gameplay.store.noteCollected('log', 6));
  await sleep(700);
  s = await st();
  check('step 2 (6 logs) completes -> step 3', s.step >= 2, JSON.stringify(s.goal));
  await ev(() => window.__gameplay.craft('planks'));
  await sleep(700);
  s = await st();
  check('step 3 (craft planks) completes -> step 4', s.step >= 3, JSON.stringify(s.goal));
  await sleep(2400);

  const build = async (spot, want) => {
    await cmd('debug.teleport', { x: spot[0], z: spot[1] });
    await sleep(500);
    return ev(async (want) => {
      const g = window.__gameplay; const b = window.__gw.bridge;
      const slot = g.store.slots.findIndex((x) => x && x.item === 'planks'); g.store.select(slot);
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      let n = 0;
      for (let dx = 2; dx <= 6 && g.store.stats.placedVillage < want; dx++) for (let dz = -4; dz <= 4 && g.store.stats.placedVillage < want; dz++) {
        const p = b.player.pos; const cx = Math.floor(p.x) - dx, cz = Math.floor(p.z) + dz;
        const gr = b.query('world.ground', { x: cx + 0.5, z: cz + 0.5 });
        g.setAim([cx + 0.5 - p.x, gr.block_y + 0.9 - (p.y + 0.95), cz + 0.5 - p.z]);
        await raf(); await raf();
        const before = g.store.stats.placed; g.place(); await raf(); if (g.store.stats.placed > before) n++; else { const t = document.querySelector('.gw-toast')?.textContent ?? (g.target ? 'hit:' + g.target.name : 'nohit'); window.__failHist = window.__failHist || {}; window.__failHist[t] = (window.__failHist[t] || 0) + 1; }
      }
      g.setAim(null);
      return n;
    }, want);
  };
  const n1 = (await build([62, 2], 21)) + (await build([56, 8], 21)) + (await build([66, -4], 21));
  await sleep(600);
  s = await st();
  check('step 4 (20 blocks near the green) completes -> step 5', s.step >= 4 && s.placedVillage >= 20, `placed near village ${s.placedVillage}, ${n1} placements`);
  await shot('10_quest_complete_banner');
  await sleep(2500);

  // ------------------------------------------------------------------ step 5: befriend a Puffbun (real E + berry), away from Pip
  await cmd('debug.teleport', { x: 40, z: 24 });
  await sleep(600);
  const pp = await q('player.info');
  const sp = await cmd('debug.spawn_creature', { species: 'Puffbun', x: pp.pos[0] + 2.4, z: pp.pos[2], variant: 1 });
  await sleep(2200);
  await ev(() => window.__gw.engine.input.setLook(Math.atan2(-2.4, 0), 0.3, 0.25));
  await sleep(600);
  let friend = false;
  for (let i = 0; i < 10 && !friend; i++) {
    await press('KeyE', 500);
    friend = !!(await q('creature.info', { id: sp.id })).companion;
    if (friend) break;
    await sleep(3300);
    const pn = await q('player.info'); const cr = await q('creature.info', { id: sp.id });
    if (Math.hypot(cr.pos[0] - pn.pos[0], cr.pos[2] - pn.pos[2]) > 3.4) await cmd('debug.teleport', { x: cr.pos[0] - 1.6, z: cr.pos[2] });
  }
  await sleep(500);
  s = await st();
  check('step 5 (befriend a Puffbun) completes -> step 6', friend && s.step >= 5, JSON.stringify(s.goal));
  await sleep(2400);

  // ------------------------------------------------------------------ step 6: village level 1 -> Bram arrives
  const bramBefore = await ev(() => window.__story.npcInfo('bram').present);
  const n2 = await build([54, -2], 62) + (await build([70, 10], 62)) + (await build([40, 6], 62));
  console.log('   build failures:', JSON.stringify(await ev(() => window.__failHist)));
  const n3 = (await ev(() => window.__gameplay.store.stats.placedVillage)) < 62 ? await build([58, 8], 62) : 0;
  const n4 = (await ev(() => window.__gameplay.store.stats.placedVillage)) < 62 ? await build([68, 4], 62) : 0;
  await sleep(500);
  s = await st();
  check('60 placed blocks near the green -> village level 1', s.level === 1 && s.placedVillage >= 60, `level ${s.level}, near-village blocks ${s.placedVillage} (${n2}+${n3}+${n4} placements)`);
  await sleep(450);
  await shot('11_village_level_toast');
  await sleep(2000);
  const bram = await ev(() => window.__story.npcInfo('bram'));
  check('Bram arrives at village level 1 (not before)', bram.present && !bramBefore, JSON.stringify(bram));
  await sleep(2500);
  await shot('12_bram_walking_in');
  await waitFor(() => !window.__story.cam.active, 8000, 200);
  await sleep(5500);
  const b2 = await ev(() => window.__story.npcInfo('bram'));
  await cmd('debug.teleport', { x: b2.x + 1.5, z: b2.z + 1.5 });
  await sleep(1000);
  await ev((b2) => window.__gw.engine.input.setLook(Math.atan2(-(b2.x - (b2.x + 1.5)), -(b2.z - (b2.z + 1.5))), 0.2, 0.22), b2);
  await sleep(800);
  await shot('13_bram_bang');
  await press('KeyE', 600);
  const bramTalk = await dlgOpen();
  const who = await ev(() => document.querySelector('#gw-dlg .nm')?.textContent ?? '');
  check('E near Bram opens his dialogue', bramTalk && who === 'Bram', `speaker "${who}"`);
  await runDialogue();
  await sleep(600);
  s = await st();
  check('step 6 completes after meeting Bram -> The Ripple Lens', s.step >= 6 && /Ripple/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  await sleep(2600);
  await shot('14_goal_ripple_lens');

  // ------------------------------------------------------------------ persistence
  const before = await st();
  await ev(() => { window.__story.engine.flush(); window.__gameplay.store.flush(); });
  await boot();
  await sleep(2500);
  const after = await st();
  const bramAfter = await ev(() => window.__story.npcInfo('bram').present);
  check('story progress persists after reload', after.step === before.step && after.level === before.level && bramAfter && after.goal?.title === before.goal?.title, `before ${JSON.stringify(before.goal)} lvl ${before.level} / after ${JSON.stringify(after.goal)} lvl ${after.level}, bram ${bramAfter}`);
  check('intro does not replay after reload', !(await ev(() => window.__story.introActive)));
  await shot('15_after_reload');

  // ------------------------------------------------------------------ phase 2: acts 2-3 (PLACEHOLDER triggers: friendships are set through the store, the pickups/pedestal/finale are the real code)
  await ev(() => window.__gameplay.store.markFriend(1, 0, 'Splash')); // a Tidler friend (simulated)
  await sleep(1500);
  await shot('16_marlo_arrival_glance');
  await waitFor(() => !window.__story.cam.active, 8000, 200);
  s = await st();
  const marlo = await ev(() => window.__story.npcInfo('marlo'));
  check('befriending a Tidler -> village level 2 and Marlo arrives', s.level === 2 && marlo.present, `level ${s.level}, marlo ${JSON.stringify(marlo)}`);
  let mk = await ev(() => window.__story.markerInfo());
  const ripple = mk.find((m) => m.id === 'lens_ripple');
  check('Ripple Lens glow marker appears on the pond bank', !!ripple, JSON.stringify(ripple));
  await cmd('debug.teleport', { x: ripple.x + 1.4, z: ripple.z + 0.4 });
  await sleep(1200);
  await ev((m) => window.__gw.engine.input.setLook(Math.atan2(-(m.x - (m.x + 1.4)), -(m.z - (m.z + 0.4))), 0.22, 0.22), ripple);
  await sleep(1200);
  await shot('17_lens_marker');
  await press('KeyE', 700);
  s = await st();
  check('E picks up the Ripple Lens -> step 8 (Whisper Lens)', s.flags.lens_ripple && /Whisper/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  await sleep(2400);
  await ev(() => window.__gameplay.store.markFriend(2, 0, 'Fern')); // a Sprigfox friend (simulated)
  await sleep(1500);
  await waitFor(() => !window.__story.cam.active, 8000, 200);
  s = await st();
  check('befriending a Sprigfox -> village level 3 and Willa arrives', s.level === 3 && (await ev(() => window.__story.npcInfo('willa').present)), `level ${s.level}`);
  mk = await ev(() => window.__story.markerInfo());
  const whisper = mk.find((m) => m.id === 'lens_whisper');
  check('Whisper Lens marker appears in the forest', !!whisper, JSON.stringify(whisper));
  await cmd('debug.teleport', { x: whisper.x + 1.2, z: whisper.z });
  await sleep(900);
  await press('KeyE', 700);
  s = await st();
  check('Whisper Lens collected -> step 9 (Cheer Lens)', s.flags.lens_whisper && /Cheer/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  mk = await ev(() => window.__story.markerInfo());
  const cheer = mk.find((m) => m.id === 'lens_cheer');
  check('Cheer Lens marker appears in the highland meadow', !!cheer, JSON.stringify(cheer));
  await cmd('debug.teleport', { x: cheer.x + 1.2, z: cheer.z });
  await sleep(900);
  await press('KeyE', 700);
  s = await st();
  check('Cheer Lens collected -> step 10 (Build the Beacon)', s.flags.lens_cheer && /Beacon/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  await sleep(2400);
  const li = await ev(() => window.__story.lighthouseInfo());
  await cmd('debug.teleport', { x: li.pedestal[0] + 0.5, z: li.pedestal[2] + 1.8 });
  await sleep(900);
  await ev(() => window.__gw.engine.input.setLook(Math.PI, 0.25, 0.3));
  await sleep(700);
  await shot('18_pedestal');
  await press('KeyE', 600);
  await sleep(1800);
  await shot('19_beacon_camera');
  await waitFor(() => !window.__story.cam.active, 9000, 200);
  s = await st();
  check('pedestal E: lenses set, beacon lit, village level 4', s.flags.beacon_lit && s.level === 4 && (await ev(() => window.__story.lighthouseInfo().lit)), `level ${s.level}`);
  const finale = await waitFor(() => window.__story.dlg.open, 9000, 200);
  check('finale dialogue (Pip + Glim) starts by itself', finale);
  await sleep(2600);
  await shot('20_finale_dialogue');
  await runDialogue(20);
  await sleep(900);
  s = await st();
  check('finale done -> free-play Village Wishes', /Village Wish/.test(s.goal?.title ?? ''), JSON.stringify(s.goal));
  await ev(() => window.__game.setTime(20.2, true));
  await sleep(2500);
  await shot('21_festival_green');
  await ev((p) => window.__gw.engine.input.setLook(p, 0.12, 0.7), Math.atan2(-(li.site.x - 58), -(li.site.z + 1)));
  await cmd('debug.teleport', { x: 58, z: 4 });
  await sleep(2500);
  await shot('22_lit_lighthouse_dusk');

  check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error('PLAYTEST CRASHED', e);
  exitCode = 1;
} finally {
  await close();
  await srv.stop?.();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || (failed.length ? 1 : 0));
