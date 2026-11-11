import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
try:
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'};proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');page=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None));page.wait_for_load_state('networkidle');page.set_default_timeout(4000)
  def call(cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def keys(v):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,v)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  window.lift();keys([0x11,0x12,0x10,0x77]);wait(lambda:call('plugin:window|is_visible',label='commands'));box=page.get_by_role('combobox',name='Категория Emoji');expect(box).to_be_visible();box.click();menu=page.get_by_role('listbox',name='Категория Emoji');expect(menu).to_be_visible();assert menu.locator('.commands__category-icon').count()==11;page.screenshot(path=str(OUT/'categories.png'));menu.get_by_role('option',name='Животные и природа').click();expect(box).to_contain_text('Животные и природа');assert page.locator('.commands__emoji [role=option]').count()>0
  box.focus();page.keyboard.press('Enter');expect(menu).to_be_visible();page.keyboard.press('End');expect(menu.get_by_role('option',name='Флаги')).to_be_in_viewport();page.keyboard.press('Enter');expect(box).to_contain_text('Флаги');box.focus();page.keyboard.press('Enter');page.keyboard.press('Escape');expect(menu).to_have_count(0);assert call('plugin:window|is_visible',label='commands');page.keyboard.press('Escape');wait(lambda:not call('plugin:window|is_visible',label='commands'))
  call('snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':True,'artifacts':str(OUT)}),flush=True)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
