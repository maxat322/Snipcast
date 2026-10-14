"""Isolated Windows hooks/UIA/clipboard integration. Requires the inline-qa Tauri binary.
All foreground controls, profiles, data and processes are owned by this test.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import socket
import threading
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.qa-work'/'text-suggestions'/'native'
OUT.mkdir(parents=True,exist_ok=True)
parser=argparse.ArgumentParser()
parser.add_argument('--exe',type=Path,default=ROOT/'.qa-work/text-suggestions/app/snipcast.exe')
parser.add_argument("--quick",action="store_true",help="Only form, safety and browser regressions")
parser.add_argument("--browser-only",action="store_true",default=os.environ.get('SNIPCAST_INLINE_QA_BROWSER_ONLY')=='1')
args=parser.parse_args()
gate=Path(os.environ['SNIPCAST_INLINE_QA_GATE']) if os.environ.get('SNIPCAST_INLINE_QA_GATE') else None
if gate and not args.browser_only:raise ValueError('Prepared gate currently supports --browser-only')
u=c.WinDLL('user32',use_last_error=True)
k=c.WinDLL('kernel32',use_last_error=True)
LRESULT=c.c_ssize_t
WNDPROC=c.WINFUNCTYPE(LRESULT,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
class WNDCLASS(c.Structure):
    _fields_=[('style',w.UINT),('proc',WNDPROC),('clsExtra',c.c_int),('winExtra',c.c_int),('instance',w.HINSTANCE),('icon',w.HICON),('cursor',w.HANDLE),('background',w.HBRUSH),('menu',w.LPCWSTR),('name',w.LPCWSTR)]
class KEYBDINPUT(c.Structure):
    _fields_=[('vk',w.WORD),('scan',w.WORD),('flags',w.DWORD),('time',w.DWORD),('extra',c.c_size_t)]
class MOUSEINPUT(c.Structure):
    _fields_=[('dx',w.LONG),('dy',w.LONG),('data',w.DWORD),('flags',w.DWORD),('time',w.DWORD),('extra',c.c_size_t)]
class UNION(c.Union):
    _fields_=[('key',KEYBDINPUT),('mouse',MOUSEINPUT)]
class INPUT(c.Structure):
    _fields_=[('type',w.DWORD),('data',UNION)]
class GUIINFO(c.Structure):
    _fields_=[('size',w.DWORD),('flags',w.DWORD),('active',w.HWND),('focus',w.HWND),('capture',w.HWND),('menu',w.HWND),('move',w.HWND),('caret',w.HWND),('rect',w.RECT)]
u.DefWindowProcW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.DefWindowProcW.restype=LRESULT
u.CreateWindowExW.argtypes=[w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,c.c_int,c.c_int,c.c_int,c.c_int,w.HWND,w.HMENU,w.HINSTANCE,c.c_void_p];u.CreateWindowExW.restype=w.HWND
u.RegisterClassW.argtypes=[c.POINTER(WNDCLASS)];u.RegisterClassW.restype=w.WORD
u.SendMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.SendMessageW.restype=LRESULT
u.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.PostMessageW.restype=w.BOOL
u.SetForegroundWindow.argtypes=[w.HWND];u.SetForegroundWindow.restype=w.BOOL
u.AttachThreadInput.argtypes=[w.DWORD,w.DWORD,w.BOOL];u.AttachThreadInput.restype=w.BOOL
u.ShowWindow.argtypes=[w.HWND,c.c_int];u.ShowWindow.restype=w.BOOL
u.BringWindowToTop.argtypes=[w.HWND];u.BringWindowToTop.restype=w.BOOL
u.SetFocus.argtypes=[w.HWND];u.SetFocus.restype=w.HWND
u.GetForegroundWindow.restype=w.HWND
u.GetCursorPos.argtypes=[c.POINTER(w.POINT)];u.GetCursorPos.restype=w.BOOL
u.WindowFromPoint.argtypes=[w.POINT];u.WindowFromPoint.restype=w.HWND
u.GetAncestor.argtypes=[w.HWND,w.UINT];u.GetAncestor.restype=w.HWND
u.GetWindowTextW.argtypes=[w.HWND,w.LPWSTR,c.c_int];u.GetWindowTextW.restype=c.c_int
u.GetWindowRect.argtypes=[w.HWND,c.POINTER(w.RECT)];u.GetWindowRect.restype=w.BOOL
u.SetCursorPos.argtypes=[c.c_int,c.c_int];u.SetCursorPos.restype=w.BOOL
u.GetWindowThreadProcessId.argtypes=[w.HWND,c.POINTER(w.DWORD)];u.GetWindowThreadProcessId.restype=w.DWORD
u.GetGUIThreadInfo.argtypes=[w.DWORD,c.POINTER(GUIINFO)];u.GetGUIThreadInfo.restype=w.BOOL
u.LoadKeyboardLayoutW.argtypes=[w.LPCWSTR,w.UINT];u.LoadKeyboardLayoutW.restype=w.HANDLE
u.ActivateKeyboardLayout.argtypes=[w.HANDLE,w.UINT];u.ActivateKeyboardLayout.restype=w.HANDLE
u.GetKeyboardLayout.argtypes=[w.DWORD];u.GetKeyboardLayout.restype=w.HANDLE
u.VkKeyScanExW.argtypes=[w.WCHAR,w.HANDLE];u.VkKeyScanExW.restype=c.c_short
u.MapVirtualKeyExW.argtypes=[w.UINT,w.UINT,w.HANDLE];u.MapVirtualKeyExW.restype=w.UINT
u.SendInput.argtypes=[w.UINT,c.POINTER(INPUT),c.c_int];u.SendInput.restype=w.UINT
k.GetModuleHandleW.argtypes=[w.LPCWSTR];k.GetModuleHandleW.restype=w.HINSTANCE
k.GetCurrentThreadId.restype=w.DWORD
host={}
ready=threading.Event()
@WNDPROC
def proc(hwnd,msg,wp,lp):
    if msg==0x800a:
        host['lastFocus']=lp
        foreground_tid=u.GetWindowThreadProcessId(u.GetForegroundWindow(),None)
        own_tid=k.GetCurrentThreadId()
        attached=foreground_tid!=own_tid and bool(u.AttachThreadInput(own_tid,foreground_tid,True))
        try:
            u.ShowWindow(hwnd,5);u.BringWindowToTop(hwnd);u.SetForegroundWindow(hwnd);u.SetFocus(lp)
        finally:
            if attached:u.AttachThreadInput(own_tid,foreground_tid,False)
        return 0
    if msg==6 and (wp&0xffff)!=0 and host.get('lastFocus'):
        u.SetFocus(host['lastFocus']);return 0
    if msg==0x800b:
        u.ActivateKeyboardLayout(lp,0);return 0
    if msg==0x10:
        u.DestroyWindow(hwnd);u.PostQuitMessage(0);return 0
    return u.DefWindowProcW(hwnd,msg,wp,lp)
def host_thread():
    u.SetProcessDpiAwarenessContext(c.c_void_p(-4))
    instance=k.GetModuleHandleW(None)
    wc=WNDCLASS(0,proc,0,0,instance,None,None,c.c_void_p(6),None,'SnipcastInlineQA')
    assert u.RegisterClassW(c.byref(wc))
    hwnd=u.CreateWindowExW(0,wc.name,'Snipcast — isolated input QA',0xcf0000|(0 if gate else 0x10000000),500,420,720,330,None,None,instance,None)
    assert hwnd
    host['window']=hwnd
    host['field']=u.CreateWindowExW(0x200,'EDIT','',0x50010000|4|0x1000|0x40,18,20,660,100,hwnd,None,instance,None)
    host['second']=u.CreateWindowExW(0x200,'EDIT','',0x50010000|0x80,18,136,660,32,hwnd,None,instance,None)
    host['password']=u.CreateWindowExW(0x200,'EDIT','',0x50010000|0x80|0x20,18,188,660,32,hwnd,None,instance,None)
    ready.set()
    msg=w.MSG()
    while u.GetMessageW(c.byref(msg),None,0,0)>0:
        u.TranslateMessage(c.byref(msg));u.DispatchMessageW(c.byref(msg))
thread=threading.Thread(target=host_thread,daemon=True)
thread.start();assert ready.wait(5)
TAG=0x534e5141
layout=u.LoadKeyboardLayoutW('00000409',0)
u.PostMessageW(host['window'],0x50,0,layout)
time.sleep(.15)
def focus_field(name='field'):
    u.PostMessageW(host['window'],0x800a,0,host[name])
    u.PostMessageW(host['window'],0x800b,0,layout)
    for _ in range(50):
        info=GUIINFO();info.size=c.sizeof(info)
        tid=u.GetWindowThreadProcessId(host['window'],None)
        if u.GetForegroundWindow()==host['window'] and u.GetGUIThreadInfo(tid,c.byref(info)) and info.focus==host[name] and (u.GetKeyboardLayout(tid)&0xffff)==(layout&0xffff):return
        time.sleep(.04)
    raise AssertionError(f'Could not foreground QA field: foreground={u.GetForegroundWindow()}, host={host["window"]}, focus={info.focus}, expected={host[name]}')
def event(vk,up=False,tag=TAG):
    return INPUT(1,UNION(key=KEYBDINPUT(vk,u.MapVirtualKeyExW(vk,0,layout),2 if up else 0,0,tag)))
def inject(events):
    hwnd=u.GetForegroundWindow()
    if all(event.type==0 for event in events):
        point=w.POINT();u.GetCursorPos(c.byref(point))
        hwnd=u.GetAncestor(u.WindowFromPoint(point),2)
    pid=w.DWORD();u.GetWindowThreadProcessId(hwnd,c.byref(pid))
    if hwnd!=host['window'] and hwnd!=globals().get('chrome_hwnd'):
        raise RuntimeError('Typing target lost foreground; input stopped; pid='+str(pid.value))
    batch=(INPUT*len(events))(*events)
    assert u.SendInput(len(events),batch,c.sizeof(INPUT))==len(events)
def press(vk,modifiers=(),tag=TAG):
    events=[event(m,tag=tag) for m in modifiers]+[event(vk,tag=tag),event(vk,True,tag)]+[event(m,True,tag) for m in reversed(modifiers)]
    inject(events);time.sleep(.08)
def type_text(text):
    for ch in text:
        value=u.VkKeyScanExW(ch,layout)
        assert value!=-1,repr(ch)
        modifiers=[]
        for bit,vk in [(1,0xa0),(2,0xa2),(4,0xa4)]:
            if (value>>8)&bit:modifiers.append(vk)
        press(value&255,modifiers)
def text(name='field'):
    hwnd=host[name];size=u.SendMessageW(hwnd,0xe,0,0);buf=c.create_unicode_buffer(size+1)
    u.SendMessageW(hwnd,0xd,size+1,c.cast(buf,c.c_void_p).value)
    return buf.value
def clear(prefix='',name='field'):
    focus_field(name)
    inject([event(vk,True) for vk in (0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0x5b,0x5c)])
    u.PostMessageW(host['window'],0x1f,0,0);press(27);press(0x24)
    buf=c.create_unicode_buffer(prefix)
    u.SendMessageW(host[name],0xc,0,c.cast(buf,c.c_void_p).value)
    u.SendMessageW(host[name],0xb1,len(prefix),len(prefix));time.sleep(.12)
def wait_until(check,message,seconds=5):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=check()
        if value:return value
        time.sleep(.05)
    raise AssertionError(message)

data=OUT/'profile';data.mkdir(exist_ok=True)
settings=dict(enabled=True,mode='trigger',trigger='/',toggleHotkey='Control+Alt+Shift+F10',searchText=False,minChars=3,excludedApps=[])
config=dict(paletteHotkey='',screenshotHotkey='',autostart=False,screenshotPresets=[],screenshotPresetDefaultsVersion=1,theme='dark',textSuggestions=settings)
(data/'config.json').write_text(json.dumps(config),encoding='utf8')
templates=dict(version=1,groups=[dict(id='qa',title='QA',color='#5164f2',isMaster=False,items=[
    dict(type='template',id='hello',title='Hello',content='Hello QA!'),
    dict(type='template',id='hello2',title='Hello alternative',content='Other QA!'),
    dict(type='template',id='ru',title='Приветствие',content='Здравствуйте, {name}!'),
    dict(type='template',id='form',title='Form',content='Добрый день, [Имя]!'),
    dict(type='template',id='body',title='Another title',content='Content needle match'),
])])
(data/'templates.json').write_text(json.dumps(templates,ensure_ascii=False),encoding='utf8')
(data/'variables.json').write_text(json.dumps({'name':'Анна'},ensure_ascii=False),encoding='utf8')
with socket.socket() as endpoint:
    endpoint.bind(('127.0.0.1',0));port=endpoint.getsockname()[1]
env={**os.environ,'SNIPCAST_DATA_DIR':str(data.resolve()),'SNIPCAST_QA_INPUT':'1','WEBVIEW2_USER_DATA_FOLDER':str((data/'webview2').resolve()),'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':f'--remote-debugging-port={port}'}
results=[]
process=None
chrome_process=None
log=(OUT/'process.log').open('w',encoding='utf8')
try:
    process=subprocess.Popen([str(args.exe.resolve())],env=env,stdout=log,stderr=log)
    def available():
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=.4):return True
        except OSError:return False
    wait_until(available,'QA CDP did not start',20)
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        pages=browser.contexts[0].pages
        main=next(page for page in pages if 'snipcast=' not in page.url)
        main.wait_for_timeout(1000)
        def popup_page():
            main.wait_for_timeout(100)
            return next((page for page in browser.contexts[0].pages if 'text-suggestions' in page.url),None)
        try:popup=wait_until(popup_page,'Popup WebView did not start',15)
        except AssertionError:
            raise AssertionError('Popup startup: '+json.dumps({'urls':[page.url for page in browser.contexts[0].pages],'status':main.evaluate('window.__TAURI_INTERNALS__.invoke("snipcast_suggestions_status")')},ensure_ascii=False))
        main.wait_for_load_state('networkidle');popup.wait_for_load_state('networkidle')
        def invoke(command,args=None):return main.evaluate('([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args)',[command,args or {}])
        def view():return invoke('snipcast_suggestions_view')
        def hints(expected=None):
            cfg=invoke('snipcast_get_config')['textSuggestions']
            expected=expected or text().split()[-1]
            if expected.startswith(cfg['trigger']) and cfg['mode']=='trigger':expected=expected[len(cfg['trigger']):]
            try:value=wait_until(lambda:(v if (v:=view())['hits'] and v['query'].casefold()==expected.casefold() else None),'Hints did not reach the complete query')
            except AssertionError:
                raise AssertionError('Query synchronization: '+json.dumps({'expected':expected,'view':view(),'status':invoke('snipcast_suggestions_status')},ensure_ascii=False))
            popup.wait_for_function('(s)=>document.querySelector(".text-suggestions")?.dataset.session===String(s)',arg=value['session'])
            wait_until(lambda:view()['ready'],'Rendered popup did not acknowledge keyboard readiness')
            return value
        def set_cfg(**patch):
            cfg=invoke('snipcast_get_config');cfg['textSuggestions'].update(patch);invoke('snipcast_save_config',{'incoming':cfg});time.sleep(.3)
        if not args.quick and not args.browser_only:
            clear('Before ');type_text('/he');time.sleep(.3)
            assert not view()['hits'],'Quick palette appeared before three query characters'
            type_text('l');hints()
            find_proc=c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
            popup_handles=[]
            @find_proc
            def visit_popup(hwnd,_):
                owned_pid=w.DWORD();u.GetWindowThreadProcessId(hwnd,c.byref(owned_pid))
                if owned_pid.value==process.pid:
                    name=c.create_unicode_buffer(256);u.GetWindowTextW(hwnd,name,256)
                    if 'Быстрая палитра' in name.value:popup_handles.append(hwnd)
                return True
            u.EnumWindows(visit_popup,0);assert len(popup_handles)==1
            before_rect=w.RECT();assert u.GetWindowRect(popup_handles[0],c.byref(before_rect))
            type_text('lo');v=hints()
            after_rect=w.RECT();assert u.GetWindowRect(popup_handles[0],c.byref(after_rect))
            assert (before_rect.left,before_rect.top)==(after_rect.left,after_rect.top),'Quick palette followed typing'

            assert v['hits'][0]['title']=='Hello'
            assert u.GetForegroundWindow()==host['window'],'Popup stole foreground'
            popup.screenshot(path=str(OUT/'popup-native.png'))
            press(13);wait_until(lambda:text()=='Before Hello QA!','Wrong replacement: '+repr(text()))
            assert '\r' not in text() and '\n' not in text(),'Enter leaked'
            results.append(dict(app='Win32 EDIT',scenario='trigger /; title priority; preserve prefix; Enter suppression; focus',result='passed'))
            clear();type_text('/hello');hints();press(0x28);v=hints();assert v['selected']==1
            press(13);wait_until(lambda:text()=='Other QA!','Arrows chose wrong template')
            clear();type_text('/hellx');press(8);hints();press(27);wait_until(lambda:not view()['hits'],'Esc did not close hints');assert text()=='/hell'
            results.append(dict(app='Win32 EDIT',scenario='arrows; Backspace; Esc preserves text',result='passed'))
            set_cfg(trigger='/+/');clear();type_text('/+/hello');hints();press(13);wait_until(lambda:text()=='Hello QA!','Multicharacter trigger left text behind')
            set_cfg(trigger='@');clear();type_text('@hello');hints();press(13);wait_until(lambda:text()=='Hello QA!','@ trigger failed')
            set_cfg(trigger='/')
            set_cfg(searchText=True);clear();type_text('/needle');v=hints();assert v['hits'][0]['title']=='Another title';press(13);wait_until(lambda:text()=='Content needle match','Body search failed')
            results.append(dict(app='Win32 EDIT',scenario='multicharacter trigger; @; content search',result='passed'))
            set_cfg(searchText=False,mode='automatic');clear();type_text('hello');hints();press(13);wait_until(lambda:text()=='Hello QA!','Automatic mode failed')
            layout=u.LoadKeyboardLayoutW('00000419',0);u.PostMessageW(host['window'],0x50,0,layout);time.sleep(.2)
            clear();type_text('прив');hints();press(13);wait_until(lambda:text()=='Здравствуйте, Анна!','RU translation or variable failed')
            results.append(dict(app='Win32 EDIT',scenario='automatic mode; RU; variables',result='passed'))
            layout=u.LoadKeyboardLayoutW('00000409',0);u.PostMessageW(host['window'],0x50,0,layout);time.sleep(.2)
        if not args.browser_only:
            set_cfg(mode='trigger');clear();type_text('/form');hints();press(13)
            field=popup.locator('[data-bracket-label="Имя"]');field.wait_for(state='visible',timeout=5000)
            assert text()=='/form','Word was deleted before form confirmation'
            # Fill the quick palette; the ordinary palette must never open its form.
            assert main.locator('[data-bracket-label]').count()==0
            main.wait_for_timeout(400)
            field.fill('Олег')
            pid=w.DWORD();u.GetWindowThreadProcessId(u.GetForegroundWindow(),c.byref(pid))
            assert pid.value==process.pid,'Snipcast form must own native foreground'
            down=(INPUT*1)(event(13));assert u.SendInput(1,down,c.sizeof(INPUT))==1
            time.sleep(.3)
            held=(INPUT*2)(event(13),event(13,True));assert u.SendInput(2,held,c.sizeof(INPUT))==2
            try:
                wait_until(lambda:text()=='Добрый день, Олег!','Complex form did not replace fragment')
            except AssertionError:
                popup.screenshot(path=str(OUT/'form-failure.png'))
                raise AssertionError('Complex form: '+json.dumps({'status':invoke('snipcast_suggestions_status'),'pending':invoke('snipcast_suggestions_pending'),'alert':popup.locator('[role=alert]').all_text_contents(),'form':field.count(),'length':len(text()),'foreground':u.GetForegroundWindow()},ensure_ascii=False))
            clear();type_text('/form');hints();press(13);field.wait_for(state='visible');field.press('Escape');time.sleep(.3)
            assert text()=='/form','Cancelling form changed the target'
            results.append(dict(app='Win32 EDIT',scenario='complex form; confirmed replacement; cancellation',result='passed'))
            clear();type_text('/hello');hints();focus_field('second');press(13);time.sleep(.3)
            assert text()=='/hello' and text('second')=='','Focus change caused a stale replacement'
            clear(name='password');type_text('/hello');time.sleep(.3);assert not view()['hits'],'Password hints were shown'
            clear();type_text('/hello');hints();press(0x25);press(13);time.sleep(.3);assert 'Hello QA!' not in text(),'Caret movement caused a stale replacement'
            clear();type_text('/hello');hints();press(0x41,tag=0);time.sleep(.3);assert not view()['hits'],'Third-party injection did not invalidate hints'
            results.append(dict(app='Win32 EDIT',scenario='focus; password; caret navigation; external injection invalidation',result='passed'))
            set_cfg(excludedApps=['PYTHON.EXE']);clear();type_text('/hello');time.sleep(.3);assert not view()['hits']
            set_cfg(excludedApps=[]);clear();press(0x79,[0xa2,0xa4,0xa0]);time.sleep(.3);assert not invoke('snipcast_get_config')['textSuggestions']['enabled']
            type_text('/hello');time.sleep(.3);assert not view()['hits']
            press(0x79,[0xa2,0xa4,0xa0]);time.sleep(.3);assert invoke('snipcast_get_config')['textSuggestions']['enabled']
            results.append(dict(app='Win32 EDIT',scenario='case-insensitive exclusions; global toggle',result='passed'))

        chrome_exe=Path(os.environ['PROGRAMFILES'])/'Google/Chrome/Application/chrome.exe'
        chrome_profile=OUT/'chrome-profile'
        with socket.socket() as endpoint:
            endpoint.bind(('127.0.0.1',0));chrome_port=endpoint.getsockname()[1]
        chrome_process=subprocess.Popen([str(chrome_exe),f'--remote-debugging-port={chrome_port}',f'--user-data-dir={chrome_profile.resolve()}',
            '--force-renderer-accessibility','--disable-extensions','--no-first-run','--no-default-browser-check','--window-position=500,420','--window-size=720,400',*(['--no-startup-window'] if gate else ['about:blank'])],stdout=log,stderr=log)
        def chrome_available():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{chrome_port}/json/list',timeout=.4):return True
            except OSError:return False
        wait_until(chrome_available,'Owned Chrome CDP did not start',20)
        chrome=p.chromium.connect_over_cdp(f'http://127.0.0.1:{chrome_port}')
        if gate:
            print('READY: isolated Snipcast and Chrome are prepared; waiting for input window',flush=True)
            wait_until(gate.exists,'Prepared test was not released',600)
        web=chrome.contexts[0].pages[0] if chrome.contexts[0].pages else chrome.contexts[0].new_page()
        web.set_content('<title>Snipcast inline browser QA</title><style>input,textarea,[contenteditable]{display:block;width:550px;min-height:42px;margin:24px;font:20px sans-serif;border:1px solid gray;}</style><input id="one"><textarea id="two"></textarea><div id="three" contenteditable="true"></div>')
        enum_proc=c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
        def find_chrome():
            found=[]
            @enum_proc
            def visit(hwnd,_):
                name=c.create_unicode_buffer(256);u.GetWindowTextW(hwnd,name,256)
                if 'Snipcast inline browser QA' in name.value:found.append(hwnd)
                return True
            u.EnumWindows(visit,0)
            return found[0] if found else None
        chrome_hwnd=wait_until(find_chrome,'Owned Chrome window not found')
        foreground_thread=u.GetWindowThreadProcessId(u.GetForegroundWindow(),None)
        our_thread=k.GetCurrentThreadId()
        msg=w.MSG();u.PeekMessageW(c.byref(msg),None,0,0,0)
        attached=bool(u.AttachThreadInput(our_thread,foreground_thread,True))
        target_thread=u.GetWindowThreadProcessId(chrome_hwnd,None)
        target_attached=target_thread not in (our_thread,foreground_thread) and bool(u.AttachThreadInput(our_thread,target_thread,True))
        u.ShowWindow(chrome_hwnd,5);u.BringWindowToTop(chrome_hwnd)
        u.SetForegroundWindow(chrome_hwnd)
        if target_attached:u.AttachThreadInput(our_thread,target_thread,False)
        if attached:u.AttachThreadInput(our_thread,foreground_thread,False)
        u.PostMessageW(chrome_hwnd,0x1f,0,0)
        for selector in ('#one','#two','#three'):
            field=web.locator(selector)
            box=field.bounding_box();metrics=web.evaluate('({dpr:devicePixelRatio,width:innerWidth,height:innerHeight})')
            rect=w.RECT();assert u.GetWindowRect(chrome_hwnd,c.byref(rect))
            side=max(0,((rect.right-rect.left)-metrics['width']*metrics['dpr'])/2)
            top=(rect.bottom-rect.top)-metrics['height']*metrics['dpr']-side
            x=round(rect.left+side+(box['x']+min(50,box['width']/2))*metrics['dpr'])
            y=round(rect.top+top+(box['y']+min(16,box['height']/2))*metrics['dpr'])
            u.SetCursorPos(x,y)
            inject([INPUT(0,UNION(mouse=MOUSEINPUT(0,0,0,2,0,TAG))),INPUT(0,UNION(mouse=MOUSEINPUT(0,0,0,4,0,TAG)))])
            time.sleep(.2)
            assert field.evaluate('(el)=>document.activeElement===el'),'Real mouse click must focus '+selector
            assert u.GetForegroundWindow()==chrome_hwnd,'Browser must own foreground for native typing'
            layout=u.GetKeyboardLayout(u.GetWindowThreadProcessId(chrome_hwnd,None))
            ru=(layout&0xffff)==0x419
            query='/прив' if ru else '/hello';expected='Здравствуйте, Анна!' if ru else 'Hello QA!'
            type_text(query);hints(query);press(13)
            wait_until(lambda:field.evaluate('(el)=>el.value??el.textContent')==expected,'Browser replacement failed for '+selector+'; actual='+repr(field.evaluate('(el)=>el.value??el.textContent'))+'; status='+json.dumps(invoke('snipcast_suggestions_status'),ensure_ascii=False))
            assert field.evaluate('(el)=>el.value??el.textContent')==expected
            results.append(dict(app='Chrome '+selector,scenario='real hook/UIA; replacement; no Enter/newline leakage',result='passed'))
        chrome.close()
        browser.close()
    (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
    print('PASS:',len(results),'native scenarios; isolated Tauri/WebView2; '+', '.join(sorted({item['app'] for item in results})))
finally:
    (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
    for owned in (chrome_process,process):
        if owned is not None and owned.poll() is None:
            try:owned.terminate();owned.wait(timeout=5)
            except subprocess.TimeoutExpired:owned.kill()
    log.close();u.PostMessageW(host['window'],0x10,0,0);thread.join(timeout=3)
