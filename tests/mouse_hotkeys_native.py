"""Actual Windows mouse input against an isolated QA instance; no user settings changes."""
import ctypes,importlib.util,json,os,socket,subprocess,time,urllib.request
from ctypes import wintypes as W
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=Path(os.environ.get('SNIPCAST_MOUSE_QA_WORK',str(ROOT/'.qa-work/mouse-hotkeys-native')))/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True)
EXE=Path(os.environ.get('SNIPCAST_COMMANDS_QA_EXE',str(ROOT/'.qa-work/mouse-hotkeys-qa.exe')))
with socket.socket() as port_socket:port_socket.bind(('127.0.0.1',0));PORT=port_socket.getsockname()[1]
config={'autostart':False,'paletteHotkey':'Alt+MouseRight','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'items':{'clipboard':{'hotkey':'MouseLeft+MouseRight'},'emoji':{'hotkey':'Control+Mouse4'},'translate':{'hotkey':'Control+Mouse5'}},'storageMb':32}}
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
env={**os.environ,'SNIPCAST_QA_INPUT':'1','SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
spec=importlib.util.spec_from_file_location('keys',ROOT/'tests/native_keys.py');keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)];u.GetForegroundWindow.restype=W.HWND;u.SetForegroundWindow.argtypes=[W.HWND];u.GetWindowRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)];u.IsWindowVisible.argtypes=[W.HWND];u.GetWindowTextW.argtypes=[W.HWND,W.LPWSTR,ctypes.c_int]
u.GetAncestor.argtypes=[W.HWND,W.UINT];u.GetAncestor.restype=W.HWND;u.WindowFromPoint.argtypes=[W.POINT];u.WindowFromPoint.restype=W.HWND;u.ClientToScreen.argtypes=[W.HWND,ctypes.POINTER(W.POINT)];u.AttachThreadInput.argtypes=[W.DWORD,W.DWORD,W.BOOL]
API_ONLY=os.environ.get('SNIPCAST_MOUSE_API_ONLY')=='1'
original_cursor=W.POINT();u.GetCursorPos(ctypes.byref(original_cursor));proc=None;log=(OUT/'process.log').open('w',encoding='utf8');scenarios=[]
def wait(fn,timeout=20):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  value=fn()
  if value:return value
  time.sleep(.04)
 raise AssertionError('Native condition timed out')
def endpoints():
 if proc and proc.poll() is not None:raise RuntimeError(f'QA exited: {proc.returncode}')
 try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.5))
 except OSError:return []
def own_window(title):
 found=[]
 @ctypes.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
 def collect(hwnd,arg):
  pid=W.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(pid));text=ctypes.create_unicode_buffer(512);u.GetWindowTextW(hwnd,text,512)
  if pid.value==proc.pid and text.value==title and u.IsWindowVisible(hwnd):found.append(hwnd)
  return True
 u.EnumWindows(collect,0);assert len(found)==1,('Visible QA target',len(found));return found[0]
def focus(hwnd):
 attached=[];thread=k.GetCurrentThreadId()
 for other in {u.GetWindowThreadProcessId(hwnd,None),u.GetWindowThreadProcessId(u.GetForegroundWindow(),None)}:
  if other and other!=thread and u.AttachThreadInput(thread,other,True):attached.append(other)
 try:u.ShowWindow(hwnd,9);u.BringWindowToTop(hwnd);u.SetForegroundWindow(hwnd)
 finally:
  for other in attached:u.AttachThreadInput(thread,other,False)
def target(hwnd,x=None,y=None):
 focus(hwnd)
 if x is None:
  rect=W.RECT();assert u.GetWindowRect(hwnd,ctypes.byref(rect));point=W.POINT((rect.left+rect.right)//2,(rect.top+rect.bottom)//2)
 else:point=W.POINT(int(x),int(y));assert u.ClientToScreen(hwnd,ctypes.byref(point))
 assert u.SetCursorPos(point.x,point.y)
 assert u.GetAncestor(u.WindowFromPoint(point),2)==hwnd,'Pointer is outside the QA window; refusing input'
 if u.GetForegroundWindow()!=hwnd:
  send(None,['left'])  # Activate only the just-verified QA surface with an ordinary click.
  wait(lambda:u.GetForegroundWindow()==hwnd,4)
def send(modifier,buttons):
 events=[]
 def key(v,flags):return keys.NativeInput(kind=1,payload=keys.IPayload(keyboard=keys.KInput(vk=v,flags=flags)))
 def mouse(button,down):
  flags,data={'left':((2 if down else 4),0),'right':((8 if down else 16),0),'middle':((32 if down else 64),0),'back':((128 if down else 256),1),'forward':((128 if down else 256),2)}[button]
  return keys.NativeInput(kind=0,payload=keys.IPayload(mouse=keys.MInput(flags=flags,data=data)))
 def deliver(items):
  batch=(keys.NativeInput*len(items))(*items);assert u.SendInput(len(batch),batch,ctypes.sizeof(keys.NativeInput))==len(batch)
 try:
  if modifier:deliver([key(modifier,0)]);time.sleep(.1)
  for button in buttons:deliver([mouse(button,True)]);time.sleep(.08)
  for button in reversed(buttons):deliver([mouse(button,False)]);time.sleep(.08)
 finally:
  if modifier:deliver([key(modifier,2)])

try:
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 wait(lambda:any('tauri.localhost' in e.get('url','') and 'snipcast=' not in e['url'] for e in endpoints()))
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');main=wait(lambda:next((page for page in browser.contexts[0].pages if 'tauri.localhost' in page.url and 'snipcast=' not in page.url),None));main.wait_for_load_state('networkidle')
  def call(cmd,**args):return main.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args])
  assert call('snipcast_get_version')==json.loads((ROOT/'package.json').read_text())['version']
  state=call('snipcast_mouse_hotkeys_qa_state');assert len(state['bindings'])==4,state
  catalog=call('snipcast_commands_catalog');assert not catalog['error'],catalog['error'];scenarios.append('native mouse hook installed')
  main_hwnd=None
  for modifier,buttons,section in ([] if API_ONLY else [(0x12,['right'],'root'),(None,['left','right'],'clipboard'),(0x11,['back'],'emoji'),(0x11,['forward'],'translate')]):
   call('snipcast_commands_run',id='root')
   if main_hwnd is None:
    wait(lambda:call('plugin:window|is_visible',label='main'));main_hwnd=own_window('Snipcast')
   target(main_hwnd);expect(main.locator('input.palette__search')).to_have_attribute('placeholder','Поиск шаблонов, команд и приложений...')
   before=call('snipcast_mouse_hotkeys_qa_state');send(modifier,buttons)
   try:wait(lambda:call('snipcast_mouse_hotkeys_qa_state')['matched']==before['matched']+1,5)
   except AssertionError:
    print(json.dumps({'section':section,'before':before,'after':call('snipcast_mouse_hotkeys_qa_state')}),flush=True);raise
   after=call('snipcast_mouse_hotkeys_qa_state');assert after['seen']>=before['seen']+len(buttons)*2
   display=main
   if section!='root':
    def direct_page():
     main.wait_for_timeout(20)
     return next((page for context in browser.contexts for page in context.pages if 'snipcast=command-tool' in page.url),None)
    display=wait(direct_page);expect(display.get_by_role('button',name='Назад',exact=True)).to_have_count(0)
   if section=='root':expect(main.locator('input.palette__search')).to_have_attribute('placeholder','Поиск шаблонов, команд и приложений...')
   elif section=='clipboard':expect(display.get_by_label('Тип записей')).to_be_visible()
   elif section=='emoji':expect(display.get_by_label('Категория Emoji')).to_be_visible()
   else:expect(display.locator('.commands__translator')).to_be_visible()
   scenarios.append('actual input '+section)
  actual=call('snipcast_get_config');actual['commands']['items']['emoji']['hotkey']='';call('snipcast_save_config',incoming=actual)
  call('snipcast_open_settings');settings=wait(lambda:next((page for page in browser.contexts[0].pages if 'snipcast=settings' in page.url),None));settings.wait_for_load_state('networkidle');settings.reload();settings.wait_for_load_state('networkidle');settings.get_by_role('button',name='Основные',exact=True).click()
  field=settings.get_by_label('Запись хоткея палитры',exact=True);field.click();wait(lambda:call('snipcast_mouse_hotkeys_qa_state')['recording'])
  if API_ONLY:field.dispatch_event('mousedown',{'button':3,'buttons':8,'ctrlKey':True})
  else:
   box=field.bounding_box();target(own_window('Настройки — Snipcast'),box['x']+box['width']/2,box['y']+box['height']/2);send(0x11,['back'])
  expect(field).to_have_value('Ctrl+Мышь 4');wait(lambda:call('snipcast_get_config')['paletteHotkey']=='CommandOrControl+Mouse4');scenarios.append('DOM recorder through native save' if API_ONLY else 'actual mouse recorder')
  field.blur();wait(lambda:not call('snipcast_mouse_hotkeys_qa_state')['recording'])
  shared=settings.get_by_label('Горячая клавиша: Скриншот: копировать в буфер',exact=True);shared.click();wait(lambda:call('snipcast_mouse_hotkeys_qa_state')['recording'])
  if API_ONLY:shared.dispatch_event('mousedown',{'button':1,'buttons':4,'shiftKey':True})
  else:
   box=shared.bounding_box();target(own_window('Настройки — Snipcast'),box['x']+box['width']/2,box['y']+box['height']/2);send(0x10,['middle'])
  expect(shared).to_have_value('Shift+СКМ');wait(lambda:call('snipcast_get_config')['screenshotCopyHotkey']=='Shift+MouseMiddle');scenarios.append('shared DOM recorder through native save' if API_ONLY else 'actual shared recorder with modifier');shared.blur();settings.screenshot(path=str(OUT/'settings.png'))
  previous=call('snipcast_get_config');conflict=json.loads(json.dumps(previous));conflict['commands']['items']['emoji']['hotkey']='Control+Mouse4'
  try:call('snipcast_save_config',incoming=conflict);raise AssertionError('Conflicting shortcut accepted')
  except Exception as error:assert 'используется' in str(error)
  assert call('snipcast_get_config')==previous;scenarios.append('conflict preserves saved config')
  previous['commands']['enabled']=False;call('snipcast_save_config',incoming=previous);assert 'MouseLeft+MouseRight' not in call('snipcast_mouse_hotkeys_qa_state')['bindings'];previous['commands']['enabled']=True;call('snipcast_save_config',incoming=previous);assert 'MouseLeft+MouseRight' in call('snipcast_mouse_hotkeys_qa_state')['bindings'];scenarios.append('group switch restores assignments')
  call('snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log);wait(lambda:endpoints())
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');main=wait(lambda:next((page for page in browser.contexts[0].pages if 'tauri.localhost' in page.url and 'snipcast=' not in page.url),None));main.wait_for_load_state('networkidle');assert call('snipcast_get_config')['paletteHotkey']=='CommandOrControl+Mouse4';wait(lambda:'MouseLeft+MouseRight' in call('snipcast_mouse_hotkeys_qa_state')['bindings']);scenarios.append('restart persistence');call('snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 (OUT/'results.json').write_text(json.dumps({'passed':True,'apiOnly':API_ONLY,'scenarios':scenarios},indent=2),encoding='utf8');print(json.dumps({'passed':True,'apiOnly':API_ONLY,'scenarios':scenarios}))
except Exception as error:
 (OUT/'results.json').write_text(json.dumps({'passed':False,'completed':scenarios,'error':str(error)},indent=2),encoding='utf8');raise
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 u.SetCursorPos(original_cursor.x,original_cursor.y);log.close()
