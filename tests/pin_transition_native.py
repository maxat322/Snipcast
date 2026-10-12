"""Inspect every captured desktop frame, not only settled WebView layouts."""
import base64,ctypes,datetime,io,json,os,shutil,struct,subprocess,sys,threading,time,urllib.request
from pathlib import Path
from PIL import Image,ImageDraw,ImageGrab,ImageChops
from playwright.sync_api import sync_playwright
from ctypes import wintypes
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/('pin-transition-'+sys.argv[1]);OUT.mkdir(parents=True,exist_ok=True)
shutil.copy2(Path(sys.argv[2]),OUT/'transition-qa.exe')
# The user retained only the official old exe. In the baseline test copy,
# isolate its single-instance identifier without changing executable logic.
if os.environ.get('SNIPCAST_QA_BASELINE')=='1':
    binary=(OUT/'transition-qa.exe').read_bytes()
    assert binary.count(b'com.snipcast.app')==1
    (OUT/'transition-qa.exe').write_bytes(binary.replace(b'com.snipcast.app',b'qa1.snipcast.app'))
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','apiEnabled':False,'screenshotPresets':[]}),encoding='utf8')
(OUT/'update-state.json').write_text(json.dumps({'lastAttempt':datetime.date.today().isoformat()}),encoding='utf8')
PORT=9262
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find(ctx,selector):
    for _ in range(100):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError(selector)

def cover_count(pid):
    covers=[]
    @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def collect(hwnd,_):
        owner=wintypes.DWORD();ctypes.windll.user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        title=ctypes.create_unicode_buffer(256);ctypes.windll.user32.GetWindowTextW(hwnd,title,256)
        if owner.value==pid and title.value=='Snipcast transition':covers.append(hwnd)
        return True
    ctypes.windll.user32.EnumWindows(collect,0)
    return len(covers)
log=(OUT/'process.log').open('w',encoding='utf8')
proc=subprocess.Popen([str(OUT/'transition-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'},stdout=log,stderr=log)
results=[];creations=[]
class DesktopCrop:
    # ImageGrab copies the full desktop before cropping on Windows. Read only
    # the image rectangle into a top-down DIB so a 60Hz transition isn't missed.
    def __init__(self,rect):
        self.x,self.y,right,bottom=rect;self.w=right-self.x;self.h=bottom-self.y
        self.user=ctypes.windll.user32;self.gdi=ctypes.windll.gdi32
        self.user.GetDC.restype=ctypes.c_void_p
        self.user.ReleaseDC.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
        self.gdi.CreateCompatibleDC.argtypes=[ctypes.c_void_p];self.gdi.CreateCompatibleDC.restype=ctypes.c_void_p
        self.gdi.CreateDIBSection.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p,ctypes.c_uint]
        self.gdi.CreateDIBSection.restype=ctypes.c_void_p
        self.gdi.SelectObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p];self.gdi.SelectObject.restype=ctypes.c_void_p
        self.gdi.DeleteObject.argtypes=[ctypes.c_void_p];self.gdi.DeleteDC.argtypes=[ctypes.c_void_p]
        self.gdi.BitBlt.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_uint]
        self.screen=self.user.GetDC(None);self.dc=self.gdi.CreateCompatibleDC(self.screen);self.bits=ctypes.c_void_p()
        header=ctypes.create_string_buffer(struct.pack('<IiiHHIIiiII',40,self.w,-self.h,1,32,0,self.w*self.h*4,0,0,0,0))
        self.bitmap=self.gdi.CreateDIBSection(self.screen,header,0,ctypes.byref(self.bits),None,0)
        assert self.bitmap and self.bits.value
        self.old=self.gdi.SelectObject(self.dc,self.bitmap)
    def grab(self):
        assert self.gdi.BitBlt(self.dc,0,0,self.w,self.h,self.screen,self.x,self.y,0x40CC0020)
        return Image.frombytes('RGB',(self.w,self.h),ctypes.string_at(self.bits,self.w*self.h*4),'raw','BGRX')
    def close(self):
        self.gdi.SelectObject(self.dc,self.old);self.gdi.DeleteObject(self.bitmap);self.gdi.DeleteDC(self.dc);self.user.ReleaseDC(None,self.screen)
try:
    for _ in range(100):
        try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
        except OSError:assert proc.poll() is None;time.sleep(.1)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0];main=find(ctx,'body.settings-body')
        for variant,(x,y,w,h) in enumerate(((1000,400,420,140),(140,680,300,100))):
            image=Image.new('RGB',(w,h),(18,52,86));draw=ImageDraw.Draw(image)
            for i in range(0,w,13):draw.line((i,0,i,h),fill=(230,70,110),width=3)
            for j in range(0,h,17):draw.line((0,j,w,j),fill=(30,220,140),width=2)
            buf=io.BytesIO();image.save(buf,format='PNG')
            core=(x+8,y+8,x+w-8,y+h-8)
            source=image.crop((8,8,w-8,h-8));background=ImageGrab.grab(bbox=core).convert('RGB')
            native=ctypes.windll.user32
            native.GetWindowRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
            native.IsWindowVisible.argtypes=[wintypes.HWND]
            def visible_pin():
                found=[]
                @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
                def collect(hwnd,_):
                    owner=wintypes.DWORD();native.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
                    rect=wintypes.RECT();native.GetWindowRect(hwnd,ctypes.byref(rect))
                    if owner.value==proc.pid and native.IsWindowVisible(hwnd) and (rect.left,rect.top,rect.right,rect.bottom)==(x-24,y-24,x+w+24,y+h+24):found.append(hwnd)
                    return True
                native.EnumWindows(collect,0)
                return bool(found)
            opening=[];done=threading.Event();started=threading.Event()
            def sample_creation():
                crop=DesktopCrop(core);started.set()
                try:
                    while not done.is_set():
                        begin=time.perf_counter();visible=visible_pin();frame=crop.grab()
                        if visible and visible_pin():
                            error=max(c[1] for c in ImageChops.difference(frame,source).getextrema())
                            old=max(c[1] for c in ImageChops.difference(frame,background).getextrema())
                            opening.append((min(error,old),error,frame))
                        done.wait(max(0,1/60-(time.perf_counter()-begin)))
                finally:crop.close()
            opening_worker=threading.Thread(target=sample_creation);opening_worker.start();assert started.wait(5)
            try:
                invoke(main,'snipcast_capture_pin',{'png':base64.b64encode(buf.getvalue()).decode(),'x':x,'y':y,'width':w,'height':h})
                pin=find(ctx,'.pin');pin.locator('.pin__shot').wait_for();pin.wait_for_timeout(400)
            finally:done.set();opening_worker.join(timeout=5)
            assert opening,'new pin never appeared'
            # Calibrate against the settled desktop frame: Windows display
            # colour conversion differs from the raw PNG on this workstation.
            # First validate its exact pattern/layout, permitting that colour
            # conversion, then use the stricter 8-level transition threshold.
            displayed=ImageGrab.grab(bbox=core).convert('RGB')
            color_delta=max(c[1] for c in ImageChops.difference(displayed,source).getextrema())
            assert color_delta<=40,('settled pin does not contain the source pattern',color_delta)
            malformed=[(i,f) for i,(_,_,f) in enumerate(opening)
                if min(max(c[1] for c in ImageChops.difference(f,displayed).getextrema()),
                       max(c[1] for c in ImageChops.difference(f,background).getextrema()))>8]
            for i,f in malformed[:5]:f.save(OUT/f'pin-{variant}-creation-bad-{i}.png')
            opening[-1][2].save(OUT/f'pin-{variant}-creation-ready.png')
            final_error=max(c[1] for c in ImageChops.difference(opening[-1][2],displayed).getextrema())
            creations.append({'variant':variant,'visibleFrames':len(opening),'badFrames':len(malformed),'finalError':final_error,'displayColorDifference':color_delta})
            (OUT/'creation-results.json').write_text(json.dumps(creations,indent=2),encoding='utf8')
            if os.environ.get('SNIPCAST_QA_BASELINE')!='1':assert not malformed and final_error<=8,creations[-1]
            cpu=float(os.environ.get('SNIPCAST_QA_CPU','1'))
            ctx.new_cdp_session(pin).send('Emulation.setCPUThrottlingRate',{'rate':cpu})
            core=(x+8,y+8,x+w-8,y+h-8);expected=ImageGrab.grab(bbox=core).convert('RGB')
            expected.save(OUT/f'pin-{variant}-reference.png')
            for cycle in range(10):
                if cycle==5:
                    cfg=invoke(main,'snipcast_get_config');cfg['theme']='light';invoke(main,'snipcast_save_config',{'incoming':cfg});pin.wait_for_timeout(200)
                # Anchor the context menu in the transparent padding, away
                # from the reference image, so menu dismissal isn't a false failure.
                pin.mouse.click(w+34,h+34,button='right');menu=find(ctx,'.pinmenu')
                frames=[];stop=threading.Event()
                def sample():
                    crop=DesktopCrop(core)
                    try:
                        while not stop.is_set():
                            start=time.perf_counter();frame=crop.grab()
                            diff=ImageChops.difference(frame,expected);error=max(c[1] for c in diff.getextrema())
                            frames.append((start,error,frame));stop.wait(max(0,1/60-(time.perf_counter()-start)))
                    finally:crop.close()
                worker=threading.Thread(target=sample);worker.start()
                start=time.perf_counter()
                try:
                    menu.get_by_role('button',name='Аннотировать',exact=True).click();pin.locator('.capture--pin-editor').wait_for()
                    pin.wait_for_timeout(250);pin.keyboard.press(str(cycle%5+1));pin.wait_for_timeout(200)
                    pin.get_by_role('button',name='Готово' if cycle%2 else 'Отмена',exact=True).click();pin.locator('.pin').wait_for();pin.wait_for_timeout(300)
                finally:stop.set();worker.join(timeout=5)
                bad=[(i,t,e,f) for i,(t,e,f) in enumerate(frames) if e>8]
                if bad:
                    for i,t,e,f in bad[:5]:f.save(OUT/f'pin-{variant}-cycle-{cycle}-bad-{i}.png')
                if cycle in (0,9):
                    frames[len(frames)//2][2].save(OUT/f'pin-{variant}-cycle-{cycle}-live.png')
                    frames[-1][2].save(OUT/f'pin-{variant}-cycle-{cycle}-closed.png')
                results.append({'variant':variant,'cycle':cycle,'frames':len(frames),'maxError':max(e for _,e,_ in frames),'badFrames':len(bad),'durationMs':round((time.perf_counter()-start)*1000,1)})
                (OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8')
                if os.environ.get('SNIPCAST_QA_BASELINE')!='1':
                    assert not bad,results[-1]
                    assert cover_count(proc.pid)==0,'transition cover survived presentation'
            invoke(main,'snipcast_close_all_pins');main.wait_for_timeout(100)
        print(json.dumps({'cycles':len(results),'frames':sum(r['frames'] for r in results),'badFrames':sum(r['badFrames'] for r in results),'maxError':max(r['maxError'] for r in results),'creations':creations}))
finally:proc.terminate();proc.wait(timeout=10);log.close()
