"""Native keyboard input after changing the focused WebView2 input language."""
import ctypes,json,os,subprocess,time,urllib.request
from ctypes import wintypes as w
from pathlib import Path
import psutil
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work/text-language-native';OUT.mkdir(parents=True,exist_ok=True)
(OUT/'config.json').write_text(json.dumps(dict(paletteHotkey='',screenshotHotkey='',screenshotCopyHotkey='Q',autostart=False,theme='dark',apiEnabled=False,screenshotPresets=[],screenshotPresetDefaultsVersion=1)),encoding='utf8')
(OUT/'update-state.json').write_text(json.dumps(dict(lastAttempt=time.strftime('%Y-%m-%d'))),encoding='utf8')
u=ctypes.windll.user32
u.GetForegroundWindow.restype=w.HWND
u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)]
u.GetKeyboardLayout.argtypes=[w.DWORD];u.GetKeyboardLayout.restype=w.HANDLE
u.GetKeyboardLayoutList.argtypes=[ctypes.c_int,ctypes.POINTER(w.HANDLE)]
u.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM]
u.SetForegroundWindow.argtypes=[w.HWND]
class GUI(ctypes.Structure):
    _fields_=[('cbSize',w.DWORD),('flags',w.DWORD),('hwndActive',w.HWND),('hwndFocus',w.HWND),('hwndCapture',w.HWND),('hwndMenuOwner',w.HWND),('hwndMoveSize',w.HWND),('hwndCaret',w.HWND),('rcCaret',w.RECT)]
u.GetGUIThreadInfo.argtypes=[w.DWORD,ctypes.POINTER(GUI)]
class Keyboard(ctypes.Structure):
    _fields_=[('vk',w.WORD),('scan',w.WORD),('flags',w.DWORD),('time',w.DWORD),('extra',ctypes.c_size_t)]
class Mouse(ctypes.Structure):
    _fields_=[('x',w.LONG),('y',w.LONG),('data',w.DWORD),('flags',w.DWORD),('time',w.DWORD),('extra',ctypes.c_size_t)]
class Payload(ctypes.Union):_fields_=[('keyboard',Keyboard),('mouse',Mouse)]
class Input(ctypes.Structure):_fields_=[('kind',w.DWORD),('payload',Payload)]

def invoke(page,command,args=None):return page.evaluate('([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a)',[command,args or {}])
def page_with(ctx,selector):
    for _ in range(150):
        for page in ctx.pages:
            try:
                if page.locator(selector).count():return page
            except Exception:pass
        time.sleep(.05)
    raise AssertionError(selector)
def input_focus():
    top=u.GetForegroundWindow();owner=w.DWORD();thread=u.GetWindowThreadProcessId(top,ctypes.byref(owner))
    assert owner.value==proc.pid,('Foreground moved outside QA application',owner.value)
    gui=GUI(cbSize=ctypes.sizeof(GUI));assert u.GetGUIThreadInfo(thread,ctypes.byref(gui)) and gui.hwndFocus
    focus_thread=u.GetWindowThreadProcessId(gui.hwndFocus,None)
    return top,gui.hwndFocus,thread,focus_thread
def keys(*values):
    input_focus()
    sequence=[(v,0) for v in values]+[(v,2) for v in reversed(values)]
    events=(Input*len(sequence))(*(Input(kind=1,payload=Payload(keyboard=Keyboard(vk=vk,scan=u.MapVirtualKeyW(vk,0),flags=flags))) for vk,flags in sequence))
    assert u.SendInput(len(events),events,ctypes.sizeof(Input))==len(events)
    time.sleep(.12)

original_foreground=u.GetForegroundWindow();initial_layout=None;proc=None;result={}
log=(OUT/'process.log').open('w',encoding='utf8')
try:
    proc=subprocess.Popen([os.environ['SNIPCAST_QA_EXE']],env={**os.environ,'SNIPCAST_DATA_DIR':str(OUT),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':'--remote-debugging-port=9293'},stdout=log,stderr=log)
    with sync_playwright() as p:
        for _ in range(150):
            try:urllib.request.urlopen('http://127.0.0.1:9293/json/list',timeout=.25).close();break
            except Exception:assert proc.poll() is None;time.sleep(.1)
        browser=p.chromium.connect_over_cdp('http://127.0.0.1:9293');ctx=browser.contexts[0]
        main=page_with(ctx,'body.settings-body');invoke(main,'snipcast_start_screenshot');cap=page_with(ctx,'.capture--presented')
        info=invoke(cap,'snipcast_capture_info');invoke(cap,'plugin:window|set_focus',dict(label=info['label']))
        cap.wait_for_function("document.querySelector('.capture__shot')?.complete&&document.querySelector('.capture__shot')?.naturalWidth>0")
        cap.locator('.capture').dispatch_event('pointerdown',dict(clientX=100,clientY=100,button=0,buttons=1,pointerId=1,bubbles=True))
        cap.evaluate("window.dispatchEvent(new PointerEvent('pointerup',{clientX:1100,clientY:650,button:0,pointerId:1,bubbles:true}))")
        expect(cap.locator('.capture__toolbar')).to_be_visible()
        cap.locator('[data-tool-anchor=text]').evaluate('el=>el.click()')
        cap.wait_for_function("document.querySelector('[data-tool-anchor=text]')?.classList.contains('is-active')")
        cap.mouse.click(450,300)
        text=cap.get_by_role('textbox',name='Текст на скриншоте');expect(text).to_be_focused();cap.wait_for_timeout(150)
        invoke(cap,'snipcast_capture_keyboard_state',dict(textInput=True,suspended=False))
        top,focus,parent_thread,focus_thread=input_focus();initial_layout=u.GetKeyboardLayout(focus_thread)
        layouts=(w.HANDLE*32)();count=u.GetKeyboardLayoutList(32,layouts);available={h&0xffff:h for h in layouts[:count]}
        assert 0x409 in available and 0x419 in available,'English and Russian layouts must already be installed'
        observations=[]
        for lang,expected in [(0x409,'q'),(0x419,'й'),(0x409,'q')]:
            top,focus,parent_thread,focus_thread=input_focus()
            assert u.PostMessageW(focus,0x50,0,available[lang]) # WM_INPUTLANGCHANGEREQUEST, handled by Windows.
            for _ in range(100):
                if u.GetKeyboardLayout(focus_thread)&0xffff==lang:break
                time.sleep(.02)
            assert u.GetKeyboardLayout(focus_thread)&0xffff==lang
            before=text.input_value();keys(0x51)
            for _ in range(100):
                if len(text.input_value())>len(before):break
                time.sleep(.02)
            after=text.input_value()
            observations.append(dict(requestedLanguage=hex(lang),parentThread=parent_thread,focusThread=focus_thread,parentLayout=hex(u.GetKeyboardLayout(parent_thread)),focusLayout=hex(u.GetKeyboardLayout(focus_thread)),expected=before+expected,actual=after))
            expect(text).to_be_focused()
        # Language selectors can temporarily take focus away from WebView2.
        # An ordinary native window deactivation must preserve the live text.
        before=text.input_value()
        capture_hwnd=input_focus()[0]
        main_label=main.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label')
        invoke(main,'plugin:window|show',dict(label=main_label));invoke(main,'plugin:window|set_focus',dict(label=main_label))
        for _ in range(100):
            if u.GetForegroundWindow()!=capture_hwnd:break
            time.sleep(.02)
        assert u.GetForegroundWindow()!=capture_hwnd,'Native focus did not leave the capture'
        expect(text).to_have_value(before)
        invoke(cap,'plugin:window|set_focus',dict(label=info['label']));expect(text).to_be_focused()
        keys(0x51);expect(text).to_have_value(before+'q')
        result=dict(observations=observations,languageChangesAffectText=all(o['actual']==o['expected'] for o in observations),textSessionKeptOpen=True,nativeFocusChangeKeepsTextAndCaret=True)
        browser.close()
finally:
    if initial_layout and proc and proc.poll() is None:
        try:
            _,focus,_,_=input_focus();u.PostMessageW(focus,0x50,0,initial_layout);time.sleep(.1)
        except Exception:pass
    if proc and proc.poll() is None:
        children=psutil.Process(proc.pid).children(recursive=True);proc.terminate();proc.wait(timeout=10)
        for child in children:
            try:child.terminate()
            except psutil.NoSuchProcess:pass
        psutil.wait_procs(children,timeout=5)
    if original_foreground:u.SetForegroundWindow(original_foreground)
    log.close()
(OUT/'results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8');print(json.dumps(result,indent=2))
if os.environ.get('SNIPCAST_LAYOUT_OBSERVE')!='1':assert result['languageChangesAffectText'],result
