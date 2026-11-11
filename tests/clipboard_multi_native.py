"""Native check: sequential multi-paste writes every clipboard record in order.

Runs against a QA build compiled with `--features inline-qa` (the same isolation
pattern as text suggestions). No WebView2 DevTools/CDP and no synthetic hotkeys:
the QA-only hook performs the paste on request from `paste-many-request.json`.
The target is a real Win32 EDIT control, so both the Ctrl+V path and the
WM_PASTE fallback of ``paste_into_previous`` remain observable.

Requires an idle QA desktop: another foreground application makes the synthetic
paste target activation unreliable, and a user copying text changes the shared
clipboard mid-run. Run explicitly (not auto-selected by test:changed):

    SNIPCAST_COMMANDS_QA_EXE=<inline-qa exe> SNIPCAST_QA_INLINE=1 \
        python -B tests/clipboard_multi_native.py
"""
import ctypes,json,os,sqlite3,subprocess,time
from pathlib import Path
from ctypes import wintypes as W
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/clipboard-multi-native'/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True)
EXE=Path(os.environ['SNIPCAST_COMMANDS_QA_EXE'])
if os.environ.get('SNIPCAST_QA_INLINE')!='1':raise SystemExit('Set SNIPCAST_QA_INLINE=1 for the inline-qa build')
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.OpenClipboard.argtypes=[W.HWND];u.GetClipboardData.argtypes=[W.UINT];u.GetClipboardData.restype=W.HANDLE;u.SetClipboardData.argtypes=[W.UINT,W.HANDLE];u.SetClipboardData.restype=W.HANDLE
k.GlobalAlloc.argtypes=[W.UINT,ctypes.c_size_t];k.GlobalAlloc.restype=W.HGLOBAL;k.GlobalLock.argtypes=[W.HGLOBAL];k.GlobalLock.restype=ctypes.c_void_p;k.GlobalUnlock.argtypes=[W.HGLOBAL];k.GlobalSize.argtypes=[W.HGLOBAL];k.GlobalSize.restype=ctypes.c_size_t
u.RegisterClipboardFormatW.argtypes=[W.LPCWSTR];u.RegisterClipboardFormatW.restype=W.UINT
def opening():
 for _ in range(30):
  if u.OpenClipboard(None):return
  time.sleep(.02)
 raise RuntimeError('Clipboard busy')
def read_formats():
 opening();result={}
 try:
  fmt=0
  while True:
   fmt=u.EnumClipboardFormats(fmt)
   if not fmt:break
   if fmt not in [13,15,8,17,u.RegisterClipboardFormatW("HTML Format"),u.RegisterClipboardFormatW("Rich Text Format"),u.RegisterClipboardFormatW("PNG")]:continue
   h=u.GetClipboardData(fmt);n=k.GlobalSize(h)
   if h and 0<n<32*1024*1024:
    ptr=k.GlobalLock(h)
    if ptr:result[fmt]=ctypes.string_at(ptr,n);k.GlobalUnlock(h)
 finally:u.CloseClipboard()
 return result
saved_clip=read_formats()
def write_formats(data):
 opening()
 try:
  u.EmptyClipboard()
  for fmt,b in data.items():
   h=k.GlobalAlloc(2,len(b));ptr=k.GlobalLock(h);ctypes.memmove(ptr,b,len(b));k.GlobalUnlock(h);assert u.SetClipboardData(fmt,h)
 finally:u.CloseClipboard()
def write_text(text):write_formats({13:(text+'\0').encode('utf-16le')})

# --- native EDIT fixture -----------------------------------------------------
WS_OVERLAPPEDWINDOW=0x00CF0000;WS_CHILD=0x40000000;WS_VISIBLE=0x10000000;WS_VSCROLL=0x00200000;ES_MULTILINE=0x0004;ES_AUTOVSCROLL=0x0040;ES_LEFT=0
WM_PASTE=0x0302;WM_SETFOCUS=0x0007;WM_DESTROY=0x0002;WM_SETTEXT=0x000C;WM_KEYDOWN=0x0100;VK_CONTROL=0x11
class WNDCLASSEXW(ctypes.Structure):
 _fields_=[('cbSize',ctypes.c_uint),('style',ctypes.c_uint),('lpfnWndProc',ctypes.c_void_p),('cbClsExtra',ctypes.c_int),('cbWndExtra',ctypes.c_int),('hInstance',W.HINSTANCE),('hIcon',W.HICON),('hCursor',W.HANDLE),('hbrBackground',W.HBRUSH),('lpszMenuName',W.LPCWSTR),('lpszClassName',W.LPCWSTR),('hIconSm',W.HICON)]
WNDPROC=ctypes.WINFUNCTYPE(ctypes.c_ssize_t,W.HWND,ctypes.c_uint,W.WPARAM,W.LPARAM)
editor=W.HWND(0);messages=[]
def wndproc(hwnd,msg,wparam,lparam):
 messages.append(msg)
 if msg==WM_SETFOCUS:
  u.SetFocus(editor);return 0
 if msg==WM_PASTE:
  u.SendMessageW(editor,WM_PASTE,0,0);return 0
 if msg==WM_KEYDOWN and wparam==0x56 and (u.GetKeyState(VK_CONTROL)&0x8000):
  u.SendMessageW(editor,WM_PASTE,0,0);return 0
 if msg==WM_DESTROY:return 0
 return u.DefWindowProcW(hwnd,msg,wparam,lparam)
proc=WNDPROC(wndproc)
hinst=k.GetModuleHandleW(None)
u.RegisterClassExW.argtypes=[ctypes.POINTER(WNDCLASSEXW)];u.RegisterClassExW.restype=W.ATOM
u.CreateWindowExW.argtypes=[W.DWORD,W.LPCWSTR,W.LPCWSTR,W.DWORD,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,W.HWND,W.HMENU,W.HINSTANCE,ctypes.c_void_p];u.CreateWindowExW.restype=W.HWND
u.DefWindowProcW.argtypes=[W.HWND,ctypes.c_uint,W.WPARAM,W.LPARAM];u.DefWindowProcW.restype=ctypes.c_ssize_t
u.SendMessageW.argtypes=[W.HWND,ctypes.c_uint,W.WPARAM,W.LPARAM];u.SendMessageW.restype=ctypes.c_ssize_t
u.SetFocus.argtypes=[W.HWND];u.SetFocus.restype=W.HWND
u.ShowWindow.argtypes=[W.HWND,ctypes.c_int];u.ShowWindow.restype=W.BOOL
u.UpdateWindow.argtypes=[W.HWND];u.UpdateWindow.restype=W.BOOL
u.GetWindowTextLengthW.argtypes=[W.HWND];u.GetWindowTextLengthW.restype=ctypes.c_int
u.GetWindowTextW.argtypes=[W.HWND,W.LPWSTR,ctypes.c_int];u.GetWindowTextW.restype=ctypes.c_int
u.SetWindowTextW.argtypes=[W.HWND,W.LPCWSTR];u.SetWindowTextW.restype=W.BOOL
u.PeekMessageW.argtypes=[ctypes.POINTER(W.MSG),W.HWND,ctypes.c_uint,ctypes.c_uint,ctypes.c_uint];u.PeekMessageW.restype=W.BOOL
u.TranslateMessage.argtypes=[ctypes.POINTER(W.MSG)];u.TranslateMessage.restype=W.BOOL
u.DispatchMessageW.argtypes=[ctypes.POINTER(W.MSG)];u.DispatchMessageW.restype=ctypes.c_ssize_t
u.GetKeyState.argtypes=[ctypes.c_int];u.GetKeyState.restype=ctypes.c_short
u.DestroyWindow.argtypes=[W.HWND];u.DestroyWindow.restype=W.BOOL
u.GetForegroundWindow.restype=W.HWND
u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)];u.GetWindowThreadProcessId.restype=W.DWORD
u.BringWindowToTop.argtypes=[W.HWND];u.BringWindowToTop.restype=W.BOOL
u.SetForegroundWindow.argtypes=[W.HWND];u.SetForegroundWindow.restype=W.BOOL
u.AttachThreadInput.argtypes=[W.DWORD,W.DWORD,W.BOOL];u.AttachThreadInput.restype=W.BOOL
k.GetCurrentThreadId.argtypes=[];k.GetCurrentThreadId.restype=W.DWORD
def activate_fixture():
 # The desktop foreground belongs to another application, so a plain
 # SetForegroundWindow is refused. Attach to the foreground thread first.
 other=u.GetForegroundWindow()
 other_tid=u.GetWindowThreadProcessId(other,None) if other else 0
 mine=k.GetCurrentThreadId()
 if other_tid:u.AttachThreadInput(mine,other_tid,True)
 u.BringWindowToTop(hwnd);u.SetForegroundWindow(hwnd);u.SetFocus(editor)
 if other_tid:u.AttachThreadInput(mine,other_tid,False)
 pump(150)
 return u.GetForegroundWindow()==hwnd
cls=WNDCLASSEXW(cbSize=ctypes.sizeof(WNDCLASSEXW),lpfnWndProc=ctypes.cast(proc,ctypes.c_void_p),hInstance=hinst,lpszClassName='SnipcastMultiQaTarget')
assert u.RegisterClassExW(ctypes.byref(cls))
hwnd=u.CreateWindowExW(0,'SnipcastMultiQaTarget','Snipcast multi QA target',WS_OVERLAPPEDWINDOW,40,40,560,220,None,None,hinst,None)
assert hwnd,ctypes.GetLastError()
editor=u.CreateWindowExW(0,'EDIT','',WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_AUTOVSCROLL,0,0,540,190,hwnd,None,hinst,None)
assert editor,ctypes.GetLastError()
u.ShowWindow(hwnd,5);u.UpdateWindow(hwnd)
def pump(milliseconds=0):
 end=time.monotonic()+milliseconds/1000
 while True:
  msg=W.MSG()
  if u.PeekMessageW(ctypes.byref(msg),None,0,0,1):
   u.TranslateMessage(ctypes.byref(msg));u.DispatchMessageW(ctypes.byref(msg))
  elif time.monotonic()>=end:break
  else:time.sleep(.01)
def editor_text():
 n=u.GetWindowTextLengthW(editor);buf=ctypes.create_unicode_buffer(n+1);u.GetWindowTextW(editor,buf,n+1);return buf.value
def editor_clear():u.SetWindowTextW(editor,'');pump(50)
def wait(fn,timeout=20,message='Timed out waiting for native condition'):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  pump(20)
  value=fn()
  if value:return value
 raise AssertionError(message)
# ----------------------------------------------------------------------------
def db_path():return OUT/'clipboard/history.sqlite'
def history():
 p=db_path()
 if not p.exists():return []
 try:
  with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=1) as db:return db.execute('SELECT id,meta FROM clips ORDER BY created').fetchall()
 except sqlite3.Error:return []
def history_texts():
 return {json.loads(meta)['text']:cid for cid,meta in history()}
def request(ids):
 for name in ['paste-many-request.json','paste-many-result.json']:
  try:(OUT/name).unlink()
  except FileNotFoundError:pass
 (OUT/'paste-many-request.json').write_text(json.dumps({'ids':ids,'hwnd':int(hwnd)}),encoding='utf8')
 result=wait(lambda:(OUT/'paste-many-result.json').exists() and json.loads((OUT/'paste-many-result.json').read_text(encoding='utf8')),20)
 assert result['ok'],result
def paste(ids,expected):
 editor_clear()
 foreground=activate_fixture()
 print('fixture foreground:',foreground,flush=True)
 request(ids)
 try:wait(lambda:editor_text()==expected)
 except Exception:
  print('MULTI-PASTE DIAGNOSTIC',repr(editor_text()),'expected',repr(expected),'clipboard text',repr(read_formats().get(13)),'WM_PASTE count',messages.count(WM_PASTE),'last',[hex(m) for m in messages[-8:]],'foreground',int(u.GetForegroundWindow() or 0),'target',int(hwnd),flush=True);raise
config={'autostart':False,'paletteHotkey':'','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'','items':{},'clipboardEnabled':True,'retentionDays':30,'storageMb':32,'excludedApps':[]}}
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
log=(OUT/'process.log').open('w',encoding='utf8');proc=None
try:
 proc=subprocess.Popen([str(EXE)],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT)},stdout=log,stderr=log)
 wait(lambda:db_path().exists(),25);time.sleep(1.5)
 assert proc.poll() is None
 parts=['QA один','QA два','QA три']
 for part in parts:
  write_text(part);wait(lambda:history_texts().get(part) is not None,10)
 texts=history_texts();assert len(texts)==3,texts
 ids=[texts[part] for part in parts]
 # Paste the records oldest->newest, then newest->oldest. Both orders must survive
 # the clipboard overwrite between pastes.
 paste(ids,'QA одинQA дваQA три')
 assert len(history())==3,history()
 paste(list(reversed(ids)),'QA триQA дваQA один')
 assert len(history())==3,history()
 (OUT/'result.json').write_text(json.dumps({'passed':True,'oldestFirst':'QA одинQA дваQA три','newestFirst':'QA триQA дваQA один','historyUnchanged':True},ensure_ascii=False,indent=2),encoding='utf8')
 print('PASS native multi-paste preserves requested order; clipboard history unchanged')
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip)
 u.DestroyWindow(hwnd)
log.close()
