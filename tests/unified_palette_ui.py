import ast,json,os,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1];out=root/'.qa-work/unified-palette-20261030';out.mkdir(parents=True,exist_ok=True)
tree=ast.parse((root/'tests/commands_ui.py').read_text(encoding='utf8'));bridge=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
ext=r'''(()=>{qa.entries.push({id:'screenshot',title:'Скриншот',kind:'command',icon:'▣',keywords:'screenshot capture снимок',target:'',count:0,lastUsed:0});const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(c,a={})=>{if(c==='snipcast_list_templates')return qa.emptyTemplates?[]:[{id:'t1',title:'Emoji заметка',preview:'текст шаблона',pasteText:'template-result',groupId:'g',groupTitle:'Основное'},{id:'t2',title:'Второй шаблон',preview:'пример',pasteText:'second-result',groupId:'g2',groupTitle:'Промпты'}];return original(c,a)}})()'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='msedge');page=browser.new_page(viewport={'width':728,'height':400});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.add_init_script('('+bridge+')();'+ext);page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420'));page.wait_for_load_state('networkidle');search=page.get_by_role('textbox');expect(search).to_have_attribute('placeholder','Поиск шаблонов, команд и приложений...');expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_be_visible();assert page.get_by_role('option',name='Emoji Команда').count()==0
 # Commands is the last group chip; it lists enabled commands without a query.
 expect(page.get_by_role('tab')).to_have_text(['Все','Основное','Промпты','Команды'])
 commands=page.get_by_role('tab',name='Команды',exact=True);commands.click()
 expect(commands).to_have_attribute('aria-selected','true');expect(page.get_by_role('option')).to_have_count(4)
 expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_have_count(0)
 expect(page.get_by_role('option',name='Cursor Приложение')).to_have_count(0)
 search.press('ArrowDown');expect(page.locator('#snipcast-listbox [role=option]').nth(1)).to_have_attribute('aria-selected','true')
 search.press('ArrowUp');expect(page.locator('#snipcast-listbox [role=option]').nth(0)).to_have_attribute('aria-selected','true')
 labels=page.locator('#snipcast-listbox [role=option]').all_text_contents();emoji_index=next(i for i,label in enumerate(labels) if 'Emoji' in label)
 for _ in range(emoji_index):search.press('ArrowDown')
 search.press('Enter');expect(page.get_by_label('Категория Emoji')).to_be_visible();page.keyboard.press('Escape')
 expect(commands).to_have_attribute('aria-selected','true');expect(search).to_have_value('')
 search.fill('Emoji');expect(page.get_by_role('option',name='Emoji Команда')).to_be_visible();expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_have_count(0)
 search.fill('Cursor');expect(page.get_by_role('option',name='Cursor Приложение')).to_be_visible()
 search.fill('12+11');expect(page.locator('#snipcast-calculation')).to_contain_text('23')
 search.fill('');page.screenshot(path=str(out/'commands-chip.png'))
 page.get_by_role('tab',name='Основное',exact=True).click();search.fill('Emoji')
 expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_be_visible();expect(page.get_by_role('option',name='Emoji Команда')).to_have_count(0)
 page.get_by_role('tab',name='Все',exact=True).click();search.fill('')
 search.press('Shift+Tab');expect(commands).to_have_attribute('aria-selected','true');search.press('Tab');expect(page.get_by_role('tab',name='Все',exact=True)).to_have_attribute('aria-selected','true')
 # An empty command list must still let Tab/Shift+Tab change groups.
 page.evaluate("qa.savedItems=structuredClone(qa.config.commands.items);for(const id of ['clipboard','emoji','translate','calculator'])qa.config.commands.items[id]={enabled:false,alias:'',hotkey:''};qa.events['snipcast://commands-catalog']({payload:null})")
 commands.click();expect(page.locator('#snipcast-listbox [role=option]')).to_have_count(0);search.press('Shift+Tab');expect(page.get_by_role('tab',name='Промпты',exact=True)).to_have_attribute('aria-selected','true')
 page.evaluate("qa.config.commands.items=qa.savedItems;qa.events['snipcast://commands-catalog']({payload:null})")
 commands.click();page.evaluate("qa.config.commands.enabled=false;qa.events['snipcast://commands-catalog']({payload:null})")
 expect(commands).to_have_count(0);expect(page.get_by_role('tab',name='Все',exact=True)).to_have_attribute('aria-selected','true');expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_be_visible()
 page.evaluate("qa.config.commands.enabled=true;qa.events['snipcast://commands-catalog']({payload:null})");expect(commands).to_be_visible()
 commands.click();page.evaluate("qa.events['snipcast://palette-open']({payload:null})")
 expect(commands).to_be_visible();expect(page.get_by_role('tab',name='Все',exact=True)).to_have_attribute('aria-selected','true')
 assert page.evaluate("!qa.events['snipcast://unified-palette-mode']"), 'Legacy mode switching must not be registered'
 search.fill('Emoji');expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_be_visible();expect(page.get_by_role('option',name='Emoji Команда')).to_be_visible();page.screenshot(path=str(out/'mixed.png'));search.press('ArrowDown');search.press('Enter');expect(page.get_by_label('Категория Emoji')).to_be_visible();assert not page.evaluate("qa.calls.some(x=>x.command==='snipcast_commands_text')"), 'Opening Emoji must not paste immediately';assert not page.evaluate("qa.calls.some(x=>x.command==='palette_hide')"), 'Opening Emoji must not hide the palette';assert not page.evaluate("qa.calls.some(x=>x.command==='snipcast_commands_run'&&x.args.id==='emoji')");page.keyboard.press('Escape');expect(search).to_be_visible();expect(search).to_be_focused();expect(search).to_have_value('Emoji');search.fill('Буфер обмена');search.press('Enter');expect(page.get_by_role('option',name='Тест истории')).to_be_visible();page.keyboard.press('Escape');expect(search).to_be_visible();search.fill('Переводчик');search.press('Enter');expect(page.locator('.commands__translator')).to_be_visible();page.get_by_role('button',name='Назад').click();expect(search).to_be_visible();search.fill('Калькулятор');search.press('Enter');expect(page.get_by_placeholder('Введите выражение…')).to_be_visible();page.keyboard.press('Escape');expect(search).to_be_visible()
 search.fill('Второй');search.press('Enter');page.wait_for_function("qa.calls.some(x=>x.command==='paste_template'&&x.args.text==='second-result')")
 search.fill('12/0');expect(page.get_by_role('status')).to_contain_text('На ноль делить нельзя');search.fill('12+11');expect(page.locator('#snipcast-calculation')).to_contain_text('23');expect(page.locator('#snipcast-calculation')).to_contain_text('Выражение');expect(page.locator('#snipcast-calculation')).to_contain_text('Результат');search.press('Enter');page.wait_for_function("qa.calls.some(x=>x.command==='snipcast_commands_text'&&x.args.text==='23'&&!x.args.paste)");search.fill('Cursor');expect(page.get_by_role('option',name='Cursor Приложение')).to_be_visible();search.fill('Настройки');expect(page.get_by_role('option',name='Настройки Команда')).to_have_count(0)
 for enabled,applications in [(True,False),(False,True),(False,False),(True,True)]:
  page.evaluate('([enabled,apps])=>{Object.assign(qa.config.commands,{enabled,applicationsEnabled:apps});qa.events["snipcast://commands-catalog"]({payload:null})}',[enabled,applications])
  search.fill('Cursor');expect(page.get_by_role('option',name='Cursor Приложение')).to_have_count(1 if enabled and applications else 0)
  search.fill('Emoji');expect(page.get_by_role('option',name='Emoji Команда')).to_have_count(1 if enabled else 0);expect(page.get_by_role('option',name='Emoji заметка текст шаблона')).to_be_visible()
  search.fill('12+11');expect(page.locator('#snipcast-calculation')).to_have_count(1 if enabled else 0)
 search.fill('Буфер обмена');search.press('Enter')
 expect(page.locator('.commands__history .palette__item-row > span:first-child')).to_have_text(['📄'])
 page.evaluate('qa.rootSectionsBefore=qa.calls.filter(x=>x.command==="snipcast_commands_section"&&x.args.section==="root").length;qa.config.commands.enabled=false;qa.events["snipcast://commands-catalog"]({payload:null})')
 expect(search).to_be_visible();assert page.evaluate('qa.calls.filter(x=>x.command==="snipcast_commands_section"&&x.args.section==="root").length')==page.evaluate('qa.rootSectionsBefore')
 expect(page.locator('.commands__history')).to_have_count(0);expect(search).to_be_visible();search.fill('Второй');expect(page.get_by_role('option').filter(has_text='Второй шаблон')).to_be_visible()
 page.evaluate("qa.events['snipcast://palette-open']({payload:null})");expect(search).to_have_attribute('placeholder','Поиск шаблонов, команд и приложений...');expect(search).to_have_value('')
 # Opening the main palette again resets an embedded tool to the unified root.
 page.evaluate("qa.config.commands.enabled=true;qa.events['snipcast://commands-catalog']({payload:null})")
 search.fill('Буфер обмена');search.press('Enter');expect(page.locator('.commands__history')).to_be_visible()
 page.evaluate("qa.events['snipcast://palette-open']({payload:null})");expect(page.locator('.commands__history')).to_have_count(0);expect(search).to_have_value('')
 search.fill('Cursor');expect(page.get_by_role('option',name='Cursor Приложение')).to_be_visible()
 # Screenshot is search-only and launching it preserves the palette for the captured frame.
 search.fill('Скриншот');expect(page.get_by_role('option',name='Скриншот Команда')).to_be_visible();before=page.evaluate("qa.calls.filter(x=>x.command==='palette_hide').length");search.press('Enter');page.wait_for_function("qa.calls.some(x=>x.command==='snipcast_commands_run'&&x.args.id==='screenshot')");assert page.evaluate("qa.calls.filter(x=>x.command==='palette_hide').length")==before
 search.fill('');commands.click();expect(page.get_by_role('option',name='Скриншот Команда')).to_have_count(0)
 # A direct native request renders a standalone tool, with no back navigation and Esc closing it.
 direct=browser.new_page(viewport={'width':728,'height':400});direct.add_init_script('('+bridge+')();'+ext);direct.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=command-tool');direct.wait_for_load_state('networkidle')
 for request_id,section in [(100,'clipboard'),(101,'emoji'),(102,'translate'),(103,'calculator')]:
  direct.evaluate('request=>qa.events["snipcast://commands-open"]({payload:request})',{'id':request_id,'section':section});direct.wait_for_function('(id)=>qa.calls.some(x=>x.command==="snipcast_commands_ready"&&x.args.id===id)',arg=request_id)
  expect(direct.get_by_role('button',name='Назад',exact=True)).to_have_count(0);assert 'назад Esc' not in direct.locator('footer').inner_text();before=direct.evaluate("qa.calls.filter(x=>x.command==='snipcast_commands_hide').length");direct.keyboard.press('Escape');direct.wait_for_function('(before)=>qa.calls.filter(x=>x.command==="snipcast_commands_hide").length>before',arg=before)
 direct.close()
 page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=settings');page.wait_for_load_state('networkidle');page.get_by_role('button',name='Основные',exact=True).click()
 expect(page.get_by_text('Палитра шаблонов',exact=True)).to_be_visible();expect(page.get_by_text('Объединённая палитра (тест)',exact=True)).to_have_count(0);expect(page.get_by_text('Палитра команд',exact=True)).to_have_count(0);expect(page.get_by_text('Объединённая палитра',exact=True)).to_have_count(0);assert page.locator('.settings__nav > button').all_text_contents()[:2]==['Основные','Команды']
 expect(page.get_by_label('Горячая клавиша: Дополнительное сочетание палитры')).to_have_count(0)
 page.get_by_role('button',name='Команды',exact=True).click();expect(page.locator('.commands-settings__row strong').filter(has_text='Скриншот')).to_have_count(0);page.get_by_role('button',name='Основные',exact=True).click()
 field=page.get_by_label('Запись хоткея палитры',exact=True);field.focus();field.press('Control+Shift+KeyL');page.wait_for_function("qa.config.paletteHotkey.includes('L')");field.blur();page.get_by_role('button',name='Вернуть по-умолчанию').click();page.wait_for_function("qa.config.paletteHotkey==='CommandOrControl+Shift+Backslash'")
 # Legacy test-hotkey data cannot expose a second palette field.
 legacy=browser.new_page(viewport={'width':1000,'height':800});legacy.add_init_script('('+bridge+')();'+ext+";qa.config.paletteHotkey='Shift+Backslash';qa.config.commands.items.unified={enabled:true,alias:'',hotkey:'Control+T'};")
 legacy.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+'/?snipcast=settings');legacy.wait_for_load_state('networkidle');legacy.get_by_role('button',name='Основные',exact=True).click()
 expect(legacy.get_by_label('Запись хоткея палитры')).to_have_value('Shift+\\');expect(legacy.get_by_label('Горячая клавиша: Дополнительное сочетание палитры',exact=True)).to_have_count(0)
 legacy.get_by_role('button',name='Вернуть по-умолчанию').click();legacy.wait_for_function("!qa.config.commands.items.unified");legacy.screenshot(path=str(out/'main-palette-settings.png'));legacy.close();assert not errors,errors
 blank=browser.new_page(viewport={'width':728,'height':400});blank.add_init_script('('+bridge+')();'+ext+';qa.emptyTemplates=true;');blank.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420'));blank.wait_for_load_state('networkidle')
 expect(blank.get_by_role('tab')).to_have_text(['Все','Команды']);expect(blank.locator('#snipcast-listbox [role=option]')).to_have_count(0)
 blank.get_by_role('textbox').press('Tab');expect(blank.get_by_role('tab',name='Команды',exact=True)).to_have_attribute('aria-selected','true');expect(blank.locator('#snipcast-listbox [role=option]')).to_have_count(4)
 blank.screenshot(path=str(out/'commands-no-template-groups.png'));blank.close();browser.close()
print('PASS main unified palette, command chip, tools, search, settings and retired test shortcut')
