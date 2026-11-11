"""Clipboard history arrow navigation in the real EXE/WebView2.

Keys are sent to the page through CDP only (no system-wide SendInput), so the check
is safe on a desktop in active use: the foreground application never receives them.
A separate thread pings the palette HWND with WM_NULL to measure UI-thread stalls.

Usage: python -B tests/clipboard_nav_native.py [QA.exe]
The EXE must use an isolated single-instance identifier (see docs/qa-clipboard-navigation.md)
and, inside the agent sandbox, Medium integrity level.
"""
import ctypes,json,os,sqlite3,subprocess,sys,threading,time,urllib.request
from ctypes import wintypes as W
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
EXE=Path(sys.argv[1] if len(sys.argv)>1 else os.environ.get('SNIPCAST_COMMANDS_QA_EXE',str(ROOT/'.qa-work/commands-qa.exe')))
OUT=ROOT/'.qa-work/clipboard-nav-native'/str(time.time_ns());OUT.mkdir(parents=True,exist_ok=True);PORT=9297;SEEDED=150
(OUT/'config.json').write_text(json.dumps({'autostart':False,'paletteHotkey':'','screenshotHotkey':'','screenshotPresets':[],'screenshotPresetDefaultsVersion':1,'textSuggestions':{'enabled':False,'toggleHotkey':''},'commands':{'hotkey':'','items':{'clipboard':{'enabled':True,'alias':'','hotkey':''},'emoji':{'enabled':True,'alias':'','hotkey':''},'translate':{'enabled':True,'alias':'','hotkey':''}},'folders':[],'clipboardEnabled':False,'retentionDays':30,'storageMb':1024}}),encoding='utf8')
# Isolated history; the system clipboard is not touched.
(OUT/'clipboard').mkdir();db=sqlite3.connect(OUT/'clipboard'/'history.sqlite')
db.execute("CREATE TABLE clips(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, meta TEXT NOT NULL, payload TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)")
now=int(time.time()*1000)
for i in range(SEEDED):
 created=now-60000-i*1000
 db.execute("INSERT INTO clips(id,hash,meta,payload,size,created) VALUES(?,?,?,?,?,?)",(i+1,f'qa-{i}',json.dumps({'id':i+1,'title':f'Удержание {i+1}','kind':'text','text':f'hold row {i+1}','files':[],'source':'QA','sourcePath':'','icon':'','created':created,'pinned':False,'width':0,'height':0,'characters':10,'ocr':''},ensure_ascii=False),'[]',2,created))
db.commit();db.close()
log=(OUT/'process.log').open('w',encoding='utf8')
env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
u32=ctypes.windll.user32
u32.FindWindowW.argtypes=[W.LPCWSTR,W.LPCWSTR];u32.FindWindowW.restype=W.HWND
u32.SendMessageTimeoutW.argtypes=[W.HWND,W.UINT,W.WPARAM,W.LPARAM,W.UINT,W.UINT,ctypes.POINTER(ctypes.c_size_t)]
def wait(fn,timeout=30):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if proc.poll() is not None:raise RuntimeError('QA process exited, see '+str(OUT/'process.log'))
  try:
   v=fn()
   if v:return v
  except Exception:pass
  time.sleep(.1)
 raise TimeoutError
report={};stalls=[];stop=threading.Event()
try:
 wait(lambda:json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4)))
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
  page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle')
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  call=lambda c,**a:page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[c,a])
  call('snipcast_commands_run',id='clipboard')
  page.wait_for_function("Number(document.querySelector('.commands__history')?.dataset.loadedCount)>=100",timeout=10000)
  # A desktop in active use keeps the foreground lock: the palette hides on blur. Show it again without focus.
  page.wait_for_timeout(800);call('plugin:window|show',label='commands');page.wait_for_timeout(300)
  assert call('plugin:window|is_visible',label='commands'),'palette is not visible'
  page.evaluate("performance.clearResourceTimings();performance.setResourceTimingBufferSize(5000)")
  page.evaluate("""()=>{window.__nav={lags:[],pos(){return Number(document.querySelector('.commands__history [data-selected="true"]')?.getAttribute('aria-posinset')||0)}};
   addEventListener('keydown',e=>{if(e.key==='ArrowDown'&&e.repeat)__nav.lags.push(Math.round(performance.now()-e.timeStamp))},true)}""")
  hwnd=u32.FindWindowW(None,'Палитра команд — Snipcast');assert hwnd,'palette HWND not found'
  def pinger():
   r=ctypes.c_size_t();origin=time.perf_counter()
   while not stop.is_set():
    t=time.perf_counter();u32.SendMessageTimeoutW(hwnd,0,0,0,0,10000,ctypes.byref(r));d=(time.perf_counter()-t)*1000
    if d>100:stalls.append([round((t-origin)*1000),round(d)])
    time.sleep(.02)
  threading.Thread(target=pinger,daemon=True).start()
  cdp=page.context.new_cdp_session(page)
  def key(kind,repeat=False,age=0.0):
   cdp.send('Input.dispatchKeyEvent',{'type':kind,'key':'ArrowDown','code':'ArrowDown','windowsVirtualKeyCode':40,'nativeVirtualKeyCode':40,'autoRepeat':repeat,'timestamp':time.time()-age})
  pos=lambda:page.evaluate('__nav.pos()');settle=lambda ms=300:page.wait_for_timeout(ms)
  # 1. A short press (shorter than any Windows repeat delay) moves exactly one row.
  s=pos();key('rawKeyDown');time.sleep(.11);key('keyUp');settle();report['tap']=pos()-s
  # 2. Hold: repeats every 33 ms after a 500 ms delay; nothing moves after release.
  s=pos();key('rawKeyDown');time.sleep(.5)
  for _ in range(30):key('rawKeyDown',True);time.sleep(.033)
  key('keyUp');settle(50);up=pos();settle(1000);report['hold']={'moved':up-s,'afterRelease':pos()-up}
  # 3. Repeats that sat in the input queue (old OS timestamps) are dropped.
  page.evaluate('__nav.lags=[]');s=pos();key('rawKeyDown');time.sleep(.05)
  for i in range(30):key('rawKeyDown',True,age=.6-i*.01)
  key('keyUp');settle();report['stale']={'moved':pos()-s,'minLag':min(page.evaluate('__nav.lags'))}
  # 4. Hold to the end: the next page arrives ahead of the cursor, which reaches the last row.
  total=call('snipcast_history_list',query='',kind='',offset=0,limit=1)['total'];s=pos();key('rawKeyDown');time.sleep(.5)
  for _ in range(total-s+20):key('rawKeyDown',True);time.sleep(.033)
  key('keyUp');settle()
  report['end']={'start':s,'pos':pos(),'total':total,'loaded':page.evaluate("Number(document.querySelector('.commands__history').dataset.loadedCount)")}
  stop.set();report['uiThreadStalls']=stalls
  report['slowIpc']=page.evaluate("performance.getEntriesByType('resource').filter(e=>e.name.includes('ipc.localhost')&&e.duration>100).map(e=>[decodeURIComponent(e.name.split('/').pop()),Math.round(e.duration)])")
  page.screenshot(path=str(OUT/'clipboard-hold-end.png'));report['pageErrors']=errors
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  browser.close()
finally:
 stop.set()
 try:proc.wait(timeout=10)
 except subprocess.TimeoutExpired:
  subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True);proc.wait(timeout=10)
 log.close()
checks={'tap is one row':report.get('tap')==1,
 'hold moves':report.get('hold',{}).get('moved',0)>=25,
 'no movement after release':report.get('hold',{}).get('afterRelease')==0,
 'stale repeats dropped':report.get('stale',{}).get('moved')==1,
 'hold reaches the end':bool(report.get('end')) and report['end']['pos']==report['end']['total']==report['end']['loaded'],
 'UI thread never stalls >100 ms':report.get('uiThreadStalls')==[],
 'no slow IPC':report.get('slowIpc')==[],
 'no page errors':report.get('pageErrors')==[]}
report['checks']=checks;report['passed']=all(checks.values())
(OUT/'result.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
print(json.dumps(report,ensure_ascii=False));print('PASS' if report['passed'] else 'FAIL',OUT/'result.json')
sys.exit(0 if report['passed'] else 1)
