"""Fullscreen preset excludes interactive Alt guides; history keeps full sources."""
import base64,io,json,os,shutil,socket,subprocess,time,urllib.request
from pathlib import Path
import psutil
from PIL import Image,ImageChops
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/('preset-0366-native-'+str(time.time_ns()));OUT.mkdir(parents=True,exist_ok=True)
shutil.copy2(Path(os.environ['SNIPCAST_QA_EXE']),OUT/'preset-qa.exe')
with socket.socket() as probe:probe.bind(('127.0.0.1',0));api_port=probe.getsockname()[1]
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'screenshotPresets':[],
  'apiEnabled':True,'apiPort':api_port}),encoding='utf-8')
(OUT/'update-state.json').write_text(json.dumps({'lastAttempt':time.strftime('%Y-%m-%d')}),encoding='utf-8')
proc=subprocess.Popen([str(OUT/'preset-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':'--remote-debugging-port=9282'})
def invoke(page,command,args=None):return page.evaluate('([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args)',[command,args or {}])
def post(path,data):
  token=(OUT/'api-token').read_text(encoding='utf-8').strip()
  req=urllib.request.Request(f'http://127.0.0.1:{api_port}/{path}',data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Snipcast-Token':token})
  with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
results={}
try:
  for _ in range(120):
    try:urllib.request.urlopen('http://127.0.0.1:9282/json/list',timeout=.2).close();break
    except OSError:time.sleep(.1)
  with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp('http://127.0.0.1:9282');ctx=browser.contexts[0]
    for _ in range(120):
      main=next((page for page in ctx.pages if page.locator('body.settings-body').count()),None)
      if main:break
      time.sleep(.05)
    assert main
    cfg=invoke(main,'snipcast_get_config');preset=cfg['screenshotPresets'][0]
    assert preset['id']=='builtin-fullscreen-desktop' and preset['hotkey']=='Alt+PrintScreen' and preset['fileTemplate']=='Snip {datetime}' and not preset['select']
    # Keep writes isolated; the real OS-resolved Desktop path is verified above.
    assert Path(preset['dir']).is_dir();preset['dir']=str(OUT);preset['hotkey']='';invoke(main,'snipcast_save_config',{'incoming':cfg})
    assert post('preset',{'id':preset['id']})['ok'];first=list(OUT.glob('Snip *.png'));assert len(first)==1
    entries=invoke(main,'snipcast_capture_history_list');assert len(entries)==1
    assert entries[0]['width']==Image.open(first[0]).width
    results['fullscreenPresetSavedAndRecorded']=True
    invoke(main,'snipcast_start_screenshot')
    for _ in range(120):
      capture=next((page for page in ctx.pages if page.locator('.capture--presented').count()),None)
      if capture:break
      time.sleep(.05)
    assert capture
    info=invoke(capture,'snipcast_capture_info');invoke(capture,'plugin:window|set_focus',{'label':info['label']})
    raw=bytes(capture.evaluate("async name=>Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke('snipcast_capture_image_data',{name})))",info['imageName']))
    source=Image.open(io.BytesIO(raw)).convert('RGB')
    # Dispatch physical-key equivalents into the owned WebView; avoid the user's
    # registered global Alt+PrintScreen while their application remains running.
    capture.evaluate("()=>{document.querySelector('.capture').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100,pointerId:7}));document.querySelector('.capture').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,buttons:1,clientX:700,clientY:500,pointerId:7}));document.querySelector('.capture').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,clientX:700,clientY:500,pointerId:7}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',code:'AltLeft',altKey:true,bubbles:true}));}")
    expect(capture.locator('.capture__guides')).to_be_visible()
    assert invoke(capture,'plugin:window|is_visible',{'label':info['label']}),'Capture must be visible before fullscreen preset'
    time.sleep(1.05);assert post('preset',{'id':preset['id']})['ok']
    latest=max(OUT.glob('Snip *.png'),key=lambda path:path.stat().st_mtime_ns)
    assert ImageChops.difference(Image.open(latest).convert('RGB'),source).getbbox() is None,('Preset differs from frozen source',ImageChops.difference(Image.open(latest).convert('RGB'),source).getbbox())
    results['fullscreenPresetDuringAltSelectionHasNoGuidesOrToolbar']=True
    region=[info['x']+120,info['y']+90,160,100]
    result=post('capture',{'dir':str(OUT),'name':'Region {n}','region':region});assert result.get('ok'),result
    entries=invoke(main,'snipcast_capture_history_list');entry=entries[0]
    assert (entry['width'],entry['height'])==source.size and entry['selection']=={'x':120,'y':90,'width':160,'height':100}
    results['regionalJobHistoryKeepsFullScreenAndRegion']=True
    browser.close()
finally:
  children=psutil.Process(proc.pid).children(recursive=True) if proc.poll() is None else []
  if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
  for child in children:
    try:child.terminate()
    except psutil.NoSuchProcess:pass
  psutil.wait_procs(children,timeout=3)
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
