"""Real pin menu, clipboard and annotation in an isolated Windows/WebView2 instance.

Build debug with TAURI_CONFIG={"identifier":"com.snipcast.selection-qa"} first.
"""
import ctypes
from ctypes import wintypes
import base64
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
from PIL import Image, ImageDraw, ImageGrab
from playwright.sync_api import sync_playwright, expect
from capture_text import drag

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('SNIPCAST_QA_OUT',str(ROOT / '.qa-work' / 'pin-annotation-native')))
PORT = 9243
OUT.mkdir(parents=True, exist_ok=True)
source=Path(os.environ['SNIPCAST_QA_EXE']) if os.environ.get('SNIPCAST_QA_EXE') else ROOT/'src-tauri/target/debug/snipcast.exe'
shutil.copy2(source,OUT/'pin-qa.exe')
cfg = {'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark',
       'paletteListDensity':'normal','screenshotFormat':'png','screenshotJpegQuality':90,
       'screenshotFileTemplate':'qa {n}','screenshotSaveDir':str(OUT),'screenshotQuickLocations':[{'name':'QA','path':str(OUT/'quick')}],
       'screenshotOcrEngine':'system','screenshotOcrLanguage':'auto','screenshotOcrQuality':'mobile',
       'screenshotPresets':[],'apiEnabled':False,'apiPort':52393,'aiApiKey':'','aiModel':''}
(OUT/'config.json').write_text(json.dumps(cfg), encoding='utf8')
image = Image.new('RGB', (640,400), (18,52,86))
draw = ImageDraw.Draw(image)
draw.rectangle((0,0,20,20), fill=(20,220,80))
draw.rectangle((619,379,639,399), fill=(80,20,220))
buf = io.BytesIO(); image.save(buf, format='PNG')
png = base64.b64encode(buf.getvalue()).decode()

def invoke(page, cmd, args=None):
    return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)', [cmd,args or {}])

def find_page(context, selector):
    for _ in range(100):
        for page in context.pages:
            try:
                if page.locator(selector).count(): return page
            except Exception: pass
        time.sleep(.1)
    raise AssertionError('No native page: '+selector)

def wait_visible(page):
    label=page.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
    for _ in range(100):
        if invoke(page,'plugin:window|is_visible',{'label':label}):return
        page.wait_for_timeout(20)
    raise AssertionError('decoded pin did not become visible')

def backing_image(page):
    info = invoke(page, 'snipcast_pin_info')
    raw = page.evaluate('(name)=>window.__TAURI_INTERNALS__.invoke("snipcast_capture_image_data",{name}).then(buf=>Array.from(new Uint8Array(buf)))', info['imageName'])
    return Image.open(io.BytesIO(bytes(raw))).convert('RGB')

def save_dialog(path=None):
    user=ctypes.windll.user32
    user.SendMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
    user.GetDlgCtrlID.argtypes=[wintypes.HWND]
    callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    dialogs=[]
    def collect(hwnd,_):
        pid=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
        name=ctypes.create_unicode_buffer(128);user.GetClassNameW(hwnd,name,128)
        if pid.value==proc.pid and name.value=='#32770' and user.IsWindowVisible(hwnd):dialogs.append(hwnd)
        return True
    for _ in range(100):
        user.EnumWindows(callback_type(collect),0)
        if dialogs:break
        time.sleep(.05)
    assert dialogs,'No native Save dialog'
    dialog=dialogs[0]
    if path is None:
        user.PostMessageW(wintypes.HWND(dialog),0x111,2,0)
        return
    edits=[]
    def child(hwnd,_):
        name=ctypes.create_unicode_buffer(128);user.GetClassNameW(hwnd,name,128)
        if name.value=='Edit' and user.GetDlgCtrlID(hwnd)==1001:edits.append(hwnd)
        return True
    user.EnumChildWindows(wintypes.HWND(dialog),callback_type(child),0)
    assert edits,'No file name field'
    name=ctypes.create_unicode_buffer(str(path))
    user.SendMessageW(wintypes.HWND(edits[0]),0xC,0,ctypes.cast(name,ctypes.c_void_p).value)
    user.PostMessageW(wintypes.HWND(dialog),0x111,1,0)

with (OUT/'process.log').open('w',encoding='utf8') as log:
    proc = subprocess.Popen([str(OUT/'pin-qa.exe')], env={**os.environ,
        'SNIPCAST_DATA_DIR':str(OUT), 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'}, stdout=log,stderr=log)
try:
    for _ in range(100):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close(); break
        except OSError:
            assert proc.poll() is None, 'QA instance exited; check its identifier'
            time.sleep(.1)
    else: raise AssertionError('No WebView2 endpoint')
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
        context = browser.contexts[0]
        main = find_page(context,'body.settings-body')
        invoke(main,'snipcast_capture_pin',{'png':png,'x':120,'y':160,'width':640,'height':400})
        pin = find_page(context,'.pin'); pin.set_default_timeout(5000)
        pin.locator('.pin__shot').wait_for()
        wait_visible(pin)
        errors=[];pin.on('pageerror',lambda e:errors.append(str(e)))
        geometry=lambda: [invoke(pin,'plugin:window|outer_position',{'label':pin.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')}),invoke(pin,'plugin:window|outer_size',{'label':pin.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')})]
        original = geometry()
        expect(pin.locator('.pin')).to_have_class('pin pin--selected')
        label=pin.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
        for _ in range(100):
            if invoke(pin,'plugin:window|is_visible',{'label':label}):break
            main.wait_for_timeout(20)
        assert invoke(pin,'plugin:window|is_visible',{'label':label})
        invoke(pin,'plugin:window|hide',{'label':label})
        invoke(pin,'snipcast_pin_ready');invoke(pin,'snipcast_pin_ready')
        assert not invoke(pin,'plugin:window|is_visible',{'label':label}),'repeat readiness reshowed an existing hidden pin'
        invoke(pin,'plugin:window|show',{'label':label})
        label2=invoke(main,'snipcast_capture_pin',{'png':png,'x':950,'y':160,'width':320,'height':200})
        for _ in range(100):
            second=None
            for pg in context.pages:
                try:
                    if pg.evaluate('window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label')==label2:second=pg;break
                except Exception:pass
            if second and second.locator('.pin').count():break
            pin.wait_for_timeout(50)
        wait_visible(second)
        expect(second.locator('.pin')).to_have_class('pin pin--selected')
        expect(pin.locator('.pin')).to_have_class('pin')
        second.locator('.pin__shot').wait_for();pin.wait_for_timeout(150)
        invoke(pin,'plugin:window|set_focus',{'label':label})
        expect(pin.locator('.pin')).to_have_class('pin pin--selected')
        expect(second.locator('.pin')).to_have_class('pin')
        invoke(main,'plugin:window|show',{'label':'settings'})
        invoke(main,'plugin:window|set_focus',{'label':'settings'})
        expect(pin.locator('.pin')).to_have_class('pin')
        invoke(pin,'plugin:window|set_focus',{'label':label})
        pin.mouse.click(80,80,button='right')
        menu=find_page(context,'.pinmenu')
        expect(menu.get_by_role('button')).to_have_count(4)
        expect(menu.locator('.pinmenu__item svg')).to_have_count(4)
        expect(pin.locator('.pin')).to_have_class('pin pin--selected')
        menu.screenshot(path=str(OUT/'menu.png'))
        menu.get_by_role('button',name='Копировать',exact=True).click()
        for _ in range(200):
            visible=main.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'pinmenu'}).catch(()=>false)")
            if not visible:break
            main.wait_for_timeout(50)
        assert not visible,'menu copy did not complete'
        copied=ImageGrab.grabclipboard()
        assert isinstance(copied,Image.Image) and copied.size==(640,400), str(type(copied))+str(getattr(copied,'size',None))
        assert copied.convert('RGB').tobytes()==image.tobytes()
        pin.mouse.click(90,90,button='right')
        menu=find_page(context,'.pinmenu')
        menu.get_by_role('button',name='Аннотировать',exact=True).click()
        pin.locator('.capture--pin-editor').wait_for()
        box=pin.locator('.capture__shot').bounding_box()
        x,y,w,h=[box[k] for k in ('x','y','width','height')]
        pos,size=geometry();dpr=pin.evaluate('devicePixelRatio')
        assert abs(pos['x']+x*dpr-120)<1 and abs(pos['y']+y*dpr-160)<1,(pos,box)
        assert round(w*dpr)==640 and round(h*dpr)==400
        shot=Image.open(io.BytesIO(pin.screenshot(omit_background=True))).convert('RGBA')
        assert shot.getpixel((0,0))[3]==0
        user=ctypes.windll.user32;gdi=ctypes.windll.gdi32
        user.GetWindowRgn.argtypes=[wintypes.HWND,wintypes.HRGN]
        gdi.CreateRectRgn.restype=wintypes.HRGN;gdi.PtInRegion.argtypes=[wintypes.HRGN,ctypes.c_int,ctypes.c_int]
        gdi.DeleteObject.argtypes=[wintypes.HANDLE]
        region=gdi.CreateRectRgn(0,0,0,0);matches=[]
        @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        def collect(hwnd,_):
            pid=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid));rect=wintypes.RECT();user.GetWindowRect(hwnd,ctypes.byref(rect))
            if pid.value==proc.pid and rect.left==pos['x'] and rect.top==pos['y']:matches.append(hwnd)
            return True
        user.EnumWindows(collect,0);assert matches
        for _ in range(40):
            kind=user.GetWindowRgn(matches[0],region)
            if kind==3:break
            pin.wait_for_timeout(50)
        assert kind==3,'native editor must use a union region'
        toolbar=pin.locator('.capture__toolbar').bounding_box()
        tx=round((toolbar['x']+toolbar['width']/2)*dpr)
        ty=round((toolbar['y']+toolbar['height']+35)*dpr)
        assert ty<size['height'] and gdi.PtInRegion(region,tx,ty),'toolbar shadow is clipped by native window/region'
        assert gdi.PtInRegion(region,round((x+w/2)*dpr),round((y+h/2)*dpr))
        assert not gdi.PtInRegion(region,1,size['height']-2),'empty editor surroundings must not intercept the desktop'
        gdi.DeleteObject(region)
        pin.get_by_title('Нарисовать линию (2)',exact=True).click()
        drag(pin,(x+w*.2,y+h*.25),(x+w*.65,y+h*.55))
        pin.keyboard.press('4')
        center=(x+w*.8,y+h*.3)
        points=[(round(center[0]+30*math.cos(i/10)),round(center[1]+30*math.sin(i/10))) for i in range(64)]
        pin.mouse.move(*points[0]);pin.mouse.down()
        for point in points[1:]:pin.mouse.move(*point);pin.wait_for_timeout(5)
        pin.wait_for_timeout(30)
        ink=pin.locator('.capture__shapes--draft').evaluate('el=>el.toDataURL()')
        draft=Image.open(io.BytesIO(base64.b64decode(ink.split(',')[1]))).convert('RGBA')
        coverage={color[3] for color in draft.get_flattened_data()}
        assert len(coverage)>32,('native freehand aliasing',len(coverage))
        draft.save(OUT/'native-smooth-stroke.png')
        pin.mouse.up();pin.wait_for_timeout(50)
        committed=pin.locator('.capture__shapes').first
        circle=committed.evaluate('el=>el.toDataURL()')
        pin.keyboard.press('Control+z');pin.wait_for_timeout(40)
        assert committed.evaluate('el=>el.toDataURL()')!=circle,'one undo must remove the entire freehand stroke'
        pin.keyboard.press('Control+Shift+z');pin.wait_for_timeout(40)
        assert committed.evaluate('el=>el.toDataURL()')==circle,'redo changed the displayed freehand geometry'
        # The Shift prefix stays exactly straight; releasing Shift continues
        # from its endpoint. Both parts still belong to a single history step.
        pin.mouse.move(x+60,y+300);pin.mouse.down();pin.keyboard.down('Shift')
        pin.mouse.move(x+180,y+305);pin.wait_for_timeout(40)
        pin.keyboard.up('Shift');pin.mouse.move(x+210,y+340);pin.wait_for_timeout(40);pin.mouse.up()
        assert committed.evaluate('el=>el.toDataURL()')!=circle
        pin.keyboard.press('Control+z');pin.wait_for_timeout(40)
        assert committed.evaluate('el=>el.toDataURL()')==circle,'Shift continuation split the stroke history'
        pin.get_by_title('Добавить текст (5)',exact=True).click()
        pin.mouse.click(x+w*.3,y+h*.7)
        pin.locator('.capture__text-edit').fill('Закреп QA')
        editor=pin.locator('.capture__text-edit');font=float(editor.evaluate('el=>getComputedStyle(el).fontSize').replace('px',''))
        pin.mouse.move(x+w*.3+5,y+h*.7+5);pin.mouse.wheel(0,-120);pin.wait_for_timeout(50)
        assert float(editor.evaluate('el=>getComputedStyle(el).fontSize').replace('px',''))==font+1
        pin.get_by_title('Копировать в буфер обмена',exact=True).click()
        expect(pin.locator('.capture__toast')).to_be_visible()
        expected=ImageGrab.grabclipboard().convert('RGB')
        assert expected.size==(640,400)
        user=ctypes.windll.user32
        assert user.OpenClipboard(None);user.EmptyClipboard();user.CloseClipboard()
        pin.keyboard.press('c')
        for _ in range(100):
            copied=ImageGrab.grabclipboard()
            if isinstance(copied,Image.Image):break
            pin.wait_for_timeout(30)
        assert isinstance(copied,Image.Image),'C did not copy image to Windows clipboard'
        assert copied.convert('RGB').tobytes()==expected.tobytes()
        pin.get_by_title('Сохранить как файл',exact=True).click()
        save_dialog(OUT/'annotation.png')
        expect(pin.get_by_role('status')).to_contain_text('Сохранено в файл')
        exported_file=Image.open(OUT/'annotation.png').convert('RGB')
        assert exported_file.tobytes()==expected.tobytes(),'Saved PNG differs from clipboard'
        assert backing_image(pin).tobytes()==image.tobytes(),'Export changed pinned source before Apply'
        pin.keyboard.press('Enter');save_dialog()
        expect(pin.get_by_title('Сохранить как файл',exact=True)).to_be_enabled()
        assert pin.locator('.capture--pin-editor').count()==1
        pin.get_by_title('Нарисовать стрелку (1)',exact=True).click()
        pin.get_by_title('Нарисовать стрелку (1)',exact=True).click()
        expect(pin.locator('.capture__opts')).to_have_count(0)
        pin.wait_for_timeout(500)
        button=pin.get_by_title('Сохранить как файл',exact=True);b=button.bounding_box()
        pin.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2);pin.mouse.down()
        quick=pin.locator('.capture__quick-item');quick.wait_for();pin.wait_for_timeout(150);q=quick.bounding_box()
        quick_region=gdi.CreateRectRgn(0,0,0,0)
        user.GetWindowRgn(matches[0],quick_region)
        assert gdi.PtInRegion(quick_region,round((q['x']+q['width']/2)*dpr),round((q['y']+q['height']/2)*dpr)),'Quick save menu excluded from native mouse region'
        gdi.DeleteObject(quick_region)
        pin.mouse.move(q['x']+q['width']/2,q['y']+q['height']/2);pin.mouse.up()
        expect(pin.get_by_role('status')).to_contain_text('Сохранено: QA')
        quick_files=list((OUT/'quick').glob('*.png'));assert len(quick_files)==1
        assert Image.open(quick_files[0]).convert('RGB').tobytes()==expected.tobytes()
        pin.wait_for_timeout(400)
        stable_geometry=geometry();pin.wait_for_timeout(250)
        assert geometry()==stable_geometry,'Save toast keeps expanding native editor'
        assert stable_geometry[1]['height']<ctypes.windll.user32.GetSystemMetrics(1),'Editor expanded beyond monitor'
        pin.screenshot(path=str(OUT/'editor.png'))
        pin.get_by_role('button',name='Готово',exact=True).click()
        pin.locator('.pin').wait_for()
        saved=backing_image(pin)
        assert saved.size==(640,400)
        preview=Image.new('RGBA',draft.size,(18,52,86,255));preview.alpha_composite(draft)
        area=(round(center[0]-35),round(center[1]-35),round(center[0]+35),round(center[1]+35))
        rendered=preview.convert('RGB').crop(area)
        exported=saved.crop((area[0]-round(x),area[1]-round(y),area[2]-round(x),area[3]-round(y)))
        delta=max(abs(a-b) for pa,pb in zip(rendered.get_flattened_data(),exported.get_flattened_data()) for a,b in zip(pa,pb))
        assert delta<=3,('native preview/export differs',delta)
        assert saved.getpixel((1,1))==(20,220,80) and saved.getpixel((638,398))==(80,20,220)
        pixels=saved.get_flattened_data() if hasattr(saved,'get_flattened_data') else saved.getdata()
        assert sum(r>200 and g<140 and b<140 for r,g,b in pixels)>100
        assert geometry()==original,(geometry(),original)
        pin.mouse.click(80,80,button='right')
        find_page(context,'.pinmenu').get_by_role('button',name='Аннотировать',exact=True).click()
        pin.locator('.capture--pin-editor').wait_for()
        pin.get_by_role('button',name='Отмена',exact=True).click()
        pin.locator('.pin').wait_for()
        assert backing_image(pin).tobytes()==saved.tobytes()
        assert geometry()==original
        # Escape after the outline checkbox must leave its tool and then cancel.
        pin.mouse.click(80,80,button='right');find_page(context,'.pinmenu').get_by_role('button',name='Аннотировать',exact=True).click()
        pin.locator('.capture--pin-editor').wait_for();pin.keyboard.press('5')
        pin.get_by_role('checkbox',name='Обводка текста').check();pin.keyboard.press('Escape')
        expect(pin.locator('.capture__btn.is-active')).to_have_count(0)
        pin.keyboard.press('Escape');pin.locator('.pin').wait_for();assert geometry()==original
        pin.mouse.click(80,80,button='right');find_page(context,'.pinmenu')
        pin.wait_for_timeout(850)
        invoke(main,'plugin:window|show',{'label':'settings'})
        invoke(main,'plugin:window|set_focus',{'label':'settings'})
        expect(pin.locator('.pin')).to_have_class('pin')
        assert not errors,errors
        from native_tray import close_pins_from_tray
        close_pins_from_tray(proc,main,[label,label2],OUT)
        # Destroy the owner before its DOM acknowledges the transition. The
        # temporary desktop frame must not survive a closed pin window.
        invoke(main,'snipcast_capture_pin',{'png':png,'x':140,'y':160,'width':640,'height':400})
        pending=find_page(context,'.pin');pending.locator('.pin__shot').wait_for();pending.wait_for_timeout(100)
        invoke(pending,'snipcast_pin_begin_annotation')
        def covers():
            found=[]
            @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
            def collect(hwnd,_):
                owner=wintypes.DWORD();ctypes.windll.user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
                text=ctypes.create_unicode_buffer(256);ctypes.windll.user32.GetWindowTextW(hwnd,text,256)
                if owner.value==proc.pid and text.value=='Snipcast transition':found.append(hwnd)
                return True
            ctypes.windll.user32.EnumWindows(collect,0)
            return len(found)
        assert covers()==1,'pending transition cover missing'
        invoke(main,'snipcast_close_all_pins');main.wait_for_timeout(300)
        assert covers()==0,'closed pin left a transition cover on the desktop'
        print('PASS: native Save dialog/cancel, quick file save, C shortcut, exact PNG/clipboard pixels, context menu, annotations, geometry restoration, reopen/cancel, selected pins and native region')
finally:
    proc.terminate(); proc.wait(timeout=10)
