"""Browser checks for settings, stale popup sessions and inline forms. Native input has a separate test."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/'text-suggestions'/'ui'
OUT.mkdir(parents=True,exist_ok=True)
tree=ast.parse((ROOT/'tests/preset_autosave.py').read_text(encoding='utf8'))
CONFIG=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='CONFIG' for t in n.targets))
SUGGESTIONS=dict(enabled=False,mode='trigger',trigger='/',toggleHotkey='Control+Alt+T',excludedApps=[])
BRIDGE=r'''config=>{
 let next=1;const callbacks={},listeners={};
 window.qa={config,saves:[],calls:[],pending:null,fail:false,view:null,
  emit:(event,payload)=>{for(const item of Object.values(listeners))if(item.event===event)callbacks[item.handler]?.({event,id:item.id,payload});}};
 window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  transformCallback:(cb)=>{const id=next++;callbacks[id]=cb;return id;},unregisterCallback:id=>delete callbacks[id],
  invoke:async(command,args={})=>{
   qa.calls.push({command,args});
   if(command==='plugin:event|listen'){const id=next++;listeners[id]={...args,id};return id;}
   if(command==='plugin:event|unlisten'){delete listeners[args.eventId];return;}
   if(command==='snipcast_get_config')return structuredClone(qa.config);
   if(command==='snipcast_save_config'){if(qa.fail){qa.fail=false;throw 'Не удалось сохранить настройки';}qa.config=structuredClone(args.incoming);qa.saves.push(qa.config);return;}
   if(command==='snipcast_suggestions_view')return qa.view;
   if(command==='snipcast_suggestions_pending')return qa.pending;
   if(command==='snipcast_suggestions_status')return {supported:true,enabled:false,message:''};
   if(command==='snipcast_suggestions_complete'){if(qa.fail){qa.fail=false;throw 'Место ввода изменилось';}qa.pending=null;qa.view={...qa.view,session:qa.view.session+1,form:null};qa.emit('snipcast://suggestions-view',qa.view);return;}
   if(command==='snipcast_suggestions_action'&&args.action==='cancel-pending'){qa.pending=null;qa.view={...qa.view,session:qa.view.session+1,form:null};qa.emit('snipcast://suggestions-view',qa.view);return;}
   if(command==='snipcast_list_templates')return [{id:'t',title:'Обычный шаблон',preview:'Здравствуйте',pasteText:'Здравствуйте, [Имя]!',groupId:'g',groupTitle:'Тест'}];
   if(command==='snipcast_get_variables')return {};
   if(command==='snipcast_get_template_store')return {version:1,groups:[]};
   if(command==='snipcast_get_version')return 'test';
   if(command==='snipcast_ocr_languages')return [];
   if(command==='snipcast_update_writable')return true;
   if(command==='plugin:autostart|is_enabled')return false;
   return null;
  }};
}'''

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for theme in ('dark','light'):
        # A config without textSuggestions must use the product defaults in the UI.
        config={**CONFIG,'theme':theme}
        config.pop('textSuggestions',None)
        page=browser.new_page(viewport={'width':880,'height':1300})
        page.add_init_script(f'({BRIDGE})({json.dumps(config)})')
        page.goto('http://127.0.0.1:1420/?snipcast=settings')
        page.wait_for_load_state('networkidle')
        group=page.get_by_role('group',name='Подсказки во время ввода',exact=True)
        expect(group.get_by_role('switch',name='Подсказки во время ввода',exact=True)).to_have_attribute('aria-checked','true')
        expect(group.get_by_role('radio',name='Постоянно',exact=True)).to_have_attribute('aria-checked','true')
        expect(group.get_by_role('switch',name='Поиск тексту',exact=True)).to_have_attribute('aria-checked','false')
        expect(group.get_by_label('Количество символов для вызова Быстрой палитры',exact=True)).to_have_value('3')
        expect(group.get_by_label('Текстовый триггер',exact=True)).to_have_value('=')
        expect(group.get_by_label('Приложения без подсказок',exact=True)).to_have_value('')
        expect(group.locator('.settings__hotkey-input')).to_have_value('F9')
        assert group.evaluate('el=>getComputedStyle(el).borderTopWidth')=='0px'
        page.screenshot(path=str(OUT/f'defaults-{theme}.png'),full_page=True)
        group.get_by_role('switch',name='Подсказки во время ввода',exact=True).click()
        page.wait_for_function('qa.config.textSuggestions?.enabled===false')
        actual=page.evaluate('qa.config.textSuggestions')
        assert actual==dict(enabled=False,mode='automatic',trigger='=',searchText=False,minChars=3,toggleHotkey='F9',excludedApps=[]),actual
        assert group.evaluate('el=>getComputedStyle(el).borderTopWidth')=='0px'
        page.close()
        results.append(f'{theme}: product defaults and no separator passed')
    for theme in ('dark','light'):
        config={**CONFIG,'theme':theme,'textSuggestions':SUGGESTIONS.copy()}
        page=browser.new_page(viewport={'width':880,'height':1050})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script(f'({BRIDGE})({json.dumps(config)})')
        page.goto('http://127.0.0.1:1420/?snipcast=settings')
        page.wait_for_load_state('networkidle')
        group=page.get_by_role('group',name='Подсказки во время ввода',exact=True)
        enabled=group.get_by_role('switch',name='Подсказки во время ввода',exact=True)
        expect(enabled).to_have_attribute('aria-checked','false')
        expect(group.locator('input,textarea,[role="radio"]')).to_have_count(0)
        expect(group.get_by_role('switch')).to_have_count(1)
        page.screenshot(path=str(OUT/f'settings-disabled-{theme}.png'),full_page=True)
        enabled.click()
        page.wait_for_function('qa.config.textSuggestions.enabled===true')
        expect(group.get_by_role('radio')).to_have_count(2)
        expect(group.get_by_role('radio',name='По триггеру',exact=True)).to_have_attribute('aria-checked','true')
        expect(group.get_by_text('Выключены',exact=True)).to_have_count(0)
        expect(group.get_by_text('Вызов подсказок',exact=True)).to_have_count(0)
        expect(group.get_by_text('Первая подсказка выбрана сразу.',exact=False)).to_have_count(0)
        expect(group.get_by_text('По умолчанию 3.',exact=False)).to_have_count(0)
        expect(group.get_by_role('switch',name='Поиск тексту')).to_have_attribute('aria-checked','false')
        threshold=group.get_by_label('Количество символов для вызова Быстрой палитры',exact=True)
        expect(threshold).to_have_value('3')
        assert threshold.evaluate('(el)=>getComputedStyle(el).borderRadius')=='8px'
        group.get_by_role('switch',name='Поиск тексту').click()
        page.wait_for_function('qa.config.textSuggestions.searchText===true')
        threshold.fill('4');group.get_by_role('switch',name='Поиск тексту').focus()
        page.wait_for_function('qa.config.textSuggestions.minChars===4')
        threshold.fill('0');group.get_by_role('switch',name='Поиск тексту').focus()
        expect(group.get_by_role('alert')).to_contain_text('от 1 до 128')
        expect(threshold).to_have_value('4')
        group.get_by_role('switch',name='Поиск тексту').click()
        page.wait_for_function('qa.config.textSuggestions.searchText===false')

        for label,mode in [('По триггеру','trigger'),('Постоянно','automatic')]:
            group.get_by_role('radio',name=label,exact=True).click()
            page.wait_for_function('(mode)=>qa.config.textSuggestions.mode===mode&&qa.config.textSuggestions.enabled===true',arg=mode)
        page.get_by_label('Текстовый триггер',exact=True).fill('/+/')
        group.get_by_role('radio',name='По триггеру',exact=True).focus()
        page.wait_for_function('qa.config.textSuggestions.trigger==="/+/"')
        page.get_by_label('Приложения без подсказок',exact=True).fill('game.exe\neditor.exe\ngame.exe')
        group.get_by_role('radio',name='По триггеру',exact=True).focus()
        page.wait_for_function('qa.config.textSuggestions.excludedApps.length===2')
        page.evaluate('qa.fail=true')
        group.get_by_role('radio',name='Постоянно',exact=True).click()
        expect(group.get_by_role('alert')).to_contain_text('Не удалось сохранить')
        expect(group.get_by_role('radio',name='Постоянно',exact=True)).to_have_attribute('aria-checked','true')
        assert page.evaluate('qa.config.textSuggestions.enabled') is True
        # A failed switch-off keeps the parameters visible; a successful one preserves them.
        page.evaluate('qa.fail=true');enabled.click()
        expect(group.get_by_role('alert')).to_contain_text('Не удалось сохранить')
        expect(threshold).to_be_visible()
        before=page.evaluate('structuredClone(qa.config.textSuggestions)')
        enabled.click();page.wait_for_function('qa.config.textSuggestions.enabled===false')
        expect(group.locator('input,textarea,[role="radio"]')).to_have_count(0)
        enabled.click();page.wait_for_function('qa.config.textSuggestions.enabled===true')
        assert page.evaluate('qa.config.textSuggestions')==before
        # Global toggle events update the settings while preserving mode and values.
        page.evaluate('qa.emit("snipcast://suggestions-config",{...qa.config.textSuggestions,enabled:false})')
        expect(group.get_by_role('switch')).to_have_count(1)
        page.evaluate('qa.emit("snipcast://suggestions-config",qa.config.textSuggestions)')
        expect(threshold).to_have_value('4')
        for width in (880,720):
            page.set_viewport_size({'width':width,'height':1300})
            layout=group.evaluate('''el=>{
                const row=id=>{const field=el.querySelector('#'+id).getBoundingClientRect(),label=el.querySelector('label[for="'+id+'"]').getBoundingClientRect();
                    return {gap:field.left-label.right,centers:Math.abs((label.top+label.bottom-field.top-field.bottom)/2),right:field.right,width:field.width,labelHeight:label.height};};
                return {count:row('suggestions-min-chars'),trigger:row('suggestions-trigger'),
                    spacing:el.querySelector('label[for="suggestions-min-chars"]').getBoundingClientRect().top-el.querySelector('.suggestions-settings__description p').getBoundingClientRect().bottom,
                    width:el.getBoundingClientRect().right,overflow:el.scrollWidth>el.clientWidth};}''')
            for row in (layout['count'],layout['trigger']):
                assert row['gap']>=15 and row['centers']<1 and row['right']<=layout['width']+1,layout
            assert layout['spacing']>=19 and not layout['overflow'],layout
            assert layout['count']['width']==72,layout
            if width==880:
                assert layout['count']['labelHeight']<21 and layout['trigger']['labelHeight']<21,layout
            page.screenshot(path=str(OUT/f'settings-{theme}-{width}.png'),full_page=True)
        page.set_viewport_size({'width':880,'height':1050})
        # Legacy empty triggers can be enabled after removing their activation shortcut.
        page.evaluate('qa.emit("snipcast://suggestions-config",{...qa.config.textSuggestions,enabled:false,mode:"trigger",trigger:""})')
        enabled.click();page.wait_for_function('qa.config.textSuggestions.enabled===true&&qa.config.textSuggestions.trigger==="="')
        page.screenshot(path=str(OUT/f'settings-{theme}.png'),full_page=True)
        assert not errors,errors
        page.close()
        popup=browser.new_page(viewport={'width':360,'height':162},device_scale_factor=1.5)
        popup.add_init_script(f'({BRIDGE})({json.dumps(config)});qa.view='+json.dumps(dict(session=8,query='прив',hits=[dict(id='a',title='Приветствие',path='Ответы',preview='Здравствуйте! Рады вашему обращению.'),dict(id='b',title='Другой вариант',path='Ответы',preview='Добрый день!')],selected=0,theme=theme,placement='caret')))
        popup.goto('http://127.0.0.1:1420/?snipcast=text-suggestions')
        popup.wait_for_load_state('networkidle')
        expect(popup.get_by_role('option')).to_have_count(2)
        popup.wait_for_function('qa.calls.some(c=>c.command==="snipcast_suggestions_action"&&c.args.action==="ready"&&c.args.session===8)')
        popup.evaluate('qa.emit("snipcast://suggestions-view",{...qa.view,session:7,selected:1})')
        expect(popup.get_by_role('option').first).to_have_attribute('aria-selected','true')
        popup.evaluate('qa.view={...qa.view,session:9,selected:1};qa.emit("snipcast://suggestions-view",qa.view)')
        expect(popup.get_by_role('option').nth(1)).to_have_attribute('aria-selected','true')
        popup.get_by_role('option').nth(1).click()
        assert popup.evaluate('qa.calls.some(c=>c.command==="snipcast_suggestions_action"&&c.args.action==="choose"&&c.args.session===9&&c.args.index===1)')
        assert popup.evaluate('document.documentElement.scrollWidth===innerWidth&&document.documentElement.scrollHeight===innerHeight')
        assert popup.evaluate('getComputedStyle(document.documentElement).clipPath==="inset(0px round 12px)"')
        assert popup.evaluate('getComputedStyle(document.querySelector(".text-suggestions")).borderRadius==="12px"')
        popup.screenshot(path=str(OUT/f'popup-{theme}.png'))
        popup.close()
        results.append(f'{theme}: settings and popup passed')

    for theme in ('dark','light'):
        page=browser.new_page(viewport={'width':360,'height':244})
        config={**CONFIG,'theme':theme}
        view=dict(session=42,query='',hits=[],selected=0,theme=theme,placement='caret',form=dict(session=41,title='Приветствие',text='Здравствуйте, [Имя]!'))
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script(f'({BRIDGE})({json.dumps(config)});qa.view='+json.dumps(view))
        page.goto('http://127.0.0.1:1420/?snipcast=text-suggestions')
        field=page.locator('[data-bracket-label="Имя"]')
        expect(field).to_be_visible();expect(field).to_be_focused()
        page.wait_for_function('qa.calls.some(c=>c.command==="snipcast_suggestions_action"&&c.args.action==="form-ready"&&c.args.session===41)')
        field.fill('Анна');page.evaluate('qa.fail=true');field.press('Enter')
        expect(page.get_by_role('alert')).to_contain_text('Место ввода изменилось')
        expect(field).to_have_value('Анна')
        page.screenshot(path=str(OUT/f'form-{theme}.png'))
        field.press('Enter');expect(field).to_have_count(0)
        assert page.evaluate('qa.calls.some(c=>c.command==="snipcast_suggestions_complete"&&c.args.session===41&&c.args.text==="Здравствуйте, Анна!")')
        assert page.evaluate('qa.calls.every(c=>c.command!=="paste_template"&&c.command!=="palette_hide")')
        page.evaluate('qa.view={...qa.view,session:44,form:{session:43,title:"Прощание",text:"Пока, [Имя]!"}};qa.emit("snipcast://suggestions-view",qa.view)')
        expect(field).to_be_visible();field.press('Escape');expect(field).to_have_count(0)
        assert page.evaluate('qa.calls.some(c=>c.command==="snipcast_suggestions_action"&&c.args.session===43&&c.args.action==="cancel-pending")')
        page.evaluate('''qa.view={...qa.view,session:46,form:{session:45,title:"Файл",text:'Текст ["fixture.txt"]'}};qa.emit("snipcast://suggestions-view",qa.view)''')
        expect(page.get_by_role('button',name='Вставить',exact=True)).to_be_visible()
        assert page.evaluate('qa.calls.every(c=>c.command!=="snipcast_suggestions_complete"||c.args.session!==45)')
        page.screenshot(path=str(OUT/f'attachment-{theme}.png'))
        page.get_by_role('button',name='Вставить',exact=True).click()
        page.wait_for_function('qa.calls.some(c=>c.command==="snipcast_suggestions_complete"&&c.args.session===45&&c.args.text==="Текст"&&c.args.fileRefs[0]==="fixture.txt")')
        page.evaluate('qa.view={...qa.view,session:51,form:{session:50,title:"Первый Enter",text:"Ответ [name]"}};qa.emit("snipcast://suggestions-view",qa.view)')
        name=page.locator('[data-bracket-label="name"]');expect(name).to_be_focused()
        name.fill('Анна')
        count=page.evaluate('qa.calls.filter(c=>c.command==="snipcast_suggestions_complete").length')
        page.keyboard.down('Enter');page.keyboard.down('Enter')
        assert page.evaluate('qa.calls.filter(c=>c.command==="snipcast_suggestions_complete").length')==count
        page.keyboard.up('Enter');expect(name).to_have_count(0)
        assert page.evaluate('qa.calls.filter(c=>c.command==="snipcast_suggestions_complete").length')==count+1
        assert page.evaluate('qa.calls.some(c=>c.command==="snipcast_suggestions_complete"&&c.args.session===50&&c.args.text==="Ответ Анна")')
        page.evaluate('qa.view={...qa.view,session:54,form:{session:53,title:"Несколько полей",text:"[name] [city] [role]",pageSize:2}};qa.emit("snipcast://suggestions-view",qa.view)')
        expect(name).to_be_focused();name.fill('Иван')
        page.locator('[data-bracket-label="city"]').fill('Москва')
        page.wait_for_function('qa.calls.some(c=>c.command==="snipcast_suggestions_action"&&c.args.action==="form-size"&&c.args.session===53)')
        height=page.evaluate('qa.calls.filter(c=>c.command==="snipcast_suggestions_action"&&c.args.action==="form-size"&&c.args.session===53).at(-1).args.index')
        page.set_viewport_size({'width':360,'height':height})
        assert page.evaluate('''()=>{const fields=document.querySelector(".text-suggestions__fields"),footer=document.querySelector("footer").getBoundingClientRect();return fields.scrollHeight===fields.clientHeight&&[...document.querySelectorAll("input,.text-suggestions__form-actions button")].every(el=>el.getBoundingClientRect().bottom<=footer.top);}''')
        page.screenshot(path=str(OUT/f'form-pages-{theme}.png'))
        page.get_by_role('button',name='Следующие поля',exact=True).press('Enter')
        role=page.locator('[data-bracket-label="role"]');expect(role).to_be_focused();role.fill('Разработчик')
        role.evaluate('''el=>{el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}));el.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",bubbles:true}));}''')
        assert page.evaluate('qa.calls.every(c=>c.command!=="snipcast_suggestions_complete"||c.args.session!==53)')
        # Read the DOM's last edit, even before React's next change render.
        role.evaluate('el=>el.value="Разработчик!"');role.press('Enter')
        expect(role).to_have_count(0)
        assert page.evaluate('qa.calls.some(c=>c.command==="snipcast_suggestions_complete"&&c.args.session===53&&c.args.text==="Иван Москва Разработчик!")')
        assert not errors,errors
        page.close()
    page=browser.new_page()
    page.add_init_script(f'({BRIDGE})({json.dumps(CONFIG)})')
    page.goto('http://127.0.0.1:1420/')
    page.get_by_text('Обычный шаблон',exact=True).click()
    page.locator('[data-bracket-label="Имя"]').fill('Олег')
    page.locator('[data-bracket-label="Имя"]').press('Enter')
    page.wait_for_function('qa.calls.some(c=>c.command==="paste_template"&&c.args.text==="Здравствуйте, Олег!")')
    page.close()
    results.append('quick form: first Enter on release; IME; latest edit; pages without scrolling; error/retry/cancel; attachments; ordinary palette unchanged')
    browser.close()
(OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
print('PASS: '+'; '.join(results))
