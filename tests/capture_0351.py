"""Rendered shortcuts, monitor selection, percentages, outline and curve picking."""
from pathlib import Path
exec((Path(__file__).parent/'capture_035.py').read_text(encoding='utf8').split('with sync_playwright() as p:')[0])
OUT=ROOT/'.qa-work'/'capture-0351-browser';OUT.mkdir(parents=True,exist_ok=True)
def key(page,code,key=None,**extra):
    page.evaluate("args=>document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,...args}))",{'code':code,'key':key or code,**extra})
def frame(page):return page.locator('.capture__frame').evaluate('el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top),w:parseFloat(el.style.width),h:parseFloat(el.style.height)})')
def set_range(locator,value):
    locator.evaluate("(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}",value)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);results=[]
    for scale in (1,1.5,2):
      for theme in ('dark','light'):
        page,errors=fixture(browser,scale)
        page.evaluate("theme=>document.querySelector('.capture').setAttribute('data-capture-theme',theme)",theme)
        page.mouse.move(400,200);page.wait_for_timeout(40)
        expect(page.locator('.capture__hint--top')).to_have_text('Выберите область...')
        hints=page.locator('.capture__shortcuts');old=hints.bounding_box()
        page.mouse.move(old['x']+20,old['y']+20);page.wait_for_timeout(50)
        moved=hints.bounding_box();assert moved!=old,(old,moved)
        assert hints.evaluate("el=>getComputedStyle(el).pointerEvents")=='none'
        page.mouse.move(800,200);page.wait_for_timeout(40);key(page,'KeyA','ф')
        assert frame(page)=={'x':640,'y':0,'w':640,'h':900},frame(page)
        keys=hints.locator('kbd').all_text_contents()
        for expected in ['C','Enter','Пробел','1 2 ... 8','Ctrl+Z','Ctrl+Shift+Z','A','← ↑ ↓ →','Esc']:assert expected in keys,(expected,keys)
        assert 'Маркеры' not in hints.inner_text() and 'Перетаскивание внутри' not in hints.inner_text()
        assert 'Ctrl+Y' not in hints.inner_text()
        icons=page.locator('.capture__toolbar .capture__btn').evaluate_all('els=>els.map(e=>e.querySelector("svg").getBoundingClientRect().top-e.getBoundingClientRect().top)')
        assert max(icons)-min(icons)<1,icons
        for n in range(1,6):
            key(page,'Numpad'+str(n),['End','ArrowDown','PageDown','ArrowLeft','Clear'][n-1])
            active=page.locator('.capture__btn.is-active');assert active.locator('kbd').inner_text()==str(n)
            assert page.locator('.capture').evaluate("el=>getComputedStyle(el).cursor")=='crosshair'
        for kbd in page.locator('.capture__toolbar kbd').all():
            b=kbd.bounding_box();label=kbd.locator('..').locator('span').bounding_box()
            assert b['y']>=label['y']+label['height']-1,(b,label)
            assert kbd.evaluate("el=>getComputedStyle(el).borderTopStyle")=='solid'
        page.screenshot(path=str(OUT/f'{theme}-{scale}.png'))
        assert not errors,errors;page.close()
        results.append(f'{theme}@{scale}: moving hints, A monitor, RU physical keys, NumLock-off codes, badges')
    page,errors=fixture(browser);page.mouse.move(400,200);page.wait_for_timeout(30);key(page,'KeyA')
    page.keyboard.press('Numpad7');page.wait_for_function('qa.copied.length===1');assert page.evaluate('qa.copied[0]')=='1000,3'
    page.keyboard.press('Numpad8');expect(page.get_by_role('status')).to_contain_text('API-ключ')
    page.keyboard.press('Numpad6');page.wait_for_function('qa.copied.length===2&&qa.closed===1')
    assert not errors,errors;page.close();results.append('6/7/8 invoke OCR, sum and existing AI validation')
    page,errors=fixture(browser)
    page.evaluate("()=>{const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(cmd,args)=>cmd==='snipcast_capture_pin'?(qa.pinned=args,Promise.resolve('pin-test')):original(cmd,args)}")
    drag(page,(100,100),(500,500));page.keyboard.press('Space');page.wait_for_function('qa.pinned&&qa.closed===1')
    assert page.evaluate('({x:qa.pinned.x,y:qa.pinned.y,w:qa.pinned.width,h:qa.pinned.height})')=={'x':-1500,'y':-100,'w':400,'h':400}
    assert not errors,errors;page.close();results.append('Space pins the exact region and closes capture')
    page,errors=fixture(browser);drag(page,(100,100),(500,500));page.keyboard.press('5');page.mouse.click(180,200)
    editor=page.locator('.capture__text-edit');editor.fill('Обводка QA')
    expect(page.locator('.capture__opts-value').first).to_have_text('5.5%')
    before=editor.evaluate('el=>({font:getComputedStyle(el).fontSize,text:el.value})')
    page.keyboard.press('Space');page.keyboard.press('a');page.keyboard.press('Numpad1');page.keyboard.press('Enter')
    assert page.evaluate('qa.closed')==0 and page.locator('.capture__text-edit').count()==1
    editor.fill('Обводка QA');page.get_by_role('checkbox',name='Обводка текста').check()
    set_range(page.get_by_role('slider',name='Толщина обводки'),4)
    set_range(page.get_by_role('slider',name='Размер текста'),8)
    assert float(editor.evaluate('el=>getComputedStyle(el).fontSize').replace('px',''))==32
    expect(page.locator('.capture__opts-value').first).to_have_text('8%')
    assert editor.evaluate('el=>getComputedStyle(el).webkitTextStrokeWidth')=='8px'
    page.screenshot(path=str(OUT/'text-edit.png'))
    preview=Image.open(io.BytesIO(page.screenshot())).convert('RGB')
    page.keyboard.press('Control+Enter');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===1')
    img=decode(page);assert sum(c==(0,0,0) for c in img.get_flattened_data())>50,'outline missing from PNG'
    # Native textarea paint order and Canvas export must agree, including ink
    # outside the original unoutlined text box. Ignore caret/selection chrome.
    before_ink={(x,y) for x in range(170,440) for y in range(195,245) if preview.getpixel((x,y))==(0,0,0)}
    after_ink={(x,y) for x in range(170,440) for y in range(195,245) if img.getpixel((x-100,y-100))==(0,0,0)}
    preview.crop((170,195,440,245)).save(OUT/'outline-preview.png');img.crop((70,95,340,145)).save(OUT/'outline-export.png')
    # Chromium rounds the native text-control baseline to pixels. Allow one
    # pixel of baseline rounding, but require the actual outline geometry.
    overlap=max(len(before_ink&{(x,y+dy) for x,y in after_ink})/len(before_ink|{(x,y+dy) for x,y in after_ink}) for dy in (-1,0,1))
    assert overlap>.95,('outline differs between editable text and export',overlap)
    # Region resize preserves the actual size of existing letters.
    handle=page.locator('[data-handle=se]').bounding_box()
    drag(page,(handle['x']+handle['width']/2,handle['y']+handle['height']/2),(700,500))
    page.mouse.dblclick(185,208);expect(editor).to_be_visible()
    assert float(editor.evaluate('el=>getComputedStyle(el).fontSize').replace('px',''))==32
    assert '%' in page.locator('.capture__opts-value').first.inner_text()
    page.keyboard.press('Escape');page.screenshot(path=str(OUT/'text-finished.png'))
    page.mouse.move(400,200);page.wait_for_timeout(40);key(page,'KeyA')
    assert frame(page)=={'x':0,'y':0,'w':640,'h':900}
    page.keyboard.press('c');page.wait_for_function('qa.pngs.length===2')
    full=decode(page)
    assert sum(c==(0,0,0) for c in full.get_flattened_data())==sum(c==(0,0,0) for c in img.get_flattened_data()),'A lost or moved the existing text'
    assert not errors,errors;page.close();results.append('text input guards, percent of width, outline PNG, frame resize and A preserving annotations')
    page,errors=fixture(browser)
    result=page.evaluate('''async()=>{
      const {drawShape,hitTest,freehandGeometry}=await import('/src/capture/shapes.ts');
      const s={id:1,kind:'freehand',p1:{x:200,y:200},p2:{x:300,y:200},points:[{x:200,y:200},{x:250,y:300},{x:300,y:200}],color:'#ff0000',thickness:4};
      // Real pointer batches used to append the last sample twice. Assert
      // that actual event-shaped data follows the same smoothed path.
      s.points=s.points.flatMap(p=>[p,p]);
      const c=document.createElement('canvas');c.width=500;c.height=500;const ctx=c.getContext('2d');drawShape(ctx,s,1);
      const alpha=(x,y)=>ctx.getImageData(x,y,1,1).data[3];
      const geometry=freehandGeometry(s.points),curve=geometry.hitPoints[Math.floor(geometry.hitPoints.length/2)];
      return {curve:alpha(Math.round(curve.x),Math.round(curve.y)),first:alpha(200,200),last:alpha(300,200),hit:hitTest(s,curve),rounded:geometry.bounds.h<98};
    }''')
    assert result['curve']>100 and result['first']>100 and result['last']>100 and result['hit'] and result['rounded'],result
    assert not errors,errors;page.close();results.append('shared spline rounds the raw corner, preserves endpoints and accurate picking')
    browser.close();(OUT/'results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf8');print(json.dumps({'passed':results}))
