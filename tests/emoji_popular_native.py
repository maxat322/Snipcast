import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
try:
 (OUT/'command-usage.json').write_text(json.dumps({'emoji:'+chr(0x1f600+i):[100-i,1] for i in range(25)},ensure_ascii=False),encoding='utf8')
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'};proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(4000)
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),'17','18','16','119'],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  wait(lambda:call('plugin:window|is_visible',label='commands'));search=page.get_by_label('Поиск',exact=True);expect(search).to_be_focused();grid=page.locator('.commands__emoji');expect(grid.locator('.palette__item-preview')).to_have_text(['Часто используемые','Все']);options=grid.get_by_role('option');assert [options.nth(i).text_content() for i in range(21)]==[chr(0x1f600+i) for i in range(21)];assert options.nth(21).text_content()==options.nth(0).text_content();page.screenshot(path=str(OUT/'popular.png'))
  for _ in range(3):search.press('ArrowDown')
  expect(grid.locator('[aria-selected=true]')).to_have_attribute('aria-posinset','22');search.press('ArrowUp');expect(grid.locator('[aria-selected=true]')).to_have_attribute('aria-posinset','15');search.fill('smile');expect(grid.locator('.palette__item-preview')).to_have_count(0);assert grid.get_by_role('option').count()>0
  call('snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':True,'artifacts':str(OUT),'input':'CDP keyboard in native WebView'}),flush=True)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
