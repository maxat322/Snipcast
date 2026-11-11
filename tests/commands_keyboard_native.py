"""Native Esc/Enter regression, using the existing isolated clipboard/editor fixture."""
import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
def window_of(pid,title):
 u.FindWindowW.argtypes=[W.LPCWSTR,W.LPCWSTR];u.FindWindowW.restype=W.HWND;handle=u.FindWindowW(None,title);owner=W.DWORD()
 u.GetWindowThreadProcessId(handle,ctypes.byref(owner));assert handle and owner.value==pid,f'Window not found: {title}'
 return handle
try:
 # Isolated history with enough rows for paging; the system clipboard is not used,
 # so the user's own Snipcast history does not receive these rows.
 SEEDED=150;(OUT/'clipboard').mkdir(parents=True,exist_ok=True);db=sqlite3.connect(OUT/'clipboard'/'history.sqlite')
 db.execute("CREATE TABLE IF NOT EXISTS clips(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, meta TEXT NOT NULL, payload TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)")
 seeded_at=int(time.time()*1000)
 for i in range(SEEDED):
  created=seeded_at-600000-i*1000
  db.execute("INSERT INTO clips(id,hash,meta,payload,size,created) VALUES(?,?,?,?,?,?)",(i+1,f'qa-hold-{i}',json.dumps({'id':i+1,'title':f'Удержание {i+1}','kind':'text','text':f'hold row {i+1}','files':[],'source':'QA','sourcePath':'','icon':'','created':created,'pinned':False,'width':0,'height':0,'characters':10,'ocr':''},ensure_ascii=False),'[]',2,created))
 db.commit();db.close()
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  if proc.poll() is not None:raise RuntimeError('QA process exited')
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(4000);page.on('pageerror',lambda e:errors.append(str(e)))
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def visible():return call('plugin:window|is_visible',label='commands')
  def keys(values):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,values)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  def show(vk):
   editor.delete('1.0','end');window.lift();keys([0x11,0x12,0x10,vk]);wait(visible)
   expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_focused()
   handle=window_of(proc.pid,'Палитра команд — Snipcast')
   assert u.GetForegroundWindow()==handle,'Command palette did not acquire native focus'
  def body():
   page.locator('.palette__hints > span').first.click();assert page.evaluate('document.activeElement===document.body')
  def check(name,fn):
   print('START',name,flush=True)
   try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
   except Exception:
    error=__import__('traceback').format_exc();results.append({'name':name,'passed':False,'error':error});print('FAIL',name,error[-650:],flush=True)
    page.screenshot(path=str(OUT/f'failure-{len(results)}.png'))
   finally:call('snipcast_commands_hide')
   (OUT/'result.json').write_text(json.dumps({'checks':results,'pageErrors':errors},indent=2),encoding='utf8')
  marker='Esc Enter regression — exact paste'
  write_formats({13:(marker+'\0').encode('utf-16le')});wait(lambda:any(c['text']==marker for c in call('snipcast_history_list',query='',kind='',offset=0)['items']))
  def clipboard_enter():
   for i in range(5):
    show(0x78);expect(page.locator('.commands__content pre')).to_have_text(marker);page.locator('.commands__content pre').click();assert page.evaluate('document.activeElement===document.body');keys([0x0d]);wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')==marker)
   print('clipboard paste cycles: 5',flush=True)
  def clipboard_esc():
   for _ in range(5):
    show(0x78);expect(page.locator('.commands__content pre')).to_be_visible();page.locator('.commands__content pre').click();keys([0x1b]);expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();body();keys([0x1b]);wait(lambda:not visible())
   print('clipboard Esc cycles: 5',flush=True)
  def emoji_enter():
   for _ in range(5):
    show(0x77);page.get_by_role('textbox',name='Поиск',exact=True).fill('😀');expect(page.locator('.commands__emoji [role=option]')).to_have_count(1);body();keys([0x0d]);wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')=='😀')
   print('emoji paste cycles: 5',flush=True)
  def emoji_esc():
   for _ in range(5):
    show(0x77);body();keys([0x1b]);expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();keys([0x1b]);wait(lambda:not visible())
   print('emoji Esc cycles: 5',flush=True)
  def actions_esc():
   show(0x78);expect(page.locator('.commands__content pre')).to_be_visible();keys([0x11,0x4a]);expect(page.get_by_role('dialog',name='Действия',exact=True)).to_be_visible();keys([0x1b]);expect(page.get_by_role('dialog')).to_have_count(0);expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_focused();assert visible();keys([0x0d]);wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')==marker)
  def rename_enter():
   show(0x78);expect(page.locator('.commands__content pre')).to_be_visible();keys([0x11,0x4a]);page.get_by_role('button',name='Переименовать',exact=True).click();field=page.get_by_label('Название записи');field.fill('Keyboard QA renamed');keys([0x0d]);expect(page.get_by_role('dialog')).to_have_count(0);expect(page.locator('.commands__history')).to_contain_text('Keyboard QA renamed');assert visible();assert editor.get('1.0','end-1c')=='';body();keys([0x1b]);keys([0x1b]);wait(lambda:not visible())
  PROBE="""()=>{window.__nav={events:[],upPos:0,pos(){return Number(document.querySelector('.commands__history [data-selected="true"]')?.getAttribute('aria-posinset')||0)}};
   if(window.__navProbe)return;window.__navProbe=true;
   addEventListener('keydown',e=>{if(e.key==='ArrowDown')__nav.events.push({repeat:e.repeat,lag:Math.round(performance.now()-e.timeStamp)})},true);
   addEventListener('keyup',e=>{if(e.key==='ArrowDown'){__nav.upPos=__nav.pos();__nav.upLag=Math.round(performance.now()-e.timeStamp)}},true)}"""
  def clipboard_hold():
   show(0x78);page.wait_for_function("Number(document.querySelector('.commands__history')?.dataset.loadedCount)>=100")
   page.evaluate(PROBE)
   pos=lambda:page.evaluate('__nav.pos()')
   def hold(ms,delay=500,rate=33):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),'--hold','0x28',str(ms),str(delay),str(rate)],check=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
   report={}
   start=pos();hold(110);page.wait_for_timeout(300);report['tap']=pos()-start
   start=pos();hold(1500);page.wait_for_timeout(50);up=page.evaluate('__nav.upPos');page.wait_for_timeout(1000)
   report['hold']={'moved':up-start,'afterRelease':pos()-up,'events':page.evaluate('__nav.events.length')}
   # The window is busy from 0.7 s to 2.2 s and the key is released at 1.5 s:
   # repeats queued meanwhile and the late keyup must not move the list further.
   page.evaluate("()=>{__nav.events=[];setTimeout(()=>{__nav.busyPos=__nav.pos();const t=performance.now();while(performance.now()-t<1500){}},700)}")
   hold(1500);page.wait_for_timeout(1300)
   busy=page.evaluate('({busyPos:__nav.busyPos,pos:__nav.pos(),upLag:__nav.upLag,maxLag:Math.max(...__nav.events.map(e=>e.lag)),stale:__nav.events.filter(e=>e.lag>120).length,events:__nav.events.length})')
   report['busy']={**busy,'afterBusy':busy['pos']-busy['busyPos']}
   total=call('snipcast_history_list',query='',kind='',offset=0,limit=1)['total']
   start=pos();hold(int((total-start)*33+1500));page.wait_for_timeout(300)
   report['end']={'start':start,'pos':pos(),'total':total,'loaded':page.evaluate("Number(document.querySelector('.commands__history').dataset.loadedCount)")}
   (OUT/'clipboard-hold.json').write_text(json.dumps(report,indent=2),encoding='utf8');print('clipboard hold',json.dumps(report),flush=True)
   page.screenshot(path=str(OUT/'clipboard-hold-end.png'))
   assert report['tap']==1,report
   assert report['hold']['moved']>=15 and report['hold']['afterRelease']<=1,report
   assert report['busy']['afterBusy']<=2,report
   assert report['end']['pos']==total and report['end']['loaded']==total,report
  for name,fn in [('clipboard preview Enter, five reopens/pastes',clipboard_enter),('clipboard preview Esc then root Esc, five cycles',clipboard_esc),('Emoji Enter outside search, five reopens/pastes',emoji_enter),('Emoji Esc outside search, five cycles',emoji_esc),('Esc closes actions and Enter pastes once',actions_esc),('Enter submits rename without pasting',rename_enter),('clipboard arrow tap, hold, busy release and paging',clipboard_hold)]:check(name,fn)
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'pageErrors':errors,'artifacts':str(OUT)}),flush=True)
 raise SystemExit(any(not r['passed'] for r in results) or bool(errors))
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
