"""Cursor guides, clear/undo, editable history and measured two-panel placement."""
import ast, base64, io, json
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/'capture-area-annotations';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='BRIDGE' for t in n.targets))
BRIDGE=BRIDGE.replace('window.qa={session:1','window.qa={history:[],records:[],images:[],session:1')
BRIDGE=BRIDGE.replace("if(command==='snipcast_capture_info')", """
      if(command==='snipcast_capture_history_list')return qa.history;
      if(command==='snipcast_capture_history_open')return {entry:qa.history.find(e=>e.id===args.id),png:qa.historyPng};
      if(command==='snipcast_capture_history_record'){qa.records.push(args);return 'recorded';}
      if(command==='snipcast_capture_copy'){qa.images.push(args.png);return;}
      if(command==='plugin:dialog|save')return 'qa.png';
      if(command==='snipcast_capture_info')""")

def png(image):
    b=io.BytesIO();image.save(b,format='PNG');return base64.b64encode(b.getvalue()).decode()

def drag(page,a,b):
    page.mouse.move(*a);page.mouse.down();page.mouse.move(*b,steps=8);page.mouse.up()

def fixture(browser,scale=1,theme='dark',history=None,viewport=None):
    source=Image.new('RGB',(round(1280*scale),round(900*scale)),(50,65,85));encoded=png(source)
    page=browser.new_page(viewport=viewport or {'width':1280,'height':900},device_scale_factor=scale)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_default_timeout(6000)
    page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=encoded,scale=scale,theme=theme))})')
    page.add_init_script(f'qa.history={json.dumps(history or [])};qa.historyPng={json.dumps(encoded)};')
    page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_load_state('networkidle')
    page.wait_for_function("document.querySelector('.capture--presented')")
    return page,source,errors

def copy(page):
    n=page.evaluate('qa.images.length');page.get_by_title('Копировать в буфер обмена',exact=True).click()
    page.wait_for_function('n=>qa.images.length===n+1',arg=n)
    return page.evaluate('JSON.parse(JSON.stringify(qa.records.at(-1)))')

def assert_panels(page,side,selection_edge=None):
    page.wait_for_timeout(100)
    tb=page.locator('.capture__toolbar').bounding_box();opts=page.locator('.capture__opts').bounding_box();vp=page.viewport_size
    for r in (tb,opts):
        assert r['x']>=7 and r['y']>=7 and r['x']+r['width']<=vp['width']-7 and r['y']+r['height']<=vp['height']-7,(r,vp)
    if side=='above':
        assert opts['y']+opts['height']<=tb['y']-7,(tb,opts)
        if selection_edge is not None and tb['height']+opts['height']+8<=selection_edge-16:assert tb['y']+tb['height']<=selection_edge-7,(tb,selection_edge)
    else:
        assert opts['y']>=tb['y']+tb['height']+7,(tb,opts)
        if selection_edge is not None:assert tb['y']>=selection_edge+7,(tb,selection_edge)

def annotations(scale):
    shapes=[]
    for i,kind in enumerate(('arrow','line','rect','square','ellipse','circle','freehand','text')):
        x=170+(i%4)*220;y=170+(i//4)*200
        s=dict(id=i+1,kind=kind,color='#ff003c',opacity=.65,p1=dict(x=x*scale,y=y*scale),p2=dict(x=(x+90)*scale,y=(y+75)*scale))
        if kind=='text':s.update(text='История\nТекст',fontSize=22*scale,textMode='frame',width=160*scale,minHeight=80*scale,outlineColor='#000000',outlineWidth=2*scale)
        else:s.update(thickness=4*scale,filled=kind in ('rect','circle'))
        if kind=='freehand':s.update(points=[s['p1'],dict(x=(x+35)*scale,y=(y+65)*scale),s['p2']],straightPrefix=1)
        shapes.append(s)
    shapes[0]['p1']['x']+=.123456;shapes[0]['p2']['y']+=.654321
    return shapes

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for scale in (1,1.5,2):
      for theme in ('dark','light'):
        page,source,errors=fixture(browser,scale,theme)
        page.mouse.move(300,250);page.keyboard.down('Alt')
        expect(page.locator('.capture__cursor-guides')).to_have_attribute('d','M 300 0 V 900 M 0 250 H 1280')
        page.mouse.move(480,330);expect(page.locator('.capture__cursor-guides')).to_have_attribute('d','M 480 0 V 900 M 0 330 H 1280')
        page.keyboard.up('Alt');expect(page.locator('.capture__guides')).to_have_count(0)
        drag(page,(100,100),(1150,620));page.mouse.move(500,300);page.keyboard.down('Alt')
        expect(page.locator('.capture__guides path')).to_have_count(2)
        page.mouse.move(600,350);expect(page.locator('.capture__cursor-guides')).to_have_attribute('d','M 600 0 V 900 M 0 350 H 1280')
        page.evaluate("window.dispatchEvent(new Event('blur'))");expect(page.locator('.capture__guides')).to_have_count(0);page.keyboard.up('Alt')
        record=copy(page);assert record['annotations']==[]
        # The new cursor guide adds no pixels, even during the existing Alt export.
        page.mouse.move(700,350);page.keyboard.down('Alt');copy(page);page.mouse.move(900,400);copy(page);page.keyboard.up('Alt')
        a,b=page.evaluate('qa.images.slice(-2)')
        assert ImageChops.difference(Image.open(io.BytesIO(base64.b64decode(a))),Image.open(io.BytesIO(base64.b64decode(b)))).getbbox() is None
        page.locator('[data-tool-anchor=arrow]').click();assert_panels(page,'below',620)
        drag(page,(300,230),(500,350));clear=page.get_by_role('button',name='Очистить',exact=True);expect(clear).to_be_visible()
        assert page.locator('.capture__toolbar button').evaluate_all("els=>els.map(e=>e.innerText.includes('Очистить')?'clear':e.dataset.toolAnchor)")[:6]==['arrow','line','rect','freehand','text','clear']
        before=page.locator('.capture__shapes').evaluate('c=>c.toDataURL()');clear.click();expect(clear).to_have_count(0)
        page.keyboard.press('Control+z');expect(clear).to_be_visible();assert page.locator('.capture__shapes').evaluate('c=>c.toDataURL()')==before
        page.keyboard.press('Control+Shift+z');expect(clear).to_have_count(0)
        page.locator('[data-tool-anchor=text]').click();page.mouse.click(400,300);page.get_by_role('textbox',name='Текст на скриншоте').fill('Несохранённый текст')
        clear.click();expect(page.locator('textarea')).to_have_count(0);expect(clear).to_have_count(0)
        page.keyboard.press('Control+z');expect(clear).to_be_visible();assert copy(page)['annotations'][0]['text']=='Несохранённый текст'
        clear.click();assert copy(page)['annotations']==[]
        page.screenshot(path=str(OUT/f'clear-{theme}-{scale}.png'));assert not errors,errors;page.close()

        shapes=annotations(scale)
        entry=dict(id='old',width=round(1280*scale),height=round(900*scale),originX=-1600,originY=-200,selection=dict(x=round(100*scale),y=round(100*scale),width=round(1050*scale),height=round(520*scale)),annotations=shapes)
        page,_,errors=fixture(browser,scale,theme,[entry]);page.keyboard.press('-');expect(page.locator('.capture__dimchip')).to_contain_text('История')
        restored=copy(page)['annotations'];assert restored==shapes,(restored,shapes)
        if scale==1 and theme=='dark':
            page.mouse.move(600,500);page.keyboard.down('Alt');page.screenshot(path=str(OUT/'history-guides-clear.png'));page.keyboard.up('Alt')
        # Restored objects remain individually editable, including text.
        page.mouse.dblclick(850,380);text=page.get_by_role('textbox',name='Текст на скриншоте');expect(text).to_be_visible();text.fill('Изменённый текст')
        page.get_by_title('Копировать в буфер обмена',exact=True).click();page.wait_for_function("qa.records.at(-1).annotations.at(-1).text==='Изменённый текст'")
        page.set_viewport_size({'width':900,'height':1280});restored=copy(page)['annotations']
        assert len(restored)==8 and restored[-1]['text']=='Изменённый текст'
        for a,b in zip(restored[:-1],shapes[:-1]):
            for point in ('p1','p2'):
                assert abs(a[point]['x']-b[point]['x'])<.0001 and abs(a[point]['y']-b[point]['y'])<.0001,(a,b)
        assert restored[:-1]==shapes[:-1],'Unchanged annotations must still deduplicate after resize'
        page.get_by_role('button',name='Очистить',exact=True).click();assert copy(page)['annotations']==[]
        page.keyboard.press('Control+z');assert len(copy(page)['annotations'])==8
        assert not errors,errors;page.close()
        results.append(dict(scale=scale,theme=theme,cursorGuides=True,clearUndoText=True,editableHistoryAllKinds=True,physicalRoundTrip=True))

    for width,height,start,end,side in ((1280,900,(100,20),(1100,250),'below'),(1280,900,(100,500),(1100,800),'above'),(680,900,(60,350),(620,650),'above'),(680,900,(10,10),(670,890),'below')):
        page,_,errors=fixture(browser,viewport=dict(width=width,height=height));drag(page,start,end)
        for tool in ('arrow','rect','text'):
            page.locator(f'[data-tool-anchor={tool}]').click();assert_panels(page,side,start[1] if side=='above' else end[1] if end[1]<850 else None)
        page.screenshot(path=str(OUT/f'panels-{width}-{start[1]}.png'));assert not errors,errors;page.close()
    page,_,errors=fixture(browser,history=[dict(id='legacy',width=1280,height=900,originX=0,originY=0,selection=dict(x=100,y=100,width=400,height=300))]);page.keyboard.press('-');assert copy(page)['annotations']==[];assert not errors;page.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(results,ensure_ascii=False))
