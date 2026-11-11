"""OCR and sums must address the displayed source in physical image pixels."""
import ast, base64, io, json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/'history-ocr';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='BRIDGE' for t in n.targets))
BRIDGE=BRIDGE.replace("if(command==='snipcast_capture_info')", """
      if(command==='snipcast_capture_history_list')return [qa.entry];
      if(command==='snipcast_capture_history_open')return {entry:qa.entry,png:qa.historyPng};
      if(command==='snipcast_ocr_region'){qa.regions.push(args);return '12,50 7,25'}
      if(command==='snipcast_capture_info')""")

def png(size):
    b=io.BytesIO();Image.new('RGB',size,'white').save(b,format='PNG');return base64.b64encode(b.getvalue()).decode()

def action(page,title,expected):
    n=page.evaluate('qa.regions.length');page.get_by_title(title,exact=True).click()
    page.wait_for_function('n=>qa.regions.length===n+1',arg=n)
    actual=page.evaluate('qa.regions.at(-1)');assert actual==expected,(actual,expected)
    expect(page.get_by_title(title,exact=True)).to_be_enabled()

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for scale in (1,1.5,2):
      for size in ((800,1600),(2400,600)):
        entry=dict(id='1234567890abcdef12345678',width=size[0],height=size[1],selection=dict(x=100,y=150,width=500,height=300),annotations=[])
        page=browser.new_page(viewport=dict(width=1280,height=900),device_scale_factor=scale)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=png((round(1280*scale),round(900*scale))),scale=scale,theme="dark"))})')
        page.add_init_script(f'Object.assign(qa,{json.dumps(dict(entry=entry,historyPng=png(size),regions=[]))})')
        page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_load_state('networkidle')
        page.wait_for_function("document.querySelector('.capture--presented')")
        page.mouse.move(400,300);page.mouse.down();page.mouse.move(900,600);page.mouse.up()
        page.keyboard.press('-');expect(page.locator('.capture__dimchip')).to_contain_text('История')
        expected=dict(label='capture-0',historyId=entry['id'],**entry['selection'])
        action(page,'Распознать текст',expected);assert page.evaluate('qa.copied.at(-1)')=='12,50 7,25'
        action(page,'Сложить распознанные числа',expected);assert page.evaluate('qa.copied.at(-1)')=='19,75'
        page.set_viewport_size(dict(width=900,height=1280));page.wait_for_timeout(150)
        action(page,'Распознать текст',expected)
        page.keyboard.press('Equal');expect(page.locator('.capture__dimchip')).not_to_contain_text('История')
        action(page,'Распознать текст',dict(label='capture-0',historyId=None,x=round(400*scale),y=round(300*scale),width=round(500*scale),height=round(300*scale)))
        assert not errors,errors
        results.append(dict(scale=scale,source=size,historyOcr=True,historySum=True,resize=True,currentRestored=True))
        page.close()
    browser.close()
(OUT/'ui-results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results))
