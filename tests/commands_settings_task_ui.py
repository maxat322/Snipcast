import ast,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1];out=root/'.qa-work/commands-settings-task-20261030';out.mkdir(parents=True,exist_ok=True)
tree=ast.parse((root/'tests/commands_ui.py').read_text(encoding='utf8'));bridge=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='msedge');page=browser.new_page(viewport={'width':1180,'height':700});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.add_init_script('('+bridge+')()');page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=settings');page.wait_for_load_state('networkidle');page.get_by_role('button',name='Команды',exact=True).click()
 panel=page.locator('.commands-settings');expect(panel.locator('.commands-settings__name strong')).to_have_text(['Приложения','Буфер обмена','Emoji','Переводчик','Калькулятор']);expect(panel.get_by_role('heading',name='Команды')).to_be_visible();expect(panel.locator('.commands-settings__heading')).to_have_count(0);expect(page.get_by_label('Поиск команд в настройках')).to_have_count(0);expect(page.locator('.commands-settings__nav')).to_have_count(0);expect(panel.get_by_placeholder('Псевдоним')).to_have_count(0);expect(page.get_by_label('Горячая клавиша: Палитра команд')).to_have_count(0)
 # Legacy config has no group switches: both are enabled in the UI.
 master=panel.get_by_role('switch',name='Включить команды',exact=True);apps=panel.get_by_role('switch',name='Включить приложения',exact=True)
 expect(master).to_have_attribute('aria-checked','true');expect(apps).to_have_attribute('aria-checked','true')
 expect(panel.locator('.commands-settings__name > span').first).to_have_text('💻')
 expect(panel.locator('.commands-settings__configure svg')).to_have_count(5)
 empty=panel.get_by_label('Горячая клавиша: Калькулятор');expect(empty).to_have_attribute('placeholder','Назначить сочетание')
 original=page.evaluate('structuredClone(qa.config.commands.items)')
 for control in [apps,master,apps,master]:
  before=control.get_attribute('aria-checked');control.click();expect(control).to_have_attribute('aria-checked','false' if before=='true' else 'true')
  expect(control).to_be_enabled()
 assert page.evaluate('qa.config.commands.enabled') and page.evaluate('qa.config.commands.applicationsEnabled')
 assert page.evaluate('qa.config.commands.items')==original
 page.evaluate('qa.failSave=true');master.click();expect(panel.get_by_role('alert')).to_contain_text('Комбинация занята');expect(master).to_have_attribute('aria-checked','true');page.evaluate('qa.failSave=false')
 master.click();expect(master).to_have_attribute('aria-checked','false');expect(master).to_be_enabled();master.click();expect(master).to_have_attribute('aria-checked','true')
 for theme in ['dark','light']:
  page.evaluate('(theme)=>document.documentElement.dataset.appTheme=theme',theme)
  page.set_viewport_size({'width':880,'height':640});page.screenshot(path=str(out/f'commands-{theme}.png'))
  # At the settings window minimum width, placeholder and clear button still fit.
  page.set_viewport_size({'width':720,'height':640})
  assert empty.evaluate("e=>{const s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;return c.measureText(e.placeholder).width<=e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)}")
  assert panel.evaluate('e=>e.scrollWidth<=e.clientWidth')
  page.screenshot(path=str(out/f'commands-min-{theme}.png'))
 page.set_viewport_size({'width':1180,'height':700})
 for name,label in [('Буфер обмена','Хранить историю'),('Emoji','Колонок'),('Переводчик','Исходный язык')]:
  panel.get_by_role('button',name='Настроить: '+name).click();expect(page.get_by_label(label)).to_be_visible();back=panel.get_by_role('button',name='Назад',exact=True);heading=panel.locator('.commands-settings__section-header h2');assert abs(back.bounding_box()['y']+back.bounding_box()['height']/2-heading.bounding_box()['y']-heading.bounding_box()['height']/2)<2;page.get_by_role('button',name='Назад',exact=True).click()
 panel.get_by_role('button',name='Настроить: Калькулятор').click();expect(page.get_by_role('heading',name='Калькулятор')).to_be_visible();page.get_by_role('button',name='Назад',exact=True).click();panel.get_by_role('button',name='Настроить: Приложения',exact=True).click();expect(page.get_by_text('Дополнительные папки (одна на строку)')).to_be_visible();page.get_by_role('button',name='Назад',exact=True).click();page.screenshot(path=str(out/'commands.png'))
 page.get_by_role('button',name='Основные',exact=True).click();field=page.get_by_label('Горячая клавиша: Палитра команд');expect(field).to_have_value('Alt+Space');field.focus();field.press('Control+Shift+KeyL');page.wait_for_timeout(1000);print('hotkey after recording:',page.evaluate('qa.config.commands.hotkey'),flush=True);page.wait_for_function("qa.config.commands.hotkey!=='Alt+Space'",timeout=3000);field.blur();page.get_by_role('button',name='Вернуть по-умолчанию').click();page.wait_for_function("qa.config.commands.hotkey==='Alt+Space'");page.screenshot(path=str(out/'general.png'));assert not errors,errors;browser.close()
print('PASS settings task: sections, controls, command settings, hotkey save and reset')
