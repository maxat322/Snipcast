"""Real hotkeys, native visibility before frontend readiness, large history and paste."""
import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
from pywinauto import Desktop
metrics=[]
try:
 # Synthetic history only, in the harness-owned data directory.
 (OUT/'clipboard').mkdir();db=sqlite3.connect(OUT/'clipboard/history.sqlite')
 db.executescript('CREATE TABLE clips(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,meta TEXT NOT NULL,payload TEXT NOT NULL,size INTEGER NOT NULL,created INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);')
 for i in range(1,501):
  text=f'Opening QA item {i:04d}';created=int(time.time()*1000)-i
  meta={'id':i,'title':text,'kind':'text','text':text,'files':[],'source':'QA fixture','sourcePath':'fixture.exe','icon':'','created':created,'pinned':False,'width':0,'height':0,'characters':len(text),'ocr':''}
  db.execute('INSERT INTO clips VALUES(?,?,?,?,?,?,0)',(i,str(i),json.dumps(meta),json.dumps({'13':base64.b64encode((text+'\0').encode('utf-16le')).decode()}),100,created))
 db.commit();db.close()
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  if proc.poll() is not None:raise RuntimeError('QA process exited')
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(4500);page.on('pageerror',lambda e:errors.append(str(e)))
  handle=Desktop(backend='win32').window(process=proc.pid,title='Палитра команд — Snipcast',visible_only=False).handle
  u.IsWindowVisible.argtypes=[W.HWND]
  def visible():return bool(u.IsWindowVisible(handle))
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def keys(values):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,values)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  def hotkey(vk):keys([0x11,0x12,0x10,vk])
  def show(vk):
   call('snipcast_commands_hide');window.lift();start=time.perf_counter();hotkey(vk);wait(visible);elapsed=(time.perf_counter()-start)*1000
   assert u.GetForegroundWindow()==handle,'Native focus missing'
   return elapsed
  def check(name,fn):
   print('START',name,flush=True)
   try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
   except Exception:
    error=__import__('traceback').format_exc();results.append({'name':name,'passed':False,'error':error});print('FAIL',name,error[-850:],flush=True);page.screenshot(path=str(OUT/f'failure-{len(results)}.png'))
   finally:call('snipcast_commands_hide')
   (OUT/'result.json').write_text(json.dumps({'checks':results,'metrics':metrics,'pageErrors':errors},indent=2),encoding='utf8')
  def render_gate():
   client=page.context.new_cdp_session(page);client.send('Debugger.enable');observations=[]
   try:
    for section,vk in [('emoji',0x77),('clipboard',0x78),('translate',0x76)]:
     show(0x79);call('snipcast_commands_hide');window.lift()
     client.send('Debugger.pause')
     try:hotkey(vk);time.sleep(.25);observations.append({'section':section,'visibleBeforeRender':visible()})
     finally:client.send('Debugger.resume')
     wait(visible);expect(page.get_by_label('Назад',exact=True)).to_contain_text({'emoji':'Emoji','clipboard':'Буфер обмена','translate':'Переводчик'}[section]);page.screenshot(path=str(OUT/f'{section}.png'));call('snipcast_commands_hide')
   finally:client.send('Debugger.disable');client.detach()
   metrics.extend(observations);assert all(not x['visibleBeforeRender'] for x in observations),observations
  def emoji_speed():
   times=[]
   for _ in range(8):
    times.append(show(0x77));expect(page.get_by_label('Категория Emoji')).to_be_visible();assert 0<page.locator('.commands__emoji [role=option]').count()<140
    keys([0x1b]);expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();keys([0x1b]);wait(lambda:not visible())
   metrics.append({'emojiHotkeyToVisibleMs':times});assert max(times)<1500,times
  def emoji_scroll_paste():
   editor.delete('1.0','end');show(0x77);grid=page.locator('.commands__emoji');grid.evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_function("(()=>{const e=[...document.querySelectorAll('.commands__emoji [role=option]')].at(-1);return e?.getAttribute('aria-posinset')===e?.getAttribute('aria-setsize')})()")
   item=grid.get_by_role('option').last;text=item.text_content();item.click();wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')==text)
   show(0x77);search=page.get_by_role('textbox',name='Поиск',exact=True);search.fill('😀');expect(grid.get_by_role('option')).to_have_count(1);editor.delete('1.0','end');keys([0x0d]);wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')=='😀')
  def clipboard_stress():
   for i in range(10):
    show(0x78);search=page.get_by_role('textbox',name='Поиск',exact=True);search.fill('Opening QA item 04');search.fill('Opening QA item 0499');expect(page.locator('.commands__history [role=option]')).to_have_count(1);expect(page.locator('.commands__content pre')).to_have_text('Opening QA item 0499');call('snipcast_commands_hide')
   show(0x78);search.fill('Opening QA item');expect(page.locator('.commands__history [role=option]')).to_have_count(100);page.get_by_role('button',name='Показать ещё').click();expect(page.locator('.commands__history [role=option]')).to_have_count(200)
   search.fill('');marker='Native opening QA — exact text';write_formats({13:(marker+'\0').encode('utf-16le')});expect(page.locator('.commands__history')).to_contain_text(marker);search.fill(marker);expect(page.locator('.commands__content pre')).to_have_text(marker);page.locator('.commands__content pre').click();keys([0x1b]);expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();keys([0x1b]);wait(lambda:not visible())
   editor.delete('1.0','end');show(0x78);expect(page.locator('.commands__content pre')).to_have_text(marker);page.locator('.commands__content pre').click();keys([0x0d]);wait(lambda:not visible());wait(lambda:editor.get('1.0','end-1c')==marker)
   metrics.append({'clipboardReopenSearchCycles':10,'seededHistoryRows':500})
  def cancel_pending():
   call('snipcast_commands_hide');window.lift();client=page.context.new_cdp_session(page);client.send('Debugger.enable');client.send('Debugger.pause')
   try:hotkey(0x77);hotkey(0x77)
   finally:client.send('Debugger.resume');client.send('Debugger.disable');client.detach()
   page.wait_for_timeout(500);assert not visible(),'Cancelled opening became visible after late readiness'
   show(0x78);expect(page.get_by_label('Тип записей')).to_be_visible()
  def image_preview():
   image=Image.new('RGB',(640,360),(40,120,210));stream=io.BytesIO();image.save(stream,format='PNG');png=stream.getvalue();fmt=u.RegisterClipboardFormatW('PNG')
   write_formats({fmt:png});wait(lambda:any(c['kind']=='image' for c in call('snipcast_history_list',query='',kind='image',offset=0)['items']))
   for _ in range(5):
    show(0x78);page.get_by_label('Тип записей').select_option('image');expect(page.locator('.commands__history [role=option]')).to_have_count(1);preview=page.locator('.commands__content img');expect(preview).to_be_visible();assert preview.evaluate('e=>e.naturalWidth')==640;assert preview.evaluate('e=>e.naturalHeight')==360
   page.screenshot(path=str(OUT/'clipboard-image.png'));keys([0x11,0x0d]);wait(lambda:read_formats().get(fmt));assert Image.open(io.BytesIO(read_formats()[fmt])).convert('RGB').tobytes()==image.tobytes()
  cases=[('native window stays hidden until requested command renders',render_gate),('Emoji eight hotkey openings: bounded DOM and timing',emoji_speed),('Emoji last row click and Enter paste into external editor',emoji_scroll_paste),('500 history entries: ten reopens, racing searches, paging, copy update, Esc/Enter paste',clipboard_stress),('same hotkey cancels pending open; later clipboard opens',cancel_pending),('image preview five reopens and exact PNG copy',image_preview)]
  for name,fn in cases:
   if os.environ.get('SNIPCAST_OPENING_CASE')=='image' and fn is not image_preview:continue
   check(name,fn)
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'pageErrors':errors,'artifacts':str(OUT)}),flush=True)
 raise SystemExit(any(not r['passed'] for r in results) or bool(errors))
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
