"""Isolated WebView2 history persistence/clear checks without clipboard or video work."""
import base64, io, json, os, shutil, subprocess, tempfile, time, urllib.request
from pathlib import Path
import psutil
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1];REPORT=ROOT/'.qa-work'/'capture-history-native';REPORT.mkdir(parents=True,exist_ok=True)
OUT=Path(tempfile.mkdtemp(prefix='run-',dir=REPORT))
EXE=OUT/'history-qa.exe';shutil.copy2(os.environ['SNIPCAST_QA_EXE'],EXE);PORT=9289
cfg=dict(paletteHotkey='',screenshotHotkey='',autostart=False,theme='dark',apiEnabled=False,screenshotFormat='png',screenshotQuickLocations=[dict(name='QA folder',path=str(OUT))],screenshotPresets=[],screenshotPresetDefaultsVersion=1)
(OUT/'config.json').write_text(json.dumps(cfg),encoding='utf8')
(OUT/'update-state.json').write_text(json.dumps(dict(lastAttempt=time.strftime('%Y-%m-%d'))),encoding='utf8')
env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
log=(OUT/'process.log').open('w',encoding='utf8');proc=None;results={}

def start():return subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
def stop():
    if proc.poll() is not None:return
    children=psutil.Process(proc.pid).children(recursive=True);proc.terminate();proc.wait(timeout=10)
    for child in children:
        try:child.terminate()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(children,timeout=5)

def connect(p):
    for _ in range(150):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.25).close()
            browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');return browser,browser.contexts[0]
        except Exception:
            assert proc.poll() is None,'QA process exited';time.sleep(.1)
    raise AssertionError('WebView2 endpoint missing')

def find(ctx,selector):
    for _ in range(150):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError('Missing page: '+selector)

def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def key(page,code,ctrl=False):
    page.evaluate("([code,ctrl])=>document.body.dispatchEvent(new KeyboardEvent('keydown',{code,key:code==='Minus'?'-':'z',ctrlKey:ctrl,bubbles:true}))",[code,ctrl])
def capture(main,ctx):
    invoke(main,'snipcast_start_screenshot');page=find(ctx,'.capture')
    page.wait_for_function("document.querySelector('.capture--presented')");return page

try:
    proc=start()
    with sync_playwright() as p:
        browser,ctx=connect(p);main=find(ctx,'body.settings-body');cap=capture(main,ctx)
        info=invoke(cap,'snipcast_capture_info');selection=dict(x=100,y=100,width=600,height=350)
        arrow=dict(id=1,kind='arrow',color='#ff003c',opacity=.8,thickness=5,p1=dict(x=180,y=180),p2=dict(x=450,y=300))
        text=dict(id=2,kind='text',color='#ffffff',opacity=.75,p1=dict(x=200,y=340),p2=dict(x=200,y=340),text='История',fontSize=24,textMode='frame',width=240,minHeight=50,outlineColor='#000000',outlineWidth=2)
        args=dict(name=info['imageName'],selection=selection,annotations=[arrow,text])
        annotated=invoke(cap,'snipcast_capture_history_record',args)
        assert invoke(cap,'snipcast_capture_history_record',args)==annotated
        plain=invoke(cap,'snipcast_capture_history_record',dict(name=info['imageName'],selection=selection))
        assert plain!=annotated
        assert invoke(cap,'snipcast_capture_history_record',args)==annotated
        assert len(invoke(cap,'snipcast_capture_history_list'))==2
        # Simulate an existing index from before annotations were supported.
        index=OUT/'screenshots-history'/'index.json';entries=json.loads(index.read_text(encoding='utf8'))
        next(e for e in entries if e['id']==plain).pop('annotations');index.write_text(json.dumps(entries),encoding='utf8')
        assert invoke(cap,'snipcast_capture_history_open',dict(id=plain))['entry']['annotations']==[]
        opened=invoke(cap,'snipcast_capture_history_open',dict(id=annotated));assert opened['entry']['annotations']==[arrow,text]
        source=Image.open(io.BytesIO(base64.b64decode(opened['png']))).convert('RGB')
        invoke(main,'snipcast_close_capture');browser.close();stop();proc=start();browser,ctx=connect(p);main=find(ctx,'body.settings-body')
        assert invoke(main,'snipcast_capture_history_open',dict(id=annotated))['entry']['annotations']==[arrow,text]
        cap=capture(main,ctx);cap.wait_for_timeout(300);key(cap,'Minus');expect(cap.locator('.capture__dimchip')).to_contain_text('История 1/2')
        clear=cap.get_by_role('button',name='Очистить',exact=True);expect(clear).to_be_visible()
        before=cap.locator('.capture__shapes').evaluate('c=>c.toDataURL()');clear.click();expect(clear).to_have_count(0)
        key(cap,'KeyZ',True);expect(clear).to_be_visible();assert cap.locator('.capture__shapes').evaluate('c=>c.toDataURL()')==before
        clear.click();cap.get_by_title('Сохранить как файл',exact=True).hover();cap.locator('.capture__quick-item').first.click()
        for _ in range(100):
            saved=list(OUT.glob('*.png'))
            if saved:break
            time.sleep(.05)
        assert len(saved)==1,saved
        actual=Image.open(saved[0]).convert('RGB');expected=source.crop((100,100,700,450))
        assert actual.size==expected.size and ImageChops.difference(actual,expected).getbbox() is None
        # The PNG is written before the save promise records its history entry.
        # Observe persistence completion rather than racing the filesystem write.
        for _ in range(100):
            entries=invoke(main,'snipcast_capture_history_list')
            if len(entries)==2 and entries[0]['id']==plain and entries[0]['annotations']==[]:break
            time.sleep(.05)
        assert len(entries)==2 and entries[0]['id']==plain and entries[0]['annotations']==[],entries
        assert invoke(main,'snipcast_capture_history_open',dict(id=annotated))['entry']['annotations']==[arrow,text]
        # The same 30-item limit and PNG cleanup apply to annotation variants.
        cap=capture(main,ctx);source_name=invoke(cap,'snipcast_capture_info')['imageName']
        for i in range(31):
            invoke(main,'snipcast_capture_history_record',dict(name=source_name,selection=selection,annotations=[{**arrow,'color':f'#{i+1:06x}'}]))
        assert len(invoke(main,'snipcast_capture_history_list'))==30
        assert len(list((OUT/'screenshots-history').glob('*.png')))==30
        results.update(editableAnnotationsPersistAfterRestart=True,legacyIndexCompatible=True,annotationVariantsDeduplicated=True,clearUndo=True,clearedSavePixelsExact=True,oldVariantPreserved=True,limit30AndCleanup=True)
        browser.close()
finally:
    if proc and proc.poll() is None:stop()
    log.close()
(REPORT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results,indent=2))
