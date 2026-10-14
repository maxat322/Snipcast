"""Rendered capture UX and exact integer-source PNG tests across themes/DPI."""
import ast,base64,io,json,os
from pathlib import Path
from PIL import Image,ImageChops
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'capture-0366-browser';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf-8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='BRIDGE' for t in n.targets))
BRIDGE=BRIDGE.replace("window.qa={session:1", "window.qa={calls:[],images:[],history:[],historyRecords:[],dialogPath:'qa.png',config:{},session:1")
BRIDGE=BRIDGE.replace("if(command==='plugin:event|listen')", "qa.calls.push({command,args});if(command==='plugin:event|listen')")
BRIDGE=BRIDGE.replace("if(command==='snipcast_get_config')return {theme,screenshotQuickLocations:[],screenshotFormat:'png'};", "if(command==='snipcast_get_config')return {theme,screenshotQuickLocations:[{name:'QA folder',path:'C:/qa'}],screenshotFormat:'png',...qa.config};")
BRIDGE=BRIDGE.replace("if(command==='snipcast_capture_info')", "if(command==='snipcast_capture_history_list')return qa.history; if(command==='snipcast_capture_history_open'){await new Promise(r=>setTimeout(r,qa.delay??0));const item=qa.history.find(x=>x.id===args.id);return {entry:item,png:qa.historyPng};} if(command==='snipcast_capture_history_record'){qa.historyRecords.push(args);return 'saved';} if(command==='snipcast_capture_copy'){qa.images.push(args.png);return;} if(command==='snipcast_capture_pin'){qa.images.push(args.png);return;} if(command==='plugin:dialog|save'){if(qa.holdDialog)await new Promise(r=>qa.releaseDialog=r);return qa.dialogPath;} if(command==='snipcast_capture_info')")
BRIDGE=BRIDGE.replace("await new Promise(r=>setTimeout(r,qa.delay??0));const item=", "await new Promise(r=>setTimeout(r,qa.delays?.[args.id]??qa.delay??0));if(qa.corrupt?.includes(args.id))throw new Error('Corrupt history PNG');const item=")
BRIDGE=BRIDGE.replace("qa.presets.push(args);return", "qa.presets.push(args);qa.images.push(args.png);return")
def drag(page,a,b):
    page.mouse.move(*a);page.mouse.down();page.mouse.move(*b,steps=8);page.mouse.up()
def image(png):return Image.open(io.BytesIO(base64.b64decode(png))).convert('RGB')
results=[]
with sync_playwright() as p:
    executable=os.environ.get('SNIPCAST_CHROME')
    browser=p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}))
    for scale in (1,1.5,2):
      for theme in ('dark','light'):
        source=Image.new('RGB',(round(1280*scale),round(900*scale)))
        # Single-pixel detail makes fractional resampling visible, not just flat colors.
        source.putdata([((x*37)%256,(y*17)%256,(x+y)%256) for y in range(source.height) for x in range(source.width)])
        buf=io.BytesIO();source.save(buf,format='PNG');png=base64.b64encode(buf.getvalue()).decode()
        page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=scale);errors=[]
        page.set_default_timeout(5000);page.on('pageerror',lambda error:errors.append(str(error)))
        page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=png,scale=scale,theme=theme))})')
        page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_function("document.querySelector('.capture--presented')")
        drag(page,(101,101),(1001,601));page.keyboard.press('c')
        page.wait_for_function('qa.images.length===1')
        actual=image(page.evaluate('qa.images[0]'))
        expected=source.crop((round(101*scale),round(101*scale),round(101*scale)+round(900*scale),round(101*scale)+round(500*scale)))
        assert actual.size==expected.size,(actual.size,expected.size)
        assert ImageChops.difference(actual,expected).getbbox() is None,('Source pixels resampled',scale,theme)
        assert len(page.evaluate('qa.historyRecords'))==1
        page.keyboard.down('Alt');expect(page.locator('.capture__guides')).to_be_visible();page.keyboard.press('c');page.keyboard.up('Alt')
        page.wait_for_function('qa.images.length===2');expect(page.locator('.capture__guides')).to_have_count(0)
        guided=image(page.evaluate('qa.images[1]'));assert ImageChops.difference(guided,expected).getbbox() is not None
        page.evaluate('qa.holdDialog=true');page.keyboard.down('Alt');page.keyboard.press('Enter')
        page.wait_for_function('!!qa.releaseDialog');page.keyboard.up('Alt');page.evaluate('qa.releaseDialog()');page.wait_for_function('qa.images.length===3')
        assert ImageChops.difference(image(page.evaluate('qa.images[2]')),expected).getbbox() is not None,'Dialog lost held Alt'
        for action in ['Копировать в буфер обмена','Закрепить на экране']:
          count=page.evaluate('qa.images.length');page.keyboard.down('Alt');page.get_by_title(action,exact=True).click();page.keyboard.up('Alt')
          page.wait_for_function('n=>qa.images.length===n',arg=count+1)
          assert ImageChops.difference(image(page.evaluate('qa.images.at(-1)')),expected).getbbox() is not None,('Toolbar lost Alt',action)
        page.keyboard.down('Alt');page.keyboard.press('Space');page.keyboard.up('Alt');page.wait_for_function('qa.images.length===6')
        assert ImageChops.difference(image(page.evaluate('qa.images.at(-1)')),expected).getbbox() is not None
        page.keyboard.down('Alt');page.evaluate('window.dispatchEvent(new Event("blur"))');expect(page.locator('.capture__guides')).to_have_count(0);page.keyboard.up('Alt')
        # Both palette rows and anchoring are measured after layout, not inferred from CSS.
        page.locator('[data-tool-anchor=arrow]').click()
        expect(page.locator('.capture__opts-title')).to_have_count(0)
        expect(page.locator('.capture__opts-swatches').first.locator('button')).to_have_count(10)
        page.get_by_role('button',name='Цвет #000000',exact=True).click()
        page.get_by_role('button',name='Цвет #b000ff',exact=True).click()
        page.wait_for_timeout(150);panel=page.locator('.capture__opts').bounding_box();anchor=page.locator('[data-tool-anchor=arrow]').bounding_box()
        assert abs(panel['x']+panel['width']/2-anchor['x']-anchor['width']/2)<2,(panel,anchor)
        drag(page,(360,230),(610,370))
        point=page.locator('[data-kp="2"]').bounding_box();page.mouse.move(point['x']+point['width']/2,point['y']+point['height']/2);page.mouse.down()
        page.mouse.move(680,280);page.keyboard.down('Shift');page.wait_for_timeout(80)
        a=page.locator('[data-kp="1"]').bounding_box();b=page.locator('[data-kp="2"]').bounding_box();assert abs(a['y']-b['y'])<1
        page.keyboard.up('Shift');page.wait_for_timeout(80);b=page.locator('[data-kp="2"]').bounding_box();assert abs(b['y']-a['y'])>20;page.mouse.up()
        # Hover opens the menu; clicking a location exports exactly once.
        count=page.evaluate('qa.images.length');page.get_by_title('Сохранить как файл',exact=True).hover();page.wait_for_timeout(300)
        expect(page.locator('.capture__quick')).to_be_visible();page.locator('.capture__quick-item').first.hover();page.wait_for_timeout(200)
        expect(page.locator('.capture__quick')).to_be_visible();assert page.evaluate('qa.images.length')==count
        page.locator('.capture__quick-item').first.click();page.wait_for_function('n=>qa.images.length===n',arg=count+1)
        page.screenshot(path=str(OUT/f'{theme}-{scale}.png'))
        assert not errors,errors;results.append({'theme':theme,'dpi':scale,'sourcePixelsExact':True,'guides':True,'palette':True,'endpointShift':True,'hoverSave':True})
        page.close()
    # History with a different aspect ratio, restored working annotations, and keyboard remapping.
    source=Image.new('RGB',(1280,900),(30,60,100));buf=io.BytesIO();source.save(buf,format='PNG');png=base64.b64encode(buf.getvalue()).decode()
    old=Image.new('RGB',(600,300),(180,30,90));buf=io.BytesIO();old.save(buf,format='PNG');oldpng=base64.b64encode(buf.getvalue()).decode()
    page=browser.new_page(viewport={'width':1280,'height':900});page.add_init_script(f'({BRIDGE})({json.dumps(dict(png=png,scale=1,theme="dark"))})')
    page.add_init_script(f"qa.history=[{{id:'old1',width:600,height:300,originX:-300,originY:0,selection:{{x:100,y:50,width:200,height:100}}}}];qa.historyPng={json.dumps(oldpng)};qa.config={{screenshotCopyHotkey:'Control+K'}};")
    page.goto('http://127.0.0.1:1420/?snipcast=capture');page.wait_for_function("document.querySelector('.capture--presented')");drag(page,(100,100),(1100,700))
    page.locator('[data-tool-anchor=arrow]').click();drag(page,(350,230),(600,400));before=page.locator('.capture__shapes').evaluate('c=>c.toDataURL()')
    page.keyboard.press('c');assert not page.evaluate('qa.images');page.keyboard.press('Control+k');page.wait_for_function('qa.images.length===1')
    page.keyboard.press('-');expect(page.locator('.capture__dimchip')).to_contain_text('История 1/1');expect(page.locator('.capture__opts')).to_have_count(0)
    bounds=page.locator('.capture__shot').bounding_box();assert abs(bounds['width']/bounds['height']-2)<.001
    page.keyboard.press('Control+k');page.wait_for_function('qa.images.length===2');assert image(page.evaluate('qa.images[1]')).size==(200,100)
    page.keyboard.press('+');expect(page.locator('.capture__dimchip')).not_to_contain_text('История');assert before==page.locator('.capture__shapes').evaluate('c=>c.toDataURL()')
    page.keyboard.press('Control+z');assert before!=page.locator('.capture__shapes').evaluate('c=>c.toDataURL()')
    page.keyboard.press('NumpadSubtract');expect(page.locator('.capture__dimchip')).to_contain_text('История 1/1')
    page.set_viewport_size({'width':900,'height':1280});page.keyboard.press('NumpadAdd');expect(page.locator('.capture__dimchip')).not_to_contain_text('История')
    page.keyboard.press('Control+k');page.wait_for_function('qa.images.length===3');assert image(page.evaluate('qa.images[2]')).size==(1000,600)
    page.keyboard.press('NumpadSubtract');expect(page.locator('.capture__dimchip')).to_contain_text('История 1/1')
    page.keyboard.press('NumpadAdd');expect(page.locator('.capture__dimchip')).not_to_contain_text('История')
    page.keyboard.press('Control+k');page.wait_for_function('qa.images.length===4');assert image(page.evaluate('qa.images[3]')).size==(1000,600)
    # A slower earlier request cannot replace the newer requested record.
    page.add_init_script("qa.history.push({...qa.history[0],id:'old2',selection:{x:150,y:50,width:100,height:100}});qa.delays={old1:400,old2:10}")
    page.reload();page.wait_for_function("document.querySelector('.capture--presented')");drag(page,(100,100),(700,500))
    page.keyboard.press('NumpadSubtract');page.keyboard.press('NumpadSubtract');expect(page.locator('.capture__dimchip')).to_contain_text('История 2/2')
    page.wait_for_timeout(500);expect(page.locator('.capture__dimchip')).to_contain_text('История 2/2')
    page.keyboard.press('Control+k');page.wait_for_function('qa.images.length===1');assert image(page.evaluate('qa.images[0]')).size==(100,100)
    # A damaged record is skipped automatically, without blocking navigation.
    page.add_init_script("qa.corrupt=['old1'];qa.delays={}");page.reload();page.wait_for_function("document.querySelector('.capture--presented')")
    page.keyboard.press('NumpadSubtract');expect(page.locator('.capture__dimchip')).to_contain_text('История 1/1')
    results.append({'historyAspectRatio':True,'workingAnnotationsAndUndo':True,'remappedCopy':True,'numpad':True,'viewportResizeAndRepeatedReturn':True,'staleLoadIgnored':True,'corruptRecordSkipped':True})
    browser.close()
(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
