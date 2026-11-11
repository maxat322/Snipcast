import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
from pywinauto import Desktop,mouse
try:
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(4000)
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def visible():return call('plugin:window|is_visible',label='commands')
  def keys(v):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,v)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  def show(vk):window.lift();keys([0x11,0x12,0x10,vk]);wait(visible)
  def check(name,fn):
   try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
   except Exception:
    import traceback
    results.append({'name':name,'passed':False,'error':traceback.format_exc()});print('FAIL',name,results[-1]['error'][-900:],flush=True)
   finally:call('snipcast_commands_hide')
  def direct():
   for vk,selector in [(0x78,'Тип записей'),(0x77,'Категория Emoji'),(0x76,'Текст для перевода')]:
    show(vk);expect(page.get_by_label(selector)).to_be_visible();expect(page.get_by_label('Назад')).to_have_count(0);expect(page.locator('footer')).to_contain_text('закрыть');page.screenshot(path=str(OUT/f'direct-{vk}.png'));keys([0x1b]);wait(lambda:not visible())
  def nested():
   show(0x79);page.get_by_role('option',name='Emoji Команда').click();expect(page.get_by_label('Назад')).to_be_visible();keys([0x1b]);expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();keys([0x1b]);wait(lambda:not visible())
  def outside():
   for vk in (0x79,0x78,0x77,0x76):
    show(vk);rect=Desktop(backend='win32').window(handle=hwnd).rectangle();mouse.click(coords=(rect.left+30,rect.top+30));wait(lambda:not visible())
  for name,fn in [('direct Esc closes without back',direct),('nested Esc returns to root',nested),('click outside closes palette',outside)]:check(name,fn)
  try:call('snipcast_commands_run',id='quit')
  except Exception:pass
  proc.wait(timeout=10);browser.close()
 (OUT/'result.json').write_text(json.dumps({'checks':results},indent=2),encoding='utf8');print(json.dumps({'results':results,'artifacts':str(OUT)}),flush=True)
 raise SystemExit(any(not r['passed'] for r in results))
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
