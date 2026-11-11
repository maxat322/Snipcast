"""Regression for command palette keys after focus moves to preview/body."""
import ast,json,os,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.qa-work/commands-keyboard-20261030/ui';OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/commands_ui.py').read_text(encoding='utf8'))
BRIDGE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='msedge');page=browser.new_page(viewport={'width':728,'height':400});page.add_init_script('('+BRIDGE+')()');page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=commands');page.wait_for_load_state('networkidle');page.set_default_timeout(1500)
 def opening(section='root'):
  if section!='root':
   page.evaluate("qa.events['snipcast://commands-open']({payload:'root'})");expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible()
  page.evaluate("s=>qa.events['snipcast://commands-open']({payload:s})",section)
  expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_focused()
  if section=='clipboard':expect(page.locator('.commands__content pre')).to_be_visible()
  page.evaluate('qa.calls=[]')
 def calls(command,action=None):
  return page.evaluate('([c,a])=>qa.calls.filter(x=>x.command===c&&(!a||x.args.action===a)).length',[command,action])
 def check(name,fn):
  try:fn();results.append({'name':name,'passed':True});print('PASS',name,flush=True)
  except Exception:results.append({'name':name,'passed':False,'error':traceback.format_exc()});print('FAIL',name,flush=True)
 def preview_enter():
  opening('clipboard');page.locator('.commands__content pre').click();assert page.evaluate('document.activeElement===document.body');page.keyboard.press('Enter');page.wait_for_function("qa.calls.some(x=>x.command==='snipcast_history_action'&&x.args.action==='paste')");assert calls('snipcast_history_action','paste')==1
 def preview_escape():
  opening('clipboard');page.locator('.commands__content pre').click();page.keyboard.press('Escape');expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible();assert calls('snipcast_commands_hide')==0;page.keyboard.press('Escape');assert calls('snipcast_commands_hide')==1
 def dismissed_error():
  opening();page.evaluate("qa.events['snipcast://commands-error']({payload:'QA error'})");page.get_by_role('alert').get_by_role('button',name='×').click();assert page.evaluate('document.activeElement===document.body');page.keyboard.press('Escape');assert calls('snipcast_commands_hide')==1
 def repeated_open():
  opening('clipboard')
  for _ in range(5):
   before=calls('snipcast_history_list');page.evaluate("qa.events['snipcast://commands-open']({payload:'clipboard'})")
   page.wait_for_function("n=>qa.calls.filter(x=>x.command==='snipcast_history_list').length>n",arg=before)
   expect(page.locator('.commands__content pre')).to_be_visible();expect(page.locator('.commands__history [role=option]')).to_have_count(1)
 def emoji_body():
  opening('emoji');page.get_by_role('textbox',name='Поиск',exact=True).fill('grinning face');expect(page.locator('.commands__emoji [role=option]')).not_to_have_count(0)
  page.locator('.palette__hints > span').first.click();assert page.evaluate('document.activeElement===document.body');page.keyboard.press('Enter');page.wait_for_function("qa.calls.some(x=>x.command==='snipcast_commands_text'&&x.args.paste)");assert calls('snipcast_commands_text')==1
  opening('emoji');page.locator('.palette__hints > span').first.click();page.keyboard.press('Escape');expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible()
 def dialogs():
  opening('clipboard');page.keyboard.press('Control+j');expect(page.get_by_role('dialog',name='Действия',exact=True)).to_be_visible();page.keyboard.press('Escape');expect(page.get_by_role('dialog')).to_have_count(0);expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_focused();assert calls('snipcast_commands_hide')==0
  page.keyboard.press('Control+j');page.get_by_role('button',name='Переименовать',exact=True).click();field=page.get_by_label('Название записи');field.fill('Renamed');field.press('Enter');expect(page.get_by_role('dialog')).to_have_count(0);assert calls('snipcast_history_action','rename')==1;assert calls('snipcast_history_action','paste')==0
  page.keyboard.press('Control+j');page.get_by_role('button',name='Переименовать',exact=True).click();page.keyboard.press('Escape');expect(page.get_by_role('dialog')).to_have_count(0);assert calls('snipcast_commands_hide')==0
 def emoji_arrows():
  opening('emoji');search=page.get_by_role('textbox',name='Поиск',exact=True);expect(search).to_be_focused();grid=page.locator('.commands__emoji');assert grid.locator('[aria-selected=true]').get_attribute('aria-posinset')=='1';search.press('ArrowRight');assert grid.locator('[aria-selected=true]').get_attribute('aria-posinset')=='2';search.press('ArrowDown');assert grid.locator('[aria-selected=true]').get_attribute('aria-posinset')=='9';search.press('ArrowLeft');assert grid.locator('[aria-selected=true]').get_attribute('aria-posinset')=='8';search.fill('smile');search.press('ArrowRight');assert grid.locator('[aria-selected=true]').get_attribute('aria-posinset')=='2';search.press('Control+ArrowLeft');assert search.evaluate('(e)=>e.selectionStart')==0;search.press('Enter');assert calls('snipcast_commands_text')==1
 def header_back():
  opening('root');page.get_by_role('option',name='Переводчик Команда').click();back=page.get_by_role('button',name='Назад',exact=True);expect(back.locator('svg')).to_have_count(1);title=page.locator('.palette__search-wrap').get_by_text('Переводчик',exact=True);assert abs((back.bounding_box()['y']+back.bounding_box()['height']/2)-(title.bounding_box()['y']+title.bounding_box()['height']/2))<5;assert page.get_by_text('Переводчик',exact=True).count()==1;back.click();expect(page.get_by_role('tab',name='Все',exact=True)).to_be_visible()
 def visible_commands():
  opening('root');expect(page.locator('.commands__results [role=option] .palette__item-title')).to_have_count(4);assert set(page.locator('.commands__results [role=option] .palette__item-title').all_text_contents())=={'Буфер обмена','Emoji','Калькулятор','Переводчик'};search=page.get_by_label('Поиск',exact=True);search.fill('Палитра шаблонов');expect(page.locator('.commands__results [role=option]')).to_have_count(0);search.fill('Настройки');expect(page.locator('.commands__results [role=option]')).to_have_count(0);search.fill('Cursor');expect(page.get_by_role('option',name='Cursor Приложение')).to_be_visible();search.fill('Emoji');expect(page.get_by_role('option',name='Emoji Команда')).to_be_visible()
 def direct_open():
  for index,section in enumerate(['clipboard','emoji','translate'],start=100):
   page.evaluate("([s,i])=>qa.events['snipcast://commands-open']({payload:{id:i,section:s}})",[section,index]);expect(page.get_by_label('Назад')).to_have_count(0);expect(page.locator('footer.palette__hints')).to_contain_text('закрыть');page.evaluate('qa.calls=[]');page.keyboard.press('Escape');assert calls('snipcast_commands_hide')==1
 def outside():
  opening('root');page.evaluate("qa.events['tauri://blur']({payload:null})");page.wait_for_function("qa.calls.some(x=>x.command==='snipcast_commands_hide')")
 for name,fn in [('back icon and title on one row',header_back),('only requested commands appear in root and search',visible_commands),('Emoji arrows navigate from search',emoji_arrows),('direct commands close on Esc',direct_open),('focus loss closes palette',outside),('Enter after clicking clipboard preview',preview_enter),('Esc after preview click, then close root',preview_escape),('Esc after dismissing an error',dismissed_error),('reopening clipboard reloads items each time',repeated_open),('Emoji Enter/Esc after focus leaves search',emoji_body),('modal Enter/Esc keep their own actions',dialogs)]:check(name,fn)
 page.screenshot(path=str(OUT/'keyboard.png'));browser.close()
(OUT/'result.json').write_text(json.dumps(results,indent=2),encoding='utf8')
raise SystemExit(any(not x['passed'] for x in results))

