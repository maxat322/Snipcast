"""Isolated Windows capture/history/settings, Win+V and exact color verification."""
import base64,ctypes,ctypes.wintypes,io,json,os,shutil,subprocess,sys,time,urllib.request
from pathlib import Path
from PIL import Image,ImageGrab,ImageChops
import psutil
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];TOOLBAR_ONLY='--toolbar-only' in sys.argv;OUT=ROOT/'.qa-work'/('capture-toolbar-native' if TOOLBAR_ONLY else 'capture-0366-native');OUT.mkdir(parents=True,exist_ok=True)
PORT=9276;SOURCE=Path(os.environ['SNIPCAST_QA_EXE']);EXE=OUT/'capture-qa.exe';shutil.copy2(SOURCE,EXE)
cfg={'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','screenshotFormat':'png','screenshotSaveDir':str(OUT),
     'screenshotQuickLocations':[{'name':'QA folder','path':str(OUT)}],'screenshotPresets':[],'apiEnabled':False}
if TOOLBAR_ONLY:cfg['screenshotPresetDefaultsVersion']=1
(OUT/'config.json').write_text(json.dumps(cfg),encoding='utf-8');(OUT/'update-state.json').write_text(json.dumps({'lastAttempt':time.strftime('%Y-%m-%d')}),encoding='utf-8')
log=(OUT/'process.log').open('w',encoding='utf-8');proc=None;results={}
env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
def start():return subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
def stop():
    children=psutil.Process(proc.pid).children(recursive=True) if proc.poll() is None else []
    if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
    for child in children:
        try:child.terminate()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(children,timeout=3)

def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def connect(p):
    for _ in range(150):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.25).close()
            b=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');return b,b.contexts[0]
        except Exception:assert proc.poll() is None;time.sleep(.1)
    raise AssertionError('QA CDP endpoint not ready')
def find(ctx,selector):
    for _ in range(120):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError('Native page missing '+selector)
native_mouse_held=False
def drag(page,a,b):
    global native_mouse_held
    u=ctypes.windll.user32;point_type=ctypes.wintypes.POINT
    label=page.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
    origin=invoke(page,'plugin:window|outer_position',{'label':label});dpr=page.evaluate('devicePixelRatio')
    u.WindowFromPoint.restype=ctypes.c_void_p;u.GetAncestor.restype=ctypes.c_void_p
    def move(x,y):
        point=point_type(origin['x']+round(x*dpr),origin['y']+round(y*dpr));root=u.GetAncestor(ctypes.c_void_p(u.WindowFromPoint(point)),2)
        pid=ctypes.c_ulong();u.GetWindowThreadProcessId(ctypes.c_void_p(root),ctypes.byref(pid));assert pid.value==proc.pid,'Another window covers QA capture'
        assert u.SetCursorPos(point.x,point.y);page.wait_for_timeout(20)
    move(*a);page.wait_for_timeout(50);u.mouse_event(2,0,0,0,0);native_mouse_held=True
    for i in range(1,11):move(a[0]+(b[0]-a[0])*i/10,a[1]+(b[1]-a[1])*i/10)
    u.mouse_event(4,0,0,0,0);native_mouse_held=False;page.wait_for_timeout(100)

def winv():
    path=ROOT/'.qa-work/winv-count.ps1'
    value=subprocess.check_output([r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe','-NoProfile','-File',str(path)],text=True,encoding='utf-8')
    return json.loads(value)
def source_image(page,name):return Image.open(io.BytesIO(bytes(page.evaluate("async name=>Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke('snipcast_capture_image_data',{name})))",name)))).convert('RGB')
def clipboard_image():
    for _ in range(60):
        value=ImageGrab.grabclipboard()
        if isinstance(value,Image.Image):return value.convert('RGB')
        time.sleep(.05)
    raise AssertionError('Clipboard image missing')
try:
  proc=start()
  with sync_playwright() as p:
    browser,ctx=connect(p);main=find(ctx,'body.settings-body');errors=[]
    ctx.on('page',lambda page:page.on('pageerror',lambda error:errors.append(str(error))))
    assert invoke(main,'snipcast_get_version')==json.loads((ROOT/'package.json').read_text())['version']
    if TOOLBAR_ONLY:
      label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
      user=ctypes.windll.user32;width,height=user.GetSystemMetrics(0),user.GetSystemMetrics(1)
      invoke(main,'plugin:window|set_position',{'label':label,'value':{'Physical':{'x':0,'y':0}}});invoke(main,'plugin:window|set_size',{'label':label,'value':{'Physical':{'width':width,'height':height}}})
      invoke(main,'plugin:window|show',{'label':label});invoke(main,'plugin:window|set_focus',{'label':label})
      main.evaluate('()=>{const fixture=document.createElement("div");fixture.style.cssText="position:fixed;inset:0;background:linear-gradient(120deg,#596273,#8992a3);z-index:2147483647;pointer-events:none";document.body.append(fixture)}')
      main.wait_for_timeout(150);invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture--presented')
      info=invoke(cap,'snipcast_capture_info');invoke(cap,'plugin:window|set_focus',{'label':info['label']});drag(cap,(100,100),(width-180,height-350))
      hints=cap.locator('.capture__shortcuts');expect(hints).to_contain_text('− / +');expect(hints).to_contain_text('Истории скриншотов: старее / новее');expect(hints).to_contain_text('центральные направляющие');expect(hints).to_contain_text('оставить направляющие на снимке')
      cap.locator('[data-tool-anchor=arrow]').click();swatches=cap.locator('.capture__opts-swatches').first.locator('button');expect(swatches).to_have_count(10)
      tops=swatches.evaluate_all('buttons=>buttons.map(b=>b.getBoundingClientRect().top)');assert max(tops)-min(tops)<1
      expect(cap.get_by_role('button',name='Цвет #ff003c',exact=True)).to_be_visible();expect(cap.get_by_role('button',name='Цвет #b000ff',exact=True)).to_be_visible()
      cap.screenshot(path=str(OUT/'toolbar.png'));assert not errors,errors
      results={'version':invoke(main,'snipcast_get_version'),'hintsVisible':True,'singleSaturatedRow':True,'nativeDpiScale':cap.evaluate('devicePixelRatio'),'pageErrors':errors}
      (OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results));raise SystemExit(0)
    config=invoke(main,'snipcast_get_config');defaults=[x for x in config['screenshotPresets'] if x['id']=='builtin-fullscreen-desktop']
    assert len(defaults)==1 and defaults[0]['hotkey']=='Alt+PrintScreen' and not defaults[0]['select']
    results['defaultPresetMigration']=True
    config['screenshotPresets']=[];invoke(main,'snipcast_save_config',{'incoming':config})
    browser.close();stop();proc=start();browser,ctx=connect(p);main=find(ctx,'body.settings-body')
    assert not invoke(main,'snipcast_get_config')['screenshotPresets'];results['deletedDefaultNotRecreated']=True
    # Configure remapping through the real Settings interface, not just its backend.
    label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
    invoke(main,'plugin:window|show',{'label':label});invoke(main,'plugin:window|set_focus',{'label':label})
    field=main.get_by_role('textbox',name='Горячая клавиша: Копировать',exact=True);field.click();field.press('Control+k')
    main.wait_for_function("Array.from(document.querySelectorAll('input')).some(e=>e.getAttribute('aria-label')==='Горячая клавиша: Копировать'&&e.value==='Ctrl+K')")
    config=invoke(main,'snipcast_get_config');assert config['screenshotCopyHotkey']=='CommandOrControl+K'
    field.click();field.press('Enter');expect(main.get_by_text('Горячие клавиши действий должны различаться',exact=True)).to_contain_text('различаться')
    assert invoke(main,'snipcast_get_config')['screenshotCopyHotkey']=='CommandOrControl+K'
    main.locator('.settings__nav-item').first.click();assert invoke(main,'snipcast_get_config')['screenshotCopyHotkey']=='CommandOrControl+K';results['settingsRemappingAndConflict']=True
    main.screenshot(path=str(OUT/'settings.png'))
    # A known image occupies the fixture; no real user's content is included in evidence.
    user=ctypes.windll.user32;width,height=user.GetSystemMetrics(0),user.GetSystemMetrics(1)
    seed=time.time_ns();fixture=Image.new('RGB',(width,height));fixture.putdata([((x*11+seed)%256,(y*7+(seed>>8))%256,((x//64+y//64)*41+(seed>>16))%256) for y in range(height) for x in range(width)])
    buf=io.BytesIO();fixture.save(buf,format='PNG');png=base64.b64encode(buf.getvalue()).decode()
    invoke(main,'plugin:window|set_position',{'label':label,'value':{'Physical':{'x':0,'y':0}}});invoke(main,'plugin:window|set_size',{'label':label,'value':{'Physical':{'width':width,'height':height}}})
    main.evaluate('png=>{const image=document.createElement("img");image.id="qa-fixture";image.src="data:image/png;base64,"+png;image.style.cssText="position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";document.body.append(image)}',png)
    main.wait_for_timeout(250);before=winv();new_ids=[]
    for iteration in range(4):
        invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function("document.querySelector('.capture--presented')")
        info=invoke(cap,'snipcast_capture_info');invoke(cap,'plugin:window|set_focus',{'label':info['label']})
        full=source_image(cap,info['imageName']);scale=cap.locator('.capture__shot').evaluate('i=>i.naturalWidth/i.clientWidth');results['nativeDpiScale']=scale;a=(220+iteration*40,180);b=(a[0]+320,a[1]+240)
        drag(cap,a,b);cap.keyboard.press('Control+k')
        for _ in range(100):
            if not invoke(main,'plugin:window|is_visible',{'label':info['label']}):break
            main.wait_for_timeout(30)
        actual=clipboard_image();expected=full.crop((round(a[0]*scale),round(a[1]*scale),round(a[0]*scale)+round(320*scale),round(a[1]*scale)+round(240*scale)));assert actual.size==expected.size and ImageChops.difference(actual,expected).getbbox() is None,(actual.size,expected.size,scale,ImageChops.difference(actual,expected).getbbox())
        main.wait_for_timeout(700);history=winv();added=set(history['ids'])-set(before['ids'])-set(new_ids);new_ids.extend(added)
    after=winv();survived=len(set(new_ids)&set(after['ids']))
    results['clipboardHistory']={'enabled':after['enabled'],'status':after['status'],'newItemsStillPresent':survived};assert survived>=4,results['clipboardHistory']
    results['clipboardPixelsExact']=True
    large=Image.frombytes('RGB',(1536,1024),os.urandom(1536*1024*3));encoded=io.BytesIO();large.save(encoded,format='PNG');large_png=encoded.getvalue()
    ids_before_large=set(after['ids']);invoke(main,'snipcast_capture_copy',{'png':base64.b64encode(large_png).decode()});main.wait_for_timeout(800)
    copied=clipboard_image();assert copied.size==large.size and ImageChops.difference(copied,large).getbbox() is None
    results['largeClipboard']={'pngBytes':len(large_png),'bitmapBytes':1536*1024*4,'dimensions':copied.size,'newHistoryItems':len(set(winv()['ids'])-ids_before_large),'fullSizePreserved':True}
    # Opening/saving/pinning a new image must not overwrite the system clipboard.
    sequence=user.GetClipboardSequenceNumber();invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function("document.querySelector('.capture--presented')")
    info=invoke(cap,'snipcast_capture_info');drag(cap,(200,160),(520,400));cap.get_by_title('Сохранить как файл',exact=True).hover();cap.wait_for_timeout(300)
    cap.locator('.capture__quick-item').first.click();main.wait_for_timeout(500);assert user.GetClipboardSequenceNumber()==sequence
    results['saveLeavesClipboardUntouched']=True
    invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function("document.querySelector('.capture--presented')");drag(cap,(200,160),(520,400))
    cap.keyboard.press('Space');pin=find(ctx,'.pin__shot');assert not pin.locator('.pin').get_attribute('title');assert user.GetClipboardSequenceNumber()==sequence
    pin_png=pin.locator('.pin__shot').screenshot();(OUT/'pin.png').write_bytes(pin_png);results['pinLeavesClipboardUntouchedAndNoHint']=True
    invoke(main,'snipcast_close_all_pins')
    # Generate 31 distinct selected areas from one source and verify lazy persistent storage.
    invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function("document.querySelector('.capture--presented')");info=invoke(cap,'snipcast_capture_info')
    for x in range(31):invoke(cap,'snipcast_capture_history_record',{'name':info['imageName'],'selection':{'x':x,'y':100,'width':120,'height':80}})
    entries=invoke(cap,'snipcast_capture_history_list');assert len(entries)==30
    assert len(list((OUT/'screenshots-history').glob('*.png')))==30
    assert not any(e['selection']['x']==0 and e['selection']['y']==100 for e in entries)
    size_before=len(entries);invoke(cap,'snipcast_capture_history_record',{'name':info['imageName'],'selection':entries[0]['selection']});assert len(invoke(cap,'snipcast_capture_history_list'))==size_before
    latest=entries[0]['id'];opened=invoke(cap,'snipcast_capture_history_open',{'id':latest});assert Image.open(io.BytesIO(base64.b64decode(opened['png']))).size==(info['width'],info['height'])
    invoke(main,'snipcast_close_capture');old_url=cap.locator('.capture__shot').get_attribute('src');invoke(main,'snipcast_start_screenshot');cap=find(ctx,'.capture');cap.wait_for_function('old=>document.querySelector(".capture__shot")?.src!==old&&document.querySelector(".capture--presented")',arg=old_url);
    cap.keyboard.press('-');expect(cap.locator('.capture__dimchip')).to_contain_text('История');cap.keyboard.press('+');expect(cap.locator('.capture__dimchip')).not_to_contain_text('История')
    cap.screenshot(path=str(OUT/'capture.png'));invoke(main,'snipcast_close_capture')
    browser.close();stop();proc=start();browser,ctx=connect(p);main=find(ctx,'body.settings-body')
    assert len(invoke(main,'snipcast_capture_history_list'))==30;results['historyThirtyFilesPersistentAndDeduplicated']=True
    assert not errors,errors;results['pageErrors']=errors;browser.close()
finally:
  if native_mouse_held:ctypes.windll.user32.mouse_event(4,0,0,0,0)
  if proc and proc.poll() is None:stop()
  log.close()
(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False,indent=2))
