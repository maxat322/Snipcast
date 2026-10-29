"""Short isolated recording and MP4 quality comparison; no GIF/full video suite.

SNIPCAST_QA_EXE must use a separate Tauri identifier and a topmost settings
window in its QA-only configuration, so other desktop apps cannot cover the fixture.
"""
import json, os, subprocess, time, urllib.request
from pathlib import Path

import av
import numpy as np
import psutil
from PIL import Image, ImageGrab
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.qa-work' / 'video-best-native'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'config.json').write_text(json.dumps({
    'paletteHotkey': '', 'screenshotHotkey': '', 'autostart': False,
    'apiEnabled': False, 'screenshotPresets': [], 'theme': 'dark',
}), encoding='utf8')
log = (OUT / 'process.log').open('w', encoding='utf8')
proc = subprocess.Popen([os.environ['SNIPCAST_QA_EXE']], env={
    **os.environ, 'SNIPCAST_DATA_DIR': str(OUT),
    'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': '--remote-debugging-port=9266',
    'SNIPCAST_UPDATE_TEST_URL': 'http://127.0.0.1:1/no-update',
}, stdout=log, stderr=log)


def invoke(page, command, args=None):
    return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)', [command, args or {}])


def find(context, selector):
    for _ in range(200):
        for page in context.pages:
            if not page.is_closed() and page.locator(selector).count():
                return page
        time.sleep(.05)
    raise AssertionError(('Missing window', selector))


def phase(page, desired):
    for _ in range(200):
        status = invoke(page, 'snipcast_video_status')
        assert status['phase'] != 'error', status
        if status['phase'] == desired:
            return status
        time.sleep(.1)
    raise AssertionError(status)


def decode(path):
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        frames = [frame.to_ndarray(format='rgb24') for frame in container.decode(video=0)]
        return frames, {'width': stream.width, 'height': stream.height,
                        'frames': len(frames), 'bytes': path.stat().st_size}


try:
    for _ in range(150):
        try:
            urllib.request.urlopen('http://127.0.0.1:9266/json/list', timeout=.3).close()
            break
        except OSError:
            assert proc.poll() is None
            time.sleep(.1)
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://127.0.0.1:9266')
        context = browser.contexts[0]
        main = find(context, 'body.settings-body')
        invoke(main, 'plugin:window|show', {'label': 'settings'})
        invoke(main, 'plugin:window|set_focus', {'label': 'settings'})
        invoke(main, 'plugin:window|set_position', {'label': 'settings', 'value': {'Physical': {'x': 0, 'y': 0}}})
        # Two sharply different grayscale screens also exercise source capture.
        main.evaluate('''()=>{const c=document.createElement('canvas');c.width=800;c.height=500;
          c.style.cssText='position:fixed;inset:0;z-index:2147483647;width:800px;height:500px';
          document.body.append(c);const g=c.getContext('2d');window.qaDrawScene=index=>{let seed=42+index;
          for(let y=0;y<500;y+=4)for(let x=0;x<800;x+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;
            const v=30+((seed>>>8)%195);g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(x,y,4,4);}
          g.fillStyle=index?'#222':'#fff';g.fillRect(15,80,600,55);g.fillStyle=index?'#fff':'#222';
          g.font='16px sans-serif';g.fillText('Snipcast — quality 0123456789',30,110);};window.qaDrawScene(0);
        }''')
        # Let the newly shown/moved settings window finish DWM animation before
        # taking pixel references; a fading reference is not an encoder defect.
        main.wait_for_timeout(500)
        references = []
        for scene in [0, 1]:
            main.evaluate('scene=>qaDrawScene(scene)', scene)
            main.wait_for_timeout(150)
            reference = ImageGrab.grab(bbox=(80, 100, 720, 460)).convert('RGB')
            reference.save(OUT / f'reference-{scene}.png')
            references.append(np.asarray(reference).astype(float))
        main.evaluate('()=>qaDrawScene(0)')
        main.wait_for_timeout(150)
        invoke(main, 'snipcast_video_select')
        capture = find(context, '.capture--presented')
        invoke(capture, 'snipcast_video_start', {'options': {
            'x': 80, 'y': 100, 'width': 640, 'height': 360, 'fps': 30, 'audio': False,
        }})
        phase(main, 'recording')
        main.evaluate('()=>{let scene=0;window.qaSceneTimer=setInterval(()=>qaDrawScene((++scene)%2),500)}')
        main.wait_for_timeout(3000)
        invoke(main, 'snipcast_video_stop')
        main.evaluate('()=>clearInterval(qaSceneTimer)')
        status = phase(main, 'editing')
        editor = find(context, '.video-editor')
        quality = editor.get_by_role('combobox', name='Качество видео')
        quality.click()
        editor.get_by_role('option', name='Лучшее', exact=True).click()
        expect(quality).to_contain_text('Лучшее')
        editor.screenshot(path=str(OUT / 'best-quality-native.png'))
        source = next((OUT / 'capture-cache').glob('video-*.mp4'))
        source_frames, source_info = decode(source)
        results = {'source': source_info, 'hardware': status['hardware'], 'exports': {}}
        source_mses = [min(float(np.mean((frame.astype(float) - ref) ** 2)) for ref in references) for frame in source_frames]
        results['source']['worstScenePsnr'] = float(10 * np.log10(255 ** 2 / max(source_mses)))
        results['source']['sceneChanges'] = sum(
            int(np.mean(np.abs(a.astype(float) - b.astype(float))) > 10)
            for a, b in zip(source_frames, source_frames[1:]))
        Image.fromarray(source_frames[int(np.argmax(source_mses))]).save(OUT / 'worst-source.png')
        (OUT / 'source-results.json').write_text(json.dumps({**results['source'], 'frameMse': source_mses}, indent=2), encoding='utf8')
        assert results['source']['worstScenePsnr'] >= 35, results['source']
        assert results['source']['sceneChanges'] >= 4, results['source']
        for preset in ['small', 'sharp', 'best']:
            path = OUT / f'{preset}.mp4'
            invoke(editor, 'snipcast_video_export', {'path': str(path), 'options': {
                'startMs': 0, 'endMs': status['durationMs'], 'x': 0, 'y': 0,
                'width': 640, 'height': 360, 'format': 'mp4', 'quality': preset,
                'gifWidth': 640, 'gifFps': 10,
            }})
            frames, info = decode(path)
            assert frames and info['width'] == 640 and info['height'] == 360, info
            assert len(frames) == len(source_frames), (info, source_info)
            errors = [float(np.mean((a.astype(float) - b.astype(float)) ** 2))
                      for a, b in zip(source_frames, frames)]
            info['sourceMse'] = float(np.mean(errors))
            info['worstSourcePsnr'] = float(10 * np.log10(255 ** 2 / max(errors)))
            results['exports'][preset] = info
        exports = results['exports']
        assert exports['best']['sourceMse'] < exports['small']['sourceMse'], results
        assert exports['best']['sourceMse'] <= exports['sharp']['sourceMse'], results
        assert exports['best']['bytes'] > exports['small']['bytes'], results
        assert exports['best']['worstSourcePsnr'] >= 35, results
        (OUT / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf8')
        print(json.dumps(results, indent=2))
finally:
    children = psutil.Process(proc.pid).children(recursive=True) if proc.poll() is None else []
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=10)
    for child in children:
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(children, timeout=5)
    log.close()
