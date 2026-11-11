"""Native visual/keyboard regression for the reported palette and settings defects."""
import ctypes,json,os,time,subprocess,urllib.request,traceback
from ctypes import wintypes as W
from pathlib import Path
from PIL import ImageGrab
from playwright.sync_api import sync_playwright,expect
from pywinauto import Desktop
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work/commands-acceptance'/str(time.time_ns());OUT.mkdir(parents=True)
exe=os.environ['SNIPCAST_COMMANDS_QA_EXE']
import socket
with socket.socket() as endpoint_socket:
 endpoint_socket.bind(('127.0.0.1',0));port=endpoint_socket.getsockname()[1]
print('CDP port',port,flush=True)
config={'theme':'dark','autostart':False,'paletteHotkey':'Control+Alt+Shift+F6','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'Control+Alt+Shift+F10','items':{'clipboard':{'enabled':True,'alias':'','hotkey':''},'emoji':{'enabled':True,'alias':'','hotkey':''},'translate':{'enabled':True,'alias':'','hotkey':''}},'clipboardEnabled':False}}
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
(OUT/'templates.json').write_text(json.dumps({'version':1,'groups':[{'id':'qa','title':'Основное','color':'#5164f2','isMaster':False,'items':[{'type':'template','id':'hello','title':'Приветствие','content':'Здравствуйте! Это проверочный шаблон.'},{'type':'template','id':'reply','title':'Ответ','content':'Спасибо за сообщение.'}]}]},ensure_ascii=False),encoding='utf8')
u=ctypes.windll.user32;g=ctypes.windll.gdi32
u.GetForegroundWindow.restype=W.HWND;u.GetWindowRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)];u.GetWindowLongW.argtypes=[W.HWND,ctypes.c_int];u.GetWindowRgn.argtypes=[W.HWND,W.HANDLE];g.CreateRectRgn.restype=W.HANDLE;g.DeleteObject.argtypes=[W.HANDLE]
def keys(seq):
 import sys
 subprocess.run([sys.executable,"-B",str(Path(__file__).with_name('native_keys.py')),*map(str,seq)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)

from contextlib import contextmanager
import threading
@contextmanager
def foreign_hotkey(identifier,mods,vk):
 ready=threading.Event();owner={}
 def pump():
  owner['thread']=ctypes.windll.kernel32.GetCurrentThreadId()
  owner['ok']=bool(u.RegisterHotKey(None,identifier,mods,vk));ready.set()
  if not owner['ok']:return
  try:
   msg=W.MSG()
   while u.GetMessageW(ctypes.byref(msg),None,0,0)>0:pass
  finally:u.UnregisterHotKey(None,identifier)
 thread=threading.Thread(target=pump,daemon=True);thread.start()
 assert ready.wait(5) and owner['ok'],'QA conflict owner unavailable'
 try:yield
 finally:u.PostThreadMessageW(owner['thread'],0x12,0,0);thread.join(3)

def wait(fn,seconds=15):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  v=fn()
  if v:return v
  time.sleep(.1)
 raise AssertionError('Timed out')
log=(OUT/'process.log').open('w');proc=subprocess.Popen([exe],env={**os.environ,'SNIPCAST_QA_INPUT':'1','SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={port}'},stdout=log,stderr=log)
checks=[];errors=[]
import faulthandler
stack=(OUT/'stacks.log').open('w');faulthandler.dump_traceback_later(30,repeat=True,file=stack)
def endpoint():
 try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=.5))
 except OSError:return None
try:
 wait(endpoint,40);time.sleep(4)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
  page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(5000)
  main=next(x for x in browser.contexts[0].pages if x.evaluate("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label")== 'main');main.wait_for_load_state('networkidle');main.set_default_timeout(5000)
  def call(cmd,**args):return page.evaluate('([c,a])=>Promise.race([window.__TAURI_INTERNALS__.invoke(c,a),new Promise((_,r)=>setTimeout(()=>r(Error(c)),8000))])',[cmd,args])
  def show(label):
   call('plugin:window|show',label=label);call('plugin:window|set_focus',label=label);win=Desktop(backend='win32').window(process=proc.pid,title={'main':'Snipcast','commands':'Палитра команд — Snipcast','settings':'Настройки — Snipcast'}[label]);win.wait('visible',timeout=5);win.set_focus();wait(lambda:u.GetForegroundWindow()==win.handle);time.sleep(.3);return win.handle
  def check(name,fn):
   print('START',name,flush=True)
   try:fn();checks.append({'name':name,'passed':True});print('PASS',name,flush=True)
   except Exception:
    checks.append({'name':name,'passed':False,'error':traceback.format_exc()});print(checks[-1]['error'],flush=True)
   (OUT/'result.json').write_text(json.dumps({'checks':checks,'errors':errors},ensure_ascii=False,indent=2),encoding='utf8')
  def frame(label):
   h=show(label);rect=W.RECT();assert u.GetWindowRect(h,ctypes.byref(rect));region=g.CreateRectRgn(0,0,0,0);r=u.GetWindowRgn(h,region);g.DeleteObject(region)
   ImageGrab.grab(bbox=(rect.left-24,rect.top-24,rect.right+24,rect.bottom+24)).save(OUT/(label+'-native.png'))
   return {'width':rect.right-rect.left,'height':rect.bottom-rect.top,'style':u.GetWindowLongW(h,-16),'exstyle':u.GetWindowLongW(h,-20),'region':r}
  def parity():
   native={label:frame(label) for label in ['main','commands']}
   assert native['main']==native['commands'],native
   props=['borderRadius','borderWidth','padding','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','gap','boxShadow']
   styles={}
   for name,view in [('main',main),('commands',page)]:
    print('styles',name,view.url,view.evaluate('document.body.innerText.slice(0,100)'),flush=True)
    styles[name]={s:view.locator(s).first.evaluate('(e,props)=>Object.fromEntries(props.map(p=>[p,getComputedStyle(e)[p]]))',props) for s in ['.palette','.palette__chrome','.palette__search','.palette__group-tab','.palette__item','.palette__item-title','.palette__item-preview','.palette__hints']}
   (OUT/'palette-comparison.json').write_text(json.dumps({'native':native,'styles':styles},ensure_ascii=False,indent=2),encoding='utf8')
   assert styles['main']==styles['commands'],[(s,styles['main'][s],styles['commands'][s]) for s in styles['main'] if styles['main'][s]!=styles['commands'][s]]
   for view in [main,page]:
    assert 'настройки' in view.locator('footer').inner_text() and 'группы' in view.locator('footer').inner_text()
   page.get_by_role('textbox',name='Поиск',exact=True).click();page.keyboard.press('Tab');expect(page.get_by_role('tab',name='Приложения',exact=True)).to_have_attribute('aria-selected','true')
   expect(page.locator('[role=option]')).to_have_count(0)
   expect(page.locator('.palette__empty')).to_contain_text('Введите название приложения')
   page.keyboard.press('Shift+Tab');expect(page.get_by_role('tab',name='Все',exact=True)).to_have_attribute('aria-selected','true')
  check('same native frame and shared palette styles; Tab groups',parity)
  show('commands');page.keyboard.press('Control+k')
  settings=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=settings' in x.url),None));settings.wait_for_load_state('networkidle');settings.set_default_timeout(5000)
  def settings_layout():
   for width in [720,880,1170]:
    call('plugin:window|set_size',label='settings',value={'Logical':{'width':width,'height':740}})
    show('settings')
    for section in ['Команды','Калькулятор','Буфер обмена','Emoji']:
     settings.get_by_role('button',name=section,exact=True).click();expect(settings.get_by_role('heading',name=section,level=2,exact=True)).to_be_visible()
     rows=settings.locator('.commands-settings__row');assert rows.count()>0
     for row in rows.all():
      box=row.bounding_box();assert box['height']<=72,box
      parts=[row.locator('.commands-settings__name'),row.get_by_label('Псевдоним:',exact=False),row.get_by_label('Горячая клавиша:',exact=False),row.get_by_role('switch'),row.get_by_role('button',name='Очистить горячую клавишу:',exact=False)]
      centers=[e.bounding_box()['y']+e.bounding_box()['height']/2 for e in parts];assert max(centers)-min(centers)<3,centers
      assert all(e.bounding_box()['x']+e.bounding_box()['width']<=box['x']+box['width']+1 for e in parts)
     settings.screenshot(path=str(OUT/f'settings-{width}-{section}.png'))
  check('settings sidebar, compact command rows and no overflow at 720/880/1170',settings_layout)
  def recording():
   settings_hwnd=show('settings');settings.get_by_role('button',name='Команды',exact=True).click();field=settings.get_by_label('Горячая клавиша: Палитра команд',exact=True);print('record: field focus',flush=True);field.click();settings.wait_for_timeout(600);print('record: focus ready',flush=True)
   settings.evaluate("window.qaKeys=[];window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'snipcast://hotkey-recorded',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>qaKeys.push(e.payload))})")
   # A foreign owner (for example Raycast) must be reported, not swallow recording.
   with foreign_hotkey(0x743,1,0x20):
    keys([0x12,0x20]);expect(settings.get_by_role('alert')).to_be_visible()
    assert call('snipcast_get_config')['commands']['hotkey']=='Control+Alt+Shift+F10'
   settings.get_by_role('heading',name='Команды',level=2,exact=True).click();field.click();settings.wait_for_timeout(600)
   def delayed_shot():
    time.sleep(2);rect=W.RECT();u.GetWindowRect(settings_hwnd,ctypes.byref(rect));ImageGrab.grab(bbox=(rect.left,rect.top,rect.right,rect.bottom)).save(OUT/'after-native-key.png')
    u.FindWindowW.restype=W.HWND
    if u.GetForegroundWindow()==settings_hwnd and u.FindWindowW('#32768',None):
     (OUT/'system-menu-open.txt').write_text('Alt+Space opened the Windows system menu');keys([0x1b])
   threading.Thread(target=delayed_shot,daemon=True).start()
   assert u.GetForegroundWindow()==settings_hwnd
   print('record: native chord',flush=True);keys([0x12,0x20]);print('record: chord sent',flush=True);settings.wait_for_timeout(500)
   events=settings.evaluate('qaKeys');(OUT/'native-key-events.json').write_text(json.dumps(events),encoding='utf8')
   wait(lambda:call('snipcast_get_config')['commands']['hotkey']=='Alt+Space')
   expect(field).to_have_value('Alt+Space');settings.screenshot(path=str(OUT/'alt-space-recorded.png'))
   settings.get_by_role('heading',name='Команды',level=2,exact=True).click();call('plugin:window|hide',label='main');call('plugin:window|hide',label='commands');call('plugin:window|hide',label='settings');time.sleep(.5)
   keys([0x12,0x20]);wait(lambda:call('plugin:window|is_visible',label='commands'));expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_focused()
   assert any(e['code']=='Space' and e['altKey'] for e in events),events
   assert json.loads((OUT/'config.json').read_text(encoding='utf8'))['commands']['hotkey']=='Alt+Space'
   # Verify system-level conflict is reported and the saved binding survives.
   with foreign_hotkey(0x742,2|4,0x75):
    show('settings');field.click();settings.wait_for_timeout(500);keys([0x11,0x10,0x75]);expect(settings.get_by_role('alert')).to_be_visible();assert call('snipcast_get_config')['commands']['hotkey']=='Alt+Space'
   settings.get_by_role('heading',name='Команды',level=2,exact=True).click()
  check('native Alt+Space recording, persisted binding, global opening and OS conflict',recording)
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
finally:
 if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 log.close()
print(json.dumps({'passed':sum(c['passed'] for c in checks),'failed':sum(not c['passed'] for c in checks),'artifacts':str(OUT)}),flush=True)
raise SystemExit(any(not c['passed'] for c in checks))
