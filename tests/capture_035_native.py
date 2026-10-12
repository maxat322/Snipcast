"""Isolated real Windows multi-display capture, cursor, clipboard and update notice QA."""
import argparse, base64, io, json, os, shutil, subprocess, threading, time, urllib.request, psutil, ctypes
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from PIL import Image,ImageGrab,ImageDraw,ImageFont
from playwright.sync_api import sync_playwright,expect
from capture_text import drag

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'capture-035-native';PORT=9245
parser=argparse.ArgumentParser();parser.add_argument('--baseline',action='store_true');parser.add_argument('--skip-update',action='store_true');parser.add_argument('--source');parser.add_argument('--new-hotkeys',action='store_true');args=parser.parse_args()
OUT.mkdir(parents=True,exist_ok=True)
source=Path(args.source) if args.source else ROOT/('.qa-work/capture-assist-native/selection-qa.exe' if args.baseline else 'src-tauri/target/debug/snipcast.exe')
shutil.copy2(source,OUT/'native-qa.exe')
cfg={'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','paletteListDensity':'normal',
 'screenshotFormat':'png','screenshotJpegQuality':90,'screenshotFileTemplate':'qa {n}','screenshotSaveDir':str(OUT),
 'screenshotQuickLocations':[],'screenshotOcrEngine':'system','screenshotOcrLanguage':'auto','screenshotOcrQuality':'mobile',
 'screenshotPresets':[],'apiEnabled':False,'apiPort':52395,'aiApiKey':'','aiModel':''}
(OUT/'config.json').write_text(json.dumps(cfg),encoding='utf8')
(OUT/'update-state.json').unlink(missing_ok=True)
release={'tag_name':'0.35.0' if args.skip_update else '0.99.0','body':'- Изменения QA\n- Исправлено выделение области','assets':[
 {'name':'snipcast.exe','browser_download_url':'http://127.0.0.1/unused','size':1024},
 {'name':'snipcast.exe.sha256','browser_download_url':'http://127.0.0.1/unused','size':78}]}
requests=[]
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  requests.append(self.path);raw=json.dumps(release).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
 def log_message(self,*_):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}
if not args.baseline:env['SNIPCAST_UPDATE_TEST_URL']=f'http://127.0.0.1:{server.server_port}/latest'
with (OUT/'process.log').open('w',encoding='utf8') as log:proc=subprocess.Popen([str(OUT/'native-qa.exe')],env=env,stdout=log,stderr=log)
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find(context,selector):
 for _ in range(120):
  for page in context.pages:
   try:
    if page.locator(selector).count():return page
   except Exception:pass
  time.sleep(.1)
 raise AssertionError('No native page '+selector)
try:
 for _ in range(100):
  try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
  except OSError:
   assert proc.poll() is None,'QA identifier conflict';time.sleep(.1)
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0]
  main=find(ctx,'body.settings-body')
  errors=[]
  if not args.baseline and not args.skip_update:
   notice=find(ctx,'.update-notice');notice.on('pageerror',lambda e:errors.append(str(e)))
   expect(notice.locator('h1')).to_contain_text('0.99.0');expect(notice.locator('.update-notice__notes')).to_contain_text('Изменения QA')
   notice.screenshot(path=str(OUT/'update-notice.png'))
   invoke(main,'snipcast_start_screenshot');find(ctx,'.capture--presented')
   assert not invoke(main,'plugin:window|is_visible',{'label':'update-notice'})
   invoke(main,'snipcast_close_capture')
   for _ in range(40):
    if invoke(main,'plugin:window|is_visible',{'label':'update-notice'}):break
    notice.wait_for_timeout(50)
   assert invoke(main,'plugin:window|is_visible',{'label':'update-notice'})
   release['tag_name']='1.0.0';notice.get_by_role('button',name='Обновить',exact=True).click()
   expect(notice.locator('h1')).to_contain_text('1.0.0');expect(notice.get_by_role('alert')).to_contain_text('Релиз изменился')
   notice.get_by_role('button',name='Пропустить версию',exact=True).click()
   for _ in range(30):
    state=json.loads((OUT/'update-state.json').read_text(encoding='utf8'))
    if state.get('skippedVersion')=='1.0.0':break
    time.sleep(.1)
   assert state['skippedVersion']=='1.0.0'
   manual=invoke(main,'snipcast_check_update');assert manual['available'] and manual['latestVersion']=='1.0.0'
  times=[];memory=[];private=[];count=None
  for iteration in range(4):
   start=time.perf_counter();invoke(main,'snipcast_start_screenshot')
   capture=find(ctx,'.capture');capture.set_default_timeout(10000)
   capture.wait_for_function("document.querySelector('.capture').classList.contains('capture--presented')")
   times.append(round((time.perf_counter()-start)*1000,1))
   processes=[psutil.Process(proc.pid),*psutil.Process(proc.pid).children(recursive=True)]
   memory.append(sum(p.memory_info().rss for p in processes if p.is_running()))
   private.append(sum(p.memory_info().private for p in processes if p.is_running()))
   info=invoke(capture,'snipcast_capture_info')
   if not args.baseline:
    mons=info['monitors'];count=len(mons);assert len([pg for pg in ctx.pages if pg.locator('.capture').count()])==1
    assert info['x']==min(m['x'] for m in mons) and info['width']==max(m['x']+m['width'] for m in mons)-info['x']
    invoke(capture,'plugin:window|set_focus',{'label':info['label']})
    if iteration==0:
     before=invoke(capture,'snipcast_capture_move_cursor',{'dx':0,'dy':0})
     dx=-1 if before['x']>=info['x']+info['width']-2 else 1
     after=invoke(capture,'snipcast_capture_move_cursor',{'dx':dx,'dy':0})
     assert after['x']-before['x']==dx,(before,after)
    viewport=capture.evaluate('({w:innerWidth,h:innerHeight})');sx=viewport['w']/info['width'];sy=viewport['h']/info['height']
    left=mons[0];right=mons[1] if len(mons)>1 else mons[0]
    a=((left['x']+left['width']*.4-info['x'])*sx,(left['y']+left['height']*.3-info['y'])*sy)
    b=((right['x']+right['width']*.6-info['x'])*sx,(right['y']+right['height']*.7-info['y'])*sy)
    drag(capture,a,b);capture.locator('.capture__toolbar').wait_for()
    raw=capture.evaluate('(name)=>window.__TAURI_INTERNALS__.invoke("snipcast_capture_image_data",{name}).then(b=>Array.from(new Uint8Array(b)))',info['imageName'])
    image=Image.open(io.BytesIO(bytes(raw))).convert('RGB')
    frame=capture.locator('.capture__frame').evaluate('el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top),w:parseFloat(el.style.width),h:parseFloat(el.style.height)})')
    x,y,w,h=[frame[k]/(sx if k in ('x','w') else sy) for k in ('x','y','w','h')]
    # Canvas may scale a fraction of a source pixel at the crop boundary; compare stable interior.
    invoke(capture,'plugin:window|set_focus',{'label':info['label']})
    capture.keyboard.press('c')
    for _ in range(200):
     if not invoke(capture,'plugin:window|is_visible',{'label':info['label']}):break
     capture.wait_for_timeout(100)
    assert not invoke(capture,'plugin:window|is_visible',{'label':info['label']}),capture.locator('.capture__toast').all_text_contents()
    copied=ImageGrab.grabclipboard()
    assert isinstance(copied,Image.Image) and copied.size==(round(w),round(h)),getattr(copied,'size',None)
    copied=copied.convert('RGB');expected=image.crop((round(x),round(y),round(x)+round(w),round(y)+round(h)))
    for px,py in [(10,10),(copied.width//2,copied.height//2),(copied.width-10,copied.height-10)]:
     assert all(abs(a-b)<=2 for a,b in zip(copied.getpixel((px,py)),expected.getpixel((px,py))))
   else:invoke(main,'snipcast_close_capture')
   time.sleep(.2)
  if not args.baseline:
   fixture=Image.new('RGB',(640,400),'white');draw=ImageDraw.Draw(fixture)
   draw.multiline_text((20,20),'12.50\n-2.25\n0.05',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',48),fill='black',spacing=20)
   data=io.BytesIO();fixture.save(data,format='PNG');png=base64.b64encode(data.getvalue()).decode()
   label=invoke(main,'snipcast_capture_pin',{'png':png,'x':120,'y':160,'width':640,'height':400})
   pin=find(ctx,'.pin__shot');pin.wait_for_function("document.querySelector('.pin__shot')?.complete")
   if args.new_hotkeys:
    invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented')
    info=invoke(capture,'snipcast_capture_info');vp=capture.evaluate('({w:innerWidth,h:innerHeight})');mon=info['monitors'][0]
    center=((mon['x']+mon['width']/2-info['x'])*vp['w']/info['width'],(mon['y']+mon['height']/2-info['y'])*vp['h']/info['height'])
    capture.mouse.move(*center);capture.wait_for_timeout(40);capture.keyboard.press('a')
    f=capture.locator('.capture__frame').evaluate('el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top),w:parseFloat(el.style.width),h:parseFloat(el.style.height)})')
    assert abs(f['w']*info['width']/vp['w']-mon['width'])<1 and abs(f['h']*info['height']/vp['h']-mon['height'])<1
    capture.keyboard.press('Escape');invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented')
    info=invoke(capture,'snipcast_capture_info');vp=capture.evaluate('({w:innerWidth,h:innerHeight})')
    a=((120-info['x'])*vp['w']/info['width'],(160-info['y'])*vp['h']/info['height']);b=((760-info['x'])*vp['w']/info['width'],(560-info['y'])*vp['h']/info['height'])
    drag(capture,a,b);capture.keyboard.press('Space')
    for _ in range(100):
     pins=[pg for pg in ctx.pages if pg.locator('.pin').count()]
     if len(pins)==2 and not invoke(main,'plugin:window|is_visible',{'label':info['label']}):break
     time.sleep(.05)
    assert len(pins)==2
    created=next(pg for pg in pins if pg.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')!=label)
    pin_info=invoke(created,'snipcast_pin_info');assert (pin_info['width'],pin_info['height'])==(640,400)
    assert created.locator('.pin--selected').count()==1
   invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented')
   info=invoke(capture,'snipcast_capture_info');vp=capture.evaluate('({w:innerWidth,h:innerHeight})')
   a=((120-info['x'])*vp['w']/info['width'],(160-info['y'])*vp['h']/info['height'])
   b=((760-info['x'])*vp['w']/info['width'],(560-info['y'])*vp['h']/info['height'])
   drag(capture,a,b);capture.get_by_title('Сложить распознанные числа',exact=True).click()
   expect(capture.get_by_role('status')).to_contain_text('Сумма: 10,3',timeout=25000)
   assert invoke(capture,'plugin:window|is_visible',{'label':info['label']})
   user=ctypes.windll.user32;kernel=ctypes.windll.kernel32
   user.GetClipboardData.restype=ctypes.c_void_p;kernel.GlobalLock.restype=ctypes.c_void_p;kernel.GlobalLock.argtypes=[ctypes.c_void_p];kernel.GlobalUnlock.argtypes=[ctypes.c_void_p]
   assert user.OpenClipboard(None)
   try:
    handle=user.GetClipboardData(13);ptr=kernel.GlobalLock(handle);assert ctypes.wstring_at(ptr)=='10,3';kernel.GlobalUnlock(handle)
   finally:user.CloseClipboard()
   # Native save receives the same full crop PNG; the dialog route is covered in browser QA.
   invoke(main,'snipcast_capture_save',{'png':png,'path':str(OUT/'saved-native.png'),'format':'png'})
   assert Image.open(OUT/'saved-native.png').convert('RGB').tobytes()==fixture.tobytes()
   invoke(main,'snipcast_close_capture');invoke(main,'snipcast_close_all_pins')
  assert not errors,errors
  result={'baselineBackend':args.baseline,'monitors':count,'openMs':times,'processTreeWorkingSetBytes':memory,'processTreePrivateBytes':private,'source':str(source),'frontend':'bundled frontend' if args.source else 'current Vite source','updateNoticeTest':not args.baseline and not args.skip_update}
  (OUT/('baseline.json' if args.baseline else 'release.json' if args.source else 'current.json')).write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
  if not args.baseline:print('PASS: available desktop monitors, one overlay, one-pixel system cursor, crop clipboard, system OCR sum, native PNG save; update notice tested: '+str(not args.skip_update))
finally:
 proc.terminate();proc.wait(timeout=10);server.shutdown()
