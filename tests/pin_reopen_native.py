"""Repeated annotation transitions in an isolated Windows/WebView2 instance."""
import base64, ctypes, io, json, os, shutil, subprocess, sys, time, urllib.request
from ctypes import wintypes
from pathlib import Path
from PIL import Image, ImageGrab, ImageChops
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/('pin-reopen-'+(sys.argv[1] if len(sys.argv)>1 else 'current'))
OUT.mkdir(parents=True,exist_ok=True)
source=Path(os.environ.get('SNIPCAST_QA_EXE',str(ROOT/'.qa-work/capture-035-native/native-qa.exe')))
shutil.copy2(source,OUT/'reopen-qa.exe')
(OUT/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'dark','apiEnabled':False,'screenshotPresets':[]}),encoding='utf8')
buf=io.BytesIO();Image.new('RGB',(640,400),(18,52,86)).save(buf,format='PNG');png=base64.b64encode(buf.getvalue()).decode()
user=ctypes.windll.user32
user.GetWindowLongPtrW.argtypes=[wintypes.HWND,ctypes.c_int];user.GetWindowLongPtrW.restype=ctypes.c_ssize_t
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find_page(context,selector):
    for _ in range(100):
        for page in context.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError((selector,[(p.url,p.locator('body').inner_text()[:200]) for p in context.pages]))
PORT=9255
log=(OUT/'process.log').open('w',encoding='utf8')
proc=subprocess.Popen([str(OUT/'reopen-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={PORT}'},stdout=log,stderr=log)
records=[]
try:
    for _ in range(100):
        try:urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3).close();break
        except OSError:assert proc.poll() is None;time.sleep(.1)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}');ctx=browser.contexts[0]
        main=find_page(ctx,'body.settings-body')
        # A static, contrasting desktop behind the pin makes the whole native
        # composition testable, including areas omitted by WebView screenshots.
        main_label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
        invoke(main,'plugin:window|set_position',{'label':main_label,'value':{'Physical':{'x':0,'y':0}}})
        invoke(main,'plugin:window|set_size',{'label':main_label,'value':{'Physical':{'width':user.GetSystemMetrics(0),'height':user.GetSystemMetrics(1)}}})
        main.evaluate('''()=>{const b=document.createElement('div');b.style.cssText='position:fixed;inset:0;z-index:2147483647;background:repeating-conic-gradient(#e95391 0% 25%,#37d9b0 0% 50%) 0 / 80px 80px;pointer-events:none';document.body.append(b)}''')
        invoke(main,'plugin:window|show',{'label':main_label})
        invoke(main,'plugin:window|set_focus',{'label':main_label})
        main.wait_for_timeout(300)
        background=ImageGrab.grab().convert('RGBA');background.save(OUT/'desktop-background.png')
        label=invoke(main,'snipcast_capture_pin',{'png':png,'x':140,'y':160,'width':640,'height':400})
        pin=find_page(ctx,'.pin');pin.locator('.pin__shot').wait_for()
        second_label=invoke(main,'snipcast_capture_pin',{'png':png,'x':960,'y':180,'width':320,'height':200})
        matches=[]
        @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        def collect(hwnd,_):
            pid=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
            if pid.value==proc.pid:
                r=wintypes.RECT();user.GetWindowRect(hwnd,ctypes.byref(r))
                if r.left==116 and r.top==136:matches.append(hwnd)
            return True
        user.EnumWindows(collect,0);assert len(matches)==1,matches;hwnd=matches[0]
        def geometry(target=hwnd):
            r=wintypes.RECT();user.GetWindowRect(target,ctypes.byref(r));pt=wintypes.POINT();user.ClientToScreen(target,ctypes.byref(pt))
            client=wintypes.RECT();user.GetClientRect(target,ctypes.byref(client))
            return {'hwnd':hex(target),'parent':hex(user.GetParent(target) or 0),'rect':[r.left,r.top,r.right,r.bottom],'clientRect':[client.left,client.top,client.right,client.bottom],'clientOffset':[pt.x-r.left,pt.y-r.top],'style':hex(user.GetWindowLongPtrW(target,-16)),'exStyle':hex(user.GetWindowLongPtrW(target,-20))}
        def compare_desktop(stage,owner=pin,target=hwnd):
            owner.mouse.move(5,5);owner.wait_for_timeout(120)
            g=geometry(target);r=g['rect'];margin=12
            area=(r[0]-margin,r[1]-margin,r[2]+margin,r[3]+margin)
            for settle in range(6):
                web=Image.open(io.BytesIO(owner.screenshot(omit_background=True))).convert('RGBA')
                expected=background.crop(area)
                expected.alpha_composite(web,(margin+g['clientOffset'][0],margin+g['clientOffset'][1]))
                actual=ImageGrab.grab(bbox=area).convert('RGBA')
                diff=ImageChops.difference(actual.convert('RGB'),expected.convert('RGB'))
                errors=[max(rgb) for rgb in diff.get_flattened_data()]
                bad=sum(v>24 for v in errors)
                if bad==0:break
                owner.wait_for_timeout(100) # permit the native compositor to present the new WebView frame
            actual.save(OUT/f'{stage}-desktop.png');expected.save(OUT/f'{stage}-expected.png');diff.save(OUT/f'{stage}-diff.png')
            records.append({'stage':stage,'desktopPixels':len(errors),'differentPixels':bad,'maxError':max(errors),'compositorRetries':settle,**g})
            if os.environ.get('SNIPCAST_QA_BASELINE')!='1':
                assert bad==0,('unexpected native composition',stage,bad,len(errors),max(errors))
                if os.environ.get('SNIPCAST_QA_ASSERT_FRAME')=='1':assert int(g['style'],16)&0x80000000,'WS_POPUP not retained'
        original=geometry();records.append({'stage':'initial',**original})
        children=[]
        @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        def child_record(child,_):
            children.append(geometry(child));return True
        user.EnumChildWindows(hwnd,child_record,0)
        (OUT/'hwnd-tree.json').write_text(json.dumps({'window':original,'children':children},indent=2),encoding='utf8')
        compare_desktop('initial')
        # This state transition rebuilds Tao's native styles. It must not
        # revive a caption even outside an annotation session.
        invoke(pin,'plugin:window|hide',{'label':label})
        pin.wait_for_timeout(120)
        behind=ImageGrab.grab(bbox=tuple(original['rect'])).convert('RGB')
        invoke(pin,'plugin:window|show',{'label':label})
        invoke(pin,'plugin:window|set_focus',{'label':label})
        user.RedrawWindow(hwnd,None,None,0x501) # RDW_FRAME | INVALIDATE | UPDATENOW
        pin.wait_for_timeout(200)
        g=geometry();records.append({'stage':'reshown',**g})
        visible=ImageGrab.grab(bbox=tuple(g['rect'])).convert('RGB');visible.save(OUT/'reshown.png')
        user.SendMessageW(hwnd,0x85,1,0) # WM_NCPAINT, entire non-client area
        user.SendMessageW(hwnd,0x86,1,0) # WM_NCACTIVATE
        compare_desktop('reshown-forced-frame')
        assert not (int(g['style'],16)&0x00C00000),'native caption returned on show'
        # Actual desktop pixels in the transparent top strip, rather than only
        # native flags or a screenshot of the WebView (which omits captions).
        errors=[max(abs(a-b) for a,b in zip(behind.getpixel((x,y)),visible.getpixel((x,y))))
                for x in range(50,visible.width-50) for y in range(1,6)]
        if os.environ.get('SNIPCAST_QA_BASELINE')!='1':assert max(errors)<=8,('native header painted over transparent pixels',max(errors))
        # Ordinary zoom and restoration can also rebuild native window styles.
        pos={'x':original['rect'][0],'y':original['rect'][1]}
        pin.mouse.move(160,160);pin.mouse.wheel(0,-120);pin.wait_for_timeout(120)
        compare_desktop('zoomed')
        assert not (int(geometry()['style'],16)&0x00C00000),'native caption returned after wheel zoom'
        pin.mouse.move(160,160);pin.mouse.wheel(0,120);pin.wait_for_timeout(120)
        invoke(pin,'plugin:window|set_size',{'label':label,'value':{'Physical':{'width':original['rect'][2]-pos['x'],'height':original['rect'][3]-pos['y']}}})
        invoke(pin,'plugin:window|set_position',{'label':label,'value':{'Physical':pos}})
        pin.wait_for_timeout(120)
        last_session=None
        for cycle in range(20):
            if cycle==10:
                cfg=invoke(main,'snipcast_get_config');cfg['theme']='light';invoke(main,'snipcast_save_config',{'incoming':cfg})
            pin.mouse.click(80,80,button='right');menu=find_page(ctx,'.pinmenu')
            menu.get_by_role('button',name='Аннотировать',exact=True).click();pin.locator('.capture--pin-editor').wait_for()
            pin.wait_for_timeout(120)
            if os.environ.get('SNIPCAST_QA_ASSERT_FRAME')=='1':
                session=invoke(pin,'snipcast_pin_begin_annotation')
                if last_session is not None:
                    assert invoke(pin,'snipcast_pin_regions',{'sessionId':last_session,'revision':0,'rects':[{'x':-500,'y':-500,'width':800,'height':800}]}) is None
                last_session=session['sessionId']
            box=pin.locator('.capture__shot').bounding_box();g=geometry();dpr=pin.evaluate('devicePixelRatio')
            records.append({'stage':'editor','cycle':cycle,**g})
            assert abs(g['rect'][0]+box['x']*dpr-140)<1 and abs(g['rect'][1]+box['y']*dpr-160)<1,(g,box)
            pin.keyboard.press(str(cycle%5+1))
            pin.locator('.capture__opts').wait_for()
            if cycle%5==4:pin.get_by_role('checkbox',name='Обводка текста').check()
            pin.wait_for_timeout(200)
            pin.screenshot(path=str(OUT/'editor-last.png'))
            g=geometry();box=pin.locator('.capture__shot').bounding_box()
            assert abs(g['rect'][0]+box['x']*dpr-140)<1 and abs(g['rect'][1]+box['y']*dpr-160)<1,(g,box)
            assert pin.locator('.capture').evaluate("el=>getComputedStyle(el).cursor")=='crosshair'
            records.append({'stage':'options','cycle':cycle,**g})
            user.RedrawWindow(hwnd,None,None,0x501)
            compare_desktop(f'editor-{cycle}')
            assert not (int(g['style'],16)&0x00C00000),'native caption style returned'
            pin.get_by_role('button',name='Готово' if cycle%2 else 'Отмена',exact=True).click();pin.locator('.pin').wait_for();pin.wait_for_timeout(120)
            g=geometry();records.append({'stage':'pin','cycle':cycle,**g})
            compare_desktop(f'pin-{cycle}')
            if cycle%5==0:
                invoke(pin,'plugin:window|hide',{'label':label});invoke(pin,'plugin:window|show',{'label':label})
                invoke(pin,'plugin:window|set_focus',{'label':label});user.RedrawWindow(hwnd,None,None,0x501)
                compare_desktop(f'cycle-{cycle}-reshown')
                pin.mouse.move(160,160);pin.mouse.wheel(0,-120);pin.wait_for_timeout(120)
                compare_desktop(f'cycle-{cycle}-zoomed')
                pin.mouse.move(160,160);pin.mouse.wheel(0,120);pin.wait_for_timeout(120)
                invoke(pin,'plugin:window|set_size',{'label':label,'value':{'Physical':{'width':original['rect'][2]-pos['x'],'height':original['rect'][3]-pos['y']}}})
                invoke(pin,'plugin:window|set_position',{'label':label,'value':{'Physical':pos}})
                pin.wait_for_timeout(120)
            if cycle in (0,4,19):ImageGrab.grab(bbox=tuple(g['rect'])).save(OUT/f'cycle-{cycle}.png')
            assert g['rect']==original['rect'],(cycle,g,original)
            assert not (int(g['style'],16)&0x00C00000),'native caption style returned'
            if os.environ.get('SNIPCAST_QA_ASSERT_FRAME')=='1':
                assert invoke(pin,'snipcast_pin_regions',{'sessionId':last_session,'revision':0,'rects':[]}) is None
            # Save all records even when the old binary reveals a frame offset.
        # A smaller second pin retains its on-screen scale through the same flow.
        second=next(pg for pg in ctx.pages if pg.evaluate("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label")==second_label)
        second_pos=invoke(second,'plugin:window|outer_position',{'label':second_label});second_hwnds=[]
        @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        def second_collect(target,_):
            pid=wintypes.DWORD();user.GetWindowThreadProcessId(target,ctypes.byref(pid))
            if pid.value==proc.pid and geometry(target)['rect'][:2]==[second_pos['x'],second_pos['y']]:second_hwnds.append(target)
            return True
        user.EnumWindows(second_collect,0);assert len(second_hwnds)==1,second_hwnds
        second_hwnd=second_hwnds[0]
        for cycle in range(3):
            second.mouse.click(50,50,button='right');find_page(ctx,'.pinmenu').get_by_role('button',name='Аннотировать',exact=True).click()
            second.locator('.capture--pin-editor').wait_for();second.keyboard.press('5');second.locator('.capture__opts').wait_for()
            second.get_by_role('checkbox',name='Обводка текста').check();second.wait_for_timeout(200)
            b=second.locator('.capture__shot').bounding_box();dpr=second.evaluate('devicePixelRatio')
            pos=invoke(second,'plugin:window|outer_position',{'label':second_label})
            assert abs(pos['x']+b['x']*dpr-960)<1 and abs(pos['y']+b['y']*dpr-180)<1
            assert round(b['width']*dpr)==320 and round(b['height']*dpr)==200
            compare_desktop(f'second-editor-{cycle}',second,second_hwnd)
            second.get_by_role('button',name='Отмена',exact=True).click();second.locator('.pin').wait_for()
            compare_desktop(f'second-pin-{cycle}',second,second_hwnd)
        (OUT/'results.json').write_text(json.dumps(records,indent=2),encoding='utf8')
        offsets=[r for r in records if r['clientOffset']!=original['clientOffset']]
        print(json.dumps({'cycles':20,'secondPinCycles':3,'initial':original,'frameChanges':offsets}))
        if os.environ.get('SNIPCAST_QA_ASSERT_FRAME')=='1':assert not offsets,offsets
finally:
    (OUT/'results.json').write_text(json.dumps(records,indent=2),encoding='utf8')
    proc.terminate();proc.wait(timeout=10);log.close()
