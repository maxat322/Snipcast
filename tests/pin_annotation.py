"""Pin menu and annotation regressions with an exact PNG and controlled Tauri bridge."""
import base64
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect
from capture_text import drag

OUT=Path(__file__).resolve().parents[1]/'dist'/'pin-annotation-qa'
OUT.mkdir(parents=True,exist_ok=True)
BASE='http://localhost:1420/'

BRIDGE=r"""({png,label,theme,holdImage})=>{
 const callbacks=new Map(), listeners=new Map();let id=0;
 const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0)).buffer;
 window.qa={calls:[],copied:[],updated:[],files:[],dialogPath:'C:/qa/annotation.png',failSave:false,failFile:false,failMenu:false,dragged:0,closed:0,geometry:{x:120,y:160,width:640,height:400}};
 qa.emit=(event,payload)=>{for(const [key,l] of listeners)if(l.event===event)callbacks.get(l.handler)?.({event,id:key,payload})};
 window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_,key)=>listeners.delete(key)};
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label},currentWebview:{windowLabel:label}},transformCallback:cb=>{callbacks.set(++id,cb);return id},unregisterCallback:key=>callbacks.delete(key),
 invoke:async(command,args={})=>{
  qa.calls.push({command,args});
  if(command==='plugin:event|listen'){listeners.set(++id,args);return id}
  if(command==='plugin:event|unlisten')return;
  if(command==='snipcast_pin_info')return {label,imageName:'pin.png',width:640,height:400};
  if(command==='snipcast_capture_image_data')return holdImage?new Promise(resolve=>{qa.releaseImage=()=>resolve(bytes.slice(0))}):bytes.slice(0);
  if(command==='snipcast_pin_ready'){const img=document.querySelector('.pin__shot');qa.readyImage={complete:img?.complete,width:img?.naturalWidth};return}
  if(command==='snipcast_get_config')return {theme,screenshotQuickLocations:[{name:'QA',path:'C:/qa'}]};
  if(command==='plugin:dialog|save')return qa.dialogPath;
  if(command==='snipcast_capture_save_path')return 'C:/qa/quick.png';
  if(command==='snipcast_capture_save'){if(qa.failFile)throw Error('Controlled file failure');qa.files.push(args);return}
  if(command==='snipcast_pin_begin_annotation')return {...qa.geometry,sessionId:1,revision:0};
  if(command==='snipcast_pin_end_annotation')return 1;
  if(command==='snipcast_pin_present')return;
  if(command==='snipcast_pin_update'){if(qa.failSave)throw Error('Controlled save failure');qa.updated.push(args.png);return}
  if(command==='snipcast_capture_copy'){qa.copied.push(args.png);return}
  if(command==='snipcast_pin_menu'||command==='snipcast_pin_regions')return;
  if(command==='snipcast_pin_menu_action'){if(qa.failMenu)throw Error('Controlled menu failure');return}
  if(command==='plugin:window|set_size'||command==='plugin:window|set_position'||command==='plugin:window|set_focus')return;
  if(command==='plugin:window|outer_position')return {x:qa.geometry.x,y:qa.geometry.y};
  if(command==='plugin:window|outer_size')return {width:qa.geometry.width,height:qa.geometry.height};
  if(command==='plugin:window|start_dragging'){qa.dragged++;return}
  if(command==='plugin:window|close'){qa.closed++;return}
  throw Error(`Unexpected command ${command}`);
 }};
}"""

def fixture(browser,theme='dark',scale=1,label='pin-qa',hold_image=False):
    image=Image.new('RGB',(640,400),(18,52,86))
    draw=ImageDraw.Draw(image);draw.rectangle((0,0,20,20),fill=(20,220,80));draw.rectangle((619,379,639,399),fill=(80,20,220))
    buf=io.BytesIO();image.save(buf,format='PNG')
    page=browser.new_page(viewport={'width':640,'height':610},device_scale_factor=scale)
    page.set_default_timeout(5000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(f"({BRIDGE})({json.dumps({'png':base64.b64encode(buf.getvalue()).decode(),'label':label,'theme':theme,'holdImage':hold_image})})")
    page.goto(BASE);page.wait_for_load_state('networkidle')
    return page,errors

def open_editor(page):
    page.evaluate("qa.emit('snipcast://pin-annotate')")
    page.locator('.capture__toolbar').wait_for()
    assert page.locator('.pin').count()==0
    assert page.locator('[data-handle],.capture__loupe').count()==0
    assert page.locator('.capture__toolbar button').count()==9
    return page.locator('.capture__shot').bounding_box()

def decode(png):return Image.open(io.BytesIO(base64.b64decode(png))).convert('RGB')

def restored(page):
    page.locator('.pin').wait_for()
    page.wait_for_function("qa.calls.filter(c=>c.command==='snipcast_pin_present'&&c.args.revision===1).length===qa.calls.filter(c=>c.command==='snipcast_pin_end_annotation').length")
    calls=page.evaluate('qa.calls')
    endings=[c for c in calls if c['command']=='snipcast_pin_end_annotation']
    assert endings and endings[-1]['args']=={'sessionId':1},endings
    assert page.evaluate('qa.closed')==0

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    results=[]
    page,errors=fixture(browser,hold_image=True)
    assert page.locator('.pin__shot,.pin__stub').count()==0
    assert not page.evaluate("qa.calls.some(c=>c.command==='snipcast_pin_ready')")
    assert page.locator('.pin').evaluate('el=>getComputedStyle(el).backgroundImage')=='none'
    page.evaluate('qa.releaseImage()');page.wait_for_function('qa.readyImage?.complete&&qa.readyImage.width===640')
    assert not errors,errors;page.close();results.append('delayed PNG: transparent loading, first show only after decoded image')
    page,errors=fixture(browser,label='pinmenu')
    expect(page.get_by_role('button')).to_have_count(4)
    page.get_by_role('button',name='Копировать',exact=True).click()
    assert page.evaluate("qa.calls.some(c=>c.command==='snipcast_pin_menu_action'&&c.args.action==='copy')")
    page.get_by_role('button',name='Аннотировать',exact=True).click()
    assert page.evaluate("qa.calls.some(c=>c.command==='snipcast_pin_menu_action'&&c.args.action==='annotate')")
    page.evaluate('qa.failMenu=true');page.get_by_role('button',name='Копировать',exact=True).click()
    expect(page.get_by_role('alert')).to_be_visible()
    assert not errors,errors;page.close();results.append('menu copy/annotate dispatch and error')
    for theme in ('dark','light'):
        for scale in (1,1.5,2):
            page,errors=fixture(browser,theme,scale)
            image_box=open_editor(page)
            x=image_box['x'];y=image_box['y'];w=image_box['width'];h=image_box['height']
            page.get_by_title('Нарисовать линию (2)',exact=True).click()
            drag(page,(x+w*.2,y+h*.25),(x+w*.65,y+h*.55))
            page.keyboard.press('Control+z');page.keyboard.press('Control+Shift+z')
            page.get_by_title('Добавить текст (5)',exact=True).click()
            page.mouse.click(x+w*.3,y+h*.7)
            page.locator('.capture__text-edit').fill('Закреп QA')
            # Copy commits live text and keeps the editor and pin open.
            page.get_by_title('Копировать в буфер обмена',exact=True).click()
            page.wait_for_function('qa.copied.length===1')
            copied=decode(page.evaluate('qa.copied[0]'))
            assert copied.size==(640,400),copied.size
            assert copied.getpixel((1,1))==(20,220,80)
            assert copied.getpixel((638,398))==(80,20,220)
            pixels=copied.get_flattened_data() if hasattr(copied,'get_flattened_data') else copied.getdata()
            assert any(r>150 and r>g*1.4 and r>b*1.3 for r,g,b in pixels),'No exported annotations'
            assert page.locator('.capture__toolbar').count()==1
            page.get_by_title('Сохранить как файл',exact=True).click()
            page.wait_for_function('qa.files.length===1')
            assert decode(page.evaluate('qa.files[0].png')).tobytes()==copied.tobytes()
            assert page.evaluate('qa.updated.length===0&&qa.closed===0')
            page.keyboard.press('Control+c');page.wait_for_timeout(30)
            assert page.evaluate('qa.copied.length')==1
            page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',key:'с',bubbles:true}))")
            page.wait_for_function('qa.copied.length===2')
            assert decode(page.evaluate('qa.copied[1]')).tobytes()==copied.tobytes()
            page.get_by_title('Применить аннотации к закрепу',exact=True).click()
            restored(page)
            saved=decode(page.evaluate('qa.updated[0]'))
            assert saved.tobytes()==copied.tobytes()
            assert page.evaluate('qa.dragged')==0
            # Reopen edits use the updated PNG and cancellation preserves it.
            before=page.locator('.pin__shot').get_attribute('src')
            open_editor(page)
            page.get_by_title('Нарисовать фигуру (3)',exact=True).click()
            drag(page,(100,100),(210,190))
            page.screenshot(path=str(OUT/f'{theme}-{scale}.png'))
            page.get_by_title('Отменить аннотирование',exact=True).click()
            restored(page)
            assert page.locator('.pin__shot').get_attribute('src')==before
            assert len(page.evaluate('qa.updated'))==1
            assert not errors,errors;page.close();results.append(f'{theme} @ {scale}: file export/physical C/copy/apply/reopen/cancel')
    page,errors=fixture(browser);open_editor(page)
    page.evaluate('qa.dialogPath=null');page.keyboard.press('Enter');page.wait_for_timeout(80)
    assert page.evaluate('qa.files.length===0&&qa.updated.length===0&&qa.closed===0')
    page.evaluate("qa.dialogPath='C:/qa/annotation.png';qa.failFile=true")
    page.keyboard.press('Enter');expect(page.get_by_role('status')).to_contain_text('Controlled file failure')
    assert page.locator('.capture__toolbar').count()==1
    page.evaluate('qa.failFile=false')
    button=page.get_by_title('Сохранить как файл',exact=True);box=button.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down()
    quick=page.locator('.capture__quick-item');quick.wait_for()
    q=quick.bounding_box();page.mouse.move(q['x']+q['width']/2,q['y']+q['height']/2);page.mouse.up()
    page.wait_for_function('qa.files.length===1');assert page.evaluate('qa.files[0].path')=='C:/qa/quick.png'
    assert page.locator('.capture__toolbar').count()==1 and page.evaluate('qa.closed')==0
    page.get_by_title('Добавить текст (5)',exact=True).click();page.mouse.click(220,200)
    editor=page.locator('.capture__text-edit');editor.fill('Текст');page.keyboard.press('c')
    assert editor.input_value()=='Текстc' and page.evaluate('qa.copied.length')==0
    page.keyboard.press('Enter');expect(editor).to_be_visible();assert page.evaluate('qa.files.length')==1
    assert not errors,errors;page.close();results.append('file dialog cancel/error, hold quick save, C/Enter preserve text entry')
    page,errors=fixture(browser)
    open_editor(page);page.evaluate('qa.failSave=true')
    page.get_by_title('Применить аннотации к закрепу',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Controlled save failure')
    assert page.locator('.capture__toolbar').count()==1
    page.keyboard.press('Escape');restored(page)
    assert page.evaluate('qa.updated')==[]
    assert not errors,errors;page.close();results.append('failed save keeps editor; Esc cancels')
    browser.close();print(json.dumps({'passed':results}))
