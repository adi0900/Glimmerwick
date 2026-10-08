"""Original, procedurally synthesized score for the Glimmerwick trailer (57 s, 120 bpm, C major). No samples, no external material.
A bouncy marimba theme over a I-V-vi-IV progression: celesta intro, groove, warm strings, a snare-roll build and a logo hit at 50.0 s.
Usage: python tools/synth-trailer-music.py out.wav [mix|music|sfx]   (stems for an editor; random draws stay identical)"""
import numpy as np, wave, sys
from scipy.signal import lfilter
SR = 48000; DUR = 57.0; BEAT = .5; BAR = 2.0
rng = np.random.default_rng(5)
N = int(SR * DUR); L = np.zeros(N); R = np.zeros(N)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
MODE = sys.argv[2] if len(sys.argv) > 2 else 'mix'
LAYER = 'music'

def add(t0, sig, pan=.5, g=1.0):
    if MODE != 'mix' and MODE != LAYER: return
    i = int(t0 * SR)
    if i >= N or i < 0: return
    sig = sig[:N - i] * g
    L[i:i + len(sig)] += sig * np.cos(pan * np.pi / 2); R[i:i + len(sig)] += sig * np.sin(pan * np.pi / 2)

def tt(d): return np.arange(int(SR * d)) / SR
def marimba(m, d, v):
    t = tt(d); f = hz(m)
    s = np.sin(2 * np.pi * f * t) + .5 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t * 28) + .18 * np.sin(2 * np.pi * 10 * f * t) * np.exp(-t * 70)
    return s * np.exp(-t * 6.5) * (1 - np.exp(-t * 900)) * v
def celesta(m, d, v):
    t = tt(d); f = hz(m)
    s = np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 9) + .18 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t * 14)
    return s * np.exp(-t * 3.0) * (1 - np.exp(-t * 500)) * v
def pluckbass(m, d, v):
    t = tt(d); f = hz(m)
    s = np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * 2 * f * t) + .12 * np.sin(2 * np.pi * 3 * f * t)
    return s * np.exp(-t * 4.5) * (1 - np.exp(-t * 300)) * v
def strings(ms, d, v):
    t = tt(d); out = 0
    for m in ms:
        for det in (-.09, .09):
            f = hz(m) * 2 ** (det / 12)
            out = out + sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 2, 3, 4))
    env = np.minimum(1, t / .5) * np.minimum(1, (d - t) / .7)
    return out * env * v / (2 * len(ms) * 1.6)
def kick(v):
    t = tt(.3); f = 50 + 95 * np.exp(-t * 26)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 10) * v
def clap(v):
    t = tt(.16); n = rng.standard_normal(len(t)); n = n - lfilter([.7], [1, -.3], n)
    return n * (np.exp(-t * 32) + .6 * np.exp(-np.maximum(0, t - .015) * 45)) * v
def shaker(v):
    t = tt(.06); n = rng.standard_normal(len(t)); n = n - lfilter([.5], [1, -.5], n)
    return n * np.exp(-t * 60) * v
def snare(v):
    t = tt(.2); n = rng.standard_normal(len(t)); n = n - lfilter([.6], [1, -.4], n)
    return (n * .8 + np.sin(2 * np.pi * 190 * t) * .5) * np.exp(-t * 20) * v
def crash(d, v):
    t = tt(d); n = rng.standard_normal(len(t)); n = n - lfilter([.8], [1, -.2], n)
    return n * np.exp(-t * 1.5) * v
def riser(d, v):
    t = tt(d); n = rng.standard_normal(len(t)); y = np.zeros_like(n); acc = 0; a = .01 + .5 * (t / d) ** 2
    for i in range(len(n)): acc += a[i] * (n[i] - acc); y[i] = acc
    return y / (abs(y).max() + 1e-9) * (t / d) ** 2.2 * v

CH = [([60, 64, 67], 36), ([59, 62, 67], 43), ([57, 60, 64], 45), ([57, 60, 65], 41)]     # C  G  Am  F  (tones, bass root)
# theme (bar offset, beat, midi, beats)
A = [(0, 0, 76, 1), (0, 1, 79, 1), (0, 2, 81, 1), (0, 3, 79, 1), (1, 0, 74, 1), (1, 1, 71, 1), (1, 2, 74, 1), (1, 3, 79, 1),
     (2, 0, 72, 1), (2, 1, 76, 1), (2, 2, 81, 2), (3, 0, 79, 2), (3, 2, 77, 1), (3, 3, 76, 1)]
def theme(bar0, voice, octave=0, g=1.0, stretch=1.0):
    for (bo, bt, m, ln) in A:
        t = (bar0 + bo * stretch) * BAR + bt * BEAT * stretch
        d = max(.4, ln * BEAT * stretch * 1.4)
        if voice == 'marimba': add(t, marimba(m + octave, d, .24 * g), .4)
        else: add(t, celesta(m + octave, 2.2, .13 * g), .6)

for b in range(28):
    t = b * BAR; tones, root = CH[b % 4]
    # --- harmony ---
    if b >= 1 and not (23 <= b <= 24): add(t, strings([x + (0 if b < 15 else 0) for x in tones], BAR + .5, .16 if 15 <= b <= 20 or b >= 25 else .11), .5)
    if 23 <= b <= 24: add(t, strings(tones, BAR + .5, .14), .5)
    # --- bass ---
    if 2 <= b <= 21 or b >= 25:
        add(t, pluckbass(root + 12, 1.0, .30), .5); add(t + BEAT * 2, pluckbass(root + (24 if b % 2 else 12), .9, .24), .5)
        if 10 <= b <= 15: add(t + BEAT * 1, pluckbass(root + 12, .4, .16), .5); add(t + BEAT * 3, pluckbass(root + 12, .4, .16), .5)
    # --- celesta arpeggio (intro, lapse) ---
    if b <= 3 or 21 <= b <= 23:
        for k in range(8):
            add(t + k * BEAT / 2, celesta(tones[k % 3] + 24 + (12 if k % 4 == 3 else 0), 1.8, .09), .25 + .5 * ((k * 3) % 5) / 4)
    # --- marimba bounce between theme statements (gang/build) ---
    if 10 <= b <= 15:
        for k in range(8):
            if k % 2 == 0 or rng.random() < .4: add(t + k * BEAT / 2, marimba(tones[(k // 2) % 3] + 12 + (12 if k % 4 == 2 else 0), .5, .13), .3 + .4 * rng.random())
    # --- drums ---
    groove = (4 <= b <= 21)
    if groove:
        add(t, kick(.34)); add(t + BEAT, kick(.28)) if b >= 8 else None; add(t + BEAT * 2, kick(.34)); add(t + BEAT * 3, kick(.28)) if b >= 8 else None
        for k in range(4): add(t + k * BEAT + BEAT / 2, shaker(.045), .3 + .4 * (k % 2))
        if b >= 8:
            add(t + BEAT, clap(.12), .5); add(t + BEAT * 3, clap(.12), .5)

theme(4, 'marimba'); theme(8, 'marimba'); theme(8, 'celesta', 12, .9)
theme(16, 'celesta', 0, 1.0); theme(16, 'marimba', 0, .55)
theme(20, 'marimba', 0, 1.0); theme(20, 'celesta', 12, 1.0)
theme(25, 'celesta', 0, 1.0, 1.6)                                   # resolves slowly under the logo (bars 25-27)

LAYER = 'sfx'
# --- the build (snare roll + swells) and the logo hit ---
tr = 46.0
while tr < 50.0:
    gap = .5 if tr < 47.5 else .25 if tr < 49.0 else .125
    add(tr, snare(.16 + .22 * (tr - 46.0) / 4.0), .5); tr += gap
add(46.0, riser(4.0, .55), .5)
add(50.0, crash(3.2, .42), .5)
add(50.0, strings([48, 55, 60, 64, 67, 74], 5.5, .22), .5)           # C add9 hit
add(50.0, pluckbass(36, 2.5, .5), .5)
for k, m in enumerate((72, 76, 79, 84, 88, 91)): add(50.05 + k * .09, celesta(m, 2.4, .16), .15 + .14 * k)
# --- sparkle chimes on the captions ---
for a in (9.1, 13.1, 21.1, 26.1, 32.1, 37.1, 43.6): add(a, celesta(88, 1.8, .10), .5)
add(51.2, celesta(96, 1.6, .10), .5)

def echo(x, delays, gains):
    y = x.copy()
    for d, g in zip(delays, gains):
        i = int(d * SR); y[i:] += x[:-i] * g
    return y
L2 = echo(L, (.19, .37, .56), (.3, .2, .12)); R2 = echo(R, (.23, .41, .6), (.3, .2, .12))
L2 = lfilter([.4], [1, -.6], L2) + L2 * .45; R2 = lfilter([.4], [1, -.6], R2) + R2 * .45
t = np.arange(N) / SR
env = np.minimum(1, t / 1.2) * np.minimum(1, (DUR - t) / 1.6)
L2 *= env; R2 *= env
g = 10 ** (-3 / 20) / max(abs(L2).max(), abs(R2).max())
pcm = (np.stack([L2 * g, R2 * g], 1) * 32767).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', sys.argv[1], DUR, 's', MODE)
