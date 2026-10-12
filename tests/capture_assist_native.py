"""Isolated native WebView2 probe. Build with a QA identifier, then use start/capture/check/stop.

TAURI_CONFIG={"identifier":"com.snipcast.selection-qa"} cargo build --manifest-path src-tauri/Cargo.toml
Does not stop or modify the user's running Snipcast instance.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/'capture-assist-native'
PORT=9241
parser=argparse.ArgumentParser()
parser.add_argument('stage',choices=['start','capture','inspect','check','stop'])
args=parser.parse_args()

if args.stage=='start':
    OUT.mkdir(parents=True,exist_ok=True)
    shutil.copy2(ROOT/'src-tauri'/'target'/'debug'/'snipcast.exe',OUT/'selection-qa.exe')
    cfg={'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark',
         'paletteListDensity':'normal','screenshotFormat':'png','screenshotJpegQuality':90,
         'screenshotFileTemplate':'qa {n}','screenshotSaveDir':str(OUT),'screenshotQuickLocations':[],
         'screenshotOcrEngine':'system','screenshotOcrLanguage':'auto','screenshotOcrQuality':'mobile',
         'screenshotPresets':[],'apiEnabled':False,'apiPort':52391,'aiApiKey':'','aiModel':''}
    (OUT/'config.json').write_text(json.dumps(cfg),encoding='utf8')
    with (OUT/'process.log').open('w',encoding='utf8') as log:
        proc=subprocess.Popen([str(OUT/'selection-qa.exe')],env={**os.environ,
           'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'},stdout=log,stderr=log)
    (OUT/'pid').write_text(str(proc.pid))
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
        except OSError:
            assert proc.poll() is None,'QA instance exited; build with the separate QA identifier'
            time.sleep(.1)
    else: raise AssertionError('No WebView2 endpoint')
    print('Started isolated selection QA instance')
elif args.stage=='stop':
    os.kill(int((OUT/'pid').read_text()),15)
    print('Stopped isolated selection QA instance')
else:
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
        pages=browser.contexts[0].pages
        main=next(page for page in pages if 'snipcast=settings' in page.url)
        if args.stage=='capture':
            main.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_start_screenshot')")
            print('Started native capture')
        else:
            page=next(page for page in pages if page.locator('.capture').count())
            page.set_default_timeout(5000)
            page.wait_for_function("document.querySelector('.capture').classList.contains('capture--presented')")
            info=page.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_capture_info')")
            (OUT/'geometry.json').write_text(json.dumps(info),encoding='utf8')
            print(json.dumps({'windows':sum(c['kind']=='window' for c in info['candidates']),
                'elements':sum(c['kind']=='element' for c in info['candidates']),
                'frontWindow':next((c for c in info['candidates'] if c['kind']=='window'),None)}))
            if args.stage=='check':
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                vp=page.evaluate('({w:innerWidth,h:innerHeight})')
                rect=lambda:page.locator('.capture__frame').bounding_box()
                elements=[c for c in info['candidates'] if c['kind']=='element' and c['windowOrder']==0 and c['width']>20 and c['height']>20]
                assert elements,'Front window has no UIA elements'
                c=max(elements,key=lambda c:c['depth'])
                x=(c['x']+c['width']/2-info['x'])*vp['w']/info['width']
                y=(c['y']+c['height']/2-info['y'])*vp['h']/info['height']
                assert 0<=x<vp['w'] and 0<=y<vp['h']
                page.mouse.move(x,y)
                expect(page.locator('.capture__loupe')).to_be_visible()
                before=rect(); assert before and page.locator('.capture__toolbar').count()==0
                pixel_text=page.locator('.capture__loupe-color').inner_text().strip()
                raw=page.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_capture_image_data',{name:"+json.dumps(info['imageName'])+"}).then(buf=>Array.from(new Uint8Array(buf)))")
                image=Image.open(io.BytesIO(bytes(raw))).convert('RGB')
                px=int(x*image.width/vp['w']);py=int(y*image.height/vp['h'])
                expected='#'+''.join(f'{v:02X}' for v in image.getpixel((px,py)))
                assert pixel_text==expected,(pixel_text,expected)
                page.keyboard.press('c')
                expect(page.locator('.capture__toast')).to_contain_text(expected)
                copied=main.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_clipboard_read_text')")
                assert copied==expected,(copied,expected)
                page.keyboard.press('Tab');expect(page.locator('.capture__shortcuts')).to_have_attribute('data-mode','window')
                window_rect=rect();assert window_rect['width']>=before['width']
                page.keyboard.press('Tab');page.mouse.click(x,y)
                page.locator('.capture__toolbar').wait_for();assert page.locator('.capture__loupe').count()==0
                for key in before: assert abs(rect()[key]-before[key])<1
                page.screenshot(path=str(OUT/'selected.png'))
                page.keyboard.press('Escape')
                assert not errors,errors
                print('PASS: real UIA geometry, WebView2 proposal, window toggle, source pixel, Windows clipboard, one-click selection')
