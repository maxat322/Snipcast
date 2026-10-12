"""Real backend scheduler, restart persistence, catch-up and silent network failures.
The dates below emulate missed days in isolated state, not an actual OS sleep.
"""
import json,os,shutil,subprocess,threading,time,urllib.request
from contextlib import contextmanager
from datetime import datetime,timedelta
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/update-scheduler-native';PORT=9246
OUT.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/'src-tauri/target/debug/snipcast.exe',OUT/'update-qa.exe')
cfg=json.loads((ROOT/'.qa-work/capture-035-native/config.json').read_text(encoding='utf8'));cfg['theme']='light'
(OUT/'config.json').write_text(json.dumps(cfg),encoding='utf8')
day=datetime.now().strftime('%Y-%m-%d');past=(datetime.now()-timedelta(days=1)).strftime('%Y-%m-%d')
assert datetime.now().hour>=10,'Run daily catch-up QA after 10 local time'
boot_number=0
state=OUT/'update-state.json';requests=[];fixture={'version':'1.1.0','fail':False}
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  requests.append(self.path)
  if fixture['fail']:self.send_response(503);self.end_headers();return
  release={'tag_name':fixture['version'],'body':'- Проверка ежедневного обновления\n'*40,'assets':[{'name':n,'browser_download_url':'http://127.0.0.1/unused'} for n in ('snipcast.exe','snipcast.exe.sha256')]}
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(release).encode())
 def log_message(self,*_):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
def invoke(page,cmd,args=None):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[cmd,args or {}])
def write_state(**patch):
 data=json.loads(state.read_text(encoding='utf8')) if state.exists() else {};data.update(patch);state.write_text(json.dumps(data),encoding='utf8')
@contextmanager
def boot(p,notification=False):
 global boot_number
 boot_number+=1;port=PORT+boot_number
 before=len(requests)
 with (OUT/'process.log').open('a',encoding='utf8') as log:
  proc=subprocess.Popen([str(OUT/'update-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'SNIPCAST_UPDATE_TEST_URL':f'http://127.0.0.1:{server.server_port}/latest','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={port}'},stdout=log,stderr=log)
 try:
  for _ in range(100):
   try:urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=.2).close();break
   except OSError:assert proc.poll() is None;time.sleep(.1)
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}');ctx=browser.contexts[0]
  for _ in range(100):
   main=next((pg for pg in ctx.pages if 'snipcast=settings' in pg.url),None)
   if main:break
   ctx.pages[0].wait_for_timeout(50)
  if not main:main=next((pg for pg in ctx.pages if pg.url.startswith('http://localhost:1420')),None)
  assert main,[pg.url for pg in ctx.pages]
  for _ in range(100):
   notice=next((pg for pg in ctx.pages if pg.locator('.update-notice').count()),None)
   attempted=state.exists() and json.loads(state.read_text(encoding='utf8')).get('lastAttempt')==day
   if attempted and (not notification or notice):break
   main.wait_for_timeout(50)
  main.wait_for_timeout(800)
  assert json.loads(state.read_text(encoding='utf8'))['lastAttempt']==day
  yield main,notice,before
 finally:proc.terminate();proc.wait(timeout=10)
try:
 state.unlink(missing_ok=True)
 with sync_playwright() as p:
  with boot(p,True) as (main,notice,before):
   expect(notice.locator('h1')).to_contain_text('1.1.0');expect(notice.locator('.update-notice')).to_have_attribute('data-theme','light')
   assert notice.locator('.update-notice__notes').evaluate('e=>e.scrollHeight>e.clientHeight')
   notice.screenshot(path=str(OUT/'light-notice.png'));notice.get_by_role('button',name='Пропустить версию').click()
   for _ in range(40):
    if json.loads(state.read_text(encoding='utf8')).get('skippedVersion')=='1.1.0':break
    main.wait_for_timeout(50)
  write_state(lastAttempt=past)
  with boot(p) as (main,notice,before):
   assert len(requests)==before+1 and notice is None
   assert invoke(main,'snipcast_check_update')['latestVersion']=='1.1.0'
  fixture['version']='1.2.0';write_state(lastAttempt=past)
  with boot(p,True) as (main,notice,before):
   expect(notice.locator('h1')).to_contain_text('1.2.0');notice.get_by_role('button',name='Закрыть').click()
   for _ in range(40):
    if json.loads(state.read_text(encoding='utf8')).get('dismissedDay')==day:break
    main.wait_for_timeout(50)
   assert json.loads(state.read_text(encoding='utf8'))['dismissedDay']==day
  with boot(p) as (main,notice,before):assert len(requests)==before and notice is None
  write_state(lastAttempt=past);fixture['fail']=True
  with boot(p) as (main,notice,before):
   assert len(requests)==before+1 and notice is None
   assert '503' in (OUT/'update-errors.log').read_text(encoding='utf8')
  result={'passed':['catch-up after 10','one attempt per day after restart','skip persisted/manual sees skipped version','new version offered','dismiss persisted for the day','network failure silent/logged','light theme and scrollable notes'],'emulation':'missed day emulated through isolated persisted state; no real OS sleep'}
  (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result))
finally:server.shutdown()
