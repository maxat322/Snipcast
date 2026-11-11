import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py');tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())
try:
 env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
 def endpoint():
  try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
  except OSError:return None
 wait(endpoint,40)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
  main=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=' not in x.url),None));command=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None))
  def call(page,cmd,**args):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args])
  def clipboard():return read_formats().get(13,b'').decode('utf-16le').rstrip('\0')
  def keys(*v):subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,v)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
  for unified in (False,True):
   page=main if unified else command;label='main' if unified else 'commands'
   for action in ('enter','click','footer'):
    write_formats({13:('sentinel\0').encode('utf-16le')});window.lift()
    call(main,'snipcast_commands_run',id='unified' if unified else 'root')
    wait(lambda:call(page,'plugin:window|is_visible',label=label));field=page.locator('input.palette__search');field.fill('78/2')
    expect(page.locator('.commands__calc')).to_contain_text('39')
    if action=='enter':
     page.screenshot(path=str(OUT/('calculator-'+label+'.png')))
     field.click();keys(0x0D);wait(lambda:clipboard()=='39');wait(lambda:not call(page,'plugin:window|is_visible',label=label))
    else:
     (page.locator('.commands__calc') if action=='click' else page.locator('.palette__hints > span').nth(1)).click();wait(lambda:clipboard()=='39');wait(lambda:not call(page,'plugin:window|is_visible',label=label))
    print('PASS',label,action,flush=True)
  call(main,'snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 print(json.dumps({'passed':True,'artifacts':str(OUT)}),flush=True)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close()
