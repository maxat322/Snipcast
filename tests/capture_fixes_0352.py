"""Reported wheel/Escape/redo defects and actual pointer-batch raster quality."""
from pathlib import Path
import math
exec((Path(__file__).parent/'capture_035.py').read_text(encoding='utf8').split('with sync_playwright() as p:')[0])
OUT=ROOT/'.qa-work'/'capture-0352-browser';OUT.mkdir(parents=True,exist_ok=True)

def set_range(locator,value):
    locator.evaluate("(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}",value)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);results=[]
    for scale in (1,1.5,2):
        page,errors=fixture(browser,scale);drag(page,(100,100),(600,600));page.keyboard.press('5')
        page.mouse.move(300,280);page.mouse.wheel(0,-120)
        expect(page.locator('.capture__opts-value').first).to_have_text('4.6%') # 23 / 500
        page.mouse.click(220,250);editor=page.locator('.capture__text-edit');editor.press_sequentially('abc')
        editor.evaluate('el=>el.setSelectionRange(1,1)')
        page.mouse.move(230,258);page.mouse.wheel(0,-120);page.wait_for_timeout(50)
        assert editor.evaluate('el=>getComputedStyle(el).fontSize')=='24px'
        assert editor.evaluate('el=>el.selectionStart')==1
        page.mouse.wheel(0,120);page.wait_for_timeout(50)
        assert editor.evaluate('el=>getComputedStyle(el).fontSize')=='23px'
        assert editor.input_value()=='abc'
        page.keyboard.press('Control+Enter')
        page.mouse.move(230,258);page.mouse.wheel(0,-120);page.wait_for_timeout(50)
        page.mouse.dblclick(230,258)
        assert editor.evaluate('el=>getComputedStyle(el).fontSize')=='24px'
        page.keyboard.press('Escape');assert not page.locator('.capture__text-edit').count()
        assert not errors,errors;page.close();results.append(f'wheel size before, during and after text editing, caret intact @ {scale}')
    for control in ('checkbox','slider'):
        page,errors=fixture(browser);drag(page,(100,100),(600,600));page.keyboard.press('5')
        if control=='checkbox':page.get_by_role('checkbox',name='Обводка текста').check()
        else:page.get_by_role('slider',name='Размер текста').focus()
        page.keyboard.press('Escape');expect(page.locator('.capture__btn.is-active')).to_have_count(0)
        assert not page.locator('.capture__opts').count()
        page.keyboard.press('Escape');assert page.evaluate('qa.closed')==1
        assert not errors,errors;page.close();results.append(f'Escape after focused {control}')
    page,errors=fixture(browser);drag(page,(100,100),(600,600));page.keyboard.press('5');page.mouse.click(230,240)
    editor=page.locator('.capture__text-edit');editor.press_sequentially('undo text')
    page.keyboard.press('Control+z');undone=editor.input_value();assert undone!='undo text'
    page.keyboard.press('Control+y');assert editor.input_value()==undone
    page.keyboard.press('Control+Shift+z');assert editor.input_value()=='undo text'
    page.keyboard.press('Escape');assert not errors,errors;page.close();results.append('Ctrl+Y removed from native text history; Ctrl+Shift+Z works')
    page,errors=fixture(browser);drag(page,(100,100),(600,600));page.keyboard.press('4')
    set_range(page.get_by_role('slider',name='Толщина линии'),2)
    expect(page.locator('.capture__opts-value').first).to_have_text('2')
    points=[(round(310+80*math.cos(t/20)),round(310+80*math.sin(t/20))) for t in range(127)]
    page.mouse.move(*points[0]);page.mouse.down()
    for point in points[1:]:page.mouse.move(*point);page.wait_for_timeout(5)
    page.wait_for_timeout(30)
    draft=page.locator('.capture__shapes--draft').evaluate('el=>el.toDataURL()')
    page.mouse.up();page.wait_for_timeout(50)
    canvas=page.locator('.capture__shapes').first
    alphas=canvas.evaluate('el=>Array.from(new Set(el.getContext("2d").getImageData(200,200,220,220).data.filter((_,i)=>i%4===3)))')
    assert len(alphas)>32,('not enough edge coverage levels',alphas)
    page.screenshot(path=str(OUT/'smooth-stroke.png'))
    page.keyboard.press('c');page.wait_for_function('qa.pngs.length===1')
    img=decode(page);img.save(OUT/'smooth-stroke-export.png')
    preview=Image.open(io.BytesIO(base64.b64decode(draft.split(',')[1]))).convert('RGBA')
    composited=Image.new('RGBA',preview.size,(18,52,86,255));composited.alpha_composite(preview)
    before=composited.convert('RGB').crop((200,200,420,420));after=img.crop((100,100,320,320))
    delta=max(abs(a-b) for pa,pb in zip(before.get_flattened_data(),after.get_flattened_data()) for a,b in zip(pa,pb))
    assert delta<=3,('draft differs from export',delta)
    page.keyboard.press('Control+z');page.keyboard.press('Control+y');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===2')
    assert set(decode(page).get_flattened_data())=={(18,52,86)}
    page.keyboard.press('Control+Shift+z');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===3')
    assert decode(page).tobytes()==img.tobytes()
    assert not errors,errors;page.close();results.append(f'real dense pointer stroke: {len(alphas)} alpha levels, preview/export <= {delta}, Ctrl+Y no redo')
    browser.close();(OUT/'results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf8');print(json.dumps({'passed':results}))
