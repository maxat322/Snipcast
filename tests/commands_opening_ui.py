"""Delayed IPC / viewport regressions. Native hotkeys are checked separately."""
import ast,json,os,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/commands-opening-20261030/ui';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/commands_ui.py').read_text(encoding='utf8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
EXT=r'''(() => {
 const original=window.__TAURI_INTERNALS__.invoke;
 qa.pending=[];qa.ready=[];qa.hold=false;qa.catalogHold=false;
 window.__TAURI_INTERNALS__.invoke=async(c,a={})=>{
  if(c==='snipcast_commands_ready')qa.ready.push({id:a.id,section:document.querySelector('.palette__search')?.getAttribute('placeholder'),buttons:document.querySelectorAll('.commands__emoji [role=option]').length});
  if(c==='snipcast_commands_catalog'&&qa.catalogHold){qa.catalogHold=false;const value=await original(c,a);return new Promise(resolve=>qa.catalogResolve=()=>resolve(value));}
  if(c==='snipcast_history_list'&&qa.hold){qa.calls.push({command:c,args:a});return new Promise((resolve,reject)=>qa.pending.push({args:a,resolve,reject}));}
  return original(c,a);
 };
})()'''
results=[];errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='msedge')
 def setup(extra=''):
  page=browser.new_page(viewport={'width':728,'height':400});page.set_default_timeout(2500);page.set_default_navigation_timeout(30000)
  page.on('pageerror',lambda e:errors.append(str(e)));page.add_init_script('('+BRIDGE+')();'+EXT+';'+extra)
  page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=command-tool')
  page.wait_for_function("!!window.qa?.events['snipcast://commands-open']")
  return page
 def opening(page,section,id=None):
  page.evaluate("r=>qa.events['snipcast://commands-open']({payload:r})",section if id is None else {'id':id,'section':section})
 def resolve(page,index,text):
  page.evaluate("([i,t])=>qa.pending[i].resolve({items:[{...qa.clips[0],title:t,text:t}],total:1,status:''})",[index,text])
 def check(name,fn):
  try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
  except Exception:results.append({'name':name,'passed':False,'error':traceback.format_exc()});print('FAIL',name,results[-1]['error'][-850:],flush=True)
  finally:
   for page in browser.contexts[:]:page.close()
 def ready():
  page=setup();opening(page,'emoji',10);page.wait_for_function('qa.ready.length===1');assert page.evaluate('qa.ready[0].section')=='Поиск — Emoji';assert 0<page.evaluate('qa.ready[0].buttons')<140
  page.evaluate("qa.events['snipcast://commands-open']({payload:{id:12,section:'clipboard'}});qa.events['snipcast://commands-open']({payload:{id:11,section:'emoji'}})")
  expect(page.get_by_label('Тип записей')).to_be_visible();page.wait_for_function('qa.ready.some(x=>x.id===12)');assert not page.evaluate('qa.ready.some(x=>x.id===11)')
 def startup():
  page=setup('qa.catalogHold=true');page.wait_for_function('!!qa.catalogResolve');opening(page,'emoji');expect(page.get_by_label('Категория Emoji')).to_be_visible();page.evaluate('qa.catalogResolve()');page.wait_for_timeout(200);expect(page.get_by_label('Категория Emoji')).to_be_visible()
 def viewport():
  page=setup();opening(page,'emoji');grid=page.locator('.commands__emoji');expect(grid).to_be_visible();assert 0<grid.get_by_role('option').count()<140
  total=int(grid.get_by_role('option').first.get_attribute('aria-setsize'));assert total>1500
  grid.evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_function("(()=>{const e=[...document.querySelectorAll('.commands__emoji [role=option]')].at(-1);return e?.getAttribute('aria-posinset')===e?.getAttribute('aria-setsize')})()")
  last=grid.get_by_role('option').last;value=last.text_content();last.click();page.wait_for_function("v=>qa.calls.some(x=>x.command==='snipcast_commands_text'&&x.args.text===v)",arg=value)
  page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Часто используемые').click();expect(grid.get_by_role('option')).to_have_count(1);expect(grid.get_by_role('option')).to_be_visible()
  page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Все категории').click();search=page.get_by_role('textbox',name='Поиск',exact=True);search.focus()
  for _ in range(25):search.press('ArrowDown')
  expect(grid.locator('[aria-selected=true]')).to_be_in_viewport();assert int(grid.locator('[aria-selected=true]').get_attribute('aria-posinset'))==170
  page.set_viewport_size({'width':900,'height':650});expect(grid.locator('[aria-selected=true]')).to_be_in_viewport();page.screenshot(path=str(OUT/'emoji.png'))
 def coalesce():
  page=setup();page.evaluate('qa.hold=true');opening(page,'clipboard');page.wait_for_function('qa.pending.length===1')
  page.evaluate("for(let i=0;i<30;i++)qa.events['snipcast://clipboard-changed']({payload:null})");assert page.evaluate('qa.pending.length')==1
  resolve(page,0,'first');expect(page.locator('.commands__history')).to_contain_text('first');page.wait_for_function('qa.pending.length===2');resolve(page,1,'latest');expect(page.locator('.commands__history')).to_contain_text('latest');assert page.evaluate('qa.pending.length')==2
 def stale():
  page=setup();page.evaluate('qa.hold=true');opening(page,'clipboard');page.wait_for_function('qa.pending.length===1');page.get_by_role('textbox',name='Поиск',exact=True).fill('new');page.wait_for_function('qa.pending.length===2');resolve(page,1,'new result');resolve(page,0,'old result');expect(page.locator('.commands__history')).to_contain_text('new result');expect(page.locator('.commands__history')).not_to_contain_text('old result')
  opening(page,'emoji');page.evaluate("qa.pending[0].reject('late error')");expect(page.get_by_role('alert')).to_have_count(0)
 def timeout():
  page=setup();page.evaluate('qa.hold=true');opening(page,'clipboard');page.wait_for_function('qa.pending.length===1');expect(page.get_by_role('button',name='Повторить')).to_be_visible(timeout=10500);expect(page.locator('.commands__history')).to_contain_text('Не удалось загрузить историю');expect(page.get_by_role('alert').get_by_role('button',name='×')).to_have_count(0)
  page.get_by_role('button',name='Повторить').click();page.wait_for_function('qa.pending.length===2');resolve(page,1,'recovered');resolve(page,0,'late');expect(page.locator('.commands__history')).to_contain_text('recovered');expect(page.get_by_role('alert')).to_have_count(0)
 def categories_menu():
  page=setup();opening(page,'emoji');box=page.get_by_role('combobox',name='Категория Emoji');box.click();menu=page.get_by_role('listbox',name='Категория Emoji');expect(menu).to_be_visible();assert menu.locator('.commands__category-icon').count()==11;rect=menu.bounding_box();assert rect['y']>=0 and rect['y']+rect['height']<=400;page.screenshot(path=str(OUT/'categories-dark.png'));box.press('End');expect(menu.get_by_role('option',name='Флаги')).to_be_in_viewport();box.press('Enter');expect(box).to_contain_text('Флаги');box.press('Enter');box.press('Escape');expect(menu).to_have_count(0);assert page.get_by_role('combobox',name='Категория Emoji').is_visible();page.evaluate("document.documentElement.dataset.appTheme='light'");box.click();page.screenshot(path=str(OUT/'categories-light.png'));page.locator('.commands__emoji').click(position={'x':10,'y':10});expect(menu).to_have_count(0)
 def frequent():
  page=setup();page.evaluate("qa.usage=Object.fromEntries(Array.from({length:25},(_,i)=>['emoji:'+String.fromCodePoint(0x1f600+i),[100-i,1]]))");opening(page,'emoji');page.wait_for_function("document.querySelectorAll('.commands__emoji [role=option]').length>21");first=page.locator('.commands__emoji [role=option]');assert [first.nth(i).text_content() for i in range(21)]==[chr(0x1f600+i) for i in range(21)];expect(grid_header:=page.locator('.commands__emoji .palette__item-preview')).to_have_count(2);assert grid_header.all_text_contents()==['Часто используемые','Все'];assert first.nth(21).text_content()==first.nth(0).text_content();search=page.get_by_role('textbox',name='Поиск',exact=True);search.press('ArrowDown');search.press('ArrowDown');search.press('ArrowDown');assert page.locator('.commands__emoji [aria-selected=true]').get_attribute('aria-posinset')=='22';search.press('ArrowUp');assert page.locator('.commands__emoji [aria-selected=true]').get_attribute('aria-posinset')=='15';page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Часто используемые').click();expect(page.locator('.commands__emoji [role=option]')).to_have_count(21)
 def reopen():
  page=setup();page.evaluate('qa.hold=true');opening(page,'clipboard');page.wait_for_function('qa.pending.length===1');opening(page,'clipboard');page.wait_for_function('qa.pending.length===2');resolve(page,1,'reopened');resolve(page,0,'obsolete');expect(page.locator('.commands__history')).to_contain_text('reopened');expect(page.locator('.commands__history')).not_to_contain_text('Загрузка…')
 for name,fn in [('ready only after requested view commits; newest request wins',ready),('slow startup cannot overwrite hotkey view',startup),('Emoji bounded DOM, last row, filter, keyboard and resize',viewport),('clipboard change burst coalesces without starving first result',coalesce),('out-of-order search ignored',stale),('hung IPC stops loading; retry recovers without reopening',timeout),('category menu icons, scroll, keyboard, themes and outside click',categories_menu),('popular section limited to 21 followed by complete list',frequent),('reopen while old request pending',reopen)]:check(name,fn)
 browser.close()
(OUT/'result.json').write_text(json.dumps({'checks':results,'pageErrors':errors},indent=2),encoding='utf8')
raise SystemExit(any(not r['passed'] for r in results) or bool(errors))
