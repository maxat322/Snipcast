"""Native command palette acceptance against an isolated QA identifier/data directory."""
import ctypes,json,os,subprocess,time,urllib.request,tkinter as tk,struct,io,base64,sqlite3
from pathlib import Path
from ctypes import wintypes as W
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/commands-native'/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True)
EXE=Path(os.environ.get('SNIPCAST_COMMANDS_QA_EXE',str(ROOT/'.qa-work/commands-qa.exe')));PORT=9278
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.OpenClipboard.argtypes=[W.HWND];u.GetClipboardData.argtypes=[W.UINT];u.GetClipboardData.restype=W.HANDLE;u.SetClipboardData.argtypes=[W.UINT,W.HANDLE];u.SetClipboardData.restype=W.HANDLE
k.GlobalAlloc.argtypes=[W.UINT,ctypes.c_size_t];k.GlobalAlloc.restype=W.HGLOBAL;k.GlobalLock.argtypes=[W.HGLOBAL];k.GlobalLock.restype=ctypes.c_void_p;k.GlobalUnlock.argtypes=[W.HGLOBAL];k.GlobalSize.argtypes=[W.HGLOBAL];k.GlobalSize.restype=ctypes.c_size_t
u.GetForegroundWindow.restype=W.HWND;u.SetForegroundWindow.argtypes=[W.HWND];u.RegisterClipboardFormatW.argtypes=[W.LPCWSTR];u.RegisterClipboardFormatW.restype=W.UINT
window=tk.Tk();window.title('Snipcast command QA paste target');window.geometry('480x200+20+20');editor=tk.Text(window);editor.pack(fill='both',expand=True);window.update();hwnd=window.winfo_id()
def opening():
 for _ in range(30):
  if u.OpenClipboard(hwnd):return
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
def wait(fn,timeout=12):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  window.update()
  value=fn()
  if value:return value
  time.sleep(.08)
 raise AssertionError('Timed out waiting for native condition')
config={'autostart':False,'paletteHotkey':'','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'Control+Alt+Shift+F10','items':{},'clipboardEnabled':True,'retentionDays':30,'storageMb':32,'excludedApps':[]}}
apps=OUT/'apps';apps.mkdir();marker_file=OUT/'launched.txt'
launch_script=OUT/'launch.ps1';launch_script.write_text(f"'launched' | Set-Content -LiteralPath '{marker_file}'",encoding='utf8')
ps=f'''$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{apps}/Snipcast QA Launcher.lnk');$s.TargetPath="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";$s.Arguments='-NoProfile -WindowStyle Hidden -File "{launch_script}"';$s.WindowStyle=7;$s.Save()'''
subprocess.run(['powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],check=True,creationflags=0x08000000)
config['commands']['folders']=[str(apps)]
(OUT/'config.json').write_text(json.dumps(config),encoding='utf8')
log=(OUT/'process.log').open('w',encoding='utf8');proc=None
try:
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  if proc.poll() is not None:raise RuntimeError('QA process exited')
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,30)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None))
  page.wait_for_load_state('networkidle');page.set_default_timeout(8000)
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def listing():return call('snipcast_history_list',query='',kind='',offset=0)['items']
  wait(lambda:len(call('snipcast_commands_catalog')['entries'])>12,25)
  # Copy Unicode + HTML from an actual external clipboard owner.
  text='  Snipcast QA\nТочный текст  ';html=u.RegisterClipboardFormatW('HTML Format');rich=u.RegisterClipboardFormatW('Rich Text Format')
  payload={13:(text+'\0').encode('utf-16le'),html:b'<html><body><!--StartFragment--><b>QA</b><!--EndFragment--></body></html>\0',rich:b'{\\rtf1 QA}\0'}
  write_formats(payload);entry=wait(lambda:next((c for c in listing() if c['text']==text),None));assert entry['source'];id=entry['id']
  call('snipcast_history_action',id=id,action='pin',value=None);assert call('snipcast_history_detail',id=id)['pinned']
  call('snipcast_history_action',id=id,action='rename',value='Native pinned record');assert call('snipcast_history_detail',id=id)['title']=='Native pinned record'
  write_formats({13:'Other\0'.encode('utf-16le')});wait(lambda:len(listing())>=2);n=len(listing());call('snipcast_history_action',id=id,action='copy',value=None);restored=read_formats();assert all(restored[f]==b for f,b in payload.items());time.sleep(.5);assert len(listing())==n
  # Real focus restoration and Ctrl+V into our test edit control.
  editor.delete('1.0','end');window.deiconify();window.lift();editor.focus_force();window.update();time.sleep(.1)
  # Actual global hotkey (isolated from the user's ordinary bindings).
  for vk in [0x11,0x12,0x10,0x79]:u.keybd_event(vk,0,0,0)
  for vk in [0x79,0x10,0x12,0x11]:u.keybd_event(vk,0,2,0)
  wait(lambda:call('plugin:window|is_visible',label='commands'))
  # Keep the target GUI pumping while Windows activates it and delivers Ctrl+V.
  page.evaluate('(id)=>{window.qaPaste=null;window.__TAURI_INTERNALS__.invoke("snipcast_history_action",{id,action:"paste",value:null}).then(()=>window.qaPaste="ok",e=>window.qaPaste=String(e))}',id)
  wait(lambda:page.evaluate('window.qaPaste'))
  assert page.evaluate('window.qaPaste')=='ok'
  try:wait(lambda:editor.get('1.0','end-1c')==text)
  except Exception:
   print('PASTE DIAGNOSTIC',repr(editor.get('1.0','end-1c')),repr(text),'foreground',u.GetForegroundWindow(),'fixture',hwnd,flush=True);raise
  # Many paste: every selected record is pasted in the requested order without
  # adding new history entries.
  for part in ['QA один','QA два','QA три']:
   write_formats({13:(part+'\0').encode('utf-16le')});wait(lambda:any(c['text']==part for c in listing()))
  ids=[wait(lambda:next((c['id'] for c in listing() if c['text']==part),None)) for part in ['QA один','QA два','QA три']]
  n=len(listing());editor.delete('1.0','end');window.lift();editor.focus_force();window.update();time.sleep(.1)
  def many(order,expected):
   page.evaluate('(ids)=>{window.qaMulti=null;window.__TAURI_INTERNALS__.invoke("snipcast_history_paste_many",{ids}).then(()=>window.qaMulti="ok",e=>window.qaMulti=String(e))}',order)
   wait(lambda:page.evaluate('window.qaMulti'))
   assert page.evaluate('window.qaMulti')=='ok',page.evaluate('window.qaMulti')
   try:wait(lambda:editor.get('1.0','end-1c')==expected)
   except Exception:
    print('MULTI PASTE DIAGNOSTIC',repr(editor.get('1.0','end-1c')),repr(expected),flush=True);raise
   assert len(listing())==n
  many(ids,'QA одинQA дваQA три')
  editor.delete('1.0','end');window.lift();editor.focus_force();window.update();time.sleep(.1)
  many(list(reversed(ids)),'QA триQA дваQA один')
  # Image capture and exact dimensions.
  image=Image.new('RGB',(64,32),'#3156b0');stream=io.BytesIO();image.save(stream,'BMP');write_formats({8:stream.getvalue()[14:]});im=wait(lambda:next((c for c in listing() if c['kind']=='image'),None));assert (im['width'],im['height'])==(64,32);assert call('snipcast_history_detail',id=im['id'])['image'].startswith('data:image/png;base64,')
  # CF_HDROP keeps file list, not contents.
  sample=OUT/'sample.txt';sample.write_text('fixture',encoding='utf8');drop=struct.pack('<IiiII',20,0,0,0,1)+(str(sample)+'\0\0').encode('utf-16le');write_formats({15:drop});files=wait(lambda:next((c for c in listing() if c['kind']=='files'),None));assert files['files']==[str(sample)]
  # Explicit confidential-content marker must be ignored.
  marker=u.RegisterClipboardFormatW('ExcludeClipboardContentFromMonitorProcessing');n=len(listing());write_formats({13:'do not record\0'.encode('utf-16le'),marker:b'\x01\0\0\0'});time.sleep(.5);assert len(listing())==n
  # App discovery and built-in launch through actual dispatcher.
  catalog=call('snipcast_commands_catalog');assert any(e['kind']=='application' for e in catalog['entries']);assert any(e['target'].startswith('shell:AppsFolder') for e in catalog['entries'])
  launcher=next(e for e in catalog['entries'] if e['title']=='Snipcast QA Launcher');call('snipcast_commands_run',id=launcher['id']);wait(marker_file.exists)
  # Settings persist independently of shortcut registration; exclusions take effect immediately.
  current=call('snipcast_get_config');current['commands']['excludedApps']=['python.exe'];call('snipcast_save_config',incoming=current)
  n=len(listing());write_formats({13:'excluded source\0'.encode('utf-16le')});time.sleep(.6);assert len(listing())==n
  current['commands']['excludedApps']=[];call('snipcast_save_config',incoming=current)
  # Expired entries are removed while pinned entries survive the same cutoff.
  with sqlite3.connect(OUT/'clipboard/history.sqlite') as db:db.execute('UPDATE clips SET created=1')
  assert [c['id'] for c in listing()]==[id]
  output=OUT/'saved.txt';call('snipcast_history_action',id=id,action='save',value=str(output));assert output.read_bytes()==text.encode('utf8')
  translated=call('snipcast_commands_translate',text='Hello world',source='en',target='ru');assert translated.strip() and translated.lower()!='hello world'
  call('snipcast_commands_run',id='clipboard');page.get_by_role('option',name='Native pinned record').wait_for();page.locator('.commands__preview').get_by_text('python',exact=True).wait_for();page.screenshot(path=str(OUT/'clipboard-native.png'))
  # Validate persistence through a fresh database reader (restart tested below).
  
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
  proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log);wait(endpoint,30);browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');assert call('snipcast_history_detail',id=id)['title']=='Native pinned record';assert call('snipcast_history_detail',id=id)['pinned'];
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
 (OUT/'result.json').write_text(json.dumps({'passed':True,'applications':len([e for e in catalog['entries'] if e['kind']=='application']),'checks':['listener','source','Unicode+HTML+RTF roundtrip','dedup own restore','global hotkey','native paste preserves whitespace','image','files','confidential marker','application launch preserves shortcut arguments','source exclusion','retention preserves pins','save text','live translation','restart persistence']},ensure_ascii=False,indent=2),encoding='utf8')
 print('PASS native clipboard formats, metadata, images, files, paste target, suppression, persistence and app discovery')
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
