"""Settings-only checks: hotkey labels, clear icons, reset and save failure."""
import ast
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.qa-work' / 'settings-hotkeys-0369'
OUT.mkdir(parents=True, exist_ok=True)

def literal(name):
    tree = ast.parse((ROOT / 'tests' / 'preset_autosave.py').read_text(encoding='utf-8'))
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                and any(getattr(t, 'id', None) == name for t in n.targets))

LABELS = ['Палитра шаблонов', 'Скриншот', 'Скриншот: сохранить в файл',
          'Скриншот: закрепить', 'Скриншот: копировать в буфер']
DEFAULTS = dict(paletteHotkey='CommandOrControl+Shift+Backslash', screenshotHotkey='PrintScreen',
                screenshotSaveHotkey='Enter', screenshotPinHotkey='Space', screenshotCopyHotkey='C')
# Catch drift against the native new-user defaults rather than testing only the UI constants.
native = (ROOT / 'src-tauri' / 'src' / 'data.rs').read_text(encoding='utf-8')
assert f'DEFAULT_PALETTE_HOTKEY: &str = "{DEFAULTS["paletteHotkey"]}"' in native
assert f'DEFAULT_SCREENSHOT_HOTKEY: &str = "{DEFAULTS["screenshotHotkey"]}"' in native
for action, field in [('save', 'screenshotSaveHotkey'), ('pin', 'screenshotPinHotkey'), ('copy', 'screenshotCopyHotkey')]:
    assert re.search(rf'fn default_{action}_action_hotkey\(\).*?"{DEFAULTS[field]}"', native, re.S)

WRAP = """() => {
 const original=window.__TAURI_INTERNALS__.invoke;
 qa.saves=[];
 window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
  if(command==='snipcast_save_config'){
   if(qa.failNext){qa.failNext=false;throw new Error('Не удалось сохранить горячие клавиши');}
   qa.saves.push(structuredClone(args.incoming));
   if(qa.holdSave)await new Promise(resolve=>{qa.releaseSave=resolve});
  }
  return original(command,args);
 };
}"""
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for theme in ('dark', 'light'):
        for width in (950, 720):
            config = literal('CONFIG')
            config.update(theme=theme, paletteHotkey='Shift+Backslash', screenshotHotkey='Alt+F8',
                          screenshotSaveHotkey='Control+K', screenshotPinHotkey='Control+P', screenshotCopyHotkey='Control+Y')
            page = browser.new_page(viewport={'width': width, 'height': 950})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(f'({literal("BRIDGE")})({json.dumps(config)});({WRAP})();')
            page.goto('http://127.0.0.1:1420/?snipcast=settings')
            group = page.get_by_role('group', name='Горячие клавиши', exact=True)
            rows = group.locator('.settings__option--hotkey')
            expect(rows).to_have_count(5, timeout=15000)
            assert rows.locator('.settings__option-label').all_text_contents() == LABELS
            assert rows.locator('.settings__option-label').evaluate_all(
                'labels=>labels.every(e=>getComputedStyle(e).fontWeight==="400")')
            clear = rows.get_by_role('button')
            expect(clear).to_have_count(5)
            assert clear.all_text_contents() == ['', '', '', '', '']
            assert clear.locator('svg').count() == 5
            for i, field in enumerate(DEFAULTS):
                before = page.evaluate('structuredClone(qa.config)')
                clear.nth(i).click()
                expect(clear.nth(i)).to_be_disabled()
                after = page.evaluate('qa.config')
                assert after == {**before, field: ''}, (field, after)

            reset = group.get_by_role('button', name='Вернуть по-умолчанию', exact=True)
            page.evaluate('qa.holdSave=true')
            before_saves = page.evaluate('qa.saves.length')
            reset.click()
            expect(reset).to_be_disabled()
            for i in range(5):
                expect(rows.locator('input').nth(i)).to_be_disabled()
            page.evaluate('qa.holdSave=false;qa.releaseSave()')
            expect(reset).to_be_enabled()
            restored = page.evaluate('qa.config')
            assert restored == {**config, **DEFAULTS}
            assert page.evaluate('qa.saves.length') == before_saves + 1, 'Reset must save all keys together'
            expect(rows.locator('input').nth(2)).to_have_value('Enter')
            expect(rows.locator('input').nth(3)).to_have_value('Space')
            expect(rows.locator('input').nth(4)).to_have_value('C')
            # An actual recording after reset, then a rejected reset, must preserve the custom key.
            copy = rows.locator('input').nth(4)
            copy.click()
            copy.press('Control+k')
            reset.focus()
            page.wait_for_function('qa.config.screenshotCopyHotkey.endsWith("+K")')
            custom = page.evaluate('structuredClone(qa.config)')
            page.evaluate('qa.failNext=true')
            reset.click()
            expect(page.locator('.settings__toast--error')).to_contain_text('Не удалось сохранить')
            expect(reset).to_be_enabled()
            assert page.evaluate('qa.config') == custom
            assert copy.input_value().endswith('+K')
            reset.click()
            expect(copy).to_have_value('C')
            # Clear after reset must update the native snapshot, not just blank the input.
            clear.nth(0).click()
            assert page.evaluate('qa.config.paletteHotkey') == ''
            reset.click()
            expect(rows.locator('input').nth(0)).not_to_have_value('')
            page.locator('.settings__toast--error').wait_for(state='hidden')
            group.scroll_into_view_if_needed()
            geometry = rows.evaluate_all('''rows=>rows.map(row=>{
              const [label,input,button]=[row.querySelector('span'),row.querySelector('input'),row.querySelector('button')].map(e=>e.getBoundingClientRect());
              return {inputX:input.x,buttonX:button.x,inputRight:input.right,labelRight:label.right,labelBottom:label.bottom,inputY:input.y,buttonRight:button.right,rowRight:row.getBoundingClientRect().right};
            })''')
            assert max(g['inputX'] for g in geometry) - min(g['inputX'] for g in geometry) < 1
            for g in geometry:
                assert g['inputRight'] <= g['buttonX'] and g['buttonRight'] <= g['rowRight'] + 1
                assert g['labelRight'] <= g['inputX'] or g['labelBottom'] <= g['inputY']
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT / f'{theme}-{width}.png'))
            assert not errors, errors
            results.append(dict(theme=theme, width=width, labels=True, icons=True, clearAllFive=True,
                                resetDefaults=True, preservesOtherSettings=True, saveFailure=True, recording=True, noOverlap=True))
            page.close()
    browser.close()
(OUT / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results))
