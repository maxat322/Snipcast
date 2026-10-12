"""Selection, detection and exact source-pixel tests through a controlled Tauri bridge."""
import base64
import io
import json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect
from capture_text import BASE, drag

OUT = Path(__file__).resolve().parents[1] / "dist" / "capture-assist-qa"
OUT.mkdir(parents=True, exist_ok=True)

BRIDGE = r"""({png, scale, theme}) => {
  const callbacks=new Map(), listeners=new Map(); let id=0;
  const bytes=Uint8Array.from(atob(png), c=>c.charCodeAt(0)).buffer;
  window.qa={session:1, copied:[], ready:[], presets:[], closed:0, held:false, release:null};
  qa.emit=(event,payload)=>{for(const [key,l] of listeners) if(l.event===event) callbacks.get(l.handler)?.({event,id:key,payload})};
  const rect=(id,kind,x,y,w,h,windowOrder,depth,parent=null)=>({id,kind,x:-1600+x*scale,y:-200+y*scale,width:w*scale,height:h*scale,windowOrder,depth,parent});
  qa.candidates=[rect(1,'window',50,50,900,650,0,0),rect(2,'window',0,0,1280,900,1,0),
    rect(3,'element',100,100,220,50,0,2,1),rect(4,'element',120,110,100,25,0,3,3),rect(5,'element',100,100,300,70,1,6,2)];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_,key)=>listeners.delete(key)};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'capture-0'},currentWebview:{windowLabel:'capture-0'}},
    transformCallback:cb=>{callbacks.set(++id,cb);return id},unregisterCallback:key=>callbacks.delete(key),
    invoke:async(command,args={})=>{
      if(command==='plugin:event|listen'){listeners.set(++id,args);return id}
      if(command==='plugin:event|unlisten')return;
      if(command==='snipcast_get_config')return {theme,screenshotQuickLocations:[],screenshotFormat:'png'};
      if(command==='snipcast_capture_info')return {label:'capture-0',imageName:`frame-${qa.session}.png`,x:-1600,y:-200,width:1280*scale,height:900*scale,scale,candidates:qa.candidates,
        ...(qa.preset?{preset:{title:'QA',action:'save',dir:'test',fileTemplate:'test'}}:{})};
      if(command==='snipcast_capture_image_data'){if(qa.held)await new Promise(r=>qa.release=r);return bytes.slice(0)}
      if(command==='snipcast_capture_ready'){qa.ready.push(args.imageName);setTimeout(()=>qa.emit('snipcast://capture-shown',args.imageName),0);return}
      if(command==='snipcast_clipboard_write_text'){qa.copied.push(args.text);return}
      if(command==='snipcast_close_capture'){qa.closed++;return}
      if(command==='snipcast_capture_save_path')return 'test.png';
      if(command==='snipcast_capture_save'){qa.presets.push(args);return}
      throw Error(`Unexpected command ${command}`);
    }};
}"""

def fixture(browser, scale=1, theme="dark"):
    image=Image.new("RGB", (round(1280*scale),round(900*scale)), (18,52,86))
    image.putpixel((round(150*scale),round(120*scale)), (255,128,0))
    buf=io.BytesIO(); image.save(buf,format="PNG")
    page=browser.new_page(viewport={"width":1280,"height":900},device_scale_factor=scale)
    page.set_default_timeout(5000)
    errors=[]; page.on("pageerror",lambda e: errors.append(str(e)))
    page.add_init_script(f"({BRIDGE})({json.dumps({'png':base64.b64encode(buf.getvalue()).decode(),'scale':scale,'theme':theme})})")
    page.goto(BASE); page.wait_for_load_state("networkidle")
    page.wait_for_function("document.querySelector('.capture').classList.contains('capture--presented')")
    return page,errors

def reset(page, **settings):
    page.evaluate("s=>{Object.assign(qa,s);qa.session++;qa.emit('snipcast://capture-session')}",settings)
    page.wait_for_function("qa.ready.includes(`frame-${qa.session}.png`)")
    page.wait_for_function("document.querySelector('.capture').classList.contains('capture--presented')")

def box(page):
    return page.locator('.capture__frame').bounding_box()

def check_box(page,x,y,w,h):
    b=box(page)
    for key,val in zip(('x','y','width','height'),(x,y,w,h)):
        # Frame border extends around the declared region.
        assert abs(b[key]-val)<=4,(b,key,val)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    passed=[]
    for scale in (1,1.5,2):
        for theme in ('dark','light'):
            page,errors=fixture(browser,scale,theme)
            page.mouse.move(150,120)
            expect(page.locator('.capture__loupe-color')).to_contain_text('#FF8000')
            expect(page.locator('.capture__loupe-shortcuts')).to_contain_text('Shift RGB / HEX')
            expect(page.locator('.capture__loupe-shortcuts')).to_contain_text('C копировать цвет')
            assert page.locator('.capture__shortcuts kbd').all_text_contents()==['Tab','A','← ↑ ↓ →','Esc']
            expect(page.locator('.capture__hint--top')).to_have_text('Выберите область...')
            positions=page.locator('.capture__loupe-coordinates span').evaluate_all('els=>els.map(el=>({left:el.offsetLeft,width:el.offsetWidth}))')
            assert positions[1]['left']-positions[0]['left']-positions[0]['width']<=8,positions
            shortcut_rows=page.locator('.capture__shortcuts > div').evaluate_all('els=>els.map(el=>el.offsetTop)')
            assert all(b>a for a,b in zip(shortcut_rows,shortcut_rows[1:])),shortcut_rows
            expect(page.locator('.capture__loupe-coordinates')).to_contain_text(f'X: {-1600+round(150*scale)}')
            check_box(page,120,110,100,25)
            assert page.locator('.capture__toolbar').count()==0
            page.keyboard.press('Tab'); expect(page.locator('.capture__shortcuts')).to_have_attribute('data-mode','window')
            check_box(page,50,50,900,650)
            page.keyboard.press('Tab'); check_box(page,120,110,100,25)
            page.keyboard.down('Shift'); page.keyboard.down('Shift')
            expect(page.locator('.capture__loupe-color')).to_contain_text('rgb(255, 128, 0)')
            page.keyboard.up('Shift')
            page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'с',code:'KeyC',bubbles:true}))")
            page.wait_for_function("qa.copied.at(-1)==='rgb(255, 128, 0)'")
            page.keyboard.press('Shift'); page.keyboard.press('c')
            page.wait_for_function("qa.copied.at(-1)==='#FF8000'")
            page.keyboard.press('Control+c'); assert len(page.evaluate('qa.copied'))==2
            # Small jitter is a click; toolbar waits for release.
            page.mouse.down(); page.mouse.move(152,121)
            assert page.locator('.capture__toolbar').count()==0
            page.mouse.up(); page.locator('.capture__toolbar').wait_for(); check_box(page,120,110,100,25)
            assert page.locator('.capture__loupe').count()==0
            reset(page)
            page.mouse.move(150,120); page.mouse.down(); page.mouse.move(430,350,steps=6)
            assert page.locator('.capture__toolbar').count()==0
            expect(page.locator('.capture__loupe')).to_be_visible()
            expect(page.locator('.capture__shortcuts')).to_have_attribute('data-mode','drag')
            page.keyboard.press('Tab'); page.mouse.up()
            page.locator('.capture__toolbar').wait_for(); check_box(page,150,120,280,230)
            # New selection cancellation restores the previous completed region.
            page.mouse.move(1000,750); page.mouse.down(); page.mouse.move(1100,800)
            page.keyboard.press('Escape'); page.mouse.up(); check_box(page,150,120,280,230)
            reset(page,candidates=[])
            page.mouse.click(500,400); assert page.locator('.capture__toolbar').count()==0
            drag(page,(500,400),(507,407)); assert page.locator('.capture__toolbar').count()==0
            page.mouse.move(1279,899)
            expect(page.locator('.capture__loupe')).to_be_visible()
            b=page.locator('.capture__loupe').bounding_box()
            assert b['x']>=0 and b['y']>=0 and b['x']+b['width']<=1280 and b['y']+b['height']<=900,b
            page.screenshot(path=str(OUT/f'{theme}-{scale}.png'))
            # Pixel sampling at a boundary stays on the source rather than shifting the centre.
            expect(page.locator('.capture__loupe-color')).to_contain_text('#123456')
            page.evaluate("qa.held=true;qa.session++;qa.emit('snipcast://capture-session')")
            page.wait_for_function('qa.release!==null')
            assert page.locator('.capture__loupe,.capture__frame,.capture__toolbar').count()==0
            page.evaluate('qa.held=false;qa.release()')
            page.wait_for_function('qa.ready.includes(`frame-${qa.session}.png`)')
            assert not errors,errors
            page.close(); passed.append(f'{theme} @ {scale}')
    page,errors=fixture(browser)
    # Background discovery can arrive after the overlay is already interactive.
    original=page.evaluate('qa.candidates')
    reset(page,candidates=[c for c in original if c['kind']=='window'])
    page.mouse.move(150,120);check_box(page,50,50,900,650)
    page.evaluate("c=>qa.emit('snipcast://capture-candidates',{imageName:`frame-${qa.session}.png`,candidates:c})",original)
    page.wait_for_function("document.querySelector('.capture__frame').style.width==='100px'")
    check_box(page,120,110,100,25)
    # A late reply from an older capture must never replace current proposals.
    page.evaluate("qa.emit('snipcast://capture-candidates',{imageName:'stale.png',candidates:[{id:4,parent:1,kind:'element',x:-1600,y:-200,width:10,height:10,windowOrder:0,depth:99}]})")
    check_box(page,120,110,100,25)
    reset(page,candidates=[])
    assert page.locator('.capture__frame').count()==0
    page.close();assert not errors,errors
    page,errors=fixture(browser)
    reset(page,preset=True)
    page.mouse.click(150,120)
    page.wait_for_function('qa.presets.length===1 && qa.closed===1')
    assert not errors,errors
    page.close()
    page,errors=fixture(browser)
    reset(page,preset=True)
    page.mouse.move(150,120);page.keyboard.press('a')
    page.wait_for_function('qa.presets.length===1 && qa.closed===1')
    page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,code:'KeyA',key:'a',repeat:true}))")
    assert page.evaluate('qa.presets.length')==1
    assert not errors,errors;page.close();browser.close()
    print(json.dumps({'passed':passed,'preset':'one-click save exactly once'}))
