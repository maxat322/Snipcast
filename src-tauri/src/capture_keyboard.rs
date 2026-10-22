//! Route capture commands to its focused WebView before global hotkeys see them.
//! The hook performs only atomic reads and Win32 calls; no IPC, logging or locks.
use crate::data::AppConfig;
use std::str::FromStr;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

fn key(code: Code) -> Option<usize> {
    let name = format!("{code:?}");
    let (vk, extended) = match name.as_str() {
        "Enter" => (0x0d, false),
        "NumpadEnter" => (0x0d, true),
        "Space" => (0x20, false),
        "Escape" => (0x1b, false),
        "Tab" => (9, false),
        "Backspace" => (8, false),
        "Delete" => (0x2e, true),
        "Insert" => (0x2d, true),
        "ArrowLeft" => (0x25, true),
        "ArrowUp" => (0x26, true),
        "ArrowRight" => (0x27, true),
        "ArrowDown" => (0x28, true),
        "Home" => (0x24, true),
        "End" => (0x23, true),
        "PageUp" => (0x21, true),
        "PageDown" => (0x22, true),
        "Minus" => (0xbd, false),
        "Equal" => (0xbb, false),
        "Backquote" => (0xc0, false),
        "BracketLeft" => (0xdb, false),
        "BracketRight" => (0xdd, false),
        "Backslash" => (0xdc, false),
        "Semicolon" => (0xba, false),
        "Quote" => (0xde, false),
        "Comma" => (0xbc, false),
        "Period" => (0xbe, false),
        "Slash" => (0xbf, false),
        "PrintScreen" => (0x2c, true),
        "NumpadAdd" => (0x6b, false),
        "NumpadSubtract" => (0x6d, false),
        "NumpadMultiply" => (0x6a, false),
        "NumpadDivide" => (0x6f, true),
        "NumpadDecimal" => (0x6e, false),
        _ if name.starts_with("Key") && name.len() == 4 => (name.as_bytes()[3] as usize, false),
        _ if name.starts_with("Digit") && name.len() == 6 => (name.as_bytes()[5] as usize, false),
        _ if name.starts_with("Numpad") && name.len() == 7 => {
            (0x60 + name[6..].parse::<usize>().ok()?, false)
        }
        _ if name.starts_with('F') => {
            let n = name[1..].parse::<usize>().ok()?;
            if !(1..=24).contains(&n) {
                return None;
            }
            (0x70 + n - 1, false)
        }
        _ => return None,
    };
    Some(vk + if extended { 256 } else { 0 })
}
fn mask(mods: Modifiers) -> u32 {
    u32::from(mods.contains(Modifiers::CONTROL))
        | u32::from(mods.contains(Modifiers::SHIFT)) * 2
        | u32::from(mods.contains(Modifiers::ALT)) * 4
        | u32::from(mods.contains(Modifiers::SUPER)) * 8
}
fn rules(cfg: &AppConfig) -> [u32; 512] {
    let mut result = [0; 512];
    let mut add = |value: &str, with_alt: bool| {
        if let Ok(shortcut) = Shortcut::from_str(value) {
            if let Some(key) = key(shortcut.key) {
                let mods = mask(shortcut.mods);
                result[key] |= 1 << mods;
                if with_alt {
                    result[key] |= 1 << (mods | 4);
                }
            }
        }
    };
    for value in [
        &cfg.screenshot_save_hotkey,
        &cfg.screenshot_pin_hotkey,
        &cfg.screenshot_copy_hotkey,
    ] {
        add(value, true);
    }
    for value in [
        "Escape",
        "Tab",
        "A",
        "V",
        "Minus",
        "Equal",
        "NumpadAdd",
        "NumpadSubtract",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Delete",
        "Backspace",
    ] {
        add(value, false);
        add(&format!("Shift+{value}"), false);
    }
    for digit in 1..=8 {
        for prefix in ["", "Numpad"] {
            add(&format!("{prefix}{digit}"), false);
            add(&format!("Shift+{prefix}{digit}"), false);
        }
    }
    for value in [
        "CommandOrControl+Z",
        "CommandOrControl+Shift+Z",
        "CommandOrControl+Y",
    ] {
        add(value, true);
    }
    result
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering::Relaxed},
        OnceLock,
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, GetKeyboardLayout, GetKeyboardState, ToUnicodeEx,
            },
            Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    };
    const ROUTE: u32 = WM_APP + 0x368;
    const SUBCLASS: usize = 0x534e4b42;
    // Each monitor has an overlay. Read-only atomic slots keep the hook free
    // of locks while preserving the input mode of the focused overlay.
    static WINDOWS: [AtomicUsize; 64] = [const { AtomicUsize::new(0) }; 64];
    static EPOCHS: [AtomicU32; 64] = [const { AtomicU32::new(0) }; 64];
    static HOOK: AtomicUsize = AtomicUsize::new(0);
    static WORKER: OnceLock<Result<u32, String>> = OnceLock::new();
    static GENERATION: AtomicU32 = AtomicU32::new(0);
    static MODIFIER_KEYS: AtomicU32 = AtomicU32::new(0);
    static SUSPENDED: [AtomicBool; 64] = [const { AtomicBool::new(true) }; 64];
    static TEXT: [AtomicBool; 64] = [const { AtomicBool::new(false) }; 64];
    static RULES: [AtomicU32; 512] = [const { AtomicU32::new(0) }; 512];
    static PRESSED: [AtomicUsize; 512] = [const { AtomicUsize::new(0) }; 512];
    unsafe fn next(code: i32, message: usize, pointer: isize) -> isize {
        CallNextHookEx(std::ptr::null_mut(), code, message, pointer)
    }
    struct Context {
        window: tauri::WebviewWindow,
        generation: u32,
    }
    fn slot(hwnd: HWND) -> Option<usize> {
        if hwnd.is_null() {
            None
        } else {
            WINDOWS
                .iter()
                .position(|w| w.load(Relaxed) == hwnd as usize)
        }
    }
    unsafe fn install() -> Result<(), String> {
        if HOOK.load(Relaxed) != 0 {
            return Ok(());
        }
        let mut held = 0;
        for (bit, vk) in [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c]
            .into_iter()
            .enumerate()
        {
            if GetAsyncKeyState(vk) < 0 {
                held |= 1 << bit;
            }
        }
        MODIFIER_KEYS.store(held, Relaxed);
        // LL hooks execute on this thread; no DLL module is injected into the
        // process owning a competing registered hotkey.
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
        if hook.is_null() {
            return Err(format!("перехват клавиш: {}", GetLastError()));
        }
        HOOK.store(hook as usize, Relaxed);
        Ok(())
    }
    fn worker() -> Result<u32, String> {
        WORKER
            .get_or_init(|| {
                let (send, receive) = std::sync::mpsc::sync_channel(1);
                std::thread::spawn(move || unsafe {
                    let mut message: MSG = std::mem::zeroed();
                    PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                    let ready = install().map(|_| GetCurrentThreadId());
                    let running = ready.is_ok();
                    let _ = send.send(ready);
                    if !running {
                        return;
                    }
                    let mut quit = false;
                    while !quit {
                        while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0
                        {
                            if message.message == WM_QUIT {
                                quit = true;
                                break;
                            }
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                        if !quit {
                            MsgWaitForMultipleObjectsEx(
                                0,
                                std::ptr::null(),
                                50,
                                QS_ALLINPUT,
                                MWMO_INPUTAVAILABLE,
                            );
                        }
                    }
                    let hook = HOOK.swap(0, Relaxed);
                    if hook != 0 {
                        UnhookWindowsHookEx(hook as HHOOK);
                    }
                });
                receive
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .map_err(|e| e.to_string())?
            })
            .clone()
    }
    fn modifiers() -> u32 {
        let held = MODIFIER_KEYS.load(Relaxed);
        u32::from(held & 0x0c != 0)
            | u32::from(held & 3 != 0) * 2
            | u32::from(held & 0x30 != 0) * 4
            | u32::from(held & 0xc0 != 0) * 8
    }
    unsafe extern "system" fn keyboard(code: i32, message: usize, pointer: isize) -> isize {
        if code < 0 {
            return next(code, message, pointer);
        }
        let event = &*(pointer as *const KBDLLHOOKSTRUCT);
        let extended = event.flags & LLKHF_EXTENDED != 0;
        let index = event.vkCode as usize + if extended { 256 } else { 0 };
        if index >= 512 {
            return next(code, message, pointer);
        }
        let up = event.flags & LLKHF_UP != 0;
        // The asynchronous state is updated AFTER the low-level callback.
        // Track both sides independently so modifiers reach the browser even
        // when an unrelated global shortcut owns the corresponding chord.
        let modifier = match event.vkCode {
            0x10 | 0xa0 => Some(0),
            0xa1 => Some(1),
            0x11 | 0xa2 => Some(2),
            0xa3 => Some(3),
            0x12 | 0xa4 => Some(4),
            0xa5 => Some(5),
            0x5b => Some(6),
            0x5c => Some(7),
            _ => None,
        };
        if let Some(bit) = modifier {
            if up {
                MODIFIER_KEYS.fetch_and(!(1 << bit), Relaxed);
            } else {
                MODIFIER_KEYS.fetch_or(1 << bit, Relaxed);
            }
        }
        let old = if up {
            PRESSED[index].swap(0, Relaxed)
        } else {
            PRESSED[index].load(Relaxed)
        };
        let hwnd = GetForegroundWindow();
        let current = slot(hwnd);
        let active =
            current.is_some_and(|s| !SUSPENDED[s].load(Relaxed)) && IsWindowVisible(hwnd) != 0;
        let text_input = current.is_some_and(|s| TEXT[s].load(Relaxed));
        let mods = modifiers()
            | if event.flags & LLKHF_ALTDOWN != 0 {
                4
            } else {
                0
            };
        let packed = event.vkCode
            | ((event.scanCode & 0xff) << 8)
            | u32::from(extended) << 16
            | mods << 17
            | u32::from(up) << 21
            | u32::from(old != 0) << 22;
        if up && old != 0 {
            if let Some(s) = slot(old as HWND) {
                PostMessageW(
                    old as HWND,
                    ROUTE,
                    packed as usize,
                    EPOCHS[s].load(Relaxed) as isize,
                );
            }
            return 1;
        }
        if old != 0 && !active {
            return 1;
        }
        if !active || matches!(event.vkCode, 0x10 | 0x11 | 0x12 | 0xa0..=0xa5 | 0x5b | 0x5c) {
            return next(code, message, pointer);
        }
        let editing = text_input
            && mods & 8 == 0
            && matches!(event.vkCode,0x30..=0x5a|0x60..=0x6f|0xba..=0xe2|8|9|13|0x20..=0x2e);
        if old == 0 && RULES[index].load(Relaxed) & (1 << mods) == 0 && !editing {
            return next(code, message, pointer);
        }
        if up {
            return next(code, message, pointer);
        }
        if PostMessageW(
            hwnd,
            ROUTE,
            packed as usize,
            EPOCHS[current.unwrap()].load(Relaxed) as isize,
        ) != 0
        {
            PRESSED[index].store(hwnd as usize, Relaxed);
            return 1;
        }
        next(code, message, pointer)
    }
    fn names(vk: u32, extended: bool) -> (String, String, u32) {
        let code = match vk {
            0x41..=0x5a => format!("Key{}", char::from_u32(vk).unwrap()),
            0x30..=0x39 => format!("Digit{}", char::from_u32(vk).unwrap()),
            0x60..=0x69 => format!("Numpad{}", vk - 0x60),
            0x70..=0x87 => format!("F{}", vk - 0x70 + 1),
            13 if extended => "NumpadEnter".into(),
            13 => "Enter".into(),
            8 => "Backspace".into(),
            9 => "Tab".into(),
            0x1b => "Escape".into(),
            0x20 => "Space".into(),
            0x21 => "PageUp".into(),
            0x22 => "PageDown".into(),
            0x23 => "End".into(),
            0x24 => "Home".into(),
            0x25 => "ArrowLeft".into(),
            0x26 => "ArrowUp".into(),
            0x27 => "ArrowRight".into(),
            0x28 => "ArrowDown".into(),
            0x2d => "Insert".into(),
            0x2e => "Delete".into(),
            0x2c => "PrintScreen".into(),
            0xba => "Semicolon".into(),
            0xbb => "Equal".into(),
            0xbc => "Comma".into(),
            0xbd => "Minus".into(),
            0xbe => "Period".into(),
            0xbf => "Slash".into(),
            0xc0 => "Backquote".into(),
            0xdb => "BracketLeft".into(),
            0xdc => "Backslash".into(),
            0xdd => "BracketRight".into(),
            0xde => "Quote".into(),
            0x6a => "NumpadMultiply".into(),
            0x6b => "NumpadAdd".into(),
            0x6d => "NumpadSubtract".into(),
            0x6e => "NumpadDecimal".into(),
            0x6f => "NumpadDivide".into(),
            _ => "Unidentified".into(),
        };
        let key = if code == "Space" {
            " ".into()
        } else if code == "NumpadEnter" {
            "Enter".into()
        } else {
            code.clone()
        };
        let location = if code.starts_with("Numpad") { 3 } else { 0 };
        (code, key, location)
    }
    unsafe fn input_thread(hwnd: HWND) -> u32 {
        let owner = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        if !slot(hwnd).is_some_and(|s| TEXT[s].load(Relaxed)) {
            return owner;
        }
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        // WebView2's focused child can have a different input language from
        // the Tauri window thread after a normal Windows language switch.
        if GetGUIThreadInfo(owner, &mut info) != 0
            && !info.hwndFocus.is_null()
            && GetAncestor(info.hwndFocus, GA_ROOT) == hwnd
        {
            GetWindowThreadProcessId(info.hwndFocus, std::ptr::null_mut())
        } else {
            owner
        }
    }
    unsafe extern "system" fn route(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> isize {
        let context = &*(data as *const Context);
        if message == ROUTE {
            let word = wparam as u32;
            let up = word & (1 << 21) != 0;
            if lparam as u32 != context.generation
                || (!up
                    && (!slot(hwnd).is_some_and(|s| !SUSPENDED[s].load(Relaxed))
                        || GetForegroundWindow() != hwnd))
            {
                return 0;
            }
            let vk = word & 0xff;
            let scan = (word >> 8) & 0xff;
            let mods = (word >> 17) & 15;
            let extended = word & (1 << 16) != 0;
            let (code, mut key, location) = names(vk, extended);
            let mut state = [0u8; 256];
            GetKeyboardState(state.as_mut_ptr());
            state[vk as usize] |= 0x80;
            for (v, bit) in [
                (0x10, 2),
                (0x11, 1),
                (0x12, 4),
                (0xa0, 2),
                (0xa1, 2),
                (0xa2, 1),
                (0xa3, 1),
                (0xa4, 4),
                (0xa5, 4),
            ] {
                state[v] = (state[v] & 1) | if mods & bit != 0 { 0x80 } else { 0 };
            }
            let mut chars = [0u16; 8];
            let count = if up {
                0
            } else {
                ToUnicodeEx(
                    vk,
                    scan,
                    state.as_ptr(),
                    chars.as_mut_ptr(),
                    8,
                    0,
                    GetKeyboardLayout(input_thread(hwnd)),
                )
            };
            let text = if count > 0 {
                String::from_utf16_lossy(&chars[..count.min(8) as usize])
                    .chars()
                    .filter(|c| *c == '\r' || *c == '\n' || !c.is_control())
                    .collect::<String>()
            } else {
                String::new()
            };
            if !text.is_empty() && vk != 13 && vk != 0x20 {
                key = text.clone();
            } else if (0x41..=0x5a).contains(&vk) {
                key = char::from_u32(vk).unwrap().to_ascii_lowercase().to_string();
            }
            let cdp_mods = (mods & 4) >> 2 | (mods & 1) << 1 | (mods & 8) >> 1 | (mods & 2) << 2;
            let mut events = vec![
                serde_json::json!({"type":if up{"keyUp"}else{"rawKeyDown"},"code":code,"key":key,"windowsVirtualKeyCode":vk,"nativeVirtualKeyCode":vk,"modifiers":cdp_mods,"isSystemKey":mods&4!=0,"autoRepeat":word&(1<<22)!=0,"location":location}),
            ];
            if !up && !text.is_empty() {
                events.push(serde_json::json!({"type":"char","text":text,"modifiers":cdp_mods}));
            }
            // Browser input routing preserves native textarea editing and Undo.
            // COM work runs after the low-level hook returns, on the UI queue.
            let _ = context.window.with_webview(move |view| {
                if let Ok(core) = unsafe { view.controller().CoreWebView2() } {
                    for event in events {
                        let method = "Input.dispatchKeyEvent\0"
                            .encode_utf16()
                            .collect::<Vec<_>>();
                        let params = event
                            .to_string()
                            .encode_utf16()
                            .chain(Some(0))
                            .collect::<Vec<_>>();
                        let completed =
                            webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                                Box::new(|_, _| Ok(())),
                            );
                        let _ = unsafe {
                            core.CallDevToolsProtocolMethod(
                                windows::core::PCWSTR(method.as_ptr()),
                                windows::core::PCWSTR(params.as_ptr()),
                                &completed,
                            )
                        };
                    }
                }
            });
            return 0;
        }
        if message == WM_NCDESTROY {
            if let Some(s) = slot(hwnd) {
                WINDOWS[s].store(0, Relaxed);
            }
            for key in &PRESSED {
                let _ = key.compare_exchange(hwnd as usize, 1, Relaxed, Relaxed);
            }
            RemoveWindowSubclass(hwnd, Some(route), id);
            drop(Box::from_raw(data as *mut Context));
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
    pub fn show(window: &tauri::WebviewWindow, cfg: &AppConfig) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        let configured = rules(cfg);
        for (index, value) in configured.into_iter().enumerate() {
            RULES[index].store(value, Relaxed);
        }
        unsafe {
            let generation = GENERATION.fetch_add(1, Relaxed) + 1;
            let context = Box::into_raw(Box::new(Context {
                window: window.clone(),
                generation,
            }));
            let mut previous = 0;
            let exists = GetWindowSubclass(hwnd, Some(route), SUBCLASS, &mut previous) != 0;
            if SetWindowSubclass(hwnd, Some(route), SUBCLASS, context as usize) == 0 {
                drop(Box::from_raw(context));
                return Err("перехват: окно недоступно".into());
            }
            if exists {
                drop(Box::from_raw(previous as *mut Context));
            }
            // Keep the hook's message pump independent from WebView creation
            // and modal UI; Windows removes timed-out low-level hooks silently.
            worker()?;
        }
        let s = slot(hwnd)
            .or_else(|| WINDOWS.iter().position(|w| w.load(Relaxed) == 0))
            .ok_or("слишком много окон захвата")?;
        EPOCHS[s].store(GENERATION.load(Relaxed), Relaxed);
        SUSPENDED[s].store(false, Relaxed);
        TEXT[s].store(false, Relaxed);
        WINDOWS[s].store(hwnd as usize, Relaxed);
        Ok(())
    }
    pub fn close() {
        for w in &WINDOWS {
            w.store(0, Relaxed);
        }
    }
    pub fn state(window: &tauri::WebviewWindow, text: bool, suspended: bool) {
        let s = window.hwnd().ok().and_then(|h| slot(h.0));
        if let Some(s) = s {
            TEXT[s].store(text, Relaxed);
            SUSPENDED[s].store(suspended, Relaxed);
        }
    }
}

pub fn show(window: &tauri::WebviewWindow, cfg: &AppConfig) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::show(window, cfg);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, cfg);
        Ok(())
    }
}
pub fn close() {
    #[cfg(target_os = "windows")]
    win::close();
}
#[tauri::command]
pub fn snipcast_capture_keyboard_state(
    window: tauri::WebviewWindow,
    text_input: bool,
    suspended: bool,
) {
    if !window
        .label()
        .starts_with(crate::screenshot::CAPTURE_PREFIX)
    {
        return;
    }
    #[cfg(target_os = "windows")]
    win::state(&window, text_input, suspended);
    #[cfg(not(target_os = "windows"))]
    let _ = (text_input, suspended);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_alt() {
        let cfg = AppConfig::default();
        let r = rules(&cfg);
        let c = key(Code::KeyC).unwrap();
        assert_eq!(r[c] & 1, 1);
        assert_ne!(r[c] & (1 << 4), 0);
        assert_eq!(r[c] & (1 << 1), 0);
    }
    #[test]
    fn remapping_and_extended_keys() {
        let mut cfg = AppConfig::default();
        cfg.screenshot_copy_hotkey = "Control+Shift+F9".into();
        let r = rules(&cfg);
        assert_eq!(r[key(Code::KeyC).unwrap()], 0);
        assert_ne!(r[key(Code::F9).unwrap()] & (1 << 3), 0);
        assert_ne!(r[key(Code::F9).unwrap()] & (1 << 7), 0);
        assert_ne!(key(Code::Enter), key(Code::NumpadEnter));
        cfg.screenshot_copy_hotkey = "Control+Alt+F7".into();
        assert_ne!(rules(&cfg)[key(Code::F7).unwrap()] & (1 << 5), 0);
    }
    #[test]
    fn own_tools_only() {
        let r = rules(&AppConfig::default());
        assert_ne!(r[key(Code::NumpadSubtract).unwrap()], 0);
        assert_eq!(r[key(Code::F10).unwrap()], 0);
        assert_eq!(r[key(Code::KeyJ).unwrap()], 0);
    }
}
