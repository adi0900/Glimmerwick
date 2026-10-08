"""Original, procedurally synthesized music + SFX for the Glimmerwick ad (43.5 s, 120 bpm). No samples, no external material.
Usage: python tools/synth-ad-music.py out.wav"""
import numpy as np, wave, sys
from scipy.signal import lfilter
SR = 48000; DUR = 55.0; BEAT = .5; BAR = 2.0
rng = np.random.default_rng(11)
N = int(SR * DUR); L = np.zeros(N); R = np.zeros(N)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)

MODE = sys.argv[2] if len(sys.argv) > 2 else 'mix'     # mix | music | sfx (stems for an editor; the random draws stay identical)
LAYER = 'music'
def add(t0, sig, pan=.5, g=1.0):
    if MODE != 'mix' and MODE != LAYER: return
    i = int(t0 * SR)
    if i >= N or i < 0: return
    sig = sig[:N - i] * g
    L[i:i + len(sig)] += sig * np.cos(pan * np.pi / 2); R[i:i + len(sig)] += sig * np.sin(pan * np.pi / 2)

def bell(m, dur, vel):
    t = np.arange(int(SR * dur)) / SR; f = hz(m)
    s = np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t * 9) + .18 * np.sin(2 * np.pi * f * 3.01 * t) * np.exp(-t * 14)
    return s * np.exp(-t * 3.4) * vel * (1 - np.exp(-t * 400))

def pad(ms, dur, vel):
    t = np.arange(int(SR * dur)) / SR; out = 0
    for m in ms:
        for d in (-.07, .07):
            f = hz(m) * 2 ** (d / 12); out = out + np.sin(2 * np.pi * f * t) + .25 * np.sin(2 * np.pi * f * 2 * t)
    return out * np.minimum(1, t / .5) * np.minimum(1, (dur - t) / .6) * vel / (2 * len(ms))

def bass(m, dur, vel):
    t = np.arange(int(SR * dur)) / SR; f = hz(m)
    return (np.sin(2 * np.pi * f * t) + .2 * np.sin(2 * np.pi * f * 2 * t)) * np.exp(-t * 2.2) * (1 - np.exp(-t * 60)) * vel

def kick(vel):
    t = np.arange(int(SR * .28)) / SR; f = 48 + 90 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11) * vel

def shaker(vel):
    t = np.arange(int(SR * .07)) / SR; n = rng.standard_normal(len(t)); n = n - lfilter([.5], [1, -.5], n)
    return n * np.exp(-t * 55) * vel

def pop(f0, vel):
    t = np.arange(int(SR * .16)) / SR; f = f0 * (1 + .5 * np.exp(-t * 30))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 22) * vel

def whoosh(dur, vel):
    t = np.arange(int(SR * dur)) / SR; n = rng.standard_normal(len(t)); y = np.zeros_like(n); acc = 0; acc2 = 0
    a = .02 + .55 * (t / dur) ** 2
    for i in range(len(n)):
        acc += a[i] * (n[i] - acc); acc2 += a[i] * (acc - acc2); y[i] = acc - acc2
    env = np.sin(np.pi * np.minimum(1, t / dur)) ** 1.6
    return y / (abs(y).max() + 1e-9) * env * vel

CH = [([60, 64, 67, 71], 48), ([57, 60, 64, 67], 45), ([57, 60, 64, 65], 41), ([59, 62, 65, 67], 43)]   # Cmaj7 Am7 Fmaj7 G6
SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81]
# (start, end, bell density, pad level, drums?, bass?)
SECTIONS = [(0, 2.4, .35, .6, 0, 0), (2.4, 9.5, .6, .9, 0, 1), (9.5, 14, .85, 1.0, 1, 1), (14, 23, .55, .85, 0, 1),
            (23, 29, .8, 1.0, 1, 1), (29, 34, .6, .9, 0, 1), (34, 40.5, .75, 1.0, 1, 1), (40.5, 45.5, .5, .85, 0, 1),
            (45.5, 50, .3, .7, 0, 1), (50, 55, .5, .85, 0, 1)]
LAYER = 'music'
for s0, s1, dens, pl, drums, hasbass in SECTIONS:
    b = int(round(s0 / BEAT))
    while b * BEAT < s1 - 1e-6:
        t = b * BEAT; bar = int(t // BAR); tones, root = CH[bar % 4]
        if abs(t - bar * BAR) < 1e-6:
            add(t, pad(tones, min(BAR, s1 - t) + .5, .17 * pl))
            if hasbass: add(t, bass(root, BAR * .9, .24 * pl))
        for sub in (0, 1):                                    # eighth notes
            tt = t + sub * BEAT / 2
            if tt >= s1: break
            if rng.random() < dens + (.2 if sub == 0 else 0):
                pool = [n for n in SCALE + tones + [x + 12 for x in tones] if 57 <= n <= 88]
                m = pool[rng.integers(len(pool))] if rng.random() < .5 else pool[(int(tt * 4) * 3 + bar) % len(pool)]
                add(tt, bell(m, 2.4, .11 * pl * (.8 + .4 * rng.random())), .2 + .6 * rng.random())
        if drums:
            add(t, kick(.34)); add(t + BEAT / 2, shaker(.05), .65); add(t, shaker(.03), .35)
        b += 1

# --- SFX on the picture: wipes, words, sparkles ---
LAYER = 'sfx'
for cut in (9.5, 14.0, 17.0, 20.0, 23.0, 29.0, 34.0, 40.5, 45.5, 50.0): add(cut - .34, whoosh(.7, .22), .5)
for t, f in ((.25, 520), (.4, 620), (.85, 560), (1.0, 700), (1.2, 760), (10.0, 760), (10.7, 700), (14.25, 640), (23.05, 620), (29.3, 700), (34.3, 660)): add(t, pop(f, .2), .5)
for t, base in ((7.25, 72), (50.7, 72)):
    for k, m in enumerate((base, base + 4, base + 7, base + 12)): add(t + k * .07, bell(m, 1.6, .16), .3 + .13 * k)
for t in (14.45, 17.45, 20.45, 23.5, 24.1, 26.1, 27.9, 35.75, 37.9, 39.45, 46.2): add(t, pop(520, .16), .5)
for k in range(5): add(41.1 + k * .72, pop(560 + 70 * k, .17), .5)     # the loop's five steps lighting up

def echo(x, delays, gains):
    y = x.copy()
    for d, g in zip(delays, gains):
        i = int(d * SR); y[i:] += x[:-i] * g
    return y
L2 = echo(L, (.19, .37, .56), (.3, .2, .12)); R2 = echo(R, (.23, .41, .6), (.3, .2, .12))
L2 = lfilter([.35], [1, -.65], L2) + L2 * .35; R2 = lfilter([.35], [1, -.65], R2) + R2 * .35
t = np.arange(N) / SR
env = np.minimum(1, t / .6) * np.minimum(1, (DUR - t) / 2.2)
L2 *= env; R2 *= env
g = 10 ** (-3 / 20) / max(abs(L2).max(), abs(R2).max())
pcm = (np.stack([L2 * g, R2 * g], 1) * 32767).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', sys.argv[1], DUR, 's')
