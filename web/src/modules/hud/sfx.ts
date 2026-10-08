/**
 * Tiny procedural sound hooks (soft marimba-ish blips) so every action answers with a sound until the audio module
 * exists. If `ctx.api.audio.play(name, opts)` is published by an audio module, that is used instead.
 * Names: tick (chopping), break, place, pickup, pop (accepted), chime (discovery), fanfare (goal / friend), nope, ui.
 */
type AudioApi = { play?: (name: string, opts?: Record<string, unknown>) => void } | undefined;

export class Sfx {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  constructor(private readonly getApi: () => AudioApi) {}

  unlock(): void {
    if (this.ac) {
      void this.ac.resume();
      return;
    }
    try {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ac = new C();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.16;
      const lim = this.ac.createDynamicsCompressor();
      this.master.connect(lim).connect(this.ac.destination);
    } catch {
      this.ac = null;
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slide = 0): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    const t0 = ac.currentTime + when;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  private noise(dur: number, vol: number, cutoff: number): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const s = ac.createBufferSource();
    s.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ac.createGain();
    g.gain.value = vol;
    s.connect(f).connect(g).connect(this.master);
    s.start();
  }

  play(name: string): void {
    if (this.muted) return;
    const api = this.getApi();
    if (api?.play) {
      api.play(name);
      return;
    }
    if (!this.ac) return;
    const pent = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
    switch (name) {
      case 'tick':
        this.noise(0.06, 0.5, 1800);
        this.tone(190 + Math.random() * 40, 0.07, 'triangle', 0.25);
        break;
      case 'break':
        this.noise(0.18, 0.9, 2400);
        this.tone(150, 0.16, 'triangle', 0.4, 0, 0.6);
        this.tone(pent[1]!, 0.12, 'sine', 0.18, 0.02);
        break;
      case 'place':
        this.tone(140, 0.12, 'triangle', 0.45, 0, 0.7);
        this.noise(0.07, 0.4, 1200);
        break;
      case 'pickup':
        this.tone(pent[2]!, 0.1, 'sine', 0.3);
        this.tone(pent[4]!, 0.14, 'sine', 0.26, 0.06);
        break;
      case 'pop':
        this.tone(420, 0.12, 'sine', 0.5, 0, 2.2);
        break;
      case 'chime':
        [0, 2, 4].forEach((n, i) => this.tone(pent[n]!, 0.3, 'sine', 0.28, i * 0.09));
        break;
      case 'fanfare':
        [0, 1, 2, 3, 5].forEach((n, i) => {
          this.tone(pent[n]!, 0.38, 'triangle', 0.3, i * 0.1);
          this.tone(pent[n]! * 2, 0.3, 'sine', 0.1, i * 0.1);
        });
        break;
      case 'nope':
        this.tone(220, 0.14, 'triangle', 0.3, 0, 0.7);
        this.tone(185, 0.16, 'triangle', 0.26, 0.1, 0.7);
        break;
      default:
        this.tone(pent[3]!, 0.07, 'sine', 0.2);
    }
  }
}
