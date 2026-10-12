"""Демо-проверка: Ctrl+Z/Ctrl+Y в редакторе аннотаций и двойной клик по закрепу.

Запускается с vite dev-сервером (with_server.py). Ожидания:
- capture (?snipcast=capture): линия рисуется, Ctrl+Z её убирает, Ctrl+Y возвращает;
- pin (?snipcast=pin): одиночный клик НЕ закрывает, двойной клик закрывает
  (в демо closePin пишет в консоль "[demo] snipcast_pin_close").
"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:1420"

# Возвращает [{alpha, r, g, b, bg}] для каждого canvas в точке (x, y).
SAMPLE = """(pt) => {
  return Array.from(document.querySelectorAll('canvas')).map((c) => {
    const ctx = c.getContext('2d');
    const dpr = c.width / c.getBoundingClientRect().width;
    const x = Math.round(pt.x * dpr), y = Math.round(pt.y * dpr);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { alpha: d[3], r: d[0], g: d[1], b: d[2] };
  }).filter(Boolean);
}"""


def sample_pixel(page, x, y):
    data = page.evaluate(SAMPLE, {"x": x, "y": y})
    # Считаем точку «закрашенной», если какой-либо canvas рисует непрозрачное.
    return any(px["alpha"] > 0 for px in data)


def test_capture_undo_redo():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.goto(f"{BASE}/?snipcast=capture")
        page.wait_for_load_state("networkidle")

        # Выделяем область — появится тулбар.
        page.mouse.move(300, 200)
        page.mouse.down()
        page.mouse.move(900, 600, steps=20)
        page.mouse.up()
        page.wait_for_selector('button[title="Нарисовать линию (2)"]')

        # Инструмент «Линия», затем рисуем линию из (400,300) в (600,450).
        page.click('button[title="Нарисовать линию (2)"]')
        page.mouse.move(400, 300)
        page.mouse.down()
        page.mouse.move(600, 450, steps=15)
        page.mouse.up()
        page.wait_for_timeout(150)

        mid = {"x": 500, "y": 375}
        drawn = sample_pixel(page, *mid.values())
        assert drawn, "линия не нарисована (пиксель пустой)"

        # Ctrl+Z — линия исчезает (проверяет путь e.code === "KeyZ").
        page.keyboard.press("Control+z")
        page.wait_for_timeout(150)
        after_undo = sample_pixel(page, *mid.values())
        assert not after_undo, "Ctrl+Z не убрал линию"

        # Ctrl+Y — redo, линия возвращается.
        page.keyboard.press("Control+y")
        page.wait_for_timeout(150)
        after_redo = sample_pixel(page, *mid.values())
        assert after_redo, "Ctrl+Y не вернул линию"

        # Ctrl+Shift+Z — тоже redo (сдвиг меняет направление), состояние не меняется.
        page.keyboard.press("Control+Shift+z")
        page.wait_for_timeout(150)
        after_shift_redo = sample_pixel(page, *mid.values())
        assert after_shift_redo, "Ctrl+Shift+Z (redo при пустом future) изменил состояние"

        # Обычный Ctrl+Z после redo — линия снова исчезает.
        page.keyboard.press("Control+z")
        page.wait_for_timeout(150)
        assert not sample_pixel(page, *mid.values()), "повторный Ctrl+Z не убрал линию"

        browser.close()


def test_pin_double_click():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        logs = []
        page.on("console", lambda m: logs.append(m.text))
        page.goto(f"{BASE}/?snipcast=pin")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)

        # Одиночный клик — закрытия быть не должно.
        page.mouse.click(400, 300)
        page.wait_for_timeout(700)  # больше DOUBLE_CLICK_MS
        close_logs = [t for t in logs if "snipcast_pin_close" in t]
        assert not close_logs, f"одиночный клик закрыл закреп: {close_logs}"

        # Двойной клик — closePin вызывается (в демо пишет в консоль).
        page.mouse.dblclick(400, 300)
        page.wait_for_timeout(300)
        close_logs = [t for t in logs if "snipcast_pin_close" in t]
        assert close_logs, f"двойной клик не закрыл закреп, логи: {logs[:10]}"

        browser.close()


if __name__ == "__main__":
    results = {}
    for name, fn in [("capture_undo_redo", test_capture_undo_redo),
                     ("pin_double_click", test_pin_double_click)]:
        try:
            fn()
            results[name] = "OK"
        except Exception as e:  # noqa: BLE001
            results[name] = f"FAIL: {e}"
    print(json.dumps(results, ensure_ascii=False, indent=2))
    sys.exit(0 if all(v == "OK" for v in results.values()) else 1)
