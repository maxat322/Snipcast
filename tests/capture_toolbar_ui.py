"""Focused capture hints/palette layout checks, without clipboard/history/video work."""
import ast,base64,io,json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'capture-toolbar-ui';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf-8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='BRIDGE' for t in n.targets))
BRIDGE=BRIDGE.replace("if(command==='snipcast_capture_info')","if(command==='snipcast_capture_history_list')return [];if(command==='snipcast_capture_info')")
COLORS=['#ff003c','#003cff','#ff4f00','#ffff00','#ffffff','#00ff32','#00f5ff','#ff00a8','#000000','#b000ff']
results=[]
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  for scale in (1,1.5,2):
    for theme in ('dark','light'):
      source=Image.new('RGB',(round(1280*scale),round(900*scale)),(95,103,120));buf=io.BytesIO();source.save(buf,format='PNG')
      page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=scale);errors=[]
      page.on('pageerror',lambda error:errors.append(str(error)));page.set_default_timeout(5000)
      page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=base64.b64encode(buf.getvalue()).decode(),scale=scale,theme=theme))})')
      page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_function("document.querySelector('.capture--presented')")
      hints=page.locator('.capture__shortcuts');expect(hints).to_contain_text('− / +');expect(hints).to_contain_text('Истории скриншотов: старее / новее');expect(hints).to_contain_text('центральные направляющие')
      page.mouse.move(100,100);page.mouse.down();page.mouse.move(1100,650,steps=6);page.mouse.up()
      expect(hints).to_contain_text('центральные направляющие');expect(hints).to_contain_text('оставить направляющие на снимке')
      page.keyboard.down('Alt');expect(page.locator('.capture__guides')).to_be_visible();page.keyboard.up('Alt');expect(page.locator('.capture__guides')).to_have_count(0)
      for tool in ('arrow','text'):
        page.locator(f'[data-tool-anchor={tool}]').click();swatches=page.locator('.capture__opts-swatches').first.locator('button')
        expect(swatches).to_have_count(10);assert swatches.evaluate_all('buttons=>buttons.map(b=>b.getAttribute("aria-label"))')==['Цвет '+color for color in COLORS]
        rows=swatches.evaluate_all('buttons=>buttons.map(b=>b.getBoundingClientRect().top)');assert max(rows)-min(rows)<1
        for color in ('#ffffff','#000000'):
          button=page.get_by_role('button',name='Цвет '+color,exact=True);assert button.evaluate('e=>parseFloat(getComputedStyle(e).borderTopWidth)')>=1
        page.get_by_role('button',name='Цвет #b000ff',exact=True).click();expect(page.get_by_role('button',name='Цвет #b000ff',exact=True)).to_have_class('capture__swatch is-active')
      page.get_by_role('checkbox',name='Обводка текста',exact=True).check()
      outline=page.get_by_label('Цвет обводки',exact=True).locator('button');expect(outline).to_have_count(10)
      assert outline.evaluate_all('buttons=>buttons.map(b=>b.getAttribute("aria-label"))')==['Цвет обводки '+color for color in COLORS]
      tops=outline.evaluate_all('buttons=>buttons.map(b=>b.getBoundingClientRect().top)');assert max(tops)-min(tops)<1
      page.mouse.move(10,880);page.wait_for_timeout(100)
      bounds=hints.bounding_box();assert bounds['x']>=0 and bounds['y']>=0 and bounds['x']+bounds['width']<=1280 and bounds['y']+bounds['height']<=900
      page.screenshot(path=str(OUT/f'{theme}-{scale}.png'))
      assert not errors,errors;results.append({'theme':theme,'scale':scale,'historyAndAltHints':True,'singleSaturatedRow':True,'shapeTextOutline':True,'neutralBorders':True,'hintsInViewport':True})
      page.close()
  browser.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
