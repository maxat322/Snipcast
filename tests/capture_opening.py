"""Opening/reopening presentation with a controlled native Tauri bridge."""
import base64
import io
import json

from PIL import Image
from playwright.sync_api import sync_playwright
from capture_text import BASE, create, confirm, drag


def screenshot_bytes():
    data = io.BytesIO()
    Image.new("RGB", (1280, 900), "#dedede").save(data, "PNG")
    return base64.b64encode(data.getvalue()).decode()


BRIDGE = r"""png => {
  const callbacks = new Map(), listeners = new Map();
  let id = 0;
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0)).buffer;
  window.qa = {session: 1, ready: [], held: false, release: null, frames: 0};
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => {qa.frames++; cb(t)});
  window.qa.emit = (event, payload) => {
    for (const [eventId, listener] of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({event, id:eventId, payload});
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_, eventId) => listeners.delete(eventId)
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {currentWindow:{label:'capture-0'}, currentWebview:{windowLabel:'capture-0'}},
    transformCallback: cb => {callbacks.set(++id, cb); return id},
    unregisterCallback: callbackId => callbacks.delete(callbackId),
    invoke: async (command, args = {}) => {
      if (command === 'plugin:event|listen') {listeners.set(++id, args); return id}
      if (command === 'plugin:event|unlisten') return;
      if (command === 'snipcast_get_config') return {theme:'dark', screenshotQuickLocations:[]};
      if (command === 'snipcast_capture_info') return {
        label:'capture-0', imageName:`frame-${qa.session}.png`, x:0, y:0, width:1280, height:900, scale:1
      };
      if (command === 'snipcast_capture_image_data') {
        if (qa.held) await new Promise(resolve => {qa.release = resolve});
        return bytes.slice(0);
      }
      if (command === 'snipcast_capture_ready') {
        const root = document.querySelector('.capture'), image = document.querySelector('.capture__shot');
        qa.ready.push({imageName:args.imageName, opacity:+getComputedStyle(root).opacity,
          loaded:!!image?.complete && image.naturalWidth===1280, frames:qa.frames,
          selected:document.querySelectorAll('.capture__frame,.capture__text-selection').length});
        return;
      }
      if (command === 'snipcast_close_capture') return;
      throw new Error(`Unexpected command: ${command}`);
    }
  };
}"""


def open_mock(browser, reduced_motion="no-preference"):
    page = browser.new_page(viewport={"width": 1280, "height": 900}, reduced_motion=reduced_motion)
    errors = []
    page.on("pageerror", lambda error: errors.append(error.stack))
    page.add_init_script(f"({BRIDGE})({json.dumps(screenshot_bytes())})")
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.wait_for_function("qa.ready.length === 1")
    return page, errors


def show(page, session):
    page.evaluate("session => qa.emit('snipcast://capture-shown', `frame-${session}.png`)", session)
    page.wait_for_function("document.querySelector('.capture').classList.contains('capture--presented')")
    page.wait_for_function("+getComputedStyle(document.querySelector('.capture')).opacity === 1")


def opacity(page):
    return page.locator(".capture").evaluate("el => +getComputedStyle(el).opacity")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page, errors = open_mock(browser)
    ready = page.evaluate("qa.ready[0]")
    assert ready["opacity"] == 0 and ready["loaded"] and ready["frames"] >= 2, ready
    assert opacity(page) == 0  # A hidden prewarmed window cannot finish its entry early.
    page.evaluate("qa.emit('snipcast://capture-shown', 'old.png')")
    assert opacity(page) == 0
    page.evaluate("qa.emit('snipcast://capture-shown', 'frame-1.png')")
    page.wait_for_function("document.querySelector('.capture').getAnimations().some(a => a.transitionProperty === 'opacity')")
    samples = page.locator(".capture").evaluate("""el => {
      const transition = el.getAnimations().find(a => a.transitionProperty === 'opacity');
      transition.pause();
      const samples = [0,90,180].map(t => {transition.currentTime=t; return +getComputedStyle(el).opacity});
      transition.finish(); return samples;
    }""")
    assert samples[0] == 0 and 0 < samples[1] < 1 and samples[2] == 1, samples
    drag(page, (100,100), (1100,650))
    create(page, "Previous annotation")
    confirm(page)
    page.evaluate("qa.held=true; qa.session=2; qa.emit('snipcast://capture-session'); qa.emit('snipcast://capture-shown','frame-1.png')")
    page.wait_for_function("qa.release !== null")
    assert opacity(page) == 0
    assert page.locator(".capture__frame,.capture__text-selection,.capture__text-edit").count() == 0
    page.evaluate("qa.emit('snipcast://capture-shown', 'frame-1.png')")
    assert opacity(page) == 0
    page.evaluate("qa.held=false; qa.release()")
    page.wait_for_function("qa.ready.length === 2")
    assert page.evaluate("qa.ready[1].selected") == 0
    assert opacity(page) == 0
    page.evaluate("qa.emit('snipcast://capture-shown', 'frame-1.png')")
    assert opacity(page) == 0
    show(page, 2)
    # Two sessions inside the paint wait: only the newest may request show.
    page.evaluate("""() => {
      qa.savedRaf=window.requestAnimationFrame;
      window.requestAnimationFrame=() => 0;
      qa.session=3;qa.emit('snipcast://capture-session');
    }""")
    page.locator(".capture__shot").wait_for()
    page.evaluate("qa.session=4;qa.emit('snipcast://capture-session')")
    page.wait_for_function("qa.ready.some(r=>r.imageName==='frame-4.png')")
    assert page.evaluate("qa.ready.some(r=>r.imageName==='frame-3.png')") is False
    assert opacity(page) == 0
    page.evaluate("() => {window.requestAnimationFrame=qa.savedRaf;}")
    show(page, 4)
    assert not errors, errors
    page.close()
    page, errors = open_mock(browser, "reduce")
    show(page, 1)
    assert page.locator(".capture").evaluate("el=>getComputedStyle(el).transitionDuration") == "0s"
    assert not errors, errors
    page.close()
    browser.close()
    print(json.dumps({"passed": ["decoded image and paint before ready", "transparent until native show",
        "monotonic fade", "reopen without old selection", "reject stale show/paint callbacks",
        "hidden WebView RAF timeout", "reduced motion"], "opacity": samples}))
