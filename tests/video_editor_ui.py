"""Focused video UI checks; no screen recording, native encoder or export files."""
import base64,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work'/'video-editor-ui';OUT.mkdir(parents=True,exist_ok=True)
clip=base64.b64encode((ROOT/'tests/fixtures/save-menu-preview.mp4').read_bytes()).decode()
BRIDGE="""clip=>{window.qa={calls:[]};window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'video-editor'},currentWebview:{label:'video-editor'}},
convertFileSrc:()=>`data:video/mp4;base64,${clip}`,transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
qa.calls.push({command,args});if(command==='plugin:event|listen')return 1;
if(command==='snipcast_video_status')return {id:1,phase:'editing',durationMs:5000,bytes:1024,width:32,height:32,fps:10,audio:false,exportPercent:0};
if(command==='snipcast_get_config')return {theme:'dark',screenshotQuickLocations:[{name:'QA folder',path:'C:/qa'}]};
if(command==='plugin:dialog|save')return null;
if(command==='snipcast_capture_save_path')return 'qa.mp4';
if(command==='snipcast_video_export')return {path:'qa.mp4'};
}};}"""
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':960,'height':720});errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.add_init_script(f'({BRIDGE})({json.dumps(clip)})');page.goto('http://127.0.0.1:1420/?snipcast=video-editor')
  save=page.locator('.video-save');expect(save).to_be_enabled();page.wait_for_function('document.querySelector("video").readyState>=2')
  quality=page.get_by_role('combobox',name='Качество видео');expect(quality).to_contain_text('Компактно')
  compact_size=page.locator('.video-export__size').inner_text()
  quality.click();expect(page.get_by_role('option')).to_have_count(4)
  page.get_by_role('option',name='Лучшее',exact=True).click();expect(quality).to_contain_text('Лучшее')
  assert page.locator('.video-export__size').inner_text()!=compact_size
  expect(page.locator('.video-export__size')).to_have_text('Размер зависит от видео')
  page.locator('.video-format button').nth(1).click();expect(quality).to_have_count(0)
  page.locator('.video-format button').nth(0).click();expect(quality).to_contain_text('Лучшее')
  quality.press('Enter');quality.press('Home');quality.press('Enter');expect(quality).to_contain_text('Компактно')
  quality.press('Enter');quality.press('End');quality.press('Enter');expect(quality).to_contain_text('Лучшее')
  page.screenshot(path=str(OUT/'best-quality.png'))
  save.hover();page.wait_for_timeout(300);expect(page.locator('.video-quick')).to_be_visible()
  page.get_by_role('menuitem').hover();page.wait_for_timeout(200);expect(page.locator('.video-quick')).to_be_visible()
  assert not page.evaluate('qa.calls.some(c=>c.command==="snipcast_video_export")')
  page.mouse.move(0,0);page.wait_for_timeout(200);expect(page.locator('.video-quick')).to_have_count(0)
  save.click();page.wait_for_timeout(100);assert page.evaluate('qa.calls.filter(c=>c.command==="plugin:dialog|save").length')==1
  page.get_by_role('button',name='Обрезать кадр',exact=True).click();expect(save).to_be_disabled();save.hover(force=True);page.wait_for_timeout(300);expect(page.locator('.video-quick')).to_have_count(0)
  page.get_by_role('button',name='Отменить обрезку',exact=True).click()
  # The changed pointer handlers are checked directly on a small video fixture.
  strip=page.locator('.video-filmstrip');box=strip.bounding_box();y=box['y']+box['height']/2
  page.mouse.click(box['x']+8+(box['width']-16)*.6,y);position=strip.evaluate('e=>getComputedStyle(e).getPropertyValue("--play-position")')
  start=page.get_by_role('slider',name='Начало фрагмента',exact=True)
  page.mouse.move(box['x']+8,y);page.mouse.down();page.mouse.move(box['x']+8+(box['width']-16)*.25,y,steps=8)
  expect(page.locator('.video-filmstrip__playhead')).to_be_hidden();assert abs(float(start.input_value())-1.25)<.03
  page.mouse.up();expect(page.locator('.video-filmstrip__playhead')).to_be_visible();page.wait_for_timeout(200)
  assert strip.evaluate('e=>getComputedStyle(e).getPropertyValue("--play-position")')==position
  save.hover();page.wait_for_timeout(300);page.get_by_role('menuitem').click()
  page.wait_for_function('qa.calls.some(c=>c.command==="snipcast_video_export")')
  assert page.evaluate('qa.calls.filter(c=>c.command==="snipcast_video_export").length')==1
  assert page.evaluate('qa.calls.find(c=>c.command==="snipcast_video_export").args.options.quality')=='best'
  assert not errors,errors
  browser.close()
result={'bestQualitySelectionAndExport':True,'qualityKeyboardNavigation':True,'qualitySurvivesFormatSwitch':True,'sizeEstimateUpdates':True,'hoverDelay':True,'menuTransition':True,'noExportOnHover':True,'leaveCloses':True,'normalClick':True,'disabledButton':True,'trimPointerAndCursor':True,'oneClickOneExport':True}
(OUT/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result))
