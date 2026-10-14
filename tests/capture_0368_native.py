"""Real competing RegisterHotKey probe: own commands, text, focus, dialog, close."""
import ast,ctypes,ctypes.wintypes,json,sys,threading,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
# Reuse the isolated capture harness and its native mouse/cleanup helpers.
sys.argv.append('--toolbar-only');source=ROOT/'tests/capture_0366_native.py';tree=ast.parse(source.read_text(encoding='utf-8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
ns={'__file__':str(source),'__name__':'capture_harness'};exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),ns)
OUT=ns['OUT'];invoke=ns['invoke'];user=ctypes.windll.user32;counts={1:0,2:0};ready=threading.Event();probe={}
def competitor():
 probe['thread']=ctypes.windll.kernel32.GetCurrentThreadId()
 ok1=user.RegisterHotKey(None,1,3,0x76);ok2=user.RegisterHotKey(None,2,0,0x43);probe['ready']=bool(ok1 and ok2);ready.set()
 try:
  msg=ctypes.wintypes.MSG()
  while user.GetMessageW(ctypes.byref(msg),None,0,0)>0:
   if msg.message==0x312 and msg.wParam in counts:counts[msg.wParam]+=1
 finally:
  if ok1:user.UnregisterHotKey(None,1)
  if ok2:user.UnregisterHotKey(None,2)
thread=threading.Thread(target=competitor,daemon=True);thread.start();assert ready.wait(5) and probe['ready'],'QA hotkey already occupied'
class Keyboard(ctypes.Structure):_fields_=[('vk',ctypes.wintypes.WORD),('scan',ctypes.wintypes.WORD),('flags',ctypes.wintypes.DWORD),('time',ctypes.wintypes.DWORD),('extra',ctypes.c_size_t)]
class Mouse(ctypes.Structure):_fields_=[('x',ctypes.wintypes.LONG),('y',ctypes.wintypes.LONG),('data',ctypes.wintypes.DWORD),('flags',ctypes.wintypes.DWORD),('time',ctypes.wintypes.DWORD),('extra',ctypes.c_size_t)]
class Payload(ctypes.Union):_fields_=[('keyboard',Keyboard),('mouse',Mouse)]
class Input(ctypes.Structure):_fields_=[('kind',ctypes.wintypes.DWORD),('payload',Payload)]
def keys(*values):
 # Send the chord as one serial batch; unrelated input cannot be inserted
 # between its modifier presses and the actual command key.
 sequence=[(v,0) for v in values]+[(v,2) for v in reversed(values)]
 events=(Input*len(sequence))(*(Input(kind=1,payload=Payload(keyboard=Keyboard(vk=vk,scan=user.MapVirtualKeyW(vk,0),flags=flags))) for vk,flags in sequence))
 assert user.SendInput(len(events),events,ctypes.sizeof(Input))==len(events);time.sleep(.1)
results={}
def select(page,a,b):
 # This probe exercises real OS keyboard delivery in a native capture window.
 # Starting through IPC does not grant foreground activation rights. Windows
 # may eat the activation click; establish foreground ownership before drag.
 origin=invoke(page,'plugin:window|outer_position',{'label':page.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')});dpr=page.evaluate('devicePixelRatio');user.SetCursorPos(origin['x']+round(a[0]*dpr),origin['y']+round(a[1]*dpr));user.mouse_event(2,0,0,0,0);user.mouse_event(4,0,0,0,0);page.wait_for_timeout(100)
 ns['drag'](page,a,b)
 expect(page.locator('.capture__toolbar')).to_be_visible()
try:
 ns['proc']=ns['start']()
 with sync_playwright() as p:
  browser,context=ns['connect'](p);main=ns['find'](context,'body.settings-body');cfg=invoke(main,'snipcast_get_config');cfg['screenshotPinHotkey']='Control+Alt+F7';invoke(main,'snipcast_save_config',{'incoming':cfg})
  label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');invoke(main,'plugin:window|show',{'label':label});invoke(main,'plugin:window|set_focus',{'label':label})
  keys(0x11,0x12,0x76);time.sleep(.2);assert counts[1]==1,'Competing hotkey is not working outside capture'
  old_image=next((page.locator('.capture').get_attribute('data-capture-image') for page in context.pages if page.locator('.capture').count()),None)
  invoke(main,'snipcast_start_screenshot');cap=ns['find'](context,'.capture')
  cap.wait_for_function('old=>{const root=document.querySelector(".capture--presented"),shot=document.querySelector(".capture__shot");return root?.dataset.captureImage&&root.dataset.captureImage!==old&&shot?.complete&&shot.naturalWidth>0}',arg=old_image)
  info=invoke(cap,'snipcast_capture_info');invoke(cap,'plugin:window|set_focus',{'label':info['label']});select(cap,(200,180),(900,620))
  old_source=cap.locator('.capture__shot').get_attribute('src')
  expect(cap.locator('.capture__toolbar')).to_contain_text('Ctrl+Alt+F7')
  keys(0x11,0x12,0x76);pin=ns['find'](context,'.pin__shot');time.sleep(.2);assert counts[1]==1,'Capture command leaked to the competitor';results['competingPinHotkeySuppressed']=True
  cap.wait_for_function("async label=>!await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label})",arg=info['label'])
  invoke(main,'snipcast_close_all_pins');invoke(main,'snipcast_start_screenshot');cap=ns['find'](context,'.capture')
  cap.wait_for_function('old=>document.querySelector(".capture__shot")?.src!==old&&document.querySelector(".capture--presented")',arg=old_source)
  info=invoke(cap,'snipcast_capture_info');invoke(cap,'plugin:window|set_focus',{'label':info['label']});select(cap,(180,150),(1100,730))
  cap.locator('[data-tool-anchor=text]').click();cap.mouse.click(600,300);text=cap.get_by_role('textbox',name='Текст на скриншоте');expect(text).to_be_focused();cap.wait_for_timeout(100)
  keys(0x43);expect(text).not_to_have_value('');assert len(text.input_value())==1,'Text key repeated';assert counts[2]==0,'Text key leaked to the competitor';results['textInputKeepsPriority']=True
  keys(0x11,0x0d);expect(text).to_have_count(0)
  invoke(main,'plugin:window|set_focus',{'label':label});time.sleep(.1);keys(0x11,0x12,0x76);time.sleep(.2);assert counts[1]==2;results['focusLossRestoresOtherHotkeys']=True
  invoke(cap,'plugin:window|set_focus',{'label':info['label']});cap.wait_for_timeout(100);keys(0x0d);time.sleep(.4)
  user.GetForegroundWindow.restype=ctypes.wintypes.HWND;cls=ctypes.create_unicode_buffer(256)
  for _ in range(100):
   dialog=user.GetForegroundWindow();user.GetClassNameW(dialog,cls,256)
   if cls.value=='#32770':break
   time.sleep(.05)
  assert cls.value=='#32770',('Save dialog missing',cls.value)
  keys(0x11,0x12,0x76);time.sleep(.2);assert counts[1]==3;keys(0x1b);time.sleep(.25);results['saveDialogRestoresOtherHotkeys']=True
  invoke(main,'snipcast_close_capture');invoke(main,'plugin:window|set_focus',{'label':label});time.sleep(.1);keys(0x43);keys(0x11,0x12,0x76);time.sleep(.2);assert counts[2]==1 and counts[1]==4;results['closeRestoresOtherHotkeys']=True
  results['version']=invoke(main,'snipcast_get_version');results['nativeDpiScale']=cap.evaluate('devicePixelRatio');browser.close()
finally:
 if ns.get('native_mouse_held'):user.mouse_event(4,0,0,0,0)
 if ns.get('proc') and ns['proc'].poll() is None:ns['stop']()
 ns['log'].close();user.PostThreadMessageW(probe['thread'],0x12,0,0);thread.join(timeout=3)
(OUT/'keyboard-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
