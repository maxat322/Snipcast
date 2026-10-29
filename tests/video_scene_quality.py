"""Native encoder regression for abrupt screen changes, using a clean H.264 fixture.

Usage: python -B tests/video_scene_quality.py <native-video.dll> <run-name> [--legacy]
Build the DLL first with tests/build_video_quality_dll.py <run-name>.
--legacy measures the former bitrate-only ABI and records results without quality gates.
"""
import ctypes as C
import json
import math
import sys
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.qa-work' / 'video-scenes' / sys.argv[2]
OUT.mkdir(parents=True, exist_ok=True)
W, H, FPS = 1280, 720, 30
SCENE_LENGTHS = [60, 45, 45]


def make_scene(index):
    rng = np.random.default_rng(100 + index)
    if index == 0:
        gray = np.full((H, W), 240, dtype=np.uint8)
    else:
        gray = np.repeat(np.repeat(rng.integers(30, 225, (H // 4, W // 4), dtype=np.uint8), 4, 0), 4, 1)
    image = Image.fromarray(gray).convert('RGB')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, W, 50), fill='#242424')
    font = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 18)
    draw.text((18, 14), f'Snipcast scene {index} - abrupt window switch', font=font, fill='white')
    draw.rectangle((28, 80, 620, 650), fill='white' if index != 2 else '#202020')
    for row in range(25):
        draw.text((44, 90 + row * 21), f'{row:02} | Screen text, details 0123456789 AaBb',
                  font=font, fill='#181818' if index != 2 else '#ededed')
    return np.asarray(image)


source = OUT / 'source.mp4'
with av.open(str(source), 'w') as container:
    stream = container.add_stream('libx264', rate=FPS)
    stream.width, stream.height, stream.pix_fmt = W, H, 'yuv420p'
    stream.options = {'crf': '1', 'preset': 'fast', 'x264-params': 'keyint=30:scenecut=40:bframes=0'}
    n = 0
    for scene, length in enumerate(SCENE_LENGTHS):
        rgb = make_scene(scene)
        for local in range(length):
            changed = np.roll(rgb, (local // 15) * 137, axis=1) if scene else rgb
            frame = av.VideoFrame.from_ndarray(changed, format='rgb24')
            frame.pts, frame.time_base = n, Fraction(1, FPS)
            for packet in stream.encode(frame):
                container.mux(packet)
            n += 1
    for packet in stream.encode():
        container.mux(packet)

dll = C.CDLL(str(Path(sys.argv[1]).resolve()))
callback_type = C.CFUNCTYPE(None, C.c_void_p, C.c_uint32)
progress = callback_type(lambda *_: None)
cancel = C.c_int32(0)
export = dll.snipcast_video_export
export.restype = C.c_int32
export.argtypes = [C.c_wchar_p, C.c_wchar_p, C.c_uint64, C.c_uint64,
                   *([C.c_uint32] * (7 if '--legacy' in sys.argv else 8)),
                   C.POINTER(C.c_int32), callback_type, C.c_void_p]
target = OUT / 'best.mp4'
args = [str(source), str(target), 0, 5000, 0, 0, W, H, round(W * H * FPS * .32 / 1000)]
if '--legacy' not in sys.argv:
    args.append(1)  # best-quality mode, independent of the bitrate fallback
args += [0, 10, C.byref(cancel), progress, None]
hr = export(*args)
assert hr >= 0, f'Native export HRESULT 0x{hr & 0xffffffff:08x}'

metrics = []
worst = (float('inf'), None)
with av.open(str(source)) as reference, av.open(str(target)) as result:
    for index, (a, b) in enumerate(zip(reference.decode(video=0), result.decode(video=0), strict=True)):
        original, encoded = a.to_ndarray(format='rgb24'), b.to_ndarray(format='rgb24')
        mse = float(np.mean((original.astype(np.float32) - encoded.astype(np.float32)) ** 2))
        psnr = 10 * math.log10(255 ** 2 / max(mse, .000001))
        metrics.append(psnr)
        if psnr < worst[0]:
            worst = (psnr, index)
            Image.fromarray(np.concatenate((original, encoded), axis=1)).save(OUT / 'worst-frame.png')
assert len(metrics) == 150, len(metrics)
transitions = []
for index in [60, 75, 90, 105, 120, 135]:
    transitions.append({'frame': index, 'firstFivePsnr': metrics[index:index + 5],
                        'minimumPsnr': min(metrics[index:index + 5]),
                        'settledPsnr': float(np.mean(metrics[index + 10:index + 15]))})
report = {'frames': len(metrics), 'width': W, 'height': H, 'sourceBytes': source.stat().st_size,
          'exportBytes': target.stat().st_size, 'worstPsnr': worst[0], 'worstFrame': worst[1],
          'transitions': transitions, 'framePsnr': metrics}
(OUT / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps({k: v for k, v in report.items() if k != 'framePsnr'}, indent=2))
if '--legacy' not in sys.argv:
    assert worst[0] >= 38, report
