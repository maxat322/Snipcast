"""Native acceptance: direct tools, unified search and fully visible palettes in captures."""
import ctypes,io,json,os,socket,subprocess,time,urllib.request
from ctypes import wintypes as W
from pathlib import Path
from PIL import Image,ImageGrab,ImageChops,ImageStat
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/palette-regressions-03619/native'/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True)
EXE=Path(os.environ.get('SNIPCAST_COMMANDS_QA_EXE',str(ROOT/'.qa-work/commands-qa.exe')))
with socket.socket() as sock:sock.bind(('127.0.0.1',0));PORT=sock.getsockname()[1]
config={'autostart':False,'theme':'dark','paletteHotkey':'Control+Alt+Shift+F5','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'Control+Alt+Shift+F10','items':{'unified':{'hotkey':'Control+Alt+Shift+F6'},'clipboard':{'hotkey':'Control+Alt+Shift+F9'},'emoji':{'hotkey':'Control+Alt+Shift+F8'},'translate':{'hotkey':'Control+Alt+Shift+F7'}},'clipboardEnabled':False,'storageMb':32}}
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
env={**os.environ,'SNIPCAST_QA_INPUT':'1','SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
log=(OUT/'process.log').open('w',encoding='utf8');proc=None;checks=[];metrics=[]
u=ctypes.windll.user32
u.RegisterHotKey.argtypes=[W.HWND,ctypes.c_int,W.UINT,W.UINT]
def wait(fn,timeout=30):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  value=fn()
  if value:return value
  time.sleep(.04)
 raise AssertionError('Native condition timed out')
def endpoint():
 if proc and proc.poll() is not None:raise RuntimeError(f'QA exited: {proc.returncode}')
 try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
 except OSError:return []
def invoke(page,cmd,**args):return page.evaluate('([cmd,args])=>Promise.race([window.__TAURI_INTERNALS__.invoke(cmd,args),new Promise((_,reject)=>setTimeout(()=>reject(Error(cmd+" IPC timeout")),10000))])',[cmd,args])
def available(id,key):
 free=bool(u.RegisterHotKey(None,id,7,key))
 if free:u.UnregisterHotKey(None,id)
 return free
try:
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 wait(lambda:any('tauri.localhost' in e.get('url','') for e in endpoint()))
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
  def find(label):
   pages=[page for context in browser.contexts for page in context.pages]
   if pages:pages[0].wait_for_timeout(20)
   for page in pages:
    try:
     if page.evaluate('window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label')==label:return page
    except Exception:pass
   return None
  main=wait(lambda:find('main'));main.wait_for_load_state('networkidle');errors=[];main.on('pageerror',lambda error:errors.append(str(error)))
  def call(cmd,**args):return invoke(main,cmd,**args)
  def visible(label):return call('plugin:window|is_visible',label=label)
  assert call('snipcast_get_version')==json.loads((ROOT/'package.json').read_text())['version']
  actual=call('snipcast_get_config');assert 'hotkey' not in actual['commands'] and 'unified' not in actual['commands']['items'];assert available(911,0x79) and available(912,0x75);assert not available(913,0x74) and not available(914,0x78)
  wait(lambda:'command-tool' in call('plugin:window|get_all_windows'));assert not visible('command-tool');assert 'commands' not in call('plugin:window|get_all_windows');checks.append('no command-list palette or retired hotkeys; direct tool prepared hidden')
  for section in ['clipboard','emoji','translate','calculator']:
   call('snipcast_commands_run',id=section);tool=wait(lambda:find('command-tool'));tool.wait_for_load_state('networkidle')
   wait(lambda:call('snipcast_commands_catalog')['pending'] is None and call('snipcast_commands_catalog')['section']==section)
   assert not visible('main');expect(tool.get_by_role('button',name='Назад',exact=True)).to_have_count(0)
   if section=='clipboard':expect(tool.get_by_label('Тип записей')).to_be_visible()
   elif section=='emoji':expect(tool.get_by_label('Категория Emoji')).to_be_visible()
   elif section=='translate':expect(tool.locator('.commands__translator')).to_be_visible()
   else:expect(tool.get_by_placeholder('Введите выражение…')).to_be_visible()
   tool.screenshot(path=str(OUT/(section+'-direct.png')));tool.keyboard.press('Escape');wait(lambda:not visible('command-tool'));checks.append('direct '+section+' opens separate tool without back; Esc hides it')
  def capture_palette(page,label,name,search_launch=False):
   # Let the live WebView paint, then compare the actual captured desktop pixels.
   invoke(page,'plugin:window|show',label=label);invoke(page,'plugin:window|set_focus',label=label);page.wait_for_timeout(40)
   assert visible(label),'Palette is not visible before capture'
   position=invoke(page,'plugin:window|outer_position',label=label);size=invoke(page,'plugin:window|inner_size',label=label)
   box=(position['x']+12,position['y']+12,position['x']+size['width']-12,position['y']+size['height']-12)
   live=Image.open(io.BytesIO(page.screenshot())).convert('RGB').resize((size['width'],size['height'])).crop((12,12,size['width']-12,size['height']-12))
   before=ImageGrab.grab(bbox=box,all_screens=True).convert('RGB');pre_error=sum(ImageStat.Stat(ImageChops.difference(live,before)).mean)/3
   assert pre_error<4,('Palette is occluded before capture',pre_error)
   if search_launch:page.get_by_role('option',name='Скриншот Команда').click()
   else:invoke(page,'snipcast_start_screenshot')
   cap=wait(lambda:find('capture-0'));wait(lambda:invoke(cap,'snipcast_capture_info').get('imageName'))
   info=invoke(cap,'snipcast_capture_info');image=Image.open(io.BytesIO(bytes(cap.evaluate("async name=>Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke('snipcast_capture_image_data',{name})))",info['imageName'])))).convert('RGB')
   cropped=image.crop((box[0]-info['x'],box[1]-info['y'],box[2]-info['x'],box[3]-info['y']))
   error=sum(ImageStat.Stat(ImageChops.difference(before,cropped)).mean)/3
   assert error<4,('Palette faded or disappeared in captured frame',name,error)
   # Both native and React blur paths must leave the palette alone during capture.
   invoke(page,'snipcast_palette_blur');page.wait_for_timeout(350);assert visible(label),'Capture blur hid palette'
   before.save(OUT/(name+'-before.png'));cropped.save(OUT/(name+'-captured.png'));metrics.append({'name':name,'preCaptureMeanDifference':pre_error,'captureMeanDifference':error});invoke(cap,'snipcast_close_capture');checks.append(name+' remains opaque in native capture and survives blur')
  call('snipcast_commands_run',id='root');wait(lambda:visible('main'));search=main.locator('input.palette__search');expect(main.get_by_role('tab',name='Команды',exact=True)).to_be_visible();search.fill('Скриншот');expect(main.get_by_role('option',name='Скриншот Команда')).to_be_visible();capture_palette(main,'main','main-search-screenshot',True)
  call('snipcast_commands_run',id='clipboard');tool=wait(lambda:find('command-tool'));wait(lambda:call('snipcast_commands_catalog')['pending'] is None);capture_palette(tool,'command-tool','direct-clipboard')
  call('snipcast_open_settings');settings=wait(lambda:find('settings'));settings.get_by_role('button',name='Команды',exact=True).click();expect(settings.locator('.commands-settings__row strong').filter(has_text='Скриншот')).to_have_count(0);checks.append('Screenshot absent from command settings')
  assert not errors,errors
  call('snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 result={'passed':True,'checks':checks,'metrics':metrics,'inputMethod':'native command entry point used by hotkeys; Esc via WebView keyboard; desktop capture pixels compared'};(OUT/'results.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps({'passed':True,'artifacts':str(OUT),'checks':checks,'metrics':metrics}))
except Exception as error:
 (OUT/'results.json').write_text(json.dumps({'passed':False,'completed':checks,'metrics':metrics,'error':str(error)},indent=2),encoding='utf8');raise
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 log.close()
