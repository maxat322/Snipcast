import sys, json
from pathlib import Path
from playwright.sync_api import sync_playwright, BrowserType
root=Path.cwd();sys.path.insert(0,str(root/'tests'))
original=BrowserType.launch
installed=sorted((Path.home()/'AppData/Local/ms-playwright').glob('chromium-*/chrome-win*/chrome.exe'))
def launch(self,**kwargs):
    if self.name=='chromium' and not Path(self.executable_path).exists():kwargs['executable_path']=str(installed[-1])
    return original(self,**kwargs)
BrowserType.launch=launch
namespaces=[]
for filename in ('capture_035.py','pin_annotation.py'):
    file=root/'tests'/filename;ns={'__file__':str(file),'__name__':'qa_fixture'}
    exec(file.read_text(encoding='utf8').split('with sync_playwright() as p:')[0],ns);namespaces.append(ns)
out=root/'.qa-work/shape-contrast';out.mkdir(parents=True,exist_ok=True);records=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for context,ns in zip(('capture','pin'),namespaces):
        for theme in ('light','dark'):
            if context=='capture':
                page,errors=ns['fixture'](browser);page.locator('.capture').evaluate('(el,t)=>el.dataset.captureTheme=t',theme);ns['drag'](page,(100,100),(600,600))
            else:
                page,errors=ns['fixture'](browser,theme);ns['open_editor'](page)
            page.keyboard.press('3')
            for title in ('Прямоугольник','Квадрат','Круг','Овал'):
                btn=page.get_by_role('button',name=title,exact=True);btn.click();page.mouse.move(5,5)
                active=btn.locator('svg').evaluate('el=>getComputedStyle(el).color')
                assert active==('rgb(49, 64, 158)' if theme=='light' else 'rgb(255, 255, 255)'),active
            normal=page.get_by_role('button',name='Круг',exact=True)
            inactive=normal.locator('svg').evaluate('el=>getComputedStyle(el).color')
            assert inactive==('rgb(44, 53, 68)' if theme=='light' else 'rgb(201, 201, 212)'),inactive
            page.locator('.capture__opts').screenshot(path=str(out/f'{context}-{theme}.png'))
            normal.hover();hover=normal.locator('svg').evaluate('el=>getComputedStyle(el).color')
            assert hover==('rgb(49, 64, 158)' if theme=='light' else 'rgb(255, 255, 255)'),hover
            page.locator('.capture__opts').screenshot(path=str(out/f'{context}-{theme}-hover.png'))
            assert not errors,errors;records.append({'context':context,'theme':theme,'normal':inactive,'selected':active,'hover':hover});page.close()
    browser.close()
(out/'results.json').write_text(json.dumps(records,indent=2),encoding='utf8');print(json.dumps(records))
