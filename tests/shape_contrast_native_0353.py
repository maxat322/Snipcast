import base64,datetime,io,json,os,shutil,subprocess,time,urllib.request
from pathlib import Path
from PIL import Image,ImageGrab
from playwright.sync_api import sync_playwright
root=Path.cwd();out=root/'.qa-work/shape-contrast-native';out.mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'src-tauri/target/debug/snipcast.exe',out/'native-qa.exe')
(out/'config.json').write_text(json.dumps({'paletteHotkey':'','screenshotHotkey':'','autostart':False,'theme':'light','apiEnabled':False,'screenshotPresets':[]}),encoding='utf8')
(out/'update-state.json').write_text(json.dumps({'lastAttempt':datetime.date.today().isoformat()}),encoding='utf8')
port=9260
proc=subprocess.Popen([str(out/'native-qa.exe')],env={**os.environ,'SNIPCAST_DATA_DIR':str(out),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={port}'})
def invoke(page,cmd,args=None):return page.evaluate('([cmd,args])=>window.__TAURI_INTERNALS__.invoke(cmd,args)',[cmd,args or {}])
def find(ctx,sel):
    for _ in range(100):
        for page in ctx.pages:
            try:
                if page.locator(sel).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError(sel)
def verify(page,context,theme):
    page.keyboard.press('3');page.locator('.capture__opts-shapes').wait_for()
    for name in ('Прямоугольник','Квадрат','Круг','Овал'):
        btn=page.get_by_role('button',name=name,exact=True);btn.click();page.mouse.move(5,5)
        assert btn.locator('svg').evaluate('el=>getComputedStyle(el).color')==('rgb(49, 64, 158)' if theme=='light' else 'rgb(255, 255, 255)')
    normal=page.get_by_role('button',name='Круг',exact=True)
    assert normal.locator('svg').evaluate('el=>getComputedStyle(el).color')==('rgb(44, 53, 68)' if theme=='light' else 'rgb(201, 201, 212)')
    page.locator('.capture__opts').screenshot(path=str(out/f'{context}-{theme}.png'))
    ImageGrab.grab().save(out/f'{context}-{theme}-desktop.png')
try:
    for _ in range(100):
        try:urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=.3).close();break
        except OSError:assert proc.poll() is None;time.sleep(.1)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}');ctx=browser.contexts[0];main=find(ctx,'body.settings-body')
        buf=io.BytesIO();Image.new('RGB',(640,400),(18,52,86)).save(buf,format='PNG')
        label=invoke(main,'snipcast_capture_pin',{'png':base64.b64encode(buf.getvalue()).decode(),'x':200,'y':200,'width':640,'height':400})
        pin=find(ctx,'.pin');pin.locator('.pin__shot').wait_for()
        pin.mouse.click(80,80,button='right');find(ctx,'.pinmenu').get_by_role('button',name='Аннотировать',exact=True).click()
        pin.locator('.capture--pin-editor').wait_for();verify(pin,'pin','light')
        pin.get_by_role('button',name='Отмена',exact=True).click();pin.locator('.pin').wait_for();cfg=invoke(main,'snipcast_get_config');cfg['theme']='dark';invoke(main,'snipcast_save_config',{'incoming':cfg});pin.wait_for_timeout(300);pin.locator('.pin').wait_for();pin.mouse.click(80,80,button='right');find(ctx,'.pinmenu').get_by_role('button',name='Аннотировать',exact=True).click();pin.locator('.capture--pin-editor').wait_for()
        verify(pin,'pin','dark');pin.get_by_role('button',name='Отмена',exact=True).click();pin.locator('.pin').wait_for()
        invoke(main,'snipcast_close_all_pins')
        for theme in ('light','dark'):
            cfg=invoke(main,'snipcast_get_config');cfg['theme']=theme;invoke(main,'snipcast_save_config',{'incoming':cfg})
            invoke(main,'snipcast_start_screenshot');capture=find(ctx,'.capture--presented')
            capture.mouse.move(300,200);capture.mouse.down();capture.mouse.move(900,600);capture.mouse.up()
            verify(capture,'capture',theme);invoke(main,'snipcast_close_capture')
        print('PASS: native Windows/WebView2 figure icons in capture and pin, light/dark, all four selections')
finally:proc.terminate();proc.wait(timeout=10)
