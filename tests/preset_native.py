"""Preset CRUD against the real Tauri/WebView2 backend (Windows).

Run after `npm run tauri build -- --no-bundle`. Uses isolated data; never edits
the user's settings. --expect-hang reproduces the pre-fix config/tray deadlock.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import socket
import tempfile
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--exe", type=Path, default=ROOT / "src-tauri/target/release/snipcast.exe")
parser.add_argument("--expect-hang", action="store_true")
args = parser.parse_args()
PORT = 9237


def ping(page):
    return page.evaluate("""async () => Promise.race([
      window.__TAURI_INTERNALS__.invoke('snipcast_get_version').then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 1500))
    ])""")


def saved_config(page):
    return page.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_get_config')")


def wait_saved(page, expression):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        assert ping(page), f"Backend stopped responding after {expression}"
        if page.evaluate(f"""async () => {{
          const cfg = await window.__TAURI_INTERNALS__.invoke('snipcast_get_config');
          return {expression};
        }}"""):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"Preset was not persisted: {expression}")


def post_preset(config, data_dir, preset_id):
    # Read only the isolated test token; never print it or access the user's token.
    token = (data_dir / "api-token").read_text(encoding="utf8").strip()
    request = urllib.request.Request(f"http://127.0.0.1:{config['apiPort']}/preset",
        data=json.dumps({"id": preset_id}).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Snipcast-Token": token})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert json.load(response)["ok"]


with tempfile.TemporaryDirectory(prefix="snipcast-preset-qa-") as folder:
    data_dir = Path(folder)
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", 0))
        api_port = port_probe.getsockname()[1]
    config = {
        "paletteHotkey": "", "screenshotHotkey": "", "autostart": False,
        "theme": "dark", "paletteListDensity": "normal", "screenshotFormat": "png",
        "screenshotJpegQuality": 90, "screenshotFileTemplate": "qa {n}",
        "screenshotSaveDir": folder, "screenshotQuickLocations": [],
        "screenshotOcrEngine": "system", "screenshotOcrLanguage": "auto",
        "screenshotOcrQuality": "mobile", "screenshotPresets": [],
        "apiEnabled": True, "apiPort": api_port, "aiApiKey": "", "aiModel": "",
    }
    (data_dir / "config.json").write_text(json.dumps(config), encoding="utf8")
    env = {**os.environ, "SNIPCAST_DATA_DIR": folder,
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f"--remote-debugging-port={PORT}"}
    with (data_dir / "process.log").open("w", encoding="utf8") as log:
        process = subprocess.Popen([str(args.exe.resolve())], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=0.3).close()
                    break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError("Test app exited; close any other Snipcast instance first")
                    time.sleep(0.1)
            else:
                raise RuntimeError("WebView2 debugging endpoint did not start")
            with sync_playwright() as p:
                browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
                page = next(page for page in browser.contexts[0].pages if "snipcast=settings" in page.url)
                page.set_default_timeout(5000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.wait_for_load_state("networkidle")
                page.evaluate("window.__TAURI_INTERNALS__.invoke('snipcast_open_settings')")
                page.get_by_role("button", name="Скриншот", exact=True).click()
                assert ping(page), "Backend must respond before adding a preset"
                page.get_by_role("button", name="Добавить пресет", exact=True).click()
                expect(page.locator(".settings__preset")).to_have_count(1)
                # Wait for the real 500ms debounce and tray update, not just DOM rendering.
                page.wait_for_timeout(1100)
                responsive = ping(page)
                if args.expect_hang:
                    assert not responsive, "Expected pre-fix preset save to block the UI thread"
                    print("REPRODUCED: adding a preset blocks the native backend after autosave")
                else:
                    assert responsive, "Adding a preset blocked the native backend"
                    saved = saved_config(page)
                    assert len(saved["screenshotPresets"]) == 1
                    preset_id = saved["screenshotPresets"][0]["id"]
                    assert preset_id
                    row = page.locator(".settings__preset").first
                    row.locator(".settings__preset-title").fill("Проверка пресета")
                    wait_saved(page, "cfg.screenshotPresets[0].title === 'Проверка пресета'")
                    assert saved_config(page)["screenshotPresets"][0]["id"] == preset_id
                    row.locator(".settings__preset-template").fill("preset-test-{n}")
                    wait_saved(page, "cfg.screenshotPresets[0].fileTemplate === 'preset-test-{n}'")

                    hotkey = row.locator(".settings__preset-hotkey")
                    hotkey.click()
                    hotkey.press("Control+Alt+Shift+F12")
                    expect(hotkey).to_have_value("Shift+Alt+Ctrl+F12")
                    wait_saved(page, "cfg.screenshotPresets[0].hotkey === 'Shift+Alt+CommandOrControl+F12'")
                    row.locator(".settings__preset-title").click()
                    assert ping(page), "Hotkey resume blocked the backend"
                    row.get_by_role("button", name="Очистить", exact=True).click()
                    wait_saved(page, "cfg.screenshotPresets[0].hotkey === ''")

                    for label, action in [("Сохранить + текст", "ocr"), ("Закрепить", "pin"), ("Сохранить", "save")]:
                        row.get_by_role("radio", name=label, exact=True).click()
                        wait_saved(page, f"cfg.screenshotPresets[0].action === '{action}'")
                    row.get_by_role("radio", name="Весь экран", exact=True).click()
                    wait_saved(page, "cfg.screenshotPresets[0].select === false")
                    post_preset(config, data_dir, preset_id)
                    assert list(data_dir.glob("preset-test-*.png")), f"Full-screen preset did not save a PNG: files={[f.name for f in data_dir.iterdir()]}, preset={saved_config(page)['screenshotPresets'][0]}"
                    assert ping(page), "Full-screen preset left the backend blocked"

                    row.get_by_role("radio", name="Выделение области", exact=True).click()
                    wait_saved(page, "cfg.screenshotPresets[0].select === true")
                    post_preset(config, data_dir, preset_id)
                    deadline = time.monotonic() + 10
                    capture = None
                    while time.monotonic() < deadline:
                        capture = next((candidate for candidate in browser.contexts[0].pages
                            if candidate != page and not candidate.is_closed()
                            and candidate.locator(".capture").count()), None)
                        if capture:
                            break
                        page.wait_for_timeout(100)
                    assert capture, "Area preset did not open a capture overlay"
                    capture.on("pageerror", lambda error: errors.append(str(error)))
                    expect(capture.locator(".capture--presented")).to_be_visible()
                    expect(capture.locator(".capture__preset-chip")).to_be_visible()
                    capture.mouse.move(100, 100)
                    capture.mouse.down()
                    capture.mouse.move(350, 250, steps=10)
                    capture.mouse.up()
                    deadline = time.monotonic() + 10
                    while len(list(data_dir.glob("preset-test-*.png"))) < 2 and time.monotonic() < deadline:
                        page.wait_for_timeout(100)
                    assert len(list(data_dir.glob("preset-test-*.png"))) == 2, "Area preset did not save a second PNG"
                    assert ping(page), "Area preset left the backend blocked"
                    page.get_by_role("button", name="Добавить пресет", exact=True).click()
                    wait_saved(page, "cfg.screenshotPresets.length === 2")
                    second = page.locator(".settings__preset").nth(1)
                    second.locator('button[aria-label^="Удалить пресет"]').click()
                    wait_saved(page, "cfg.screenshotPresets.length === 1")
                    assert saved_config(page)["screenshotPresets"][0]["id"] == preset_id
                    row.locator('button[aria-label^="Удалить пресет"]').click()
                    wait_saved(page, "cfg.screenshotPresets.length === 0")
                    assert not errors, errors
                    print("PASS: native preset add, rename, stable id, template, hotkey record/clear, all action settings, modes, full-screen and area PNGs, delete; backend responsive after every operation")
        finally:
            process.terminate()
            process.wait(timeout=10)
