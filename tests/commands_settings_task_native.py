"""Native settings/group-switch acceptance with isolated app data and identity."""
import ast
from pathlib import Path
source=Path(__file__).with_name('commands_e2e.py')
tree=ast.parse(source.read_text(encoding='utf8'));prefix=[]
for node in tree.body:
 if isinstance(node,ast.Try):break
 prefix.append(node)
exec(compile(ast.Module(body=prefix,type_ignores=[]),str(source),'exec'),globals())

def keys(values):
 subprocess.run([sys.executable,'-B',str(ROOT/'tests/native_keys.py'),*map(str,values)],check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)

def available(vk):
 ok=u.RegisterHotKey(None,901,7,vk)
 if ok:u.UnregisterHotKey(None,901)
 return bool(ok)

try:
 env={**os.environ,'SNIPCAST_QA_INPUT':'1','SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_USER_DATA_FOLDER':str(OUT/'webview'),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
 def launch(p):
  global proc
  proc=subprocess.Popen([str(EXE)],env=env,stdout=log,stderr=log)
  def endpoint():
   if proc.poll() is not None:raise RuntimeError('QA process exited')
   try:return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.4))
   except OSError:return None
  # Attach after the command target has navigated: a passive Python polling loop
  # does not pump Playwright's sync events for WebViews created after connection.
  wait(lambda:any('snipcast=commands' in x.get('url','') for x in (endpoint() or [])),40)
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
  def command_page():
   if browser.contexts[0].pages:browser.contexts[0].pages[0].wait_for_timeout(50)
   return next((x for x in browser.contexts[0].pages if 'snipcast=commands' in x.url),None)
  try:page=wait(command_page,25)
  except AssertionError:
   print('WebView targets:',[x.get('url') for x in (endpoint() or [])],'connected pages:',[x.url for x in browser.contexts[0].pages],flush=True)
   raise
  page.wait_for_load_state('networkidle');page.set_default_timeout(6000)
  return browser,page
 def call(page,cmd,**args):
  return page.evaluate('([c,a])=>Promise.race([window.__TAURI_INTERNALS__.invoke(c,a),new Promise((_,r)=>setTimeout(()=>r(Error(c+" timed out")),10000))])',[cmd,args])
 def rejected(page,cmd,**args):
  return page.evaluate('async([c,a])=>{try{await window.__TAURI_INTERNALS__.invoke(c,a);return false}catch(e){return String(e)}}',[cmd,args])
 def listing(page):return call(page,'snipcast_history_list',query='',kind='',offset=0)['items']
 def write_text(value):write_formats({13:(value+'\0').encode('utf-16le')})
 with sync_playwright() as p:
  browser,page=launch(p)
  cfg=call(page,'snipcast_get_config');assert cfg['commands']['enabled'] and cfg['commands']['applicationsEnabled']
  def launcher_catalog():
   c=call(page,'snipcast_commands_catalog')
   return c if any(e['title']=='Snipcast QA Launcher' for e in c['entries']) else None
  catalog=wait(launcher_catalog,30)
  app=next(e for e in catalog['entries'] if e['title']=='Snipcast QA Launcher')
  cfg['commands']['items'][app['id']]={'enabled':True,'alias':'qa-app','hotkey':'Control+Alt+Shift+F6'}
  call(page,'snipcast_save_config',incoming=cfg);original=cfg['commands']['items'].copy()
  assert all(not available(vk) for vk in [0x79,0x78,0x77,0x76,0x75]), 'Active native hotkeys must be registered'
  call(page,'snipcast_commands_run',id='command-settings')
  settings=wait(lambda:next((x for x in browser.contexts[0].pages if 'snipcast=settings' in x.url),None));settings.wait_for_load_state('networkidle')
  # The hidden settings WebView loaded before the fixture installed its app hotkey.
  settings.reload();settings.wait_for_load_state('networkidle')
  settings.get_by_role('button',name='Команды',exact=True).click()
  panel=settings.locator('.commands-settings')
  expect(panel.locator('.commands-settings__name strong')).to_have_text(['Приложения','Буфер обмена','Emoji','Переводчик','Калькулятор'])
  expect(panel.locator('.commands-settings__configure svg')).to_have_count(5)
  for name in ['Приложения','Буфер обмена','Emoji','Переводчик','Калькулятор']:
   panel.get_by_role('button',name='Настроить: '+name,exact=True).click()
   heading=panel.locator('.commands-settings__section-header h2');expect(heading).to_have_text(name)
   back=panel.get_by_role('button',name='Назад',exact=True)
   assert abs((back.bounding_box()['y']+15)-(heading.bounding_box()['y']+heading.bounding_box()['height']/2))<3
   back.click()
  settings.screenshot(path=str(OUT/'settings.png'))
  write_text('kept-before-disable');kept=wait(lambda:next((c for c in listing(page) if c['text']=='kept-before-disable'),None))
  call(page,'snipcast_history_action',id=kept['id'],action='pin',value=None)
  apps_switch=panel.get_by_role('switch',name='Включить приложения',exact=True)
  apps_switch.click();wait(lambda:call(page,'snipcast_get_config')['commands']['applicationsEnabled'] is False)
  assert call(page,'snipcast_get_config')['commands']['items']==original
  assert available(0x75) and not available(0x77)
  assert rejected(page,'snipcast_commands_run',id=app['id'])
  # Full catalog remains available to settings while application search is disabled.
  assert any(e['id']==app['id'] for e in call(page,'snipcast_commands_catalog')['entries'])
  master=panel.get_by_role('switch',name='Включить команды',exact=True)
  call(page,'snipcast_commands_run',id='root');wait(lambda:call(page,'plugin:window|is_visible',label='commands'))
  master.click();wait(lambda:call(page,'snipcast_get_config')['commands']['enabled'] is False)
  wait(lambda:not call(page,'plugin:window|is_visible',label='commands'))
  assert all(available(vk) for vk in [0x79,0x78,0x77,0x76,0x75])
  for id in ['root','clipboard','emoji','translate','calculator',app['id']]:assert rejected(page,'snipcast_commands_run',id=id),id
  write_text('must-not-be-recorded');time.sleep(.7)
  assert all(c['text']!='must-not-be-recorded' for c in listing(page))
  # An OS-level conflict on re-enable must leave the saved switch and bindings off.
  assert u.RegisterHotKey(None,902,7,0x79)
  try:
   master.click();expect(panel.get_by_role('alert')).to_be_visible()
   expect(master).to_have_attribute('aria-checked','false')
   assert call(page,'snipcast_get_config')['commands']['enabled'] is False
   assert available(0x78) and available(0x77)
  finally:u.UnregisterHotKey(None,902)
  master.click();wait(lambda:call(page,'snipcast_get_config')['commands']['enabled'] is True)
  assert not available(0x79) and not available(0x78) and available(0x75)
  time.sleep(.7);assert all(c['text']!='must-not-be-recorded' for c in listing(page))
  apps_switch.click();wait(lambda:call(page,'snipcast_get_config')['commands']['applicationsEnabled'] is True)
  assert not available(0x75)
  before_sequence=u.GetClipboardSequenceNumber();write_text('recorded-after-enable');immediate=read_formats().get(13,b'').decode('utf-16le',errors='ignore').split('\0')[0];print('Resume clipboard immediately:',{'matches':immediate=='recorded-after-enable','length':len(immediate),'sequence':u.GetClipboardSequenceNumber()},flush=True)
  try:wait(lambda:any(c['text']=='recorded-after-enable' for c in listing(page)))
  except AssertionError:
   response=call(page,'snipcast_history_list',query='',kind='',offset=0)
   print('Resume diagnostic:',{'sequenceBefore':before_sequence,'sequenceAfter':u.GetClipboardSequenceNumber(),'status':response.get('status'),'titles':[c['title'] for c in response['items']],'clipboardMatches':read_formats().get(13,b'').decode('utf-16le',errors='ignore').split('\0')[0]=='recorded-after-enable'},flush=True)
   raise
  assert call(page,'snipcast_history_detail',id=kept['id'])['pinned']
  assert call(page,'snipcast_get_config')['commands']['items']==original
  # The restored shortcut really opens the requested section.
  call(settings,'plugin:window|hide',label='settings');window.lift();keys([0x11,0x12,0x10,0x78])
  wait(lambda:call(page,'plugin:window|is_visible',label='commands'));expect(page.locator('.commands__history')).to_be_visible()
  page.screenshot(path=str(OUT/'clipboard.png'))
  # Persist both flags off, restart, and verify history/items survive with no bindings.
  cfg=call(page,'snipcast_get_config');cfg['commands'].update(enabled=False,applicationsEnabled=False)
  call(page,'snipcast_save_config',incoming=cfg);call(page,'snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
  browser,page=launch(p);cfg=call(page,'snipcast_get_config')
  assert cfg['commands']['enabled'] is False and cfg['commands']['applicationsEnabled'] is False
  assert cfg['commands']['items']==original and call(page,'snipcast_history_detail',id=kept['id'])['pinned']
  assert all(available(vk) for vk in [0x79,0x78,0x77,0x76,0x75])
  assert rejected(page,'snipcast_commands_run',id='root')
  call(page,'snipcast_commands_run',id='command-settings')
  cfg['commands'].update(enabled=True,applicationsEnabled=True);call(page,'snipcast_save_config',incoming=cfg)
  assert all(not available(vk) for vk in [0x79,0x78,0x77,0x76,0x75])
  call(page,'snipcast_commands_run',id='quit');proc.wait(timeout=10);browser.close()
 (OUT/'results.json').write_text(json.dumps({'passed':True,'scenarios':['legacy defaults','settings navigation','native hotkeys','application switch','master switch','clipboard pause/resume without backfill','OS conflict rollback','restart persistence']},ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps({'passed':True,'artifacts':str(OUT)}),flush=True)
finally:
 if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
 write_formats(saved_clip);window.destroy();log.close();faulthandler.cancel_dump_traceback_later();stacklog.close()
