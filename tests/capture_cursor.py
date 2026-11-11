"""System cursor toggle: physical pixels, cropped exports, history and keyboard guards."""
import ast, base64, io, json, os, math
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.qa-work' / 'capture-cursor'
OUT.mkdir(parents=True, exist_ok=True)
tree = ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf8'))
BRIDGE = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, 'id', None)=='BRIDGE' for t in n.targets))
BRIDGE = BRIDGE.replace('window.qa={session:1', 'window.qa={images:[],records:[],history:[],session:1')
BRIDGE = BRIDGE.replace("imageName:`frame-${qa.session}.png`,", "imageName:`frame-${qa.session}.png`,cursorImage:qa.cursorImage,videoSelection:qa.videoSelection,")
BRIDGE = BRIDGE.replace("if(command==='snipcast_capture_info')", """
      if(command==='snipcast_capture_history_list')return qa.history;
      if(command==='snipcast_capture_history_open')return {entry:qa.history[0],png:qa.historyPng};
      if(command==='snipcast_capture_history_record'){qa.records.push(args);return 'recorded';}
      if(['snipcast_capture_copy','snipcast_capture_save','snipcast_capture_pin'].includes(command)){qa.images.push(args.png);return;}
      if(command==='snipcast_capture_keyboard_state')return;
      if(command==='plugin:dialog|save')return 'qa.png';
      if(command==='snipcast_capture_info')""")

def png(image):
    out = io.BytesIO(); image.save(out, format='PNG'); return base64.b64encode(out.getvalue()).decode()

def same(actual, expected):
    decoded = Image.open(io.BytesIO(base64.b64decode(actual))).convert('RGB')
    assert decoded.size == expected.size, (decoded.size, expected.size)
    assert ImageChops.difference(decoded, expected.convert('RGB')).getbbox() is None

def export(page, key='c'):
    count = page.evaluate('qa.images.length'); page.keyboard.press(key)
    page.wait_for_function('n=>qa.images.length===n+1', arg=count)
    page.wait_for_function('n=>qa.records.length===n+1', arg=count)
    return page.evaluate('qa.images.at(-1)')

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,**({'channel':os.environ['SNIPCAST_TEST_BROWSER']} if os.environ.get('SNIPCAST_TEST_BROWSER') else {}))
    for scale in (1, 1.5, 2):
        original=Image.new('RGB',(int(1280*scale),int(900*scale)),(18,52,86))
        patch=Image.new('RGB',(32,40),(18,52,86))
        ImageDraw.Draw(patch).polygon([(1,1),(1,32),(9,24),(16,38),(21,35),(14,21),(28,21)],fill='white',outline='black')
        x,y=int(300*scale),int(240*scale)
        combined=original.copy();combined.paste(patch,(x,y))
        page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=scale)
        page.set_default_timeout(10000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=png(original),scale=scale,theme="dark"))})')
        history=[dict(id='old',width=original.width,height=original.height,selection=dict(x=0,y=0,width=original.width,height=original.height))]
        page.add_init_script(f'qa.cursorImage={json.dumps(dict(x=x,y=y,width=32,height=40,png=png(patch)))};qa.historyPng={json.dumps(png(original))};qa.history={json.dumps(history)};')
        page.goto(os.environ.get('SNIPCAST_TEST_URL','http://127.0.0.1:1420/?snipcast=capture'),timeout=30000);page.wait_for_load_state('networkidle')
        page.wait_for_function("document.querySelector('.capture--presented')")
        hints=page.locator('.capture__shortcuts')
        expect(hints).to_contain_text('Aвесь экран');expect(hints).to_contain_text('PВключить курсор')
        expect(page.locator('.capture__system-cursor')).to_have_count(0)
        page.keyboard.press('a');same(export(page),original)
        page.keyboard.press('p');expect(hints).to_contain_text('PВыключить курсор')
        expect(page.locator('.capture__system-cursor')).to_be_visible()
        # Repeated keydown and modified shortcuts must not flip the toggle.
        page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyP',key:'p',repeat:true,bubbles:true}))")
        page.keyboard.press('Control+p');expect(hints).to_contain_text('PВыключить курсор')
        for key in ('c','Enter','Space'):same(export(page,key),combined)
        assert page.evaluate('qa.records.at(-1).includeCursor') is True
        page.screenshot(path=str(OUT/f'enabled-{scale}.png'))
        # Moving the selection pointer never moves the frozen system cursor.
        page.mouse.move(900,500);same(export(page),combined)
        page.keyboard.press('p');same(export(page),original)
        assert page.evaluate('qa.records.at(-1).includeCursor') is False
        # Physical key code also works on the Russian keyboard layout.
        page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyP',key:'з',bubbles:true}))")
        expect(hints).to_contain_text('PВыключить курсор')
        page.keyboard.press('-');expect(page.locator('.capture__system-cursor')).to_have_count(0)
        page.keyboard.press('=');expect(page.locator('.capture__system-cursor')).to_be_visible()
        page.keyboard.press('5');page.mouse.click(450,300)
        editor=page.get_by_role('textbox',name='Текст на скриншоте');expect(editor).to_be_visible()
        page.keyboard.press('p');expect(editor).to_have_value('p')
        expect(page.locator('.capture__system-cursor')).to_be_visible()
        page.keyboard.press('Escape')
        page.evaluate("qa.session++;qa.emit('snipcast://capture-session')")
        page.wait_for_function('qa.ready.includes(`frame-${qa.session}.png`)')
        expect(hints).to_contain_text('PВключить курсор');expect(page.locator('.capture__system-cursor')).to_have_count(0)
        # Partial cursor at the crop edge, then a crop excluding it completely.
        for a,b in (((310,245),(620,450)),((700,500),(1000,700))):
            page.evaluate("qa.session++;qa.emit('snipcast://capture-session')")
            page.wait_for_function('qa.ready.includes(`frame-${qa.session}.png`)')
            page.keyboard.press('p');page.mouse.move(*a);page.mouse.down();page.mouse.move(*b,steps=5);page.mouse.up()
            left,top=(math.floor(v*scale+.5) for v in a)
            width,height=(math.floor((end-start)*scale+.5) for start,end in zip(a,b))
            same(export(page),combined.crop((left,top,left+width,top+height)))
        page.evaluate("qa.videoSelection=true;qa.session++;qa.emit('snipcast://capture-session')")
        page.wait_for_function('qa.ready.includes(`frame-${qa.session}.png`)')
        page.keyboard.press('p');expect(page.locator('.capture__system-cursor')).to_have_count(0)
        expect(hints).not_to_contain_text('Включить курсор')
        assert not errors,errors
        results.append(dict(scale=scale,status='passed',exports=page.evaluate('qa.images.length')))
        page.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8')
print(json.dumps(results))
