import ast, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
tree = ast.parse((root/'tests/commands_ui.py').read_text(encoding='utf8'))
bridge = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BRIDGE' for t in n.targets))
with sync_playwright() as p:
 browser = p.chromium.launch(headless=True, channel='msedge')
 for unified in (False, True):
  page = browser.new_page(); errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
  page.add_init_script('('+bridge+')();'+("const old=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(c,a)=>c==='snipcast_unified_palette_state'?true:c==='snipcast_list_templates'?[]:old(c,a);" if unified else ''))
  page.goto(os.environ.get('SNIPCAST_COMMANDS_TEST_URL','http://127.0.0.1:1420')+('' if unified else '/?snipcast=commands'))
  field=page.locator('input.palette__search'); field.fill('78/2')
  card=page.locator('.commands__calc'); expect(card).to_contain_text('39')
  expect(page.locator('.palette__hints')).to_contain_text('Копировать результат')
  page.evaluate('qa.calls=[]'); page.keyboard.press('Enter')
  page.wait_for_function("qa.calls.some(c=>c.command==='snipcast_commands_text'&&c.args.text==='39'&&!c.args.paste)")
  page.evaluate('qa.calls=[]'); card.click()
  page.wait_for_function("qa.calls.some(c=>c.command==='snipcast_commands_text'&&c.args.text==='39'&&!c.args.paste)")
  page.evaluate('qa.calls=[]'); page.locator('.palette__hints > span').nth(1).click()
  page.wait_for_function("qa.calls.some(c=>c.command==='snipcast_commands_text'&&c.args.text==='39'&&!c.args.paste)")
  assert not errors, errors
  page.close()
 browser.close()
print('PASS calculator result: Enter, card click and copy action in footer in both palettes')
