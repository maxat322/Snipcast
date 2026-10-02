"""Settings hotkey regression: Windows PrintScreen keyup and duplicate prevention."""
import json
import os

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("SNIPCAST_SETTINGS_TEST_URL", "http://localhost:1420/?snipcast=settings")
CONFIG = {
    "paletteHotkey": "Control+Shift+F11", "screenshotHotkey": "ScrollLock",
    "autostart": False, "theme": "dark", "paletteListDensity": "normal",
    "screenshotFormat": "png", "screenshotJpegQuality": 90,
    "screenshotFileTemplate": "{datetime}", "screenshotSaveDir": "",
    "screenshotQuickLocations": [], "screenshotOcrEngine": "system",
    "screenshotOcrLanguage": "", "screenshotOcrQuality": "fast",
    "screenshotPresets": [{"id": "test", "title": "Тест", "hotkey": "",
        "dir": "", "fileTemplate": "", "action": "save", "select": True}],
    "apiEnabled": False, "apiPort": 0, "aiApiKey": "", "aiModel": "",
}
BRIDGE = r"""config => {
  window.qa = {config, saves: [], commands: []};
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, args = {}) => {
      qa.commands.push(command);
      if (command === 'snipcast_get_config') return structuredClone(qa.config);
      if (command === 'snipcast_save_config') {
        qa.config = structuredClone(args.incoming);
        qa.saves.push(qa.config);
      }
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


def key(field, kind="keyup", **overrides):
    # Matches the real Win32/WebView2 event reproduced with SendInput.
    field.dispatch_event(kind, {"key": "PrintScreen", "code": "", "keyCode": 44,
        "bubbles": True, "cancelable": True, **overrides})


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(f"({BRIDGE})({json.dumps(CONFIG)})")
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    shot = page.get_by_label("Запись хоткея скриншота", exact=True)
    shot.click()
    key(shot)
    expect(shot).to_have_value("PrintScreen")
    assert page.evaluate("qa.config.screenshotHotkey") == "PrintScreen"
    page.wait_for_function("qa.saves.length === 1")
    assert page.evaluate("qa.commands.includes('snipcast_screenshot_hotkey_pause')")

    key(shot, ctrlKey=True, shiftKey=True)
    expect(shot).to_have_value("Shift+Ctrl+PrintScreen")
    page.wait_for_function("qa.saves.length === 2")
    key(shot, "keydown", code="PrintScreen", altKey=True)
    key(shot, "keyup", code="PrintScreen")
    expect(shot).to_have_value("Alt+PrintScreen")
    page.wait_for_function("qa.saves.length === 3")

    # Modifier releases and ordinary keyup must not replace the recorded chord.
    shot.dispatch_event("keyup", {"key": "Alt", "code": "AltLeft", "keyCode": 18})
    expect(shot).to_have_value("Alt+PrintScreen")
    shot.press("Control+KeyA")
    expect(shot).to_have_value("Ctrl+A")
    page.wait_for_function("qa.saves.length === 4")

    palette = page.get_by_label("Запись хоткея палитры", exact=True)
    palette.click()
    page.wait_for_function("qa.commands.includes('snipcast_screenshot_hotkey_resume')")
    key(palette, ctrlKey=True)
    expect(palette).to_have_value("Ctrl+PrintScreen")
    assert page.evaluate("qa.config.paletteHotkey") == "CommandOrControl+PrintScreen"
    page.wait_for_function("qa.saves.length === 5")

    page.get_by_role("button", name="Скриншот", exact=True).click()
    preset = page.locator(".settings__preset-hotkey")
    preset.click()
    key(preset, altKey=True, shiftKey=True)
    expect(preset).to_have_value("Shift+Alt+PrintScreen")
    assert page.evaluate("qa.config.screenshotPresets[0].hotkey") == "Shift+Alt+PrintScreen"
    page.wait_for_function("qa.saves.length === 6")
    preset.press("Escape")
    page.wait_for_function("qa.commands.includes('snipcast_preset_hotkeys_resume')")
    assert page.evaluate("document.activeElement.classList.contains('settings__preset-hotkey')") is False
    assert page.evaluate("qa.saves.length") == 6
    assert not errors, errors
    print("Settings hotkeys: 6 saves verified; screenshot, palette, preset, modifiers, keyup-only, deduplication, Escape/blur passed")
    browser.close()
