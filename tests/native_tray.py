"""Exercise the real tray popup belonging only to the isolated QA process."""
import ctypes, json, time
from ctypes import wintypes
from PIL import ImageGrab

def close_pins_from_tray(proc,main,labels,out):
    user=ctypes.windll.user32;matches=[]
    user.PostMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
    @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def collect(hwnd,_):
        pid=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
        name=ctypes.create_unicode_buffer(256);user.GetClassNameW(hwnd,name,256)
        if pid.value==proc.pid and name.value=='tray_icon_app':matches.append(hwnd)
        return True
    user.EnumWindows(collect,0);assert len(matches)==1,matches
    user.SetCursorPos(800,700)
    # Same right-button notification Explorer sends to tray-icon 0.21.3.
    user.PostMessageW(matches[0],6002,0,0x204)
    time.sleep(.2);menus=[];classes=[]
    @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def popup(hwnd,_):
        pid=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
        if pid.value==proc.pid:
            name=ctypes.create_unicode_buffer(256);user.GetClassNameW(hwnd,name,256);classes.append(name.value)
            if name.value=='#32768':menus.append(hwnd)
        return True
    user.EnumWindows(popup,0);assert len(menus)==1,('native tray popup missing',classes)
    # MN_GETHMENU and GetMenuItemRect read the real system popup, independent
    # of optional UI Automation providers installed on this Windows image.
    user.SendMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
    user.SendMessageW.restype=wintypes.LPARAM
    user.GetMenuItemCount.argtypes=[wintypes.HMENU]
    user.GetMenuStringW.argtypes=[wintypes.HMENU,wintypes.UINT,wintypes.LPWSTR,ctypes.c_int,wintypes.UINT]
    user.GetMenuItemRect.argtypes=[wintypes.HWND,wintypes.HMENU,wintypes.UINT,ctypes.POINTER(wintypes.RECT)]
    menu=user.SendMessageW(menus[0],0x1E1,0,0);assert menu
    rows=[]
    for i in range(user.GetMenuItemCount(menu)):
        name=ctypes.create_unicode_buffer(256);user.GetMenuStringW(menu,i,name,256,0x400)
        rect=wintypes.RECT();assert user.GetMenuItemRect(None,menu,i,ctypes.byref(rect))
        rows.append({'name':name.value,'x':rect.left,'y':rect.top,'w':rect.right-rect.left,'h':rect.bottom-rect.top})
    item=next(r for r in rows if r['name']=='Закрыть все закрепы')
    out.joinpath('tray-menu.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
    ImageGrab.grab().save(out/'tray-menu-desktop.png')
    user.SetCursorPos(round(item['x']+item['w']/2),round(item['y']+item['h']/2))
    user.mouse_event(2,0,0,0,0);user.mouse_event(4,0,0,0,0)
    for _ in range(50):
        windows=main.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows')")
        if not any(label in windows for label in labels):break
        time.sleep(.05)
    assert not any(label in windows for label in labels),windows
    print('PASS: real isolated tray menu closes both pinned windows')
