"""Real pointer drags of template groups; persistence bridge and delayed autosave."""
import ast, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.qa-work' / 'template-groups-03611'
OUT.mkdir(parents=True, exist_ok=True)
def literal(name):
    tree = ast.parse((ROOT/'tests/preset_autosave.py').read_text(encoding='utf-8'))
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(getattr(t, 'id', None) == name for t in n.targets))
GROUPS = [dict(id=id, title=title, color=color, isMaster=master,
               masterSourcePath='C:/fixtures/master.json' if master else None,
               items=[dict(type='template', id=id+'-item', title='Шаблон '+title, content='Текст '+title)])
          for id, title, color, master in [('prompts','Промпты','#e8791b',False),('main','Основное','#12a485',False),('master','Мастер','#5164f2',True)]]
WRAP = """store => {
 qa.store=JSON.parse(localStorage.getItem('qa.store') || 'null') || store;
 qa.writes=[];qa.active=0;qa.maxActive=0;
 const original=window.__TAURI_INTERNALS__.invoke;
 window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
  if(command==='snipcast_get_template_store')return structuredClone(qa.store);
  if(command==='snipcast_save_template_store'){
   qa.active++;qa.maxActive=Math.max(qa.maxActive,qa.active);
   try {
    if(qa.failNext){qa.failNext=false;throw new Error('Не удалось сохранить порядок групп');}
    if(qa.holdNext){qa.holdNext=false;qa.pending=true;await new Promise(resolve=>{qa.release=resolve})}
    qa.store=structuredClone(args.store);qa.writes.push(structuredClone(args.store));
    localStorage.setItem('qa.store',JSON.stringify(qa.store));
   }finally{qa.active--;qa.pending=false}
   return;
  }
  return original(command,args);
 };
}"""
def order(page):return page.locator('[data-group-id]').evaluate_all('els=>els.map(e=>e.dataset.groupId)')
def start(page,id):
    button=page.locator(f'[data-group-id="{id}"]');button.scroll_into_view_if_needed();r=button.bounding_box()
    page.mouse.move(r['x']+r['width']/2,r['y']+r['height']/2);page.mouse.down()
def target(page,id,after):
    r=page.locator(f'[data-group-id="{id}"]').bounding_box()
    page.mouse.move(r['x']+r['width']*(.8 if after else .2),r['y']+r['height']/2,steps=10)
def drag(page,id,to,after):start(page,id);target(page,to,after);page.mouse.up()
def open_page(browser,theme,groups=GROUPS,width=950):
    page=browser.new_page(viewport=dict(width=width,height=800));config=literal('CONFIG');config['theme']=theme
    page.add_init_script(f'({literal("BRIDGE")})({json.dumps(config)});({WRAP})({json.dumps(dict(version=1,groups=groups))});')
    page.goto('http://127.0.0.1:1420/?snipcast=settings')
    page.get_by_role('button',name='Шаблоны',exact=True).click()
    expect(page.locator('[data-group-id]')).to_have_count(len(groups),timeout=15000)
    return page
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for theme in ('dark','light'):
        page=open_page(browser,theme);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        start(page,'prompts');target(page,'main',True)
        expect(page.locator('[data-group-id=main]')).to_have_class(__import__('re').compile('is-drop-after'))
        page.screenshot(path=str(OUT/f'{theme}-drag.png'));page.mouse.up()
        assert order(page)==['main','prompts','master']
        expect(page.locator('[data-group-id=prompts]')).to_have_attribute('aria-pressed','true')
        page.wait_for_function('qa.writes.length===1')
        assert page.evaluate('qa.store.groups')==[GROUPS[1],GROUPS[0],GROUPS[2]]
        drag(page,'master','main',False);assert order(page)==['master','main','prompts']
        page.wait_for_function('qa.writes.length===2')
        drag(page,'prompts','master',False);assert order(page)==['prompts','master','main']
        page.wait_for_function('qa.writes.length===3')
        # A drop into the same slot, outside the list, and Escape must not write.
        drag(page,'prompts','master',False);assert page.evaluate('qa.writes.length')==3
        start(page,'main');target(page,'prompts',False);page.mouse.move(900,650);page.mouse.up()
        assert order(page)==['prompts','master','main'] and page.evaluate('qa.writes.length')==3
        start(page,'main');target(page,'prompts',False);page.keyboard.press('Escape');page.mouse.up()
        assert order(page)==['prompts','master','main'] and page.evaluate('qa.writes.length')==3
        expect(page.locator('[data-group-id=prompts]')).to_have_attribute('aria-pressed','true')
        # Reopening uses the saved order, including an intact master source path.
        page.reload();page.get_by_role('button',name='Шаблоны',exact=True).click()
        expect(page.locator('[data-group-id]')).to_have_count(3)
        assert order(page)==['prompts','master','main']
        page.locator('.settings__tree-row').first.click();body=page.locator('#tpl-body')
        page.evaluate('qa.holdNext=true');body.fill('Правка во время сохранения')
        page.wait_for_function('qa.pending===true')
        drag(page,'main','prompts',False)
        assert order(page)==['main','prompts','master']
        expect(body).to_have_value('Правка во время сохранения')
        page.evaluate('qa.release()')
        page.wait_for_function('qa.writes.length===2 && qa.active===0')
        assert page.evaluate('qa.maxActive')==1
        assert page.evaluate('qa.store.groups.map(g=>g.id)')==['main','prompts','master']
        assert page.evaluate('qa.store.groups.find(g=>g.id==="prompts").items[0].content')=='Правка во время сохранения'
        expect(body).to_have_value('Правка во время сохранения')
        page.evaluate('qa.failNext=true');drag(page,'main','master',True)
        expect(page.locator('.settings__toast--error')).to_contain_text('Не удалось сохранить порядок')
        page.wait_for_function('document.querySelector("[data-group-id]").dataset.groupId==="main"')
        assert order(page)==['main','prompts','master']
        drag(page,'main','master',True);page.wait_for_function('qa.store.groups[2].id==="main"')
        page.locator('.settings__toast--error').wait_for(state='hidden')
        page.screenshot(path=str(OUT/f'{theme}-saved.png'));assert not errors,errors
        results.append(dict(theme=theme,moveBothWays=True,masterPreserved=True,selectionPreserved=True,
                            cancelledDrags=True,reopen=True,delayedAutosave=True,errorAndRetry=True))
        page.close()
    many=[{**GROUPS[0],'id':f'g{i}','title':f'Группа {i+1}'} for i in range(18)]
    page=open_page(browser,'dark',many,width=820);start(page,'g0')
    r=page.locator('.settings__group-tags').bounding_box();page.mouse.move(r['x']+r['width']-8,r['y']+r['height']/2,steps=10)
    page.wait_for_function('(()=>{const e=document.querySelector(".settings__group-tags");return e.scrollLeft>=e.scrollWidth-e.clientWidth-2})()',timeout=10000)
    page.mouse.up();page.wait_for_function('qa.store.groups.at(-1).id==="g0"')
    results.append(dict(autoScroll=True,groups=18));page.close();browser.close()
(OUT/'results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results))
