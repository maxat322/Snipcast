"""Real pointer/keyboard and PNG regression tests for the capture text tool."""
import base64
import io
import json
import os
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = os.environ.get("SNIPCAST_TEST_URL", "http://localhost:1420/?snipcast=capture")
OUT = Path(__file__).resolve().parents[1] / "dist" / "text-qa"
OUT.mkdir(parents=True, exist_ok=True)
RESULTS = []


def bounds(locator):
    b = locator.bounding_box()
    assert b is not None
    return b


def near(a, b, tolerance=1):
    assert abs(a - b) <= tolerance, (a, b)


def selection(page):
    return page.locator(".capture__text-selection:not(.is-editing)")


def drag(page, start, end):
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=8)
    page.mouse.up()


def text_button(page):
    return page.locator(".capture__toolbar button").nth(3)


def editor(page):
    return page.locator(".capture__text-edit")


def setup(browser, dpr=1):
    page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=dpr)
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("""(() => {
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const png = original.apply(this, args);
        window.__lastExport = { png, width: this.width, height: this.height };
        return png;
      };
    })()""")
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.locator(".capture").wait_for()
    drag(page, (100, 100), (1130, 660))
    page.locator(".capture__toolbar").wait_for()
    return page, errors


def create(page, text, frame=None, at=(320, 240)):
    text_button(page).click()
    if frame:
        drag(page, at, (at[0] + frame[0], at[1] + frame[1]))
    else:
        page.mouse.click(*at)
    editor(page).wait_for()
    assert page.evaluate("document.activeElement.className") == "capture__text-edit"
    editor(page).fill(text)


def confirm(page):
    page.keyboard.press("Enter")
    assert editor(page).count() == 0
    assert selection(page).count() == 1
    assert "is-active" not in (text_button(page).get_attribute("class") or "")


def red_bbox(image):
    rgb = image.convert("RGB")
    mask = Image.new("L", rgb.size)
    pixels = rgb.get_flattened_data() if hasattr(rgb, "get_flattened_data") else rgb.getdata()
    mask.putdata([255 if r > 110 and r > g * 1.4 and r > b * 1.3 else 0 for r, g, b in pixels])
    return mask.getbbox()


def native_layout(page, text, width, font_size=22):
    return page.evaluate("""async ({text, width, fontSize}) => {
      const {layoutText} = await import('/src/capture/textLayout.ts');
      return layoutText({id:1, kind:'text', color:'#ff4d4d', p1:{x:0,y:0}, p2:{x:0,y:0},
        text, fontSize, textMode:width ? 'frame' : 'auto', width:width || 0, minHeight:0});
    }""", {"text": text, "width": width, "fontSize": font_size})


def test_creation_and_export(browser, dpr):
    page, errors = setup(browser, dpr)
    text = "Оченьдлинноесловобезпробелов1234567890 👩‍🚀\n\nДва  пробела\n"
    create(page, text, frame=(65, 70))
    before = bounds(editor(page))
    near(before["width"], 65, .01)
    assert before["height"] > 70
    layout = native_layout(page, text, 65)
    near(before["height"], layout["h"], .05)
    # Compare native textarea glyph positions with the committed Canvas, excluding the caret/handles.
    image_before = Image.open(io.BytesIO(page.screenshot()))
    confirm(page)
    after = bounds(selection(page))
    for key in before:
        near(before[key], after[key], .05)
    image_after = Image.open(io.BytesIO(page.screenshot()))
    before_pixels = red_bbox(image_before)
    after_pixels = red_bbox(image_after)
    assert before_pixels and after_pixels
    for a, b in zip(before_pixels, after_pixels):
        near(a, b, max(2, dpr))
    page.screenshot(path=str(OUT / f"frame-{dpr}.png"))
    page.mouse.dblclick(after["x"] + 15, after["y"] + 8)
    reopened = bounds(editor(page))
    for key in before:
        near(before[key], reopened[key], .05)
    assert editor(page).input_value() == text
    # Export while the input is still active: the latest text must be present exactly once.
    editor(page).fill(text + "Экспорт")
    page.locator(".capture__toolbar button").last.click()
    assert editor(page).count() == 0
    export = page.evaluate("window.__lastExport")
    assert export["width"] == round(1030 * dpr)
    assert export["height"] == round(560 * dpr)
    png = Image.open(io.BytesIO(base64.b64decode(export["png"].split(",")[1])))
    assert red_bbox(png)
    png.save(OUT / f"export-{dpr}.png")
    # Export and committed overlay must have the same text pixel bounds, relative to the crop.
    # Selection handles can cover descenders; they are UI chrome, not exported pixels.
    selection(page).evaluate("el => el.style.visibility = 'hidden'")
    final = Image.open(io.BytesIO(page.screenshot()))
    expected = final.crop((round(100*dpr), round(100*dpr), round(1130*dpr), round(660*dpr)))
    for a, b in zip(red_bbox(expected), red_bbox(png)):
        near(a, b, max(2, dpr))
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "narrow frame, WYSIWYG, reopen, active-input PNG export", "dpr": dpr})


def test_free_and_keyboard(browser):
    page, errors = setup(browser)
    create(page, "Свободный текст")
    assert page.locator("[data-tsize]").count() == 0
    page.keyboard.press("End")
    page.keyboard.press("Shift+Enter")
    page.keyboard.insert_text("Вторая строка")
    assert "\n" in editor(page).input_value()
    before = bounds(editor(page))
    confirm(page)
    frame = bounds(selection(page))
    near(frame["x"], 320)
    near(frame["y"], 240)
    near(frame["height"], before["height"])
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Shift+ArrowDown")
    moved = bounds(selection(page))
    near(moved["x"], frame["x"] + 1)
    near(moved["y"], frame["y"] + 10)
    page.keyboard.press("Control+z")
    near(bounds(selection(page))["y"], frame["y"])
    page.keyboard.press("Control+Shift+z")
    near(bounds(selection(page))["y"], moved["y"])
    page.keyboard.press("Enter")
    assert editor(page).input_value().startswith("Свободный текст")
    editor(page).fill("Отменённая правка")
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    assert editor(page).input_value().startswith("Свободный текст")
    page.keyboard.press("Enter")
    page.keyboard.press("Delete")
    assert selection(page).count() == 0
    page.keyboard.press("Control+z")
    # Undo restores the object even when selection was cleared by deletion.
    page.mouse.click(moved["x"] + 20, moved["y"] + 10)
    assert selection(page).count() == 1
    page.keyboard.press("Escape")
    assert selection(page).count() == 0
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "free text, multiline, arrows, edit cancel, delete, undo/redo, Esc"})


def test_handles(browser):
    for handle in ["nw", "n", "ne", "e", "se", "s", "sw", "w"]:
        page, errors = setup(browser)
        create(page, "Текст", frame=(200, 110))
        confirm(page)
        original = bounds(selection(page))
        b = bounds(page.locator(f'[data-tsize="{handle}"]'))
        start = (b["x"] + 5, b["y"] + 5)
        dx = -30 if "w" in handle else 30 if "e" in handle else 0
        dy = -25 if "n" in handle else 25 if "s" in handle else 0
        drag(page, start, (start[0] + dx, start[1] + dy))
        changed = bounds(selection(page))
        near(changed["width"], 230 if dx else 200)
        near(changed["height"], 135 if dy else 110)
        near(changed["x"] + changed["width"] if "w" in handle else changed["x"],
             original["x"] + original["width"] if "w" in handle else original["x"])
        near(changed["y"] + changed["height"] if "n" in handle else changed["y"],
             original["y"] + original["height"] if "n" in handle else original["y"])
        page.keyboard.press("Control+z")
        for key in original:
            near(bounds(selection(page))[key], original[key])
        # Cancel a resize mid-gesture without committing history or leaving capture stuck.
        b = bounds(page.locator(f'[data-tsize="{handle}"]'))
        page.mouse.move(b["x"] + 5, b["y"] + 5)
        page.mouse.down()
        page.mouse.move(b["x"] + 5 + dx, b["y"] + 5 + dy, steps=5)
        page.keyboard.press("Escape")
        page.mouse.up()
        for key in original:
            near(bounds(selection(page))[key], original[key])
        assert not errors, errors
        page.close()
        RESULTS.append({"test": "resize, fixed opposite anchor, undo, gesture cancel", "handle": handle})


def test_properties_focus_and_move(browser):
    page, errors = setup(browser)
    create(page, "abcdef", frame=(65, 45))
    editor(page).evaluate("el => el.setSelectionRange(2,4)")
    page.locator(".capture__swatch").nth(1).click()
    assert editor(page).count() == 1
    assert page.evaluate("document.activeElement.className") == "capture__text-edit"
    assert editor(page).evaluate("el => [el.selectionStart,el.selectionEnd]") == [2, 4]
    assert editor(page).evaluate("el => getComputedStyle(el).color") == "rgb(81, 100, 242)"
    # Keyboard changes to the real slider exercise the same property route.
    slider = page.locator('.capture__opts input[type="range"]')
    slider.focus()
    page.keyboard.press("ArrowRight")
    assert editor(page).count() == 1
    near(float(editor(page).evaluate("el => parseFloat(getComputedStyle(el).fontSize)")), 23)
    editor(page).focus()
    page.keyboard.press("Enter")
    old = bounds(selection(page))
    drag(page, (old["x"] + 15, old["y"] + 10), (old["x"] + 75, old["y"] + 60))
    moved = bounds(selection(page))
    near(moved["x"], old["x"] + 60)
    near(moved["y"], old["y"] + 50)
    page.mouse.dblclick(moved["x"] + 8, moved["y"] + 8)
    assert editor(page).evaluate("el => el.selectionStart") < len("abcdef")
    assert editor(page).evaluate("el => getComputedStyle(el).color") == "rgb(81, 100, 242)"
    near(float(editor(page).evaluate("el => parseFloat(getComputedStyle(el).fontSize)")), 23)
    page.keyboard.press("Escape")
    # Explicit empty submission removes existing text; empty/cancelled creation leaves no object.
    page.keyboard.press("Enter")
    editor(page).fill("")
    page.keyboard.press("Enter")
    assert selection(page).count() == 0
    text_button(page).click()
    page.mouse.click(600, 400)
    page.keyboard.press("Escape")
    assert selection(page).count() == 0
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "property focus/caret, font size, move, double-click caret, empty text"})


def test_native_undo_ime_and_frame_conversion(browser):
    page, errors = setup(browser)
    create(page, "")
    page.keyboard.type("native undo", delay=30)
    page.keyboard.press("Control+z")
    assert len(editor(page).input_value()) < len("native undo")
    page.keyboard.press("Control+Shift+z")
    assert editor(page).input_value() == "native undo"
    editor(page).dispatch_event("compositionstart")
    page.keyboard.press("Enter")
    assert editor(page).count() == 1
    editor(page).dispatch_event("compositionend")
    editor(page).fill("Свободный текст для переноса")
    confirm(page)
    assert selection(page).get_attribute("data-text-mode") == "auto"
    b = bounds(page.locator('[data-tsize="e"]'))
    drag(page, (b["x"] + 5, b["y"] + 5), (b["x"] - 80, b["y"] + 5))
    assert selection(page).get_attribute("data-text-mode") == "frame"
    page.keyboard.press("Enter")
    assert editor(page).evaluate("el => getComputedStyle(el).fontSize") == "22px"
    assert editor(page).input_value() == "Свободный текст для переноса"
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "native undo/redo, composition guard, free-to-frame conversion"})


def test_layout_edge_cases(browser):
    page, errors = setup(browser)
    for text in ["", "\n", "\n\n", "a\n\n", "a  b", "a\tb\n\tc", "👩‍🚀👨‍👩‍👧‍👦🇷🇺", "Длинноесловобезпробелов1234567890"]:
        for width in [None, 8, 65, 200]:
            layout = native_layout(page, text, width)
            assert layout["h"] >= 26.4 - .01
            assert layout["lines"]
            # Every source character (except hard newlines) appears exactly once across lines.
            assert "".join(line["text"] for line in layout["lines"]) == text.replace("\n", "")
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "32 native layouts: empty lines, spaces, tabs, emoji, long words"})


def test_editing_resize_threshold_and_outside_commit(browser):
    page, errors = setup(browser)
    # Sub-threshold movement is still a point text; reverse dragging makes a frame.
    text_button(page).click()
    drag(page, (320, 240), (322, 242))
    assert editor(page).get_attribute("wrap") == "off"
    page.keyboard.press("Escape")
    text_button(page).click()
    drag(page, (500, 380), (320, 240))
    editor(page).fill("Редактирование внутри рамки")
    before = bounds(editor(page))
    near(before["width"], 180)
    near(before["height"], 140)
    editor(page).evaluate("el => el.setSelectionRange(3, 7)")
    handle = bounds(page.locator('[data-tsize="nw"]'))
    drag(page, (handle["x"] + 5, handle["y"] + 5), (handle["x"] - 25, handle["y"] - 20))
    assert editor(page).count() == 1
    after = bounds(editor(page))
    near(after["x"] + after["width"], before["x"] + before["width"])
    near(after["y"] + after["height"], before["y"] + before["height"])
    assert editor(page).evaluate("el => [el.selectionStart, el.selectionEnd]") == [3, 7]
    page.mouse.click(800, 450)
    assert editor(page).count() == 0
    assert selection(page).count() == 1
    # Height can shrink to the text but never clips it.
    handle = bounds(page.locator('[data-tsize="s"]'))
    drag(page, (handle["x"] + 5, handle["y"] + 5), (handle["x"] + 5, after["y"] + 5))
    page.keyboard.press("Enter")
    minimum = native_layout(page, editor(page).input_value(), bounds(editor(page))["width"])
    near(bounds(editor(page))["height"], minimum["contentHeight"], .05)
    assert editor(page).evaluate("el => el.scrollHeight <= el.clientHeight + 1")
    page.keyboard.press("Escape")
    # A lost/cancelled pointer restores geometry and leaves the next gesture usable.
    original = bounds(selection(page))
    page.mouse.move(original["x"] + 20, original["y"] + 10)
    page.mouse.down()
    page.mouse.move(original["x"] + 60, original["y"] + 35)
    page.locator(".capture").dispatch_event("pointercancel", {"pointerId": 1})
    page.mouse.up()
    for key in original:
        near(bounds(selection(page))[key], original[key])
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "click threshold, reverse frame, editing resize/caret, outside submit, min height, pointer cancel"})


def test_mixed_annotations_and_slider_history(browser):
    page, errors = setup(browser)
    page.locator(".capture__toolbar button").nth(0).click()
    drag(page, (700, 230), (840, 300))
    page.locator("[data-kp='1']").wait_for()
    create(page, "Текст рядом со стрелкой", at=(320, 240))
    confirm(page)
    original = bounds(selection(page))
    slider = page.locator('.capture__opts input[type="range"]')
    b = bounds(slider)
    # Several changes during one slider gesture form one undo transaction.
    drag(page, (b["x"] + b["width"]*.12, b["y"] + b["height"]/2),
         (b["x"] + b["width"]*.35, b["y"] + b["height"]/2))
    assert bounds(selection(page))["height"] > original["height"]
    page.locator(".capture__toolbar").click(position={"x": 2, "y": 2})
    page.keyboard.press("Control+z")
    for key in original:
        near(bounds(selection(page))[key], original[key])
    page.keyboard.press("Control+z")  # text creation
    assert selection(page).count() == 0
    page.mouse.click(770, 265)
    assert page.locator("[data-kp='1']").count() == 1
    page.keyboard.press("Control+z")  # arrow creation
    assert page.locator("[data-kp='1']").count() == 0
    page.keyboard.press("Control+Shift+z")
    page.mouse.click(770, 265)
    assert page.locator("[data-kp='1']").count() == 1
    assert not errors, errors
    page.close()
    RESULTS.append({"test": "mixed arrow/text annotations and grouped slider history"})


if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for dpr in [1, 1.25, 1.5, 2]:
            test_creation_and_export(browser, dpr)
        test_free_and_keyboard(browser)
        test_handles(browser)
        test_properties_focus_and_move(browser)
        test_native_undo_ime_and_frame_conversion(browser)
        test_layout_edge_cases(browser)
        test_editing_resize_threshold_and_outside_commit(browser)
        test_mixed_annotations_and_slider_history(browser)
        browser.close()
    (OUT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(RESULTS), "results": RESULTS}, ensure_ascii=True))
