"""Real Windows OCR reads a saved image while the active capture is blank."""
import hashlib, json, os, shutil, subprocess, tempfile, time, urllib.request
from pathlib import Path
import psutil
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1];REPORT=ROOT/'.qa-work'/'history-ocr'
REPORT.mkdir(parents=True,exist_ok=True);OUT=Path(tempfile.mkdtemp(prefix='native-',dir=REPORT))
EXE=OUT/'history-ocr-qa.exe';shutil.copy2(os.environ['SNIPCAST_QA_EXE'],EXE);PORT=9293
(OUT/'config.json').write_text(json.dumps(dict(paletteHotkey='',screenshotHotkey='',autostart=False,theme='dark',apiEnabled=False,screenshotOcrEngine='system',screenshotOcrLanguage='en-US',screenshotPresets=[],screenshotPresetDefaultsVersion=1)),encoding='utf8')
(OUT/'update-state.json').write_text(json.dumps(dict(lastAttempt=time.strftime('%Y-%m-%d'))),encoding='utf8')
history=OUT/'screenshots-history';history.mkdir();entry_id='1234567890abcdef12345678'
image=Image.new('RGB',(1600,800),'white');ImageDraw.Draw(image).text((180,200),'742 158',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',64),fill='black')
image.save(history/f'{entry_id}.png')
selection=dict(x=100,y=150,width=700,height=200)
entry=dict(id=entry_id,createdAt='2026-11-09T10:00:00+03:00',width=1600,height=800,originX=-1600,originY=-200,selection=selection,annotations=[],sourceHash=hashlib.sha256((history/f'{entry_id}.png').read_bytes()).hexdigest())
(history/'index.json').write_text(json.dumps([entry]),encoding='utf8')
log=(OUT/'process.log').open('w',encoding='utf8')
proc=subprocess.Popen([str(EXE)],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'},stdout=log,stderr=log)
results={}
def invoke(page,command,args=None):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[command,args or {}])
def find(ctx,selector):
    for _ in range(160):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError('Missing '+selector)
try:
    with sync_playwright() as p:
        for _ in range(120):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.25).close();break
            except Exception:
                assert proc.poll() is None,'QA app exited';time.sleep(.1)
        else:raise AssertionError('QA WebView2 endpoint missing')
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0];main=find(ctx,'body.settings-body')
        invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function("document.querySelector('.capture--presented')")
        info=invoke(cap,'snipcast_capture_info');sources=list(OUT.rglob(info['imageName']));assert len(sources)==1,sources
        Image.new('RGB',(info['width'],info['height']),'white').save(sources[0])
        cap.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Minus',key:'-',bubbles:true}))")
        expect(cap.locator('.capture__dimchip')).to_contain_text('История')
        # The browser test verifies both buttons' IPC arguments. Exercise that
        # same command against the real OCR engine without changing the clipboard.
        text=invoke(cap,'snipcast_ocr_region',dict(label=info['label'],historyId=entry_id,**selection))
        assert '742' in text and '158' in text,text
        assert invoke(cap,'snipcast_ocr_region',dict(label=info['label'],**selection,engine='system',language='en-US')).strip()==''
        for bad in [dict(historyId='0'*24,**selection),dict(historyId=entry_id,x=1600,y=0,width=1,height=1)]:
            try:invoke(cap,'snipcast_ocr_region',dict(label=info['label'],**bad))
            except Exception:pass
            else:raise AssertionError('Invalid source/bounds accepted')
        cap.screenshot(path=str(REPORT/'native-history.png'))
        results=dict(historyText=text,activeCaptureBlank=True,missingHistoryRejected=True,outsideBoundsRejected=True)
        browser.close()
finally:
    if proc.poll() is None:
        children=psutil.Process(proc.pid).children(recursive=True);proc.terminate();proc.wait(timeout=10)
        for child in children:
            try:child.terminate()
            except psutil.NoSuchProcess:pass
        psutil.wait_procs(children,timeout=5)
    log.close()
(REPORT/'native-results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results))
