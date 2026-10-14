"""Real WGC/wcap recording, standalone editor, trim/crop/MP4/GIF and cancellation.
Runs a separate Tauri identifier and isolated data directory; never kills the user app.
Usage: SNIPCAST_QA_EXE=<QA build> python tests/video_native.py [run-name]
"""
import ctypes, ctypes.wintypes, json, os, shutil, subprocess, sys, threading, time, urllib.request
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image, ImageGrab
import psutil
import av, numpy as np
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/('video-native-'+(sys.argv[1] if len(sys.argv)>1 else 'current'))
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'quick-saves').mkdir(exist_ok=True)
SOURCE=Path(os.environ.get('SNIPCAST_QA_EXE',str(ROOT/'src-tauri/target/debug/snipcast.exe')))
shutil.copy2(SOURCE,OUT/'video-qa.exe')
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','apiEnabled':False,'screenshotPresets':[],'screenshotFileTemplate':'Video {datetime} {n}','screenshotQuickLocations':[{'name':'QA folder','path':str(OUT/'quick-saves')},{'name':'Missing folder','path':str(OUT/'does-not-exist')}]}),encoding='utf8')
PORT=9260
WIDTH=int(os.environ.get('SNIPCAST_QA_WIDTH','386'))
HEIGHT=int(os.environ.get('SNIPCAST_QA_HEIGHT','202'))
class Files(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(OUT),**kwargs)
    def end_headers(self):self.send_header('Access-Control-Allow-Origin','*');super().end_headers()
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Files)
threading.Thread(target=server.serve_forever,daemon=True).start()
log=(OUT/'process.log').open('w',encoding='utf8')
proc=subprocess.Popen([str(OUT/'video-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}','SNIPCAST_UPDATE_TEST_URL':f'http://127.0.0.1:{server.server_port}/no-update'},stdout=log,stderr=log)
native_mouse_held=False
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find(context,selector):
    for _ in range(160):
        assert proc.poll() is None,('QA process exited',proc.returncode,(OUT/'process.log').read_text())
        for page in context.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError(('No native page',selector))
def wait_phase(page,phase):
    for _ in range(180):
        status=invoke(page,'snipcast_video_status')
        if status['phase']==phase:return status
        if status['phase']=='error':raise AssertionError(status)
        page.wait_for_timeout(100)
    raise AssertionError(status)
def decode_video(page,path,timepoint=.3):
    url=f'http://127.0.0.1:{server.server_port}/{path.name}'
    return page.evaluate('''async([url,timepoint])=>{
      const v=document.createElement('video');v.crossOrigin='anonymous';v.muted=true;v.src=url;
      await new Promise((r,j)=>{v.onloadedmetadata=r;v.onerror=()=>j(new Error('export metadata'));});
      const duration=v.duration,width=v.videoWidth,height=v.videoHeight;
      v.currentTime=Math.min(timepoint,v.duration-.02);
      await new Promise((r,j)=>{v.onseeked=r;v.onerror=j;});
      const c=document.createElement('canvas');c.width=width;c.height=height;const g=c.getContext('2d');g.drawImage(v,0,0);
      const pixel=Array.from(g.getImageData(20,20,1,1).data);const bottom=Array.from(g.getImageData(20,height-20,1,1).data);
      v.removeAttribute('src');v.load();return{duration,width,height,pixel,bottom};
    }''',[url,timepoint])
results={}
def memory_snapshot():
    owner=psutil.Process(proc.pid)
    processes=[owner,*owner.children(recursive=True)]
    return {'appWorkingSetBytes':owner.memory_info().rss,'processTreeWorkingSetBytes':sum(p.memory_info().rss for p in processes if p.is_running())}

def native_key(code,repeats=1):
    user=ctypes.windll.user32
    class Keyboard(ctypes.Structure):
        _fields_=[('vk',ctypes.c_ushort),('scan',ctypes.c_ushort),('flags',ctypes.c_ulong),('time',ctypes.c_ulong),('extra',ctypes.c_void_p)]
    class Inputs(ctypes.Union):
        _fields_=[('keyboard',Keyboard),('padding',ctypes.c_byte*32)]
    class Input(ctypes.Structure):
        _fields_=[('type',ctypes.c_ulong),('data',Inputs)]
    assert ctypes.sizeof(Input)==40
    for flags in [*([0]*repeats),2]:
        event=Input();event.type=1;event.data.keyboard=Keyboard(code,user.MapVirtualKeyW(code,0),flags,0,None)
        assert user.SendInput(1,ctypes.byref(event),ctypes.sizeof(event))==1,('SendInput failed',ctypes.get_last_error())
        time.sleep(.08)

def native_save_dialog():
    user=ctypes.windll.user32;dialogs=[]
    callback_type=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    def collect(hwnd,_):
        pid=ctypes.c_ulong();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
        name=ctypes.create_unicode_buffer(256);user.GetClassNameW(hwnd,name,256)
        if pid.value==proc.pid and name.value=='#32770' and user.IsWindowVisible(hwnd):dialogs.append(hwnd)
        return True
    for _ in range(100):
        user.EnumWindows(callback_type(collect),0)
        if dialogs:return dialogs[0]
        time.sleep(.05)
    raise AssertionError('Native Save dialog did not open')

def check_corners(page,label,name):
    """Check real composited desktop pixels, not just a DWM attribute."""
    user=ctypes.windll.user32;handles=[];fixture_handles=[]
    title='Обрезка видео — Snipcast' if label=='video-editor' else 'Запись — Snipcast'
    callback_type=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    def collect(hwnd,_):
        pid=ctypes.c_ulong();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
        text=ctypes.create_unicode_buffer(256);user.GetWindowTextW(hwnd,text,256)
        if pid.value==proc.pid and text.value==title:handles.append(hwnd)
        if pid.value==proc.pid and text.value=='Настройки — Snipcast':fixture_handles.append(hwnd)
        return True
    user.EnumWindows(callback_type(collect),0);assert len(handles)==1
    hwnd=ctypes.c_void_p(handles[0]);origin=ctypes.wintypes.POINT()
    assert user.ClientToScreen(hwnd,ctypes.byref(origin))
    assert len(fixture_handles)==1
    fixture_origin=ctypes.wintypes.POINT();assert user.ClientToScreen(ctypes.c_void_p(fixture_handles[0]),ctypes.byref(fixture_origin))
    assert user.SetWindowPos(ctypes.c_void_p(fixture_handles[0]),ctypes.c_void_p(-1),0,0,0,0,0x13)
    assert user.SetWindowPos(hwnd,ctypes.c_void_p(-1),0,0,0,0,0x13)
    fixture_dpr=main.evaluate('devicePixelRatio')
    affinity=ctypes.c_ulong();assert user.GetWindowDisplayAffinity(hwnd,ctypes.byref(affinity))
    if affinity.value:invoke(page,'plugin:window|set_content_protected',{'label':label,'value':False})
    try:
        page.wait_for_timeout(150)
        viewport=page.evaluate('({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})')
        w=round(viewport['w']*viewport['dpr']);h=round(viewport['h']*viewport['dpr'])
        shot=ImageGrab.grab(bbox=(origin.x,origin.y,origin.x+w,origin.y+h)).convert('RGB')
        shot.save(OUT/f'{name}-desktop.png')
        outer=ctypes.wintypes.RECT();assert user.GetWindowRect(hwnd,ctypes.byref(outer))
        ImageGrab.grab(bbox=(outer.left-2,outer.top-2,outer.right+2,outer.bottom+2)).save(OUT/f'{name}-window-desktop.png')
        colors=[]
        for x,y in [(0,0),(w-1,0),(0,h-1),(w-1,h-1)]:
            actual=shot.getpixel((x,y));expected=(233,83,145) if origin.y+y<fixture_origin.y+160*fixture_dpr else (55,217,176)
            colors.append(actual)
            assert max(abs(a-b) for a,b in zip(actual,expected))<75,(name,x,y,actual,expected)
        page.screenshot(path=str(OUT/f'{name}-transparent.png'),omit_background=True)
        rgba=Image.open(OUT/f'{name}-transparent.png').convert('RGBA')
        assert all(rgba.getpixel(p)[3]==0 for p in [(0,0),(rgba.width-1,0),(0,rgba.height-1),(rgba.width-1,rgba.height-1)]),name
        results[name+'CornerPixels']=colors
        if label=='video-editor':
            x=origin.x+w-2;y=origin.y+h//2
            assert user.SendMessageW(hwnd,0x84,0,ctypes.c_void_p((x&0xffff)|((y&0xffff)<<16)))==11,'Editor right-edge resizing no longer works'
    finally:
        if affinity.value:invoke(page,'plugin:window|set_content_protected',{'label':label,'value':True})
try:
    for _ in range(150):
        try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
        except OSError:assert proc.poll() is None;time.sleep(.1)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0]
        main=find(ctx,'body.settings-body');errors=[]
        ctx.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))))
        assert invoke(main,'snipcast_get_version')=='0.36.6'
        for existing_page in ctx.pages:existing_page.on('pageerror',lambda e:errors.append(str(e)))
        label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
        user=ctypes.windll.user32
        invoke(main,'plugin:window|set_position',{'label':label,'value':{'Physical':{'x':0,'y':0}}})
        invoke(main,'plugin:window|set_size',{'label':label,'value':{'Physical':{'width':user.GetSystemMetrics(0),'height':user.GetSystemMetrics(1)}}})
        main.evaluate('''()=>{const el=document.createElement('div');el.id='record-fixture';el.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#37d9b0;pointer-events:none';
          el.innerHTML='<div style="position:absolute;left:0;right:0;top:0;height:160px;background:#e95391"></div><div id="video-marker" style="position:absolute;top:150px;left:160px;width:60px;height:60px;background:#f1bf66"></div>';
          document.body.append(el);let x=160;window.qaMotion=setInterval(()=>{x=x===160?320:160;document.querySelector('#video-marker').style.left=x+'px'},350);
        }''')
        invoke(main,'plugin:window|show',{'label':label});invoke(main,'plugin:window|set_focus',{'label':label});main.wait_for_timeout(250)
        results['idleMemory']=memory_snapshot()
        invoke(main,'snipcast_video_select');capture=find(ctx,'.capture--presented')
        info=invoke(capture,'snipcast_capture_info');assert info['videoSelection']
        invoke(capture,'plugin:window|set_focus',{'label':info['label']})
        capture.wait_for_timeout(700)
        vp=capture.evaluate('({w:innerWidth,h:innerHeight})');sx=vp['w']/info['width'];sy=vp['h']/info['height']
        a=((80-info['x'])*sx,(100-info['y'])*sy);b=((80+WIDTH-info['x'])*sx,(100+HEIGHT-info['y'])*sy)
        capture.mouse.move(*a);capture.mouse.down();capture.wait_for_timeout(50);capture.mouse.move(*b,steps=8);capture.wait_for_timeout(50);capture.mouse.up()
        capture.screenshot(path=str(OUT/'selection-before-toolbar.png'))
        print('selection',capture.locator('.capture__frame').count(),capture.locator('button').all_text_contents(),errors,flush=True)
        capture.get_by_title('Начать запись области',exact=True).wait_for()
        assert capture.get_by_role('button',name='Стрелка',exact=True).count()==0
        capture.screenshot(path=str(OUT/'selection.png'))
        # Invalid options fail while keeping the selection visible.
        invalid=capture.evaluate('''()=>window.__TAURI_INTERNALS__.invoke('snipcast_video_start',{options:{x:80,y:100,width:8,height:400,fps:30,audio:false}}).then(()=>false,()=>true)''')
        assert invalid and invoke(main,'snipcast_video_status')['phase']=='selecting'
        capture.get_by_role('combobox',name='Частота кадров записи').click()
        assert capture.locator('select').count()==0
        capture.screenshot(path=str(OUT/'capture-themed-dropdown.png'))
        capture.get_by_role('option',name='30 кадров/с',exact=True).click()
        capture.get_by_role('checkbox',name='Звук системы').check()
        capture.get_by_title('Начать запись области',exact=True).click()
        control=find(ctx,'.video-record');st=wait_phase(control,'recording');assert st['width']==WIDTH and st['height']==HEIGHT
        assert control.evaluate('({w:innerWidth,h:innerHeight})')=={'w':300,'h':44}
        assert control.locator('.video-record__details').count()==0
        control_pos=invoke(control,'plugin:window|outer_position',{'label':'video-control'})
        work=ctypes.wintypes.RECT();assert user.SystemParametersInfoW(0x0030,0,ctypes.byref(work),0)
        assert abs(control_pos['x']-(work.left+(work.right-work.left-300)/2))<=2,control_pos
        assert abs(control_pos['y']-(work.bottom-44-16))<=2,control_pos
        results['recordPanelPosition']=control_pos
        results['globalRecordingKeys']=os.environ.get('SNIPCAST_QA_KEYS')!='0'
        control.wait_for_timeout(1400)
        invoke(main,'plugin:window|set_focus',{'label':label})
        (native_key(0x7A,repeats=2) if os.environ.get('SNIPCAST_QA_KEYS')!='0' else control.get_by_role('button',name='Пауза',exact=True).click());paused=wait_phase(control,'paused')
        results['recordingMemory']=memory_snapshot()
        control.wait_for_timeout(1100);frozen=invoke(control,'snipcast_video_status');assert abs(frozen['durationMs']-paused['durationMs'])<350,(paused,frozen)
        control.screenshot(path=str(OUT/'recording-paused.png'))
        check_corners(control,'video-control','controller-dark')
        control.evaluate("document.documentElement.dataset.appTheme='light'")
        check_corners(control,'video-control','controller-light')
        control.evaluate("document.documentElement.dataset.appTheme='dark'")
        (native_key(0x7A) if os.environ.get('SNIPCAST_QA_KEYS')!='0' else control.get_by_role('button',name='Продолжить',exact=True).click());wait_phase(control,'recording')
        # Move the real controller into the captured area; display affinity must exclude it.
        invoke(control,'plugin:window|set_position',{'label':'video-control','value':{'Physical':{'x':90,'y':110}}})
        control.wait_for_timeout(1700)
        (native_key(0x7B) if os.environ.get('SNIPCAST_QA_KEYS')!='0' else control.get_by_role('button',name='Завершить',exact=True).click())
        editor=find(ctx,'.video-editor');st=wait_phase(editor,'editing');results['recording']=st
        assert all(not(user.GetAsyncKeyState(key)&0x8000) for key in [0x7A,0x7B]),'Recording key remained held'
        results['recordingKeysReleased']=True
        assert 2700<st['durationMs']<4200,st
        assert st['audio'],st
        results['editorMemory']=memory_snapshot()
        editor.screenshot(path=str(OUT/'editor-before-thumbnails.png'))
        assert editor.get_by_role('button',name='Отмена',exact=True).count()==0
        editor.get_by_role('combobox',name='Качество видео').click()
        assert editor.locator('select').count()==0
        editor.screenshot(path=str(OUT/'editor-themed-dropdown.png'))
        editor.get_by_role('option',name='Баланс',exact=True).click()
        expect(editor.get_by_role('combobox',name='Качество видео')).to_contain_text('Баланс')
        editor.get_by_role('combobox',name='Качество видео').press('ArrowDown')
        editor.get_by_role('combobox',name='Качество видео').press('Home')
        editor.get_by_role('combobox',name='Качество видео').press('Enter')
        expect(editor.get_by_role('combobox',name='Качество видео')).to_contain_text('Компактно')
        results['themedDropdowns']=True
        # Inspect the real HWND region and capture the editor through Snipcast's
        # native screenshot path (the prior display-affinity flag hid it).
        handles=[]
        callback_type=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
        def collect_editor(hwnd,_):
            pid=ctypes.c_ulong();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
            title=ctypes.create_unicode_buffer(256);user.GetWindowTextW(hwnd,title,256)
            if pid.value==proc.pid and title.value=='Обрезка видео — Snipcast':handles.append(hwnd)
            return True
        user.EnumWindows(callback_type(collect_editor),0);assert len(handles)==1,handles
        hwnd=ctypes.c_void_p(handles[0]);affinity=ctypes.c_ulong()
        assert user.GetWindowDisplayAffinity(hwnd,ctypes.byref(affinity)) and affinity.value==0,affinity.value
        rounded=ctypes.c_ulong()
        assert ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd,33,ctypes.byref(rounded),4)==0 and rounded.value==1,rounded.value
        invoke(editor,'plugin:window|set_size',{'label':'video-editor','value':{'Physical':{'width':920,'height':680}}})
        editor.wait_for_timeout(250)
        check_corners(editor,'video-editor','editor-resized-dark')
        editor.evaluate("document.documentElement.dataset.appTheme='light'")
        check_corners(editor,'video-editor','editor-resized-light')
        editor.evaluate("document.documentElement.dataset.appTheme='dark'")
        results['nativeRoundedCorners']=True
        invoke(editor,'plugin:window|set_size',{'label':'video-editor','value':{'Physical':{'width':900,'height':660}}})
        editor.wait_for_timeout(250)
        ep=invoke(editor,'plugin:window|outer_position',{'label':'video-editor'})
        save_rect=editor.get_by_role('button',name='Сохранить MP4',exact=True).bounding_box()
        client_origin=ctypes.wintypes.POINT(0,0);assert user.ClientToScreen(hwnd,ctypes.byref(client_origin))
        point=[client_origin.x+save_rect['x']+5,client_origin.y+save_rect['y']+save_rect['height']/2]
        invoke(main,'snipcast_start_screenshot');shot=find(ctx,'.capture--presented');shot_info=invoke(shot,'snipcast_capture_info')
        screenshot_pixel=shot.evaluate('''([x,y])=>{const img=document.querySelector('.capture__shot');const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const g=c.getContext('2d');g.drawImage(img,0,0);return Array.from(g.getImageData(x,y,1,1).data);}''',[point[0]-shot_info['x'],point[1]-shot_info['y']])
        shot.screenshot(path=str(OUT/'editor-visible-in-screenshot.png'))
        assert all(abs(a-b)<=10 for a,b in zip(screenshot_pixel[:3],[81,100,242])),screenshot_pixel
        shot.keyboard.press('Escape');editor.wait_for_timeout(200)
        results['editorCapturable']=True


        print('recording',st,flush=True)
        expect(editor.locator('video')).to_have_js_property('videoWidth',WIDTH)
        editor.wait_for_function("document.querySelectorAll('.video-filmstrip img').length===8",timeout=20000)
        assert abs(float(editor.get_by_role('slider',name='Конец фрагмента',exact=True).input_value())-st['durationMs']/1000)<.0001,'End thumb rounded away from recording end'
        invoke(editor,'plugin:window|set_focus',{'label':'video-editor'})
        editor.get_by_role('button',name='Воспроизвести',exact=True).click()
        editor.wait_for_function('document.querySelector("video").currentTime>.1',timeout=5000)
        editor.get_by_role('button',name='Пауза',exact=True).click()
        # Cursor follows the held mouse, including moves outside the timeline.
        timeline=editor.locator('.video-filmstrip').bounding_box();tx,ty=timeline['x'],timeline['y']+timeline['height']/2
        thumb_width=editor.locator('.video-filmstrip').evaluate('el=>parseFloat(getComputedStyle(el).getPropertyValue("--trim-handle-width"))')
        assert thumb_width==16,thumb_width
        editor.mouse.move(tx+timeline['width']*.25,ty);editor.mouse.down()
        editor.mouse.move(tx+timeline['width']*.7,ty,steps=8)
        assert abs(editor.locator('video').evaluate('v=>v.currentTime')-st['durationMs']/1000*.7)<.15
        editor.mouse.move(tx+timeline['width']*.85,ty+100,steps=4);editor.mouse.up()
        assert abs(editor.locator('video').evaluate('v=>v.currentTime')-st['durationMs']/1000*.85)<.15
        editor.get_by_role('spinbutton',name='Начало фрагмента, секунды').fill('0.5')
        assert abs(editor.locator('video').evaluate('v=>v.currentTime')-.5)<.03
        editor.get_by_role('spinbutton',name='Конец фрагмента, секунды').fill('2.5')
        assert abs(editor.locator('video').evaluate('v=>v.currentTime')-2.5)<.03
        # Drag the actual native range thumbs. Verify a decoded frame is presented
        # at the changed boundary, not just a changed input/currentTime property.
        assert user.SetWindowPos(hwnd,ctypes.c_void_p(-1),0,0,0,0,0x13)
        dpr=editor.evaluate('devicePixelRatio')
        def mouse_at(x,y):
            client_origin.x=client_origin.y=0
            assert user.ClientToScreen(hwnd,ctypes.byref(client_origin))
            point=ctypes.wintypes.POINT(client_origin.x+round(x*dpr),client_origin.y+round(y*dpr))
            user.WindowFromPoint.restype=ctypes.c_void_p;user.GetAncestor.restype=ctypes.c_void_p
            hit=user.WindowFromPoint(point)
            assert user.GetAncestor(ctypes.c_void_p(hit),2)==hwnd.value,'Another window covers the QA editor'
            assert user.SetCursorPos(point.x,point.y)
        editor.mouse.click(tx+thumb_width/2+(timeline['width']-thumb_width)*.6,ty)
        saved_position=editor.locator('video').evaluate('v=>v.currentTime')
        saved_cursor=editor.locator('.video-filmstrip').evaluate('el=>getComputedStyle(el).getPropertyValue("--play-position")')
        editor.mouse.move(10,10);editor.wait_for_timeout(200)
        for name,fraction in [('Начало фрагмента',.3),('Конец фрагмента',.9)]:
            handle=editor.get_by_role('slider',name=name,exact=True)
            value=float(handle.input_value());duration=float(handle.get_attribute('max'))
            hx=tx+thumb_width/2+(timeline['width']-thumb_width)*value/duration
            editor.evaluate('''()=>{window.qaPresentedFrame=null;const v=document.querySelector('video');const watch=(_,frame)=>{window.qaPresentedFrame=frame.mediaTime;window.qaFrameWatch=v.requestVideoFrameCallback(watch);};window.qaFrameWatch=v.requestVideoFrameCallback(watch);}''')
            mouse_at(hx,ty);assert not(user.GetAsyncKeyState(1)&0x8000),'User mouse is already held'
            cursor_left=editor.locator('.video-filmstrip__playhead').bounding_box()['x']
            user.mouse_event(2,0,0,0,0);native_mouse_held=True
            destination=tx+thumb_width/2+(timeline['width']-thumb_width)*fraction
            # WebView2 can defer CDP replies while its native range drag owns the
            # mouse. Inspect the real desktop while held, then query DOM on release.
            for step in range(1,11):
                mouse_at(hx+(destination-hx)*step/10,ty);time.sleep(.025)
            time.sleep(.15)
            client_origin.x=client_origin.y=0;assert user.ClientToScreen(hwnd,ctypes.byref(client_origin))
            held=ImageGrab.grab(bbox=(client_origin.x,client_origin.y,client_origin.x+round(900*dpr),client_origin.y+round(660*dpr))).convert('RGB')
            held.save(OUT/('trim-start-drag.png' if name=='Начало фрагмента' else 'trim-end-drag.png'))
            column=round(cursor_left*dpr)
            rows=range(round((timeline['y']+8)*dpr),round((timeline['y']+timeline['height']-8)*dpr))
            white=sum(max(abs(c-235) for c in held.getpixel((column,y)))<30 for y in rows)
            assert white<len(rows)/4,('Playhead visible during native trim',white,len(rows))
            user.mouse_event(4,0,0,0,0);native_mouse_held=False
            expect(editor.locator('.video-filmstrip__playhead')).to_be_visible()
            boundary=float(handle.input_value())
            assert abs(boundary-value)>.1,(name,value,boundary)
            assert abs(boundary-duration*fraction)<.04,(name,boundary,duration*fraction)
            assert abs(editor.locator('video').evaluate('v=>v.currentTime')-boundary)<.03
            editor.wait_for_function('target=>window.qaPresentedFrame!==null&&!document.querySelector("video").seeking&&Math.abs(qaPresentedFrame-target)<.15',arg=boundary)
            presented=editor.evaluate('window.qaPresentedFrame')
            editor.evaluate('document.querySelector("video").cancelVideoFrameCallback(window.qaFrameWatch)')
            assert abs(presented-boundary)<.15,(name,presented,boundary)
            editor.wait_for_timeout(350)  # Include the decoder's delayed timeupdate.
            assert editor.locator('.video-filmstrip').evaluate('el=>getComputedStyle(el).getPropertyValue("--play-position")')==saved_cursor,'Trim moved the playback cursor'
            editor.screenshot(path=str(OUT/('trim-start-released.png' if name=='Начало фрагмента' else 'trim-end-released.png')))
            frame=editor.locator('.video-filmstrip__selection').bounding_box()
            start_value=float(editor.get_by_role('slider',name='Начало фрагмента',exact=True).input_value())
            end_value=float(editor.get_by_role('slider',name='Конец фрагмента',exact=True).input_value())
            assert abs(frame['x']-(tx+thumb_width+(timeline['width']-thumb_width)*start_value/duration))<1
            assert abs(frame['x']+frame['width']-(tx+(timeline['width']-thumb_width)*end_value/duration))<1
        results['trimHandleGeometry']=True;results['playheadHiddenWhileTrimming']=True;results['playheadPreservedAfterTrim']=True
        editor.get_by_role('button',name='Воспроизвести',exact=True).click()
        editor.wait_for_timeout(150)
        resumed=editor.locator('video').evaluate('v=>v.currentTime')
        assert saved_position<=resumed<saved_position+.5,(saved_position,resumed)
        editor.get_by_role('button',name='Пауза',exact=True).click()
        results['playbackResumesAtSavedCursor']=True
        # A cursor outside the new selection stays put until Play starts at its beginning.
        editor.wait_for_timeout(350)  # Let the normal pause timeupdate settle first.
        outside_cursor=editor.locator('.video-filmstrip').evaluate('el=>getComputedStyle(el).getPropertyValue("--play-position")')
        new_start=float(editor.get_by_role('slider',name='Начало фрагмента',exact=True).input_value())
        editor.get_by_role('spinbutton',name='Конец фрагмента, секунды').fill(str(new_start+.3))
        editor.wait_for_timeout(350)
        assert editor.locator('.video-filmstrip').evaluate('el=>getComputedStyle(el).getPropertyValue("--play-position")')==outside_cursor
        editor.get_by_role('button',name='Воспроизвести',exact=True).click()
        editor.wait_for_timeout(100)
        assert new_start<=editor.locator('video').evaluate('v=>v.currentTime')<new_start+.4
        if editor.get_by_role('button',name='Пауза',exact=True).count():editor.get_by_role('button',name='Пауза',exact=True).click()
        results['playbackOutsideSelectionStartsAtBeginning']=True
        editor.get_by_role('spinbutton',name='Начало фрагмента, секунды').fill('0.5')
        editor.get_by_role('spinbutton',name='Конец фрагмента, секунды').fill('2.5')
        editor.get_by_role('button',name='Обрезать кадр',exact=True).click()
        for handle,cursor in [('nw','nwse-resize'),('n','ns-resize'),('ne','nesw-resize'),('e','ew-resize'),('se','nwse-resize'),('s','ns-resize'),('sw','nesw-resize'),('w','ew-resize')]:
            assert editor.locator(f'[data-handle={handle}]').evaluate('el=>getComputedStyle(el).cursor')==cursor,(handle,cursor)
        results['cropResizeCursors']=True
        editor.locator('[data-handle=se]').press('Shift+ArrowLeft')
        assert editor.locator('.video-crop__dimensions').inner_text().startswith(str(WIDTH-10))
        expect(editor.get_by_role('button',name='Сохранить MP4',exact=True)).to_be_disabled()
        editor.screenshot(path=str(OUT/'crop-confirmation.png'))
        editor.get_by_role('button',name='Применить обрезку',exact=True).click()
        expect(editor.locator('.video-crop-applied')).to_contain_text(f'{WIDTH-10} × {HEIGHT}')
        assert editor.locator('.video-crop').count()==0
        assert editor.locator('video').evaluate('v=>v.style.transform').startswith('translate(')
        editor.get_by_role('button',name='Изменить обрезку',exact=True).click()
        editor.locator('[data-handle=se]').press('Shift+ArrowLeft')
        editor.get_by_role('button',name='Отменить обрезку',exact=True).click()
        expect(editor.locator('.video-crop-applied')).to_contain_text(f'{WIDTH-10} × {HEIGHT}')
        editor.screenshot(path=str(OUT/'editor-dark.png'))
        # Real native trim/crop and audio preservation, then decode the produced file.
        opts={'startMs':500,'endMs':2500,'x':40,'y':20,'width':min(480,WIDTH-40),'height':min(300,HEIGHT-20),'format':'mp4','quality':'small','gifWidth':640,'gifFps':10}
        mp4=OUT/'trimmed.mp4';invoke(editor,'snipcast_video_export',{'path':str(mp4),'options':opts})
        decoded=decode_video(editor,mp4);results['mp4']={**decoded,'bytes':mp4.stat().st_size}
        assert (decoded['width'],decoded['height'])==(opts['width'],opts['height']),decoded
        assert 1.8<decoded['duration']<2.25,decoded
        assert abs(decoded['pixel'][0]-233)<25 and abs(decoded['pixel'][1]-83)<25,decoded
        assert abs(decoded['bottom'][0]-55)<25 and abs(decoded['bottom'][1]-217)<25,decoded
        # Frame inside the controller's location still shows the underlying fixture.
        excluded=decode_video(editor,mp4,1.7);assert abs(excluded['pixel'][0]-233)<25 and abs(excluded['pixel'][1]-83)<25,excluded
        results['controllerExcluded']=True
        # Compare full frames, not two flat-color pixels: this catches row-pitch
        # corruption that can leave individual sampled pixels accidentally valid.
        original=av.open(str(OUT/'capture-cache'/f"video-{st['id']}.mp4"))
        original_frame=next(f for f in original.decode(video=0) if float(f.time)>=.5).to_ndarray(format='rgb24')
        original.close()
        expected=original_frame[opts['y']:opts['y']+opts['height'],opts['x']:opts['x']+opts['width']].astype(float)
        exported=av.open(str(mp4));exported_frame=next(exported.decode(video=0)).to_ndarray(format='rgb24');exported.close()
        results['mp4FrameMAE']=float(np.abs(exported_frame.astype(float)-expected).mean())
        assert results['mp4FrameMAE']<10,results['mp4FrameMAE']
        results['audio']=editor.evaluate('''async url=>{const context=new AudioContext();try{const bytes=await(await fetch(url)).arrayBuffer();const a=await context.decodeAudioData(bytes);return{channels:a.numberOfChannels,duration:a.duration,sampleRate:a.sampleRate};}finally{await context.close();}}''',f'http://127.0.0.1:{server.server_port}/{mp4.name}')
        assert results['audio']['channels']==2 and 1.7<results['audio']['duration']<2.25,results['audio']
        # GIF has an adaptive palette, coalesces repeated frames, and loops.
        gif=OUT/'trimmed.gif';invoke(editor,'snipcast_video_export',{'path':str(gif),'options':{**opts,'format':'gif','gifWidth':480}})
        im=Image.open(gif);gif_info={'dimensions':im.size,'frames':im.n_frames,'loop':im.info.get('loop'),'bytes':gif.stat().st_size}
        milliseconds=0
        for n in range(im.n_frames):im.seek(n);milliseconds+=im.info.get('duration',0)
        gif_info['durationMs']=milliseconds;results['gif']=gif_info
        assert im.size==(opts['width'],opts['height']) and im.n_frames>=2,gif_info
        im.seek(0);gif_pixels=np.asarray(im.convert('RGB')).astype(float)
        results['gifFrameMAE']=float(np.abs(gif_pixels-expected).mean());assert results['gifFrameMAE']<10,results['gifFrameMAE']
        assert 1800<=milliseconds<=2200,gif_info
        assert gif_info['loop']==0,gif_info
        # Cancel an actual native encoder and preserve an existing destination.
        cancelled=OUT/'cancelled.gif';cancelled.write_bytes(b'previous GIF')
        cancel_result=editor.evaluate('''async([path,options])=>{
          const invoke=window.__TAURI_INTERNALS__.invoke;let settled=false;
          const pending=invoke('snipcast_video_export',{path,options}).then(()=>{settled=true;return{ok:true};},e=>{settled=true;return{ok:false,error:String(e)};});
          for(let n=0;n<100&&!settled;n++){const st=await invoke('snipcast_video_status');if(st.phase==='exporting'){await invoke('snipcast_video_cancel_export');break;}await new Promise(r=>setTimeout(r,1));}
          return await pending;
        }''',[str(cancelled),{**opts,'startMs':0,'endMs':st['durationMs'],'format':'gif','gifWidth':960,'gifFps':15}])
        assert not cancel_result['ok'] and 'отменено' in cancel_result['error'],cancel_result
        assert cancelled.read_bytes()==b'previous GIF' and not list(OUT.glob('.snipcast-video-*'))
        results['cancelExport']=cancel_result
        # Failed output never overwrites an existing file and returns to editing.
        preserved=OUT/'preserved.mp4';preserved.write_bytes(b'previous contents')
        failed=editor.evaluate('''([path,options])=>window.__TAURI_INTERNALS__.invoke('snipcast_video_export',{path,options}).then(()=>false,()=>true)''',[str(preserved),{**opts,'endMs':999999}])
        assert failed and preserved.read_bytes()==b'previous contents'
        assert invoke(editor,'snipcast_video_status')['phase']=='editing'
        # Native dialog cancellation makes no writes; interact with the actual dialog.
        editor.get_by_role('button',name='Сбросить обрезку',exact=True).click()
        editor.get_by_role('button',name='Сохранить MP4',exact=True).click(no_wait_after=True)
        dialog=native_save_dialog()
        user.PostMessageW(ctypes.c_void_p(dialog),0x0010,0,0)
        expect(editor.get_by_role('button',name='Сохранить MP4',exact=True)).to_be_enabled(timeout=10000)
        assert invoke(editor,'snipcast_video_status')['phase']=='editing'
        invoke(main,'snipcast_save_config',{'incoming':{**invoke(main,'snipcast_get_config'),'theme':'light'}})
        editor.evaluate("document.documentElement.dataset.appTheme='light'")
        editor.screenshot(path=str(OUT/'editor-light.png'))
        assert not errors,errors
        results['pageErrors']=errors;results['version']=invoke(main,'snipcast_get_version')
        editor.get_by_role('button',name='Обрезать кадр',exact=True).click()
        editor.locator('[data-handle=se]').press('Shift+ArrowLeft')
        editor.get_by_role('button',name='Применить обрезку',exact=True).click()
        # Save through the delivered UI and actual Windows dialog: only the
        # confirmed crop must reach the encoder, with the selected time range.
        ui_mp4=OUT/'ui-applied-crop.mp4'
        editor.get_by_role('button',name='Сохранить MP4',exact=True).click(no_wait_after=True)
        dialog=native_save_dialog();edits=[]
        callback_type=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
        def collect_filename(hwnd,_):
            class_name=ctypes.create_unicode_buffer(256);user.GetClassNameW(hwnd,class_name,256)
            if class_name.value=='Edit' and user.GetDlgCtrlID(hwnd)==1001:edits.append(hwnd)
            return True
        user.EnumChildWindows(ctypes.c_void_p(dialog),callback_type(collect_filename),0)
        assert len(edits)==1,('Filename edit control',edits)
        user.SendMessageW(ctypes.c_void_p(edits[0]),0x000C,0,ctypes.c_wchar_p(str(ui_mp4)))
        user.PostMessageW(ctypes.c_void_p(dialog),0x0111,1,0)
        for _ in range(200):
            if editor.is_closed():break
            main.wait_for_timeout(100)
        assert editor.is_closed(),'Editor remained open after successful Save'
        results['editorClosedAfterSave']=True
        ui_decoded=decode_video(main,ui_mp4)
        assert (ui_decoded['width'],ui_decoded['height'])==(WIDTH-10,HEIGHT),ui_decoded
        assert 1.8<ui_decoded['duration']<2.25,ui_decoded
        results['confirmedCropUiExport']=ui_decoded
        main.wait_for_timeout(300)
        assert not list((OUT/'capture-cache').glob('video-*.mp4')),'Temporary video left after editor close'
        # Closing frozen selection WebViews for memory must not break the next capture.
        invoke(main,'snipcast_video_select');again=find(ctx,'.capture--presented')
        assert invoke(again,'snipcast_capture_info')['videoSelection']
        again.keyboard.press('Escape');main.wait_for_timeout(200)
        results['nextSelection']=True
        # A second real recording shows the delivered editor with actual Snipcast UI.
        main.evaluate("clearInterval(window.qaMotion);document.querySelector('#record-fixture').remove()")
        invoke(main,'snipcast_save_config',{'incoming':{**invoke(main,'snipcast_get_config'),'theme':'dark'}})
        invoke(main,'plugin:window|show',{'label':label});invoke(main,'plugin:window|set_focus',{'label':label})
        invoke(main,'snipcast_start_screenshot');demo=find(ctx,'.capture--presented')
        dinfo=invoke(demo,'snipcast_capture_info');invoke(demo,'plugin:window|set_focus',{'label':dinfo['label']});demo.wait_for_timeout(300)
        demo.mouse.move(*a);demo.mouse.down();demo.mouse.move(*b,steps=8);demo.mouse.up()
        buttons=demo.locator('.capture__toolbar button').all_text_contents()
        video_index=next(i for i,t in enumerate(buttons) if 'Видео' in t)
        assert 'Сохранить' in buttons[video_index+1],buttons
        assert 'V' in buttons[video_index],buttons
        demo.screenshot(path=str(OUT/'toolbar-video-v.png'))
        demo.keyboard.press('v');demo_control=find(ctx,'.video-record');wait_phase(demo_control,'recording')
        demo_control.wait_for_timeout(1500);demo_control.get_by_role('button',name='Завершить',exact=True).click()
        demo_editor=find(ctx,'.video-editor');demo_status=wait_phase(demo_editor,'editing')
        assert not demo_status['audio'] and demo_status['frames']>10,demo_status
        demo_editor.wait_for_function("document.querySelectorAll('.video-filmstrip img').length===8",timeout=15000)
        demo_editor.screenshot(path=str(OUT/'editor-interface.png'))
        results['silentRecording']=demo_status
        # Text/interface footage and the exact tiny MP4 dimensions reported by
        # the user exercise both padded input surfaces and cropped output rows.
        source=av.open(str(OUT/'capture-cache'/f"video-{demo_status['id']}.mp4"))
        source_frame=next(source.decode(video=0)).to_ndarray(format='rgb24').astype(float);source.close()
        actual_opts={**opts,'startMs':0,'endMs':demo_status['durationMs'],'x':0,'y':0,'width':WIDTH,'height':HEIGHT,'format':'gif','gifWidth':960}
        actual_gif=OUT/'actual-interface.gif'
        invoke(demo_editor,'snipcast_video_export',{'path':str(actual_gif),'options':actual_opts})
        actual_image=Image.open(actual_gif)
        assert actual_image.size==(WIDTH,HEIGHT),actual_image.size
        results['interfaceGifFrameMAE']=float(np.abs(np.asarray(actual_image.convert('RGB')).astype(float)-source_frame).mean())
        assert results['interfaceGifFrameMAE']<10,results['interfaceGifFrameMAE']
        small_opts={**actual_opts,'format':'mp4','x':40,'y':20,'width':80,'height':72}
        small_mp4=OUT/'small-crop.mp4'
        invoke(demo_editor,'snipcast_video_export',{'path':str(small_mp4),'options':small_opts})
        small_source=av.open(str(small_mp4));small_frame=next(small_source.decode(video=0)).to_ndarray(format='rgb24');small_source.close()
        assert small_frame.shape[:2]==(72,80),small_frame.shape
        results['smallMp4FrameMAE']=float(np.abs(small_frame.astype(float)-source_frame[20:92,40:120]).mean())
        assert results['smallMp4FrameMAE']<10,results['smallMp4FrameMAE']
        demo_editor.get_by_role('button',name='GIF',exact=True).click()
        demo_editor.get_by_role('combobox',name='Ширина GIF').click()
        demo_editor.get_by_role('option',name='480',exact=True).click()
        demo_editor.get_by_role('combobox',name='Частота GIF').click()
        demo_editor.get_by_role('option',name='10 кадров/с',exact=True).click()
        save_button=demo_editor.get_by_role('button',name='Сохранить GIF',exact=True)
        save_button.hover();demo_editor.wait_for_timeout(300)
        expect(demo_editor.get_by_role('menu',name='Быстрые места сохранения')).to_be_visible()
        demo_editor.get_by_role('menuitem',name='QA folder',exact=False).hover();demo_editor.wait_for_timeout(200)
        assert not list((OUT/'quick-saves').iterdir()),'Hover unexpectedly saved the video'
        demo_editor.mouse.move(10,10);demo_editor.wait_for_timeout(200)
        expect(demo_editor.get_by_role('menu',name='Быстрые места сохранения')).to_be_hidden()
        results['hoverQuickSaveMenu']=True
        def hold_save():
            rect=save_button.bounding_box();demo_editor.mouse.move(rect['x']+rect['width']/2,rect['y']+rect['height']/2);demo_editor.mouse.down();demo_editor.wait_for_timeout(350)
            expect(demo_editor.get_by_role('menu',name='Быстрые места сохранения')).to_be_visible()
        hold_save();demo_editor.screenshot(path=str(OUT/'quick-save-menu.png'))
        demo_editor.mouse.move(10,10);demo_editor.mouse.up()
        assert not list((OUT/'quick-saves').iterdir()) and not demo_editor.is_closed()
        hold_save();bad=demo_editor.get_by_role('menuitem',name='Missing folder',exact=False).bounding_box()
        demo_editor.mouse.move(bad['x']+20,bad['y']+bad['height']/2);demo_editor.mouse.up()
        expect(demo_editor.get_by_role('alert')).to_contain_text('Папка сохранения не найдена')
        assert not demo_editor.is_closed()
        hold_save();good=demo_editor.get_by_role('menuitem',name='QA folder',exact=False).bounding_box()
        demo_editor.mouse.move(good['x']+20,good['y']+good['height']/2);demo_editor.mouse.up()
        for _ in range(200):
            if demo_editor.is_closed():break
            main.wait_for_timeout(100)
        assert demo_editor.is_closed(),'Editor remained open after quick Save'
        quick_files=list((OUT/'quick-saves').glob('*.gif'));assert len(quick_files)==1,quick_files
        assert Image.open(quick_files[0]).size==(min(WIDTH,480),HEIGHT*min(WIDTH,480)//WIDTH)
        results['quickSaveClosedEditor']=True;results['quickSaveFile']=str(quick_files[0])
        main.wait_for_timeout(250)
        assert not list((OUT/'capture-cache').glob('video-*.mp4'))
        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(results,ensure_ascii=False,indent=2))
finally:
    if native_mouse_held:ctypes.windll.user32.mouse_event(4,0,0,0,0)
    children=psutil.Process(proc.pid).children(recursive=True) if proc.poll() is None else []
    if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
    for child in children:
        try:child.terminate()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(children,timeout=3)
    for key in [0x7A,0x7B]:ctypes.windll.user32.keybd_event(key,ctypes.windll.user32.MapVirtualKeyW(key,0),2,0)
    server.shutdown();log.close()
