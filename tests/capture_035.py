"""Cross-monitor pixels, capture shortcuts, freehand/axis constraints and exact OCR sums."""
import ast, base64, io, json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect
from capture_text import drag

ROOT=Path(__file__).resolve().parents[1]
tree=ast.parse((ROOT/'tests/capture_assist.py').read_text(encoding='utf8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
EXTRA=r'''scale=>{
 const original=window.__TAURI_INTERNALS__.invoke;
 qa.commands=[];qa.pngs=[];qa.saved=[];qa.dialog=null;qa.ocr='1 234,56\n−234.56\n0,10\n0.20';
 window.__TAURI_INTERNALS__.invoke=async(cmd,args={})=>{
  qa.commands.push({cmd,args});
  if(cmd==='snipcast_capture_info'){const info=await original(cmd,args);return {...info,sessionId:info.imageName,
    monitors:[{x:-1600,y:-200,width:640*scale,height:900*scale,scale},{x:-1600+640*scale,y:-200,width:640*scale,height:900*scale,scale:scale===1?2:1}]};}
  if(cmd==='snipcast_capture_copy'){qa.pngs.push(args.png);return;}
  if(cmd==='snipcast_capture_move_cursor')return {x:-1000,y:0};
  if(cmd==='plugin:dialog|save')return qa.dialog;
  if(cmd==='snipcast_capture_save'){qa.saved.push(args);return;}
  if(cmd==='snipcast_ocr_region'){if(qa.failOcr)throw Error('OCR unavailable');return qa.ocr;}
  return original(cmd,args);
 };
}'''

def fixture(browser,scale=1):
    image=Image.new('RGB',(round(1280*scale),round(900*scale)),(18,52,86))
    image.paste((30,70,100),(round(640*scale),0,image.width,image.height))
    buf=io.BytesIO();image.save(buf,format='PNG')
    page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=scale)
    page.set_default_timeout(5000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(f'({BRIDGE})({json.dumps({"png":base64.b64encode(buf.getvalue()).decode(),"scale":scale,"theme":"dark"})});({EXTRA})({scale});')
    page.goto('http://localhost:1420/?snipcast=capture');page.wait_for_function("document.querySelector('.capture--presented')")
    return page,errors

def decode(page):return Image.open(io.BytesIO(base64.b64decode(page.evaluate('qa.pngs.at(-1)')))).convert('RGB')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);results=[]
    for scale in (1,1.5,2):
        page,errors=fixture(browser,scale)
        page.mouse.move(500,200);page.keyboard.press('ArrowRight');page.keyboard.press('ArrowDown')
        assert page.evaluate("qa.commands.filter(c=>c.cmd==='snipcast_capture_move_cursor').map(c=>c.args)")==[{'dx':1,'dy':0},{'dx':0,'dy':1}]
        drag(page,(400,200),(900,600));toolbar=page.locator('.capture__toolbar').bounding_box()
        assert toolbar['x']>=640 and toolbar['x']+toolbar['width']<=1280,toolbar
        page.keyboard.press('c');page.wait_for_function('qa.pngs.length===1&&qa.closed===1')
        img=decode(page);assert img.size==(round(500*scale),round(400*scale))
        assert img.getpixel((2,2))==(18,52,86) and img.getpixel((img.width-3,2))==(30,70,100)
        assert not errors,errors;page.close();results.append(f'two monitor crop/DPI {scale}, mixed monitor scale metadata')
    page,errors=fixture(browser);drag(page,(100,100),(1200,650))
    for key,title in [('1','Нарисовать стрелку (1)'),('2','Нарисовать линию (2)'),('3','Нарисовать фигуру (3)'),('4','Свободное рисование (4)'),('5','Добавить текст (5)')]:
        page.keyboard.press(key);expect(page.get_by_title(title,exact=True)).to_have_class('capture__btn is-active')
    page.keyboard.press('2');page.keyboard.down('Shift');drag(page,(200,200),(480,240));page.keyboard.up('Shift')
    page.keyboard.press('c');page.wait_for_function('qa.pngs.length===1')
    img=decode(page);assert img.getpixel((250,100))[0]>200 and img.getpixel((250,140))==(18,52,86)
    page.keyboard.press('Control+z');page.keyboard.press('Control+Shift+z');page.keyboard.press('Control+z')
    page.keyboard.press('4');page.mouse.move(220,300);page.mouse.down()
    for x,y in [(250,330),(280,310),(310,345),(330,320)]:page.mouse.move(x,y);page.wait_for_timeout(20)
    page.keyboard.down('Shift');page.mouse.move(500,340);page.wait_for_timeout(30);page.mouse.up();page.keyboard.up('Shift')
    page.keyboard.press('c');page.wait_for_function('qa.pngs.length===2')
    img=decode(page);assert img.getpixel((300,200))[0]>200 and img.getpixel((180,230))==(18,52,86)
    page.keyboard.press('Control+z');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===3')
    img=decode(page);assert img.getpixel((300,200))==(18,52,86)
    page.keyboard.press('Control+Shift+z');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===4');assert decode(page).getpixel((300,200))[0]>200
    assert not errors,errors;page.close();results.append('numeric tools, axis Shift, freehand one-step undo/redo, PNG')
    page,errors=fixture(browser);drag(page,(100,100),(1200,650))
    page.keyboard.press('4');page.mouse.move(220,300);page.mouse.down()
    page.mouse.move(260,330);page.wait_for_timeout(30)
    page.keyboard.down('Shift');page.mouse.move(240,540);page.wait_for_timeout(40)
    page.keyboard.up('Shift');page.mouse.move(280,560);page.wait_for_timeout(40);page.mouse.up()
    page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',key:'с',bubbles:true}))")
    page.wait_for_function('qa.pngs.length===1');img=decode(page)
    assert img.getpixel((120,350))[0]>200,img.getpixel((120,350))
    assert any(img.getpixel((x,450))[0]>200 for x in range(120,181)),[img.getpixel((x,450)) for x in range(120,181,10)]
    assert img.getpixel((160,230))==(18,52,86)
    page.keyboard.press('Escape');page.keyboard.press('Escape')
    drag(page,(220,450),(270,490));page.keyboard.press('c');page.wait_for_function('qa.pngs.length===2')
    assert decode(page).getpixel((170,390))[0]>200
    page.keyboard.press('Delete');page.keyboard.press('c');page.wait_for_function('qa.pngs.length===3')
    assert decode(page).getpixel((170,390))==(18,52,86)
    page.keyboard.press('Control+z');page.keyboard.press('5');page.mouse.click(700,250)
    editor=page.locator('.capture__text-edit');editor.fill('Текст')
    page.keyboard.press('1');page.keyboard.press('Enter');page.keyboard.press('ArrowLeft')
    expect(editor).to_be_visible();assert editor.input_value().startswith('Текст1\n')
    page.keyboard.press('c');page.wait_for_timeout(80);assert page.evaluate('qa.pngs.length')==3
    assert not errors,errors;page.close();results.append('vertical Shift, resumed freehand, move/delete/history, physical Russian KeyC, input hotkey guards')
    page,errors=fixture(browser);drag(page,(100,100),(1200,650))
    page.get_by_title('Сложить распознанные числа',exact=True).click();page.wait_for_function('qa.copied.length===1');assert page.evaluate('qa.copied[0]')=='1000,3'
    assert page.evaluate('qa.closed')==0
    page.evaluate("qa.ocr='letters only'");page.get_by_title('Сложить распознанные числа',exact=True).click();expect(page.get_by_role('status')).to_contain_text('Числа не найдены');assert page.evaluate('qa.copied.length')==1
    page.evaluate('qa.failOcr=true');page.get_by_title('Сложить распознанные числа',exact=True).click();expect(page.get_by_role('status')).to_contain_text('OCR unavailable');assert page.evaluate('qa.copied.length')==1
    cases={'0.1 0.2':'0,3','−12,50\n2.5':'-10','1\u00a0234,50 0,5':'1235','99999999999999999999,99 0,01':'100000000000000000000','12.34.56':None,'foo':None,'-0,00':'0'}
    for text,expected in cases.items():
        result=page.evaluate("async text=>(await import('/src/capture/sumNumbers.ts')).sumNumbers(text)",text)
        assert (result['sum'] if result else None)==expected,(text,result,expected)
    page.keyboard.press('Enter');page.wait_for_function("qa.commands.some(c=>c.cmd==='plugin:dialog|save')");assert page.evaluate('qa.closed')==0
    page.evaluate("qa.dialog='C:/qa/test.png'");page.keyboard.press('Enter');page.wait_for_function('qa.saved.length===1&&qa.closed===1')
    assert not errors,errors;page.close();results.append('OCR sum exact decimal/errors, Enter cancel/save')
    browser.close();print(json.dumps({'passed':results}))
