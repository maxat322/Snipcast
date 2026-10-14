"""Targeted hint return, shape fill/opacity/export and unified Settings hotkeys."""
import ast,base64,io,json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'capture-0368-ui';OUT.mkdir(parents=True,exist_ok=True)
def literal(file,name):
 tree=ast.parse((ROOT/'tests'/file).read_text(encoding='utf-8'))
 return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)==name for t in n.targets))
BRIDGE=literal('capture_assist.py','BRIDGE').replace('window.qa={session:1','window.qa={images:[],session:1')
BRIDGE=BRIDGE.replace("if(command==='snipcast_capture_info')","if(command==='snipcast_capture_history_list')return [];if(command==='snipcast_capture_copy'){qa.images.push(args.png);return;}if(command==='snipcast_capture_info')")
def drag(page,a,b):page.mouse.move(*a);page.mouse.down();page.mouse.move(*b,steps=8);page.mouse.up()
def range_value(slider,value):slider.evaluate('(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,String(v));e.dispatchEvent(new Event("input",{bubbles:true}));}',value)
def export(page):
 before=page.evaluate('qa.images.length');page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',key:'c',bubbles:true}))")
 page.wait_for_function('n=>qa.images.length===n+1',arg=before)
 return Image.open(io.BytesIO(base64.b64decode(page.evaluate('qa.images.at(-1)')))).convert('RGB')
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for scale in (1,1.5,2):
  for theme in ('dark','light'):
   source=Image.new('RGB',(round(1280*scale),round(900*scale)),(60,80,100));buffer=io.BytesIO();source.save(buffer,format='PNG')
   page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=scale);errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=base64.b64encode(buffer.getvalue()).decode(),scale=scale,theme=theme))})')
   page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_function("document.querySelector('.capture--presented')")
   page.mouse.move(1200,20);page.wait_for_timeout(70);hint=page.locator('.capture__shortcuts');home=hint.bounding_box()
   page.mouse.move(home['x']+home['width']/2,home['y']+home['height']/2);page.wait_for_timeout(150);away=hint.bounding_box();assert abs(away['y']-home['y'])>100 or abs(away['x']-home['x'])>100,(home,away)
   page.mouse.move(1200,20);page.wait_for_timeout(70);back=hint.bounding_box();assert abs(back['x']-home['x'])<1 and abs(back['y']-home['y'])<1
   expect(hint).to_contain_text('Истории скриншотов: старее / новее')
   drag(page,(100,100),(1100,750));page.locator('[data-tool-anchor=rect]').click();page.get_by_role('button',name='Заливка',exact=True).click()
   slider=page.get_by_role('slider',name='Прозрачность',exact=True);range_value(slider,50);expect(slider).to_have_value('50')
   drag(page,(350,280),(550,480));image=export(page);pixel=image.getpixel((round(350*scale),round(280*scale)));assert max(abs(a-b) for a,b in zip(pixel,(158,40,80)))<=1,pixel
   drag(page,(450,380),(500,430));image=export(page);assert image.getpixel((round(275*scale),round(205*scale)))==(60,80,100),'Filled center did not move shape'
   range_value(slider,100);image=export(page);assert image.getpixel((round(400*scale),round(330*scale)))==(60,80,100)
   page.keyboard.press('Control+z');expect(slider).to_have_value('50');page.get_by_role('button',name='Контур',exact=True).click();image=export(page);assert image.getpixel((round(400*scale),round(330*scale)))==(60,80,100)
   page.keyboard.press('Control+z');image=export(page);assert max(abs(a-b) for a,b in zip(image.getpixel((round(400*scale),round(330*scale))),(158,40,80)))<=1
   page.locator('[data-tool-anchor=rect]').click()
   if not page.get_by_role('button',name='Круг',exact=True).count():page.locator('[data-tool-anchor=rect]').click()
   page.get_by_role('button',name='Круг',exact=True).click();page.get_by_role('button',name='Заливка',exact=True).click();range_value(slider,50)
   drag(page,(780,280),(940,440));image=export(page);assert max(abs(a-b) for a,b in zip(image.getpixel((round(760*scale),round(260*scale))),(158,40,80)))<=1
   page.locator('[data-tool-anchor=text]').click();range_value(slider,50);page.get_by_role('checkbox',name='Обводка текста').check();page.mouse.click(700,450);text=page.get_by_role('textbox',name='Текст на скриншоте');text.fill('Прозрачность');assert text.evaluate('e=>getComputedStyle(e).opacity')=='0.5';text.press('Control+Enter');page.wait_for_timeout(70)
   assert page.locator('.capture__shapes').evaluate('c=>{const data=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let max=0;for(let i=3;i<data.length;i+=4)max=Math.max(max,data[i]);return max}')<=129,'Outline accumulated opacity'
   page.mouse.move(1250,850);page.screenshot(path=str(OUT/f'{theme}-{scale}.png'));assert not errors,errors
   results.append({'theme':theme,'scale':scale,'hintReturnsHome':True,'fillCenterSelectable':True,'opacityPreviewAndExport':True,'contourFillUndo':True,'ellipseFill':True,'textOpacity':True});page.close()
 for theme in ('dark','light'):
  config=literal('preset_autosave.py','CONFIG');config['theme']=theme
  page=browser.new_page(viewport={'width':950,'height':880});page.add_init_script(f'({literal("preset_autosave.py","BRIDGE")})({json.dumps(config)})');page.goto('http://127.0.0.1:1420/?snipcast=settings')
  group=page.get_by_role('group',name='Горячие клавиши',exact=True);expect(group.locator('input')).to_have_count(5)
  assert group.locator('.settings__option-label').all_text_contents()==['Горячие клавиши','Палитра шаблонов','Скриншот','Скриншот: сохранить в файл','Скриншот: закрепить','Скриншот: копировать в буфер']
  assert group.locator('input').evaluate_all('inputs=>new Set(inputs.map(e=>e.closest(".settings__panel"))).size')==1
  positions=group.locator('input').evaluate_all('inputs=>inputs.map(e=>e.getBoundingClientRect().x)');assert max(positions)-min(positions)<1
  page.screenshot(path=str(OUT/f'settings-{theme}.png'));results.append({'settingsTheme':theme,'fiveHotkeysOneList':True});page.close()
 browser.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
