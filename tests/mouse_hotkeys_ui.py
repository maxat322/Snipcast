"""Mouse shortcut fields: focus click, chords, side buttons and native recorder."""
import ast,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/mouse-hotkeys-03618/ui';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/preset_autosave.py').read_text(encoding='utf8'))
def literal(name):return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)==name for t in n.targets))
WRAP=r'''window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
qa.mouseRecordingEvents=[];qa.events={};const original=window.__TAURI_INTERNALS__.invoke,callbacks={};
const transform=window.__TAURI_INTERNALS__.transformCallback;
window.__TAURI_INTERNALS__.transformCallback=(callback,once)=>{const id=transform(callback,once);callbacks[id]=callback;return id};
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 if(command==='snipcast_mouse_hotkey_recording')qa.mouseRecordingEvents.push(args.active);
 if(command==='plugin:event|listen')qa.events[args.event]=callbacks[args.handler];
 if(command==='snipcast_save_config'&&qa.failNext){qa.failNext=false;throw Error('Не удалось сохранить сочетание');}
 return original(command,args);
};'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='msedge');results=[]
 for theme in ['dark','light']:
  config=literal('CONFIG');config.update(theme=theme,paletteHotkey='Shift+Backslash',screenshotHotkey='PrintScreen')
  page=browser.new_page(viewport={'width':1000,'height':900});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  page.add_init_script('('+literal('BRIDGE')+')('+json.dumps(config)+');'+WRAP)
  page.goto('http://127.0.0.1:1420/?snipcast=settings');page.get_by_role('button',name='Основные',exact=True).click()
  field=page.get_by_label('Запись хоткея палитры',exact=True);field.click();expect(field).to_have_value('Shift+\\');assert page.evaluate('qa.config.paletteHotkey')=='Shift+Backslash'
  field.dispatch_event('mousedown',{'button':2,'buttons':2,'altKey':True});expect(field).to_have_value('Alt+ПКМ');assert page.evaluate('qa.config.paletteHotkey')=='Alt+MouseRight'
  field.dispatch_event('mousedown',{'button':0,'buttons':1});expect(field).to_have_value('Alt+ПКМ')
  field.dispatch_event('mousedown',{'button':2,'buttons':3});expect(field).to_have_value('ЛКМ+ПКМ');assert page.evaluate('qa.config.paletteHotkey')=='MouseLeft+MouseRight'
  field.dispatch_event('mousedown',{'button':3,'buttons':8,'ctrlKey':True});expect(field).to_have_value('Ctrl+Мышь 4');assert page.evaluate('qa.config.paletteHotkey')=='CommandOrControl+Mouse4'
  page.evaluate('window.dispatchEvent(new Event("blur"))');expect(field).not_to_be_focused();page.wait_for_function('qa.mouseRecordingEvents.at(-1)===false');field.click()
  page.evaluate('qa.failNext=true');field.dispatch_event('mousedown',{'button':1,'buttons':4,'shiftKey':True});expect(field).to_have_value('Ctrl+Мышь 4');assert page.evaluate('qa.config.paletteHotkey')=='CommandOrControl+Mouse4'
  screenshot=page.get_by_label('Запись хоткея скриншота',exact=True);screenshot.click();screenshot.dispatch_event('mousedown',{'button':4,'buttons':16,'ctrlKey':True});expect(screenshot).to_have_value('Ctrl+Мышь 5');assert page.evaluate('qa.config.screenshotHotkey')=='CommandOrControl+Mouse5'
  shared=page.get_by_label('Горячая клавиша: Скриншот: копировать в буфер',exact=True);shared.click();shared.dispatch_event('mousedown',{'button':2,'buttons':2,'altKey':True});expect(shared).to_have_value('Alt+ПКМ');assert page.evaluate('qa.config.screenshotCopyHotkey')=='Alt+MouseRight'
  shared.click();page.wait_for_function('!!qa.events["snipcast://mouse-hotkey-recorded"]');page.evaluate('qa.events["snipcast://mouse-hotkey-recorded"]({payload:"Control+Mouse5"})');expect(shared).to_have_value('Ctrl+Мышь 5')
  page.evaluate('qa.failNext=true');shared.click();shared.dispatch_event('mousedown',{'button':1,'buttons':4,'ctrlKey':True});expect(shared).to_have_value('Ctrl+Мышь 5');assert page.evaluate('qa.config.screenshotCopyHotkey')=='Control+Mouse5'
  page.get_by_role('group',name='Горячие клавиши',exact=True).scroll_into_view_if_needed();page.screenshot(path=str(OUT/(theme+'.png')));assert not errors,errors
  page.get_by_role('button',name='Скриншот',exact=True).click();preset=page.locator('input.settings__preset-hotkey').first;preset.click();preset.dispatch_event('mousedown',{'button':2,'buttons':2,'altKey':True});expect(preset).to_have_value('Alt+ПКМ');page.wait_for_function('qa.config.screenshotPresets[0].hotkey==="Alt+MouseRight"')
  page.evaluate('qa.failNext=true');preset.dispatch_event('mousedown',{'button':3,'buttons':8,'ctrlKey':True});expect(preset).to_have_value('Alt+ПКМ');assert page.evaluate('qa.config.screenshotPresets[0].hotkey')=='Alt+MouseRight'
  results.append({'theme':theme,'passed':True,'focusClickIgnored':True,'altRight':True,'leftRight':True,'ctrlSide4And5':True,'sharedField':True,'nativeRecorder':True,'failedSavePreserved':True});page.close()
 browser.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print(json.dumps(results))
