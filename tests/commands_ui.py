"""Command palette UI tests with a deterministic Tauri bridge; native transport tested separately."""
from pathlib import Path
import json,os
from playwright.sync_api import sync_playwright,expect
OUT=Path(__file__).resolve().parents[1]/'.qa-work/commands-ui';OUT.mkdir(parents=True,exist_ok=True)
BASE=os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')
BRIDGE=r'''() => {
let id=0;const callbacks={},eventListeners={};window.qa={calls:[],events:{},entries:[['clipboard','Буфер обмена'],['emoji','Emoji'],['translate','Переводчик'],['calculator','Калькулятор'],['settings','Настройки'],['templates','Палитра шаблонов'],['app:cursor','Cursor']].map(([id,title])=>({id,title,kind:id.startsWith('app:')?'application':'command',icon:'',keywords:id,target:'',count:0,lastUsed:0})),clips:[{id:1,title:'Тест истории',kind:'text',text:'  Текст\nсо строками  ',files:[],source:'Notepad',sourcePath:'notepad.exe',created:Date.now(),pinned:false,width:0,height:0,characters:21,ocr:'',icon:''}],config:{theme:'dark',paletteListDensity:'normal',paletteHotkey:'',screenshotHotkey:'',screenshotPresets:[],screenshotQuickLocations:[],screenshotOcrEngine:'system',screenshotOcrLanguage:'auto',screenshotFormat:'png',screenshotFileTemplate:'{datetime}',aiApiKey:'',aiModel:'',commands:{hotkey:'Alt+Space',items:{clipboard:{enabled:true,alias:'',hotkey:'Alt+V'},emoji:{enabled:true,alias:'',hotkey:'Alt+E'},translate:{enabled:true,alias:'',hotkey:'Alt+T'}},folders:[],clipboardEnabled:true,retentionDays:30,storageMb:1024,ocr:false,excludedApps:[],emojiColumns:7,emojiAction:'paste',skinTone:'',sourceLanguage:'en',targetLanguage:'ru'}},usage:{'emoji:😀':[5,1]}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event,eventId)=>{delete eventListeners[event]?.[eventId]}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'commands'},currentWebview:{windowLabel:'commands'}},transformCallback:fn=>{callbacks[++id]=fn;return id},invoke:async(command,args={})=>{qa.calls.push({command,args});
if(command==='plugin:event|listen'){const eventId=++id;(eventListeners[args.event]??={})[eventId]=callbacks[args.handler];qa.events[args.event]=event=>Object.values(eventListeners[args.event]).forEach(fn=>fn(event));return eventId}
if(command==='snipcast_get_config')return structuredClone(qa.config);
if(command==='snipcast_save_config'){if(qa.failSave)throw 'Комбинация занята';qa.config=structuredClone(args.incoming);return}
if(command==='snipcast_commands_catalog')return structuredClone({entries:qa.entries,config:qa.config.commands,section:'root',scanning:false,error:'',usage:qa.usage});
if(command==='snipcast_history_list'){const all=qa.clips.filter(c=>(!args.kind||c.kind===args.kind)&&(!args.query||c.text.includes(args.query))),offset=args.offset||0;if(qa.listDelay&&offset)await new Promise(r=>setTimeout(r,qa.listDelay));return {items:all.slice(offset,offset+(args.limit??100)),total:all.length,status:''}}
if(command==='snipcast_history_detail')return qa.clips.find(c=>c.id===args.id);
if(command==='snipcast_history_action'){const c=qa.clips.find(c=>c.id===args.id);if(args.action==='pin')c.pinned=!c.pinned;if(args.action==='rename')c.title=args.value;return}
if(command==='snipcast_commands_translate'){if(qa.delayTranslate) return await new Promise(r=>qa.resolveTranslate=r);return 'Hello world'}
if(command==='snipcast_history_latest_text')return qa.latestText??null
if(command==='snipcast_translation_history')return qa.translations??[]
if(command==='snipcast_translation_remember'){const item={input:args.input,output:args.output,source:args.source,target:args.target,at:Date.now()};const same=qa.translations?.[0];if(!(same&&same.input===item.input&&same.output===item.output))qa.translations=[item,...(qa.translations||[])].slice(0,10);return qa.translations}
if(command==='snipcast_get_template_store')return {version:1,groups:[]};
if(command==='snipcast_get_variables')return {};
if(command==='snipcast_ocr_languages')return [];
if(command==='snipcast_get_version')return 'test';
if(command==='snipcast_update_writable')return true;
if(command==='plugin:autostart|is_enabled')return false;
return null;}};
}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel="msedge");page=browser.new_page(viewport={'width':760,'height':500});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.add_init_script('('+BRIDGE+')()');page.goto(BASE+'/?snipcast=commands');page.wait_for_load_state('networkidle')
 expect(page.get_by_role('textbox',name='Поиск',exact=True)).to_be_visible()
 expect(page.get_by_role('option',name='Cursor Приложение')).to_have_count(0)
 # Group flags update an already open palette; old configs omit both flags.
 for enabled,applications in [(True,False),(False,True),(False,False),(True,True)]:
  page.evaluate('([enabled,apps])=>{Object.assign(qa.config.commands,{enabled,applicationsEnabled:apps});qa.events["snipcast://commands-catalog"]({payload:null})}',[enabled,applications])
  field=page.get_by_role('textbox',name='Поиск',exact=True);field.fill('Cursor')
  expect(page.get_by_role('option',name='Cursor Приложение')).to_have_count(1 if enabled and applications else 0)
  field.fill('Emoji');expect(page.get_by_role('option',name='Emoji Команда')).to_have_count(1 if enabled else 0)
  field.fill('12+11');expect(page.locator('.commands__calc')).to_have_count(1 if enabled else 0)
 page.get_by_role('textbox',name='Поиск',exact=True).fill('')
 # All six clipboard types use the requested glyphs in the shared list.
 page.evaluate('qa.originalClips=qa.clips;qa.clips=["image","text","files","link","email","color"].map((kind,i)=>({...qa.originalClips[0],id:10+i,kind,title:kind}))')
 page.get_by_role('option',name='Буфер обмена Команда').click()
 expect(page.locator('.commands__history .palette__item-row > span:first-child')).to_have_text(['🖼️','📄','📋','🔗','✉️','🎨'])
 page.screenshot(path=str(OUT/'clipboard-types.png'))
 type_filter=page.get_by_label('Тип записей')
 expect(type_filter.locator('option')).to_have_text(['Все типы','📄 Текст','🖼️ Изображения','📋 Файлы','🔗 Ссылки','✉️ Email','🎨 Цвета'])
 for kind,label in [('text','📄 Текст'),('image','🖼️ Изображения'),('files','📋 Файлы'),('link','🔗 Ссылки'),('email','✉️ Email'),('color','🎨 Цвета')]:
  type_filter.select_option(kind);expect(type_filter).to_have_value(kind)
  expect(page.locator('.commands__history .palette__item-title')).to_have_text([kind])
  assert page.evaluate('qa.calls.filter(c=>c.command==="snipcast_history_list").at(-1).args.kind')==kind
 page.screenshot(path=str(OUT/'clipboard-filter-icons.png'))
 type_filter.select_option('');expect(page.locator('.commands__history [role=option]')).to_have_count(6)

 page.get_by_role('button',name='Назад',exact=True).click();page.evaluate('qa.clips=qa.originalClips')
 values=page.evaluate('''async()=>{const {calculate}=await import('/src/commands/model.ts');return ['12+11','((2+3)*6)/2','-2^2','2^3^2','0,1+0,2','1/0','2+','123'].map(calculate)}''')
 assert [v['result'] for v in values[:5]]==['23','15','-4','512','0.3'],values
 assert values[5]['error'] and values[6]['error'] and values[7] is None
 languages=page.evaluate('''async()=>{const {guessSource,languageOptions,preferredTarget}=await import('/src/commands/model.ts');return {guess:['Привет','Київ','こんにちは','안녕','你好','Hello'].map(guessSource),source:languageOptions('source',{'source:de':2,'source:fr':1}).map(o=>o.value),target:languageOptions('target',{}).map(o=>o.value).slice(0,2),pref:preferredTarget({'target:de':3},'en'),fallback:preferredTarget({},'auto')}}''')
 assert languages['guess']==['ru','uk','ja','ko','zh-CN','en'],languages['guess']
 assert languages['source'][:3]==['auto','de','fr'] and languages['source'][-1]=='pl',languages['source']
 assert languages['target']==['auto','en'] and languages['pref']=='de' and languages['fallback']=='ru'
 search=page.get_by_role('textbox',name='Поиск',exact=True);search.fill('сгкыщк');expect(page.get_by_role('option',name='Cursor Приложение')).to_be_visible();search.fill('');expect(page.get_by_role('option',name='Cursor Приложение')).to_have_count(0);search.fill('12+11');expect(page.locator('.commands__calc')).to_contain_text('23');search.press('Enter');assert page.evaluate("qa.calls.some(c=>c.command==='snipcast_commands_text'&&c.args.text==='23'&&!c.args.paste)")
 search.fill('');page.evaluate("""qa.clips.push({id:2,title:'Вторая запись',kind:'text',text:'Второй текст',files:[],source:'Notepad',sourcePath:'notepad.exe',created:Date.now()-1000,pinned:false,width:0,height:0,characters:12,ocr:'',icon:''},{id:3,title:'Третья запись',kind:'text',text:'Третий текст',files:[],source:'Notepad',sourcePath:'notepad.exe',created:Date.now()-2000,pinned:false,width:0,height:0,characters:12,ocr:'',icon:''})""");page.get_by_role('option',name='Буфер обмена Команда').click();expect(page.locator('.commands__preview')).to_contain_text('Notepad');page.screenshot(path=str(OUT/'clipboard-dark.png'));page.get_by_role('button',name='Действия').click();page.get_by_role('button',name='Закрепить',exact=True).click();expect(page.locator('.commands__history')).to_contain_text('Закреплённые');page.get_by_role('button',name='Действия').click();page.get_by_role('button',name='Переименовать',exact=True).click();dialog=page.get_by_role('dialog',name='Переименовать запись');dialog.get_by_role('textbox').fill('Моя запись');dialog.get_by_role('button',name='Сохранить').click();expect(page.locator('.commands__history')).to_contain_text('Моя запись');search.press('Control+Enter');assert page.evaluate("qa.calls.some(c=>c.command==='snipcast_history_action'&&c.args.action==='copy')")
 # Multi-select: Shift marks a contiguous range from the anchor, Enter pastes it
 # back-to-front (reverse of the selection direction).
 rows=page.locator('.commands__history [role=option]');selected=page.locator('.commands__history [role=option][aria-selected="true"]')
 def pasted_ids():return page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_paste_many').at(-1).args.ids")
 assert page.evaluate("qa.clips.map(c=>c.id)")==[1,2,3]
 # The keyboard cursor highlights the first row immediately, before any key press.
 assert 'palette__item--kb' in rows.nth(0).get_attribute('class')
 rows.nth(0).click();page.evaluate('qa.calls=[]');rows.nth(2).click(modifiers=['Shift']);expect(selected).to_have_count(3);expect(page.locator('footer.palette__hints')).to_contain_text('вставить (3)');assert 'выбрано' not in page.locator('footer.palette__hints').inner_text();page.screenshot(path=str(OUT/'clipboard-multi.png'));page.keyboard.press('Enter');page.wait_for_function("qa.calls.some(c=>c.command==='snipcast_history_paste_many')");assert pasted_ids()==[3,2,1],pasted_ids()
 rows.nth(2).click();rows.nth(0).click(modifiers=['Shift']);page.keyboard.press('Enter');page.wait_for_function("qa.calls.filter(c=>c.command==='snipcast_history_paste_many').length===2");assert pasted_ids()==[1,2,3],pasted_ids()
 # Shift+arrows extend the same range; Esc collapses it before leaving the section.
 page.keyboard.press('Shift+ArrowDown');page.keyboard.press('Shift+ArrowDown');expect(selected).to_have_count(3);expect(page.locator('footer.palette__hints')).to_contain_text('вставить (3)');assert 'выбрано' not in page.locator('footer.palette__hints').inner_text();page.keyboard.press('Escape');expect(page.get_by_role('button',name='Назад',exact=True)).to_be_visible();expect(selected).to_have_count(1);assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_commands_hide').length")==0
 page.keyboard.press('ArrowUp');page.keyboard.press('ArrowUp');expect(selected).to_have_count(1)
 page.keyboard.press('Shift+ArrowDown');page.keyboard.press('Shift+ArrowDown');page.keyboard.press('Enter');page.wait_for_function("qa.calls.filter(c=>c.command==='snipcast_history_paste_many').length===3");assert pasted_ids()==[3,2,1],pasted_ids()
 # A plain arrow collapses the multi-selection and keeps the single paste path.
 page.keyboard.press('Shift+ArrowDown');page.keyboard.press('ArrowUp');expect(selected).to_have_count(1);page.evaluate('qa.calls=[]');page.keyboard.press('Enter');page.wait_for_function("qa.calls.some(c=>c.command==='snipcast_history_action'&&c.args.action==='paste')");assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_paste_many').length")==0
 # Детали записи грузятся с паузой и кэшируются: удержание стрелки не ставит
 # запрос в очередь на каждое повторение клавиши, иначе список «доезжает».
 # Переоткрываем раздел, чтобы кэш деталей был пуст.
 page.get_by_role('button',name='Назад',exact=True).click();page.get_by_role('option',name='Буфер обмена Команда').click();page.wait_for_timeout(300);page.evaluate('qa.calls=[]')
 page.keyboard.press('ArrowDown');page.wait_for_timeout(20);page.keyboard.press('ArrowDown')
 expect(selected).to_have_count(1)
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")==0
 page.wait_for_timeout(300)
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")==1
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').at(-1).args.id")==page.evaluate("qa.clips[2].id")
 expect(page.locator('.commands__preview')).to_contain_text('Третий текст')
 page.keyboard.press('ArrowUp');page.wait_for_timeout(300)
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")==2
 page.keyboard.press('ArrowDown');page.wait_for_timeout(300)
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")==2
 rows.nth(0).click()
 # Image preview fits the pane height instead of overflowing it.
 page.evaluate("qa.clips.push({id:9,title:'Картинка',kind:'image',text:'',files:[],source:'Снимок',sourcePath:'',created:Date.now(),pinned:false,width:1,height:1,characters:0,ocr:'',icon:'',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='})")
 page.evaluate("qa.events['snipcast://clipboard-changed']({payload:null})");page.wait_for_timeout(350)
 page.locator('.commands__history [role=option]').last.click();page.wait_for_timeout(400)
 expect(page.locator('.commands__preview--image')).to_have_count(1)
 assert page.evaluate("getComputedStyle(document.querySelector('.commands__preview--image img')).maxHeight")=='none'
 assert page.evaluate("getComputedStyle(document.querySelector('.commands__preview--image img')).objectFit")=='contain'
 # Удержание стрелки: пока клавиша зажата, detail не грузится; после отпускания —
 # ровно один запрос для последней выбранной записи.
 page.evaluate('qa.calls=[]')
 page.keyboard.down('ArrowUp');page.wait_for_timeout(40);page.keyboard.down('ArrowUp');page.wait_for_timeout(40);page.keyboard.down('ArrowUp');page.wait_for_timeout(150)
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")==0
 page.keyboard.up('ArrowUp');page.wait_for_timeout(400)
 # После отпускания detail загружается максимум один раз (или берётся из кэша).
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")<=1
 expect(page.locator('.commands__preview')).to_contain_text('Текст')
 assert 'palette__item--kb' in page.locator('.commands__history [role=option]').first.get_attribute('class')
 # Стрелки: нажатие — ровно один шаг, удержание движется только от свежих
 # автоповторов Windows. Пачка залежавшихся повторов, потерянный keyup и
 # повторы после отпускания не двигают список; следующая страница истории
 # грузится заранее, поэтому удержание не упирается в конец загруженной части.
 page.evaluate("""qa.clips.push(...Array.from({length:150},(_,i)=>({id:100+i,title:'Ряд '+(i+1),kind:'text',text:'row '+(i+1),files:[],source:'Notepad',sourcePath:'notepad.exe',created:Date.now()-10000-i,pinned:false,width:0,height:0,characters:4,ocr:'',icon:''})))""")
 page.evaluate("qa.events['snipcast://clipboard-changed']({payload:null})")
 page.wait_for_function("Number(document.querySelector('.commands__history')?.dataset.loadedCount)>=100")
 page.evaluate("document.querySelector('.commands__history').scrollTop=0");page.wait_for_timeout(50);rows.nth(0).click()
 NAV_HELPERS='''
  const list=()=>document.querySelector('.commands__history');
  const pos=()=>Number(list().querySelector('[data-selected="true"]')?.getAttribute('aria-posinset')||0);
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const fire=(type,repeat=false,key='ArrowDown')=>window.dispatchEvent(new KeyboardEvent(type,{key,repeat,bubbles:true,cancelable:true}));
 '''
 nav=page.evaluate('async()=>{'+NAV_HELPERS+'''
  const r={start:pos()};
  fire('keydown');await wait(120);fire('keyup');await wait(150);r.tap=pos()-r.start;
  let at=pos();fire('keydown');await wait(300);for(let i=0;i<20;i++){await wait(33);fire('keydown',true)}await frame();r.hold=pos()-at;
  fire('keyup');await frame();at=pos();await wait(400);r.afterUp=pos()-at;
  at=pos();fire('keydown');await frame();for(let i=0;i<40;i++)fire('keydown',true);await frame();r.burst=pos()-at;fire('keyup');await wait(300);r.burstAfter=pos()-at;
  fire('keydown');for(let i=0;i<5;i++){await wait(33);fire('keydown',true)}await frame();at=pos();await wait(500);r.lostKeyup=pos()-at;fire('keyup');
  at=pos();fire('keydown',true);await wait(40);fire('keydown',true);await frame();r.orphan=pos()-at;
  fire('keydown',false,'ArrowUp');await wait(80);fire('keyup',false,'ArrowUp');await frame();r.up=pos()-at;
  return r;
 }''')
 assert nav['tap']==1,nav
 assert nav['hold']>=15,nav
 assert nav['afterUp']==0 and nav['lostKeyup']==0 and nav['orphan']==0,nav
 assert 1<=nav['burst']<=2 and nav['burstAfter']==nav['burst'],nav
 assert nav['up']==-1,nav
 assert page.evaluate("qa.calls.filter(c=>c.command==='snipcast_history_detail').length")>=1
 page.evaluate("document.querySelector('.commands__history').scrollTop=0");page.wait_for_timeout(50);rows.nth(0).click();page.evaluate('qa.listDelay=150')
 tail=page.evaluate('async()=>{'+NAV_HELPERS+'''
  const total=qa.clips.length,before=Number(list().dataset.loadedCount);
  fire('keydown');for(let i=1;i<total;i++){await wait(15);fire('keydown',true)}
  await wait(400);fire('keyup');await frame();
  return {total,before,loaded:Number(list().dataset.loadedCount),pos:pos()};
 }''')
 assert tail['before']<tail['total'] and tail['loaded']==tail['total'] and tail['pos']==tail['total'],tail
 page.evaluate('qa.listDelay=0;qa.events["snipcast://clipboard-changed"]({payload:null})');page.wait_for_timeout(400)
 kept=page.evaluate("({loaded:Number(document.querySelector('.commands__history').dataset.loadedCount),pos:Number(document.querySelector('.commands__history [data-selected=\"true\"]')?.getAttribute('aria-posinset')||0)})")
 assert kept=={'loaded':tail['total'],'pos':tail['total']},kept
 page.get_by_role('button',name='Назад',exact=True).click();page.get_by_role('option',name='Emoji Команда').click();expect(page.locator('.commands__emoji [role=option]').first).to_be_visible();page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Часто используемые').click();expect(page.locator('.commands__emoji [role=option]')).to_have_count(1);search.fill('');page.get_by_role('combobox',name='Категория Emoji').click();page.get_by_role('listbox',name='Категория Emoji').get_by_role('option',name='Все категории').click();search.fill('улыб');assert page.locator('.commands__emoji [role=option]').count()>0;page.screenshot(path=str(OUT/'emoji-dark.png'))
 page.get_by_role('button',name='Назад',exact=True).click();page.get_by_role('option',name='Переводчик Команда').click();expect(page.locator('.commands__header .palette__search-icon')).to_have_text('🌐');expect(page.get_by_role('button',name='Перевести',exact=True)).to_have_count(0);expect(page.locator('footer')).to_contain_text('копировать перевод');expect(page.locator('footer')).to_contain_text('пред. перевод');page.get_by_role('combobox',name='Исходный язык').click();expect(page.get_by_role('listbox',name='Исходный язык').get_by_role('option').first).to_contain_text('Авто');page.keyboard.press('Escape');page.get_by_role('combobox',name='Язык перевода').click();expect(page.get_by_role('listbox',name='Язык перевода').get_by_role('option').first).to_contain_text('Авто');expect(page.get_by_role('listbox',name='Язык перевода').get_by_role('option').nth(1)).to_contain_text('Английский');page.keyboard.press('Escape');field=page.get_by_label('Текст для перевода');result=page.get_by_label('Результат перевода');field.fill('Привет');expect(result).to_have_value('Hello world');field.press('Enter');assert page.evaluate("qa.calls.some(c=>c.command==='snipcast_commands_text'&&c.args.text==='Hello world'&&c.args.paste===false)");page.evaluate('qa.delayTranslate=true;qa.resolveTranslate=null');field.fill('Первый');page.wait_for_function('!!qa.resolveTranslate');field.fill('Новый текст');page.evaluate("const resolve=qa.resolveTranslate;qa.resolveTranslate=null;resolve('old')");expect(result).to_have_value('');page.evaluate('qa.delayTranslate=false');expect(result).to_have_value('Hello world');field.fill('Черновик');page.keyboard.press('-');expect(field).to_have_value('Новый текст');page.keyboard.press('+');expect(field).to_have_value('Черновик');page.evaluate("qa.latestText=null;qa.events['snipcast://commands-open']({payload:{id:900,section:'translate'}})");expect(field).to_have_value('');page.evaluate("qa.latestText='Из буфера';qa.events['snipcast://commands-open']({payload:{id:901,section:'translate'}})");expect(field).to_have_value('Из буфера');page.screenshot(path=str(OUT/'translator-dark.png'))
 page.evaluate("qa.events['snipcast://commands-open']({payload:{id:902,section:'root'}})");page.evaluate("document.documentElement.dataset.appTheme='light'");search.fill('12+11');page.screenshot(path=str(OUT/'calculator-light.png'));assert page.evaluate("getComputedStyle(document.querySelector('.palette')).borderRadius")=='12px'
 page.goto(BASE+'/?snipcast=settings');page.wait_for_load_state('networkidle');page.get_by_role('button',name='Команды',exact=True).click();expect(page.get_by_label('Горячая клавиша: Палитра команд')).to_have_count(0);page.get_by_role('button',name='Настроить: Буфер обмена',exact=True).click();page.get_by_label('Хранить историю').select_option('7');page.wait_for_function('qa.config.commands.retentionDays===7');page.screenshot(path=str(OUT/'settings-dark.png'))
 assert not errors,errors
 browser.close()
print('PASS command search/layout, calculator, clipboard actions and debounce, emoji RU/recent, translation stale response, settings, palette surface')
