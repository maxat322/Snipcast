"""Browser regression for edits made while preset autosave is still awaiting IPC.

The bridge delays one config response deliberately; native Windows integration
is covered separately by preset_native.py.
"""
import json
import os

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("SNIPCAST_SETTINGS_TEST_URL", "http://localhost:1427/?snipcast=settings")
CONFIG = {
    "paletteHotkey": "", "screenshotHotkey": "", "autostart": False,
    "theme": "dark", "paletteListDensity": "normal", "screenshotFormat": "png",
    "screenshotJpegQuality": 90, "screenshotFileTemplate": "{datetime}",
    "screenshotSaveDir": "", "screenshotQuickLocations": [],
    "screenshotOcrEngine": "system", "screenshotOcrLanguage": "auto",
    "screenshotOcrQuality": "mobile", "apiEnabled": False, "apiPort": 0,
    "aiApiKey": "", "aiModel": "",
    "screenshotPresets": [{"id": "stable", "title": "Тест", "hotkey": "",
        "dir": "", "fileTemplate": "", "action": "save", "select": True}],
}
BRIDGE = r"""config => {
  window.qa = {config, delayRead: false, readPending: false};
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, args = {}) => {
      if (command === 'snipcast_get_config') {
        const snapshot = structuredClone(qa.config);
        if (qa.delayRead) {
          qa.delayRead = false;
          qa.readPending = true;
          await new Promise(resolve => { qa.releaseRead = resolve; });
        }
        return snapshot;
      }
      if (command === 'snipcast_save_config') qa.config = structuredClone(args.incoming);
      if (command === 'snipcast_get_version') return 'test';
      if (command === 'snipcast_get_variables') return {};
      if (command === 'snipcast_get_template_store') return {version: 1, groups: []};
      if (command === 'snipcast_ocr_languages') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'snipcast_update_writable') return true;
      if (command === 'plugin:autostart|is_enabled') return false;
      return null;
    }
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(f"({BRIDGE})({json.dumps(CONFIG)})")
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Скриншот", exact=True).click()
    title = page.locator(".settings__preset-title").first
    page.evaluate("qa.delayRead = true")
    title.fill("Промежуточное название")
    page.wait_for_function("qa.readPending")
    title.fill("Окончательное название")
    page.evaluate("qa.releaseRead()")
    page.wait_for_function("qa.config.screenshotPresets[0].title === 'Окончательное название'")
    page.wait_for_timeout(1100)
    expect(title).to_have_value("Окончательное название")
    assert page.evaluate("qa.config.screenshotPresets[0].id") == "stable"

    page.get_by_role("button", name="Добавить пресет", exact=True).click()
    new_title = page.locator(".settings__preset-title").nth(1)
    new_title.fill("Правка до первого сохранения")
    page.wait_for_function("qa.config.screenshotPresets.length === 2")
    new_id = page.evaluate("qa.config.screenshotPresets[1].id")
    assert new_id
    new_title.fill("Ещё одна правка")
    page.wait_for_function("qa.config.screenshotPresets[1].title === 'Ещё одна правка'")
    assert page.evaluate("qa.config.screenshotPresets[1].id") == new_id
    assert not errors, errors
    print("PASS: late autosave response preserves a newer edit; new preset id remains stable across early edits")
    browser.close()
