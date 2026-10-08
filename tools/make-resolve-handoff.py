"""Builds showcase/nullmotion/resolve_handoff/ for DaVinci Resolve: clean DNxHR clips (no text, no wipes), audio stems,
a frame-accurate CMX3600 EDL of the rough cut, and a copy sheet of every on-screen line.
Usage (from the project root): python tools/make-resolve-handoff.py"""
import json, subprocess, sys
from pathlib import Path

ROOT = Path('showcase/nullmotion')
AD = ROOT / 'ad'
OUT = ROOT / 'resolve_handoff'
FPS = 30
counts = json.loads((AD / 'plates' / 'plates.json').read_text())
# the rough cut: clip, record-in second (matches the ad), source frames used
CUT = [('dive', 2.4), ('run', 9.5), ('cameo0', 14.0), ('cameo1', 17.0), ('cameo2', 20.0), ('build', 23.0), ('home', 29.0), ('biomes', 34.0), ('lapse', 40.5), ('outro', 45.5), ('gang', 50.0)]
NAMES = {'dive': 'GW_01_dive', 'run': 'GW_02_run', 'cameo0': 'GW_03_puffbun', 'cameo1': 'GW_04_tidler', 'cameo2': 'GW_05_sprigfox', 'build': 'GW_06_build', 'home': 'GW_07_village_home', 'biomes': 'GW_08_biome_flyover', 'lapse': 'GW_09_day_to_night', 'outro': 'GW_10_pullback', 'gang': 'GW_11_beach_friends'}

(OUT / 'clips').mkdir(parents=True, exist_ok=True)
(OUT / 'audio').mkdir(exist_ok=True)

def ffmpeg(*a):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *a], check=True)

# 1. clean clips: DNxHR SQ 4:2:2, 1920x1080, 30 fps, no audio
for shot, _ in CUT:
    dst = OUT / 'clips' / f'{NAMES[shot]}.mov'
    ffmpeg('-framerate', str(FPS), '-i', str(AD / 'plates' / shot / '%05d.jpg'), '-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq', '-pix_fmt', 'yuv422p', '-an', '-timecode', '00:00:00:00', str(dst))
    print('clip', dst.name, counts[shot], 'frames')

# 2. audio: full mix + stems (music only, effects only)
for mode, name in (('mix', 'GW_audio_mix'), ('music', 'GW_audio_music_only'), ('sfx', 'GW_audio_sfx_only')):
    subprocess.run([sys.executable, 'tools/synth-ad-music.py', str(OUT / 'audio' / f'{name}.wav'), mode], check=True, stdout=subprocess.DEVNULL)
    print('audio', name)

# 3. EDL (CMX3600, 30 fps non-drop): one video track, clips butted at their record positions
def tc(frames):
    f = frames % FPS; s = (frames // FPS) % 60; m = (frames // (FPS * 60)) % 60; h = frames // (FPS * 3600)
    return f'{h:02d}:{m:02d}:{s:02d}:{f:02d}'
lines = ['TITLE: GLIMMERWICK_AD_ROUGH_CUT', 'FCM: NON-DROP FRAME', '']
for i, (shot, rec_s) in enumerate(CUT, 1):
    n = counts[shot]; rec_in = round(rec_s * FPS)
    lines.append(f'{i:03d}  {NAMES[shot]:<16} V     C        {tc(0)} {tc(n)} {tc(rec_in)} {tc(rec_in + n)}')
    lines.append(f'* FROM CLIP NAME: {NAMES[shot]}.mov')
    lines.append('')
(OUT / 'GW_rough_cut.edl').write_text('\n'.join(lines), encoding='utf-8')

# 4. copy sheet: every line of on-screen text in the AI cut, with timing, so an editor can rewrite or delete each one
copy = [
    (0.1, 4.8, 'a village sandbox / Start small. / Grow a world.'),
    (7.2, 9.5, 'Glimmerwick / Build. Explore. Collect. Live together.'),
    (10.0, 13.6, '01 Explore. / Find new places, resources and creatures'),
    (14.0, 23.0, '02 Collect. / Puffbun: Cloud-bunny - ears that follow its mood / Tidler: Amphibious paddler - shores and ponds / Sprigfox: Fox-cat - leafy tail-plume / Find creatures across the world'),
    (23.0, 29.0, '03 Build up your village. / Floor, Walls, Roof, Lanterns / Gather resources, then upgrade it block by block.'),
    (29.3, 33.6, '04 Grow it. They come. / New creatures and NPCs move in as your village grows'),
    (34.3, 40.3, '05 Unlock new areas. / New biomes, resources and building options / pins: Village, Pond, Meadow, Highland'),
    (40.5, 45.5, 'One loop. / ...and the village keeps evolving / Explore, Collect, Build, Attract, Unlock'),
    (45.5, 50.0, 'Where it is today: In the prototype (voxel island and village, 3 creature species with moods, day and night, block editing engine) / Planned (catching and collecting, NPC villagers, other players, village growth and unlocks, more biomes)'),
    (50.4, 55.0, 'Glimmerwick / An open-world village sandbox / Early prototype - original IP / github.com/adi0900/Glimmerwick'),
    (9.9, 45.2, 'PROTOTYPE FOOTAGE (corner tag)'),
]
rows = ['ON-SCREEN COPY IN THE AI CUT (rewrite or delete freely; none of it is in the clean clips)', '']
rows += [f'{a:6.1f}s - {b:5.1f}s   {t}' for a, b, t in copy]
(OUT / 'GW_copy_sheet.txt').write_text('\n'.join(rows), encoding='utf-8')

(OUT / 'README.txt').write_text('''GLIMMERWICK - DaVinci Resolve handoff

clips/   11 clean clips, DNxHR SQ 4:2:2, 1920x1080, 30 fps, no audio, no text, no transitions
         (real game footage; the avatar is driven by a script and the friends are the game's own AI)
audio/   GW_audio_mix.wav (what the AI cut uses), GW_audio_music_only.wav, GW_audio_sfx_only.wav (48 kHz stereo; original synthesized, no samples)
GW_rough_cut.edl   CMX3600, 30 fps NDF, the AI cut's order and timing (record starts at 00:00:02:12 where the first clip begins)
GW_copy_sheet.txt  every line of on-screen text in the AI cut, with timing

In Resolve: new project at 1920x1080, 30 fps -> import clips/ and audio/ -> File > Import > Timeline > EDL, "Match using clip name"
-> cut on the action, add your own lower thirds and transitions.
Notes: the clips are fixed-length takes without handles. The "Early prototype - original IP" line is worth keeping.
''', encoding='utf-8')
print('done ->', OUT)
