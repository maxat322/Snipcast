//! Windows input broker. Hooks only enqueue events; COM/search/insertion run on an MTA worker.
use crate::{
    data::AppConfig,
    text_suggestions::{self as core, Entry, Hit, Pending, Runtime, Status, View, Word},
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst},
        mpsc::{self, SyncSender},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::{
    core::{Interface, BOOL},
    Win32::{
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
        },
        UI::Accessibility::*,
    },
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::Threading::*,
    UI::{
        Input::{Ime::*, KeyboardAndMouse::*},
        Shell::{DefSubclassProc, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};
use windows_sys::Win32::{
    Graphics::Gdi::*,
    UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
};

pub(crate) const INJECT_TAG: usize = 0x534e4950;
const LABEL: &str = "text-suggestions";
static EVENTS: OnceLock<SyncSender<Command>> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
static READY: AtomicBool = AtomicBool::new(false);
static VISIBLE: AtomicBool = AtomicBool::new(false);
static FORM_ACTIVE: AtomicBool = AtomicBool::new(false);
static REPLACING: AtomicBool = AtomicBool::new(false);
static RESTORING: AtomicBool = AtomicBool::new(false);
pub fn ready() -> bool {
    READY.load(SeqCst)
}
static TARGET_HWND: AtomicUsize = AtomicUsize::new(0);
static TARGET_FOCUS: AtomicUsize = AtomicUsize::new(0);
static POPUP: AtomicUsize = AtomicUsize::new(0);
static INPUT_SEQ: AtomicU64 = AtomicU64::new(0);
static LOST: AtomicBool = AtomicBool::new(false);
static CAPS: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "inline-qa")]
static QA_INPUT: AtomicBool = AtomicBool::new(false);
static HELD: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];
static EAT_UP: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];

pub enum Command {
    Configure(AppConfig),
    Reset,
    Recover,
    Key {
        vk: u32,
        scan: u32,
        flags: u32,
        up: bool,
        mods: u32,
        hwnd: usize,
        focus: usize,
        seq: u64,
        consumed: bool,
    },
    Action {
        session: u64,
        action: String,
        index: Option<usize>,
    },
    Complete {
        session: u64,
        text: String,
        file_refs: Vec<String>,
        reply: SyncSender<Result<(), String>>,
    },
}
pub fn send(app: &tauri::AppHandle, cmd: Command) {
    if let Some(tx) = app
        .state::<Runtime>()
        .sender
        .lock()
        .ok()
        .and_then(|x| x.clone())
    {
        if tx.try_send(cmd).is_err() {
            LOST.store(true, SeqCst);
            READY.store(false, SeqCst);
        }
    }
}
fn enqueue(cmd: Command) {
    if EVENTS.get().is_some_and(|tx| tx.try_send(cmd).is_err()) {
        LOST.store(true, SeqCst);
        READY.store(false, SeqCst);
    }
}
fn focus() -> (usize, usize, u32) {
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(hwnd, &mut pid);
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let child = if GetGUIThreadInfo(tid, &mut info) != 0 {
            info.hwndFocus as usize
        } else {
            0
        };
        (hwnd as usize, child, pid)
    }
}
fn mods() -> u32 {
    let held = |v: usize| HELD[v].load(SeqCst);
    u32::from(held(0xa2) || held(0xa3))
        | (u32::from(held(0xa0) || held(0xa1)) << 1)
        | (u32::from(held(0xa4) || held(0xa5)) << 2)
        | (u32::from(held(0x5b) || held(0x5c)) << 3)
}
fn consume_visible_key(
    vk: usize,
    up: bool,
    modifier: bool,
    mods: u32,
    ready: bool,
    visible: bool,
) -> bool {
    !up && !modifier
        && mods == 0
        && matches!(vk, 13 | 27 | 0x26 | 0x28)
        && (ready || (vk == VK_RETURN as usize && visible))
}
unsafe extern "system" fn keyboard(code: i32, message: usize, param: isize) -> isize {
    if code < 0 {
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    let e = &*(param as *const KBDLLHOOKSTRUCT);
    let vk = e.vkCode as usize;
    if vk >= 256 || e.dwExtraInfo == INJECT_TAG {
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    let qa_input = {
        #[cfg(feature = "inline-qa")]
        {
            QA_INPUT.load(SeqCst) && e.dwExtraInfo == 0x534e5141
        }
        #[cfg(not(feature = "inline-qa"))]
        {
            false
        }
    };
    #[cfg(feature = "inline-qa")]
    if QA_INPUT.load(SeqCst) && !qa_input && e.flags & LLKHF_INJECTED == 0 {
        READY.store(false, SeqCst);
        enqueue(Command::Reset);
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    if e.flags & LLKHF_INJECTED != 0 && !qa_input {
        READY.store(false, SeqCst);
        INPUT_SEQ.fetch_add(1, SeqCst);
        let recover = {
            #[cfg(feature = "inline-qa")]
            {
                !QA_INPUT.load(SeqCst)
                    || (TARGET_HWND.load(SeqCst) != 0 && focus().0 == TARGET_HWND.load(SeqCst))
            }
            #[cfg(not(feature = "inline-qa"))]
            {
                true
            }
        };
        enqueue(if recover {
            Command::Recover
        } else {
            Command::Reset
        });
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    let up = e.flags & LLKHF_UP != 0;
    let was_held = HELD[vk].swap(!up, SeqCst);
    if vk == VK_CAPITAL as usize && !up && !was_held {
        CAPS.fetch_xor(true, SeqCst);
    }
    if up && EAT_UP[vk].swap(false, SeqCst) {
        return 1;
    }
    if !up && EAT_UP[vk].load(SeqCst) {
        return 1;
    }
    if !ENABLED.load(SeqCst) {
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    let (hwnd, child, pid) = focus();
    if pid == std::process::id() || hwnd == 0 {
        return CallNextHookEx(std::ptr::null_mut(), code, message, param);
    }
    let modifier = matches!(vk,0x10..=0x12|0xa0..=0xa5|0x5b|0x5c);
    let m = mods() | if e.flags & LLKHF_ALTDOWN != 0 { 4 } else { 0 };
    let consume = consume_visible_key(
        vk,
        up,
        modifier,
        m,
        READY.load(SeqCst),
        VISIBLE.load(SeqCst),
    ) && TARGET_HWND.load(SeqCst) == hwnd
        && TARGET_FOCUS.load(SeqCst) == child;
    let seq = if (!up && !modifier) || (modifier && REPLACING.load(SeqCst)) {
        READY.store(false, SeqCst);
        INPUT_SEQ.fetch_add(1, SeqCst) + 1
    } else {
        INPUT_SEQ.load(SeqCst)
    };
    enqueue(Command::Key {
        vk: e.vkCode,
        scan: e.scanCode,
        flags: e.flags,
        up,
        mods: m,
        hwnd,
        focus: child,
        seq,
        consumed: consume,
    });
    if consume {
        EAT_UP[vk].store(true, SeqCst);
        return 1;
    }
    CallNextHookEx(std::ptr::null_mut(), code, message, param)
}
unsafe extern "system" fn mouse(code: i32, message: usize, param: isize) -> isize {
    if code >= 0
        && ENABLED.load(SeqCst)
        && matches!(
            message as u32,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL | WM_MOUSEHWHEEL
        )
    {
        let e = &*(param as *const MSLLHOOKSTRUCT);
        let hit = WindowFromPoint(e.pt);
        let root = GetAncestor(hit, GA_ROOT);
        if root as usize != POPUP.load(SeqCst) {
            READY.store(false, SeqCst);
            INPUT_SEQ.fetch_add(1, SeqCst);
            enqueue(Command::Reset);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, message, param)
}
unsafe extern "system" fn window_event(
    _: HWINEVENTHOOK,
    event: u32,
    _: HWND,
    object: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND || (event == EVENT_OBJECT_FOCUS && object != OBJID_CARET) {
        let tracked = TARGET_HWND.load(SeqCst);
        let current = focus();
        if FORM_ACTIVE.load(SeqCst) && current.2 == std::process::id() {
            return;
        }
        // SetForegroundWindow can report focus before SetFocus restores the
        // child control. Mouse/key input still advances the epoch separately.
        if RESTORING.load(SeqCst) && current.0 == tracked {
            return;
        }
        if tracked == 0 || (current.0 == tracked && current.1 == TARGET_FOCUS.load(SeqCst)) {
            return;
        }
        READY.store(false, SeqCst);
        INPUT_SEQ.fetch_add(1, SeqCst);
        enqueue(Command::Reset);
    }
}
unsafe extern "system" fn noactivate(
    hwnd: HWND,
    msg: u32,
    wp: usize,
    lp: isize,
    _: usize,
    _: usize,
) -> isize {
    if msg == WM_MOUSEACTIVATE && !FORM_ACTIVE.load(SeqCst) {
        MA_NOACTIVATE as isize
    } else {
        DefSubclassProc(hwnd, msg, wp, lp)
    }
}

pub fn start(app: &tauri::AppHandle, cfg: AppConfig) -> Result<(), String> {
    #[cfg(feature = "inline-qa")]
    QA_INPUT.store(
        std::env::var("SNIPCAST_QA_INPUT").ok().as_deref() == Some("1")
            && std::env::var_os("SNIPCAST_DATA_DIR").is_some(),
        SeqCst,
    );
    let rt = app.state::<Runtime>();
    let mut sender = rt.sender.lock().map_err(|e| e.to_string())?;
    if sender.is_some() {
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?snipcast=text-suggestions".into()),
    )
    .title("Быстрая палитра — Snipcast")
    .shadow(false)
    .background_color(tauri::utils::config::Color(27, 27, 31, 255))
    .inner_size(360., 100.)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .build()
    .map_err(|e| e.to_string())?;
    let close_app = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let pending = close_app
                .state::<Runtime>()
                .pending
                .lock()
                .ok()
                .and_then(|p| p.clone());
            if let Some(pending) = pending {
                send(
                    &close_app,
                    Command::Action {
                        session: pending.session,
                        action: "cancel-pending".into(),
                        index: None,
                    },
                );
            } else {
                send(&close_app, Command::Reset);
            }
        }
    });
    if let Ok(handle) = win.hwnd() {
        unsafe {
            let hwnd = handle.0 as HWND;
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize,
            );
            SetWindowSubclass(hwnd, Some(noactivate), 0x534e5355, 0);
            POPUP.store(hwnd as usize, SeqCst);
        }
    }
    let (tx, rx) = mpsc::sync_channel(1024);
    let _ = EVENTS.set(tx.clone());
    *sender = Some(tx);
    let ah = app.clone();
    std::thread::spawn(move || worker(ah, cfg, rx));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || unsafe {
        for i in 0..256 {
            HELD[i].store(GetAsyncKeyState(i as i32) < 0, SeqCst);
        }
        CAPS.store(GetKeyState(VK_CAPITAL as i32) & 1 != 0, SeqCst);
        let key = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(window_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let focused = SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            std::ptr::null_mut(),
            Some(window_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let ok = !key.is_null() && !mouse.is_null();
        let _ = ready_tx.send(ok);
        if ok {
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if !key.is_null() {
            UnhookWindowsHookEx(key);
        }
        if !mouse.is_null() {
            UnhookWindowsHookEx(mouse);
        }
        if !foreground.is_null() {
            UnhookWinEvent(foreground);
        }
        if !focused.is_null() {
            UnhookWinEvent(focused);
        }
    });
    if !ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false)
    {
        return Err("Не удалось подключить отслеживание ввода Windows".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
// Same 12 CSS pixels as the ordinary palette. Clip the HWND too: CSS alone
// does not clip the opaque WebView host or remove Windows' light frame.
unsafe fn apply_popup_frame(hwnd: HWND, width: i32, height: i32, scale: f64) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    let css_corners = 1u32;
    let no_border = 0xffff_fffeu32;
    DwmSetWindowAttribute(hwnd, 33, &css_corners as *const _ as _, 4);
    DwmSetWindowAttribute(hwnd, 34, &no_border as *const _ as _, 4);
    let diameter = (24. * scale).round() as i32;
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
    if !region.is_null() && SetWindowRgn(hwnd, region, 1) == 0 {
        DeleteObject(region);
    }
}
fn pinned_position(
    saved: &mut Option<(i32, i32, String, f64)>,
    anchor: Option<Rect>,
    field: Option<Rect>,
    work: Rect,
    width: i32,
    height: i32,
    scale: f64,
) -> (i32, i32, String) {
    let p = saved.get_or_insert_with(|| {
        let (x, y, kind) = place(anchor, field, work, width, height);
        (x, y, kind.into(), scale)
    });
    (p.0, p.1, p.2.clone())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum NativeKind {
    Edit,
    Scintilla,
}
#[derive(Clone)]
struct NativeText {
    kind: NativeKind,
    position: u32,
    length: u32,
    prefix: String,
}
impl NativeText {
    fn replacement_start(&self, text: &str) -> Option<u32> {
        if !self.prefix.ends_with(text) {
            return None;
        }
        let length = match self.kind {
            NativeKind::Edit => text.encode_utf16().count(),
            NativeKind::Scintilla => text.len(),
        };
        self.position.checked_sub(length.try_into().ok()?)
    }
    unsafe fn select(&self, hwnd: usize, text: &str) -> Result<(), String> {
        let start = self.replacement_start(text).ok_or("Фрагмент изменился")?;
        scalar_message(
            hwnd,
            match self.kind {
                NativeKind::Edit => 0xb1,
                NativeKind::Scintilla => 2160,
            },
            start as usize,
            self.position as isize,
        )
        .ok_or("Приложение не отвечает")?;
        Ok(())
    }
}
unsafe fn scalar_message(hwnd: usize, message: u32, wp: usize, lp: isize) -> Option<usize> {
    let mut result = 0;
    (SendMessageTimeoutW(
        hwnd as HWND,
        message,
        wp,
        lp,
        SMTO_ABORTIFHUNG,
        100,
        &mut result,
    ) != 0)
        .then_some(result)
}
unsafe fn native_snapshot(hwnd: usize) -> Option<NativeText> {
    let class = class_name(hwnd);
    if class.eq_ignore_ascii_case("Edit") {
        let (position, prefix, length) = edit_snapshot(hwnd)?;
        return Some(NativeText {
            kind: NativeKind::Edit,
            position,
            length,
            prefix,
        });
    }
    if !class.eq_ignore_ascii_case("Scintilla") {
        return None;
    }
    // Pointer-free SCI messages are safe across process boundaries. Reading
    // only the short prefix also avoids copying a whole source document.
    if scalar_message(hwnd, 2140, 0, 0)? != 0 || scalar_message(hwnd, 2570, 0, 0)? != 1 {
        return None;
    }
    let position: u32 = scalar_message(hwnd, 2008, 0, 0)?.try_into().ok()?;
    if scalar_message(hwnd, 2009, 0, 0)? != position as usize {
        return None;
    }
    let utf8 = scalar_message(hwnd, 2137, 0, 0)? == 65001;
    let mut bytes = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(150);
    for offset in position.saturating_sub(512)..position {
        if Instant::now() >= deadline {
            return None;
        }
        bytes.push(scalar_message(hwnd, 2007, offset as usize, 0)? as u8);
    }
    if !utf8 && !bytes.is_ascii() {
        return None;
    }
    if scalar_message(hwnd, 2008, 0, 0)? != position as usize
        || scalar_message(hwnd, 2009, 0, 0)? != position as usize
    {
        return None;
    }
    Some(NativeText {
        kind: NativeKind::Scintilla,
        position,
        length: scalar_message(hwnd, 2006, 0, 0)?.try_into().ok()?,
        prefix: String::from_utf8_lossy(&bytes).into_owned(),
    })
}
unsafe fn range_rect(range: &IUIAutomationTextRange) -> Option<Rect> {
    let array = range.GetBoundingRectangles().ok()?;
    if array.is_null() {
        return None;
    }
    let read = (|| {
        let lo = SafeArrayGetLBound(array, 1).ok()?;
        let hi = SafeArrayGetUBound(array, 1).ok()?;
        if hi - lo < 3 {
            return None;
        }
        let mut v = [0f64; 4];
        for (i, value) in v.iter_mut().enumerate() {
            SafeArrayGetElement(array, &(lo + i as i32), value as *mut _ as _).ok()?;
        }
        (v[3] > 0.).then_some(Rect {
            x: v[0].round() as i32,
            y: v[1].round() as i32,
            w: v[2].round() as i32,
            h: v[3].round() as i32,
        })
    })();
    let _ = SafeArrayDestroy(array);
    read
}
unsafe fn caret_range(el: &IUIAutomationElement) -> Option<IUIAutomationTextRange> {
    if let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) {
        let mut active = BOOL(0);
        if let Ok(r) = pattern.GetCaretRange(&mut active) {
            if active.as_bool() {
                return Some(r);
            }
        }
    }
    let p = el
        .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
        .ok()?;
    let ranges = p.GetSelection().ok()?;
    if ranges.Length().ok()? != 1 {
        return None;
    }
    let r = ranges.GetElement(0).ok()?;
    (r.CompareEndpoints(
        TextPatternRangeEndpoint_Start,
        &r,
        TextPatternRangeEndpoint_End,
    )
    .ok()?
        == 0)
        .then_some(r)
}
unsafe fn before(range: &IUIAutomationTextRange, count: usize) -> Option<IUIAutomationTextRange> {
    let r = range.Clone().ok()?;
    r.MoveEndpointByUnit(
        TextPatternRangeEndpoint_Start,
        TextUnit_Character,
        -(count as i32),
    )
    .ok()?;
    Some(r)
}
unsafe fn native_caret(hwnd: usize) -> Option<Rect> {
    let tid = GetWindowThreadProcessId(hwnd as HWND, std::ptr::null_mut());
    let mut info: GUITHREADINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    if GetGUIThreadInfo(tid, &mut info) == 0
        || info.hwndCaret.is_null()
        || info.rcCaret.bottom <= info.rcCaret.top
    {
        return None;
    }
    let mut p = POINT {
        x: info.rcCaret.left,
        y: info.rcCaret.top,
    };
    if ClientToScreen(info.hwndCaret, &mut p) == 0 {
        return None;
    }
    Some(Rect {
        x: p.x,
        y: p.y,
        w: info.rcCaret.right - info.rcCaret.left,
        h: info.rcCaret.bottom - info.rcCaret.top,
    })
}
unsafe fn integrity(pid: u32) -> Option<u32> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if process.is_null() {
        return None;
    }
    let mut token = std::ptr::null_mut();
    let ok = OpenProcessToken(process, TOKEN_QUERY, &mut token);
    CloseHandle(process);
    if ok == 0 {
        return None;
    }
    let mut size = 0;
    GetTokenInformation(
        token,
        TokenIntegrityLevel,
        std::ptr::null_mut(),
        0,
        &mut size,
    );
    // DWORD-aligned allocation for TOKEN_MANDATORY_LABEL.
    let mut buf = vec![
        0usize;
        (size as usize + std::mem::size_of::<usize>() - 1)
            / std::mem::size_of::<usize>()
    ];
    let ok = GetTokenInformation(
        token,
        TokenIntegrityLevel,
        buf.as_mut_ptr() as _,
        size,
        &mut size,
    );
    CloseHandle(token);
    if ok == 0 {
        return None;
    }
    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let n = *GetSidSubAuthorityCount(label.Label.Sid);
    Some(*GetSidSubAuthority(label.Label.Sid, n as u32 - 1))
}
unsafe fn process_name(pid: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
        return None;
    }
    let mut path = [0u16; 1024];
    let mut len = path.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut len);
    CloseHandle(handle);
    if ok == 0 {
        return None;
    }
    Some(
        String::from_utf16_lossy(&path[..len as usize])
            .rsplit(['\\', '/'])
            .next()?
            .to_lowercase(),
    )
}
unsafe fn class_name(hwnd: usize) -> String {
    let mut name = [0u16; 128];
    let n = GetClassNameW(hwnd as HWND, name.as_mut_ptr(), 128);
    String::from_utf16_lossy(&name[..n.max(0) as usize])
}
unsafe fn edit_snapshot(hwnd: usize) -> Option<(u32, String, u32)> {
    let mut start = 0u32;
    let mut end = 0u32;
    let mut result = 0usize;
    if SendMessageTimeoutW(
        hwnd as HWND,
        0xb0,
        &mut start as *mut _ as usize,
        &mut end as *mut _ as isize,
        SMTO_ABORTIFHUNG,
        100,
        &mut result,
    ) == 0
        || start != end
    {
        return None;
    }
    if SendMessageTimeoutW(
        hwnd as HWND,
        WM_GETTEXTLENGTH,
        0,
        0,
        SMTO_ABORTIFHUNG,
        100,
        &mut result,
    ) == 0
        || result > 8192
    {
        return None;
    }
    let mut text = vec![0u16; result + 1];
    if SendMessageTimeoutW(
        hwnd as HWND,
        WM_GETTEXT,
        text.len(),
        text.as_mut_ptr() as isize,
        SMTO_ABORTIFHUNG,
        100,
        &mut result,
    ) == 0
        || start as usize > result
    {
        return None;
    }
    let before = &text[(start as usize).saturating_sub(256)..start as usize];
    Some((start, String::from_utf16_lossy(before), result as u32))
}
#[derive(Clone)]
struct Target {
    hwnd: usize,
    focus: usize,
    el: Option<IUIAutomationElement>,
    caret: Option<IUIAutomationTextRange>,
    native: Option<NativeText>,
    value: Option<String>,
    anchor: Option<Rect>,
    field: Option<Rect>,
    terminal: bool,
}
fn max_continuous_field(name: &str, class: &str, window: bool, edit: bool) -> bool {
    name == "max.exe"
        && ((window && class.starts_with("MeWindow_"))
            || (edit && (class.contains("TextEdit") || class.contains("TextArea"))))
}
fn quick_form_height(text: &str, page_size: usize) -> i32 {
    let mut fields = std::collections::BTreeSet::new();
    let mut files = false;
    for part in text.split('[').skip(1) {
        if let Some(end) = part.find(']') {
            let label = part[..end].trim();
            if label.starts_with('"') {
                files = true;
            } else if !label.is_empty() {
                fields.insert(label);
            }
        }
    }
    174 + fields.len().min(page_size) as i32 * 70
        + if files { 32 } else { 0 }
        + if fields.len() > page_size { 30 } else { 0 }
}
unsafe fn window_midpoint(hwnd: usize) -> POINT {
    let mut rect: RECT = std::mem::zeroed();
    if GetWindowRect(hwnd as HWND, &mut rect) != 0 {
        POINT {
            x: rect.left + (rect.right - rect.left) / 2,
            y: rect.top + (rect.bottom - rect.top) / 2,
        }
    } else {
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p);
        p
    }
}
unsafe fn monitor_work(point: POINT) -> Rect {
    let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(monitor, &mut info) != 0 {
        Rect {
            x: info.rcWork.left,
            y: info.rcWork.top,
            w: info.rcWork.right - info.rcWork.left,
            h: info.rcWork.bottom - info.rcWork.top,
        }
    } else {
        Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        }
    }
}
fn form_bounds(
    origin: (i32, i32),
    work: Rect,
    width: i32,
    height: i32,
    center: bool,
) -> (i32, i32, i32) {
    let height = height.min(work.h).max(1);
    let (x, y) = if center {
        (
            work.x + (work.w - width) / 2,
            work.y + (work.h - height) / 2,
        )
    } else {
        origin
    };
    (
        x.clamp(work.x, (work.x + work.w - width).max(work.x)),
        y.clamp(work.y, (work.y + work.h - height).max(work.y)),
        height,
    )
}
impl Target {
    unsafe fn inspect(uia: &IUIAutomation, cfg: &AppConfig) -> Result<Self, String> {
        let (hwnd, child, pid) = focus();
        if hwnd == 0 || pid == std::process::id() {
            return Err(String::new());
        }
        let name = process_name(pid).ok_or("Не удалось определить приложение")?;
        if cfg.text_suggestions.excluded_apps.iter().any(|x| {
            x.trim()
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or("")
                .to_lowercase()
                .trim_end_matches(".exe")
                == name.trim_end_matches(".exe")
        }) {
            return Err("Приложение в исключениях".into());
        }
        let own = integrity(std::process::id()).unwrap_or(0);
        let target = integrity(pid).ok_or("Недоступны права целевого окна")?;
        if target > own {
            return Err("Окно с повышенными правами: вставка недоступна".into());
        }
        let klass = class_name(hwnd);
        let console = klass == "ConsoleWindowClass" || name == "windowsterminal.exe";
        let ime = ImmGetContext(child as HWND);
        if !ime.is_null() {
            let composing = ImmGetCompositionStringW(ime, GCS_COMPSTR, std::ptr::null_mut(), 0) > 0;
            ImmReleaseContext(child as HWND, ime);
            if composing {
                return Err("Ожидается завершение композиции IME".into());
            }
        }
        let el = uia
            .GetFocusedElement()
            .ok()
            .filter(|e| e.CurrentProcessId().ok() == Some(pid as i32));
        let max_root = el.as_ref().is_some_and(|e| {
            let class = e
                .CurrentClassName()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let kind = e.CurrentControlType().ok();
            max_continuous_field(
                &name,
                &class,
                kind == Some(UIA_WindowControlTypeId),
                kind == Some(UIA_EditControlTypeId),
            )
        });
        if let Some(e) = &el {
            if e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                return Err(String::new());
            }
            if !matches!(
                class_name(child).to_lowercase().as_str(),
                "edit" | "scintilla"
            ) && !max_root
                && e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .ok()
                    .is_some_and(|p| p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(true))
            {
                return Err(String::new());
            }
        } else if !console
            && !matches!(
                class_name(child).to_lowercase().as_str(),
                "edit" | "scintilla"
            )
        {
            return Err("Поле ввода не определяется".into());
        }
        if class_name(child).eq_ignore_ascii_case("Edit")
            && GetWindowLongPtrW(child as HWND, GWL_STYLE) & (0x20 | 0x800) != 0
        {
            return Err(String::new());
        }
        let native = native_snapshot(child);
        if class_name(child).eq_ignore_ascii_case("Scintilla") && native.is_none() {
            return Err(
                "Scintilla: выделение, несколько кареток или неподдержанная кодировка".into(),
            );
        }
        let caret = if console || native.is_some() {
            None
        } else {
            el.as_ref().and_then(|e| caret_range(e))
        };
        let value = if !console && !max_root && caret.is_none() && native.is_none() {
            el.as_ref()
                .and_then(|e| {
                    e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .ok()
                })
                .and_then(|p| p.CurrentValue().ok())
                .map(|s| s.to_string())
                .filter(|s| s.len() <= 16384)
        } else {
            None
        };
        let terminal =
            console || (max_root && caret.is_none() && native.is_none() && value.is_none());
        if !terminal && caret.is_none() && native.is_none() && value.is_none() {
            return Err("Нет доступного текстового диапазона".into());
        }
        let field = el
            .as_ref()
            .and_then(|e| e.CurrentBoundingRectangle().ok())
            .filter(|r| r.bottom > r.top && r.right > r.left)
            .map(|r| Rect {
                x: r.left,
                y: r.top,
                w: r.right - r.left,
                h: r.bottom - r.top,
            });
        let anchor = native_caret(hwnd).or_else(|| caret.as_ref().and_then(|r| range_rect(r)));
        Ok(Self {
            hwnd,
            focus: child,
            el: if native.is_some() { None } else { el },
            caret: if native.is_some() { None } else { caret },
            native,
            value,
            anchor,
            field,
            terminal,
        })
    }
    unsafe fn same_field(&self, other: &Self, uia: &IUIAutomation) -> bool {
        self.hwnd == other.hwnd
            && self.focus == other.focus
            && ((self.terminal && other.terminal)
                || match (&self.el, &other.el) {
                    (Some(a), Some(b)) => uia
                        .CompareElements(a, b)
                        .map(|x| x.as_bool())
                        .unwrap_or(false),
                    (None, None) => true,
                    _ => false,
                })
    }
    unsafe fn prefix(&self) -> Option<(String, bool)> {
        if let Some(native) = &self.native {
            let units = match native.kind {
                NativeKind::Edit => native.prefix.encode_utf16().count(),
                NativeKind::Scintilla => native.prefix.len(),
            };
            return Some((native.prefix.clone(), units == native.position as usize));
        }
        if let Some(value) = &self.value {
            return Some((value.clone(), true));
        }
        if let Some(r) = &self.caret {
            let range = r.Clone().ok()?;
            let moved = range
                .MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -129)
                .ok()?;
            return Some((range.GetText(1024).ok()?.to_string(), moved > -129));
        }
        None
    }
    unsafe fn fragment(&self, tracked: &str, trigger: &str) -> Option<String> {
        if self.native.is_some() || self.caret.is_some() || self.value.is_some() {
            let (prefix, start) = self.prefix()?;
            return whole_fragment(&prefix, start, tracked, trigger);
        }
        core::backspace_safe(tracked).then(|| tracked.to_owned())
    }
    unsafe fn suffix(&self, text: &str, trigger: &str) -> bool {
        self.fragment(text, trigger).as_deref() == Some(text)
    }
}
fn whole_fragment(prefix: &str, at_start: bool, tracked: &str, trigger: &str) -> Option<String> {
    if tracked.is_empty() || !prefix.ends_with(tracked) {
        return None;
    }
    let start = prefix
        .char_indices()
        .rev()
        .find(|(_, c)| !c.is_alphanumeric() && *c != '_' && !trigger.contains(*c))
        .map(|(i, c)| i + c.len_utf8());
    let text = &prefix[start.unwrap_or(0)..];
    if (start.is_none() && !at_start) || text.chars().count() > 128 {
        return None;
    }
    Some(text.to_owned())
}
fn place(
    anchor: Option<Rect>,
    _field: Option<Rect>,
    work: Rect,
    width: i32,
    height: i32,
) -> (i32, i32, &'static str) {
    let (x, y, kind) = if let Some(a) = anchor {
        (
            a.x,
            if a.y - height - 8 >= work.y {
                a.y - height - 8
            } else {
                a.y + a.h + 8
            },
            "caret",
        )
    } else {
        (
            work.x + (work.w - width) / 2,
            work.y + (work.h - height) / 2,
            "center",
        )
    };
    (
        x.clamp(work.x, (work.x + work.w - width).max(work.x)),
        y.clamp(work.y, (work.y + work.h - height).max(work.y)),
        kind,
    )
}

struct Controller {
    app: tauri::AppHandle,
    cfg: AppConfig,
    uia: IUIAutomation,
    index: Vec<Entry>,
    vars: serde_json::Map<String, serde_json::Value>,
    word: Word,
    target: Option<Target>,
    hits: Vec<usize>,
    selected: usize,
    session: u64,
    seq: u64,
    dirty: bool,
    confirm: Option<u64>,
    recover: bool,
    ime_active: bool,
    unconfirmed: Option<(u64, Instant)>,
    pending: Option<(u64, Target, String)>,
    pending_invalid: bool,
    pending_epoch: u64,
    popup_position: Option<(i32, i32, String, f64)>,
    last_files: Vec<(std::path::PathBuf, u64, u128)>,
}
impl Controller {
    unsafe fn resize_form(&mut self, height_css: i32) {
        let Some((_, target, _)) = self.pending.as_ref() else {
            return;
        };
        let Some(window) = self.app.get_webview_window(LABEL) else {
            return;
        };
        let scale = self.popup_position.as_ref().map(|p| p.3).unwrap_or(1.);
        let work = monitor_work(window_midpoint(target.hwnd));
        let width = (360. * scale).round() as i32;
        let desired = (height_css as f64 * scale).ceil() as i32;
        let origin = self
            .popup_position
            .as_ref()
            .map(|p| (p.0, p.1))
            .unwrap_or((work.x, work.y));
        let centered = target.anchor.is_none();
        let (x, y, height) = form_bounds(origin, work, width, desired, centered);
        self.popup_position = Some((
            x,
            y,
            if centered { "center" } else { "caret" }.into(),
            scale,
        ));
        let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        apply_popup_frame(POPUP.load(SeqCst) as HWND, width, height, scale);
    }
    fn status(&self, message: String) {
        let rt = self.app.state::<Runtime>();
        let message = if message.is_empty() {
            rt.hotkey_error.lock().unwrap().clone().unwrap_or_default()
        } else {
            message
        };
        let status = Status {
            supported: true,
            enabled: self.cfg.text_suggestions.enabled,
            message,
        };
        *rt.status.lock().unwrap() = status.clone();
        let _ = self.app.emit("snipcast://suggestions-status", status);
    }
    fn hide(&mut self) {
        READY.store(false, SeqCst);
        VISIBLE.store(false, SeqCst);
        self.popup_position = None;
        FORM_ACTIVE.store(false, SeqCst);
        self.hits.clear();
        self.session += 1;
        let view = View {
            ready: false,
            session: self.session,
            ..Default::default()
        };
        *self.app.state::<Runtime>().view.lock().unwrap() = view.clone();
        let _ = self.app.emit_to(LABEL, "snipcast://suggestions-view", view);
        if let Some(w) = self.app.get_webview_window(LABEL) {
            let _ = w.hide();
            let _ = w.set_focusable(false);
        }
    }
    fn reset(&mut self) {
        self.word.reset();
        self.target = None;
        self.confirm = None;
        self.dirty = false;
        self.recover = false;
        self.ime_active = false;
        self.unconfirmed = None;
        TARGET_HWND.store(0, SeqCst);
        TARGET_FOCUS.store(0, SeqCst);
        self.hide();
    }
    unsafe fn recover_word(&mut self) {
        if !self.cfg.text_suggestions.enabled || self.pending.is_some() {
            self.recover = false;
            return;
        }
        let revision = INPUT_SEQ.load(SeqCst);
        let target = match Target::inspect(&self.uia, &self.cfg) {
            Ok(target) => target,
            Err(error) => {
                self.ime_active = error == "Ожидается завершение композиции IME";
                self.recover = false;
                return;
            }
        };
        if target.terminal {
            self.recover = false;
            self.word.dismiss(); // Unreadable replacement: never restart with a partial suffix.
            return;
        }
        let text = target
            .native
            .as_ref()
            .map(|n| n.prefix.clone())
            .or_else(|| {
                target
                    .caret
                    .as_ref()
                    .and_then(|r| before(r, 128))
                    .and_then(|r| r.GetText(256).ok())
                    .map(|t| t.to_string())
            });
        let Some(text) = text else {
            self.recover = false;
            return;
        };
        if revision != INPUT_SEQ.load(SeqCst) {
            return;
        }
        let tail: String = text
            .chars()
            .rev()
            .take_while(|c| {
                c.is_alphanumeric() || *c == '_' || self.cfg.text_suggestions.trigger.contains(*c)
            })
            .take(128)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.word.reset();
        self.word.push(&tail, &self.cfg.text_suggestions.trigger);
        self.target = Some(target);
        self.seq = revision;
        self.recover = false;
        self.ime_active = false;
        self.dirty = true;
    }
    fn reload(&mut self) {
        match crate::data::load_all_templates(&self.cfg) {
            Ok(rows) => {
                self.index = core::build_index(&rows);
                self.vars = crate::data::load_variables_map().unwrap_or_default();
                self.reset();
                self.status(String::new());
            }
            Err(_) => {
                self.index.clear();
                self.reset();
                self.status("Не удалось загрузить шаблоны".into());
            }
        }
    }
    fn files(&self) -> Vec<(std::path::PathBuf, u64, u128)> {
        let mut paths = vec![crate::data::variables_path()];
        if let Ok(items) = std::fs::read_dir(crate::data::template_groups_dir()) {
            paths.extend(
                items
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "json")),
            );
        }
        if let Ok(store) = crate::data::load_template_store() {
            paths.extend(
                store
                    .groups
                    .into_iter()
                    .filter_map(|g| g.master_source_path)
                    .map(std::path::PathBuf::from),
            );
        }
        paths.sort();
        paths
            .into_iter()
            .map(|p| {
                let m = std::fs::metadata(&p).ok();
                let len = m.as_ref().map(|m| m.len()).unwrap_or(0);
                let time = m
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|t| t.as_nanos())
                    .unwrap_or(0);
                (p, len, time)
            })
            .collect()
    }
    unsafe fn publish(&mut self) {
        self.dirty = false;
        let Some(_) = self
            .word
            .query(&self.cfg.text_suggestions)
            .map(str::to_owned)
        else {
            self.hide();
            return;
        };
        if self.seq != INPUT_SEQ.load(SeqCst) {
            self.hide();
            return;
        }
        let new = match Target::inspect(&self.uia, &self.cfg) {
            Ok(t) => t,
            Err(e) => {
                self.reset();
                self.word.dismiss();
                self.status(e);
                return;
            }
        };
        let same = self
            .target
            .as_ref()
            .is_some_and(|t| t.same_field(&new, &self.uia));
        let fragment = new.fragment(&self.word.text, &self.cfg.text_suggestions.trigger);
        let suffix = fragment.is_some();
        // A UIA call may observe a newer key before that key reaches this worker.
        // Do not reset the word using a snapshot from a different input revision.
        if self.seq != INPUT_SEQ.load(SeqCst) {
            self.hide();
            return;
        }
        if same && !suffix {
            let since = if let Some((revision, since)) = self.unconfirmed {
                if revision == self.seq {
                    since
                } else {
                    Instant::now()
                }
            } else {
                Instant::now()
            };
            self.unconfirmed = Some((self.seq, since));
            if since.elapsed() < Duration::from_millis(250) {
                self.dirty = true;
                self.hide();
                return;
            }
        }
        if !same || !suffix {
            self.reset();
            self.word.dismiss();
            return;
        }
        self.unconfirmed = None;
        // Recover a missed prefix before searching, rather than expanding only
        // the buffered suffix and leaving the beginning of the command behind.
        self.word.text = fragment.unwrap();
        let Some(query) = self
            .word
            .query(&self.cfg.text_suggestions)
            .map(str::to_owned)
        else {
            self.hide();
            return;
        };
        let hits = core::search(&self.index, &query, self.cfg.text_suggestions.search_text);
        if hits.is_empty() {
            self.hide();
            return;
        }
        self.target = Some(new.clone());
        self.hits = hits;
        self.selected = self.selected.min(self.hits.len() - 1);
        self.session += 1;
        let Some(win) = self.app.get_webview_window(LABEL) else {
            return;
        };
        let point = new
            .anchor
            .map(|r| POINT { x: r.x, y: r.y })
            .unwrap_or_else(|| window_midpoint(new.hwnd));
        let detected_scale = win
            .available_monitors()
            .ok()
            .and_then(|monitors| {
                monitors.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    point.x >= p.x
                        && point.y >= p.y
                        && point.x < p.x + s.width as i32
                        && point.y < p.y + s.height as i32
                })
            })
            .map(|m| m.scale_factor())
            .unwrap_or(1.);
        let scale = self
            .popup_position
            .as_ref()
            .map(|p| p.3)
            .unwrap_or(detected_scale);
        let width = (360. * scale).round() as i32;
        let height = ((58. + self.hits.len() as f64 * 52.) * scale).round() as i32;
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let work = if GetMonitorInfoW(monitor, &mut mi) != 0 {
            Rect {
                x: mi.rcWork.left,
                y: mi.rcWork.top,
                w: mi.rcWork.right - mi.rcWork.left,
                h: mi.rcWork.bottom - mi.rcWork.top,
            }
        } else {
            Rect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            }
        };
        let (x, y, kind) = pinned_position(
            &mut self.popup_position,
            new.anchor,
            new.field,
            work,
            width,
            height,
            scale,
        );
        let _ = win.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        apply_popup_frame(POPUP.load(SeqCst) as HWND, width, height, scale);
        let view = View {
            session: self.session,
            query,
            ready: false,
            hits: self
                .hits
                .iter()
                .map(|i| {
                    let e = &self.index[*i];
                    Hit {
                        id: e.id.clone(),
                        title: e.title.clone(),
                        path: e.path.clone(),
                        preview: e
                            .content
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .chars()
                            .take(96)
                            .collect(),
                    }
                })
                .collect(),
            selected: self.selected,
            theme: self.cfg.theme.clone(),
            placement: kind,
            form: None,
        };
        *self.app.state::<Runtime>().view.lock().unwrap() = view.clone();
        VISIBLE.store(true, SeqCst);
        TARGET_HWND.store(new.hwnd, SeqCst);
        TARGET_FOCUS.store(new.focus, SeqCst);
        let _ = win.show();
        ShowWindow(POPUP.load(SeqCst) as HWND, SW_SHOWNOACTIVATE);
        let _ = self.app.emit_to(LABEL, "snipcast://suggestions-view", view);
        if self.confirm.take() == Some(self.seq) && self.seq == INPUT_SEQ.load(SeqCst) {
            self.choose(None);
        }
    }
    unsafe fn key(
        &mut self,
        vk: u32,
        scan: u32,
        flags: u32,
        up: bool,
        m: u32,
        hwnd: usize,
        child: usize,
        seq: u64,
        consumed: bool,
    ) {
        if self.pending.is_some() {
            // Modifier/key releases from the invocation can arrive before the
            // form takes focus; they do not change the source fragment.
            if !up && !matches!(vk,0x10..=0x12|0xa0..=0xa5|0x5b|0x5c) {
                self.pending_invalid = true;
            }
            return;
        }
        if !self.cfg.text_suggestions.enabled
            || up
            || matches!(vk,0x10..=0x12|0xa0..=0xa5|0x5b|0x5c)
        {
            return;
        }
        if consumed {
            self.seq = seq;
            match vk {
                13 => {
                    self.confirm = Some(seq);
                    self.dirty = true;
                    self.publish(); // Finish the latest query instead of selecting a stale row.
                }
                27 => {
                    self.word.dismiss();
                    self.hide();
                }
                0x26 | 0x28 => {
                    if !self.hits.is_empty() {
                        self.selected = if vk == 0x28 {
                            (self.selected + 1) % self.hits.len()
                        } else {
                            (self.selected + self.hits.len() - 1) % self.hits.len()
                        };
                        self.dirty = true;
                    }
                }
                _ => {}
            }
            return;
        }
        self.confirm = None;
        if matches!(vk, 0xe5 | 0xe7) {
            self.reset();
            self.recover = true;
            self.ime_active = vk == 0xe5;
            return;
        }
        if self.ime_active {
            self.reset();
            self.recover = true;
            return;
        }
        if m & 13 != 0 || matches!(vk, 9 | 13 | 27 | 0x20..=0x28 | 0x2e | 0x2d) {
            self.reset();
            return;
        }
        if self
            .target
            .as_ref()
            .is_some_and(|t| t.hwnd != hwnd || t.focus != child)
        {
            self.reset();
        }
        if self.target.is_none() {
            match Target::inspect(&self.uia, &self.cfg) {
                Ok(t) => {
                    TARGET_HWND.store(t.hwnd, SeqCst);
                    TARGET_FOCUS.store(t.focus, SeqCst);
                    self.target = Some(t);
                }
                Err(e) => {
                    self.word.dismiss();
                    self.status(e);
                    return;
                }
            }
        }
        self.seq = seq;
        if vk == 8 {
            self.word.backspace();
            self.selected = 0;
            self.dirty = true;
            return;
        }
        let mut state = [0u8; 256];
        GetKeyboardState(state.as_mut_ptr());
        state[VK_CAPITAL as usize] = u8::from(CAPS.load(SeqCst));
        state[vk as usize] |= 0x80;
        for (v, b) in [(0x10, 2), (0xa0, 2), (0xa1, 2), (0x11, 1), (0x12, 4)] {
            state[v] = (state[v] & 1) | if m & b != 0 { 0x80 } else { 0 };
        }
        // No kernel keyboard-state mutation: preserve dead keys and the application's TranslateMessage.
        let layout =
            GetKeyboardLayout(GetWindowThreadProcessId(hwnd as HWND, std::ptr::null_mut()));
        let mut chars = [0u16; 16];
        let n = ToUnicodeEx(vk, scan, state.as_ptr(), chars.as_mut_ptr(), 16, 4, layout);
        if n < 0 {
            self.reset();
            return;
        }
        if n == 0 {
            return;
        }
        if flags & LLKHF_EXTENDED != 0 && vk == 13 {
            self.reset();
            return;
        }
        self.word.push(
            &String::from_utf16_lossy(&chars[..n.min(16) as usize]),
            &self.cfg.text_suggestions.trigger,
        );
        self.selected = 0;
        self.dirty = true;
    }
    unsafe fn choose(&mut self, index: Option<usize>) {
        let Some(entry) = self
            .hits
            .get(index.unwrap_or(self.selected))
            .and_then(|i| self.index.get(*i))
            .cloned()
        else {
            return;
        };
        let Some(saved) = self.target.clone() else {
            return;
        };
        let text = core::substitute_variables(&entry.content, &self.vars);
        let replace = self.word.text.clone();
        let session = self.session;
        if self.seq != INPUT_SEQ.load(SeqCst) {
            self.reset();
            return;
        }
        let check = Target::inspect(&self.uia, &self.cfg).ok();
        if !check.as_ref().is_some_and(|t| {
            saved.same_field(t, &self.uia) && t.suffix(&replace, &self.cfg.text_suggestions.trigger)
        }) {
            self.reset();
            self.status("Место ввода изменилось — подстановка отменена".into());
            return;
        }
        let target = check.unwrap();
        let popup_position = self.popup_position.clone();
        self.hide();
        self.word.reset();
        self.target = None;
        if core::has_fields(&text) {
            self.popup_position = popup_position;
            self.pending = Some((session, target, replace));
            self.pending_invalid = false;
            self.pending_epoch = self.seq;
            let scale = self.popup_position.as_ref().map(|p| p.3).unwrap_or(1.);
            let work = monitor_work(window_midpoint(self.pending.as_ref().unwrap().1.hwnd));
            let page_size = (((work.h as f64 / scale - 230.) / 70.).floor() as usize).clamp(1, 6);
            let pending = Pending {
                session,
                text,
                title: entry.title,
                page_size,
            };
            *self.app.state::<Runtime>().pending.lock().unwrap() = Some(pending.clone());
            self.session += 1;
            let mut view = self.app.state::<Runtime>().view.lock().unwrap().clone();
            view.session = self.session;
            view.theme = self.cfg.theme.clone();
            view.form = Some(pending);
            if let Some(window) = self.app.get_webview_window(LABEL) {
                self.resize_form(quick_form_height(
                    &view.form.as_ref().unwrap().text,
                    page_size,
                ));
                view.placement = self
                    .popup_position
                    .as_ref()
                    .map(|p| p.2.clone())
                    .unwrap_or_default();
                let _ = window.show();
                ShowWindow(POPUP.load(SeqCst) as HWND, SW_SHOWNOACTIVATE);
            }
            *self.app.state::<Runtime>().view.lock().unwrap() = view.clone();
            if let Err(error) = activate_form(&self.app, self.pending.as_ref().unwrap().1.hwnd) {
                self.status(error);
            }
            let _ = self.app.emit_to(LABEL, "snipcast://suggestions-view", view);
        } else if let Err(e) = self.insert(&target, &replace, &text, &[], false, self.seq) {
            self.status(e);
        }
    }
    unsafe fn insert(
        &mut self,
        saved: &Target,
        replace: &str,
        text: &str,
        refs: &[String],
        from_form: bool,
        expected_epoch: u64,
    ) -> Result<(), String> {
        let paths = crate::template_files::resolve_template_file_refs(refs)?;
        if text.trim().is_empty() && paths.is_empty() {
            return Err("Шаблон пуст".into());
        }
        if from_form {
            let (hwnd, _, pid) = focus();
            if hwnd != saved.hwnd && pid != std::process::id() {
                return Err("Целевое окно изменилось".into());
            }
            let deadline = Instant::now() + Duration::from_millis(400);
            while [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                .iter()
                .any(|v| GetAsyncKeyState(*v as i32) < 0)
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            // Activate while our form still owns foreground; hiding first can give foreground to another app.
            activate_target(&self.app, saved.hwnd, saved.focus)?;
            if let Some(window) = self.app.get_webview_window(LABEL) {
                let _ = window.hide();
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        if INPUT_SEQ.load(SeqCst) != expected_epoch {
            return Err("Ввод изменился до подтверждения — подстановка отменена".into());
        }
        let start_seq = expected_epoch;
        let _replacing = ReplacingGuard::new();
        let deadline = Instant::now() + Duration::from_millis(if from_form { 500 } else { 0 });
        let fresh = loop {
            let snapshot = Target::inspect(&self.uia, &self.cfg);
            if focus().0 != saved.hwnd || start_seq != INPUT_SEQ.load(SeqCst) {
                return Err("Место ввода изменилось при возврате фокуса".into());
            }
            if let Ok(target) = &snapshot {
                if saved.same_field(target, &self.uia)
                    && target.suffix(replace, &self.cfg.text_suggestions.trigger)
                {
                    break snapshot.unwrap();
                }
            }
            if Instant::now() >= deadline {
                break snapshot?;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !saved.same_field(&fresh, &self.uia)
            || !fresh.suffix(replace, &self.cfg.text_suggestions.trigger)
            || (from_form && saved.value.is_some() && saved.value != fresh.value)
        {
            return Err("Набранный фрагмент изменился — подстановка отменена".into());
        }
        if let (Some(old), Some(now)) = (&saved.native, &fresh.native) {
            if old.kind != now.kind || old.position != now.position || old.prefix != now.prefix {
                return Err("Каретка перемещена — подстановка отменена".into());
            }
        } else if let (Some(old), Some(now)) = (&saved.caret, &fresh.caret) {
            if old
                .CompareEndpoints(
                    TextPatternRangeEndpoint_End,
                    now,
                    TextPatternRangeEndpoint_End,
                )
                .map_err(|_| "Каретка недоступна")?
                != 0
            {
                return Err("Каретка перемещена — подстановка отменена".into());
            }
        }
        // A held modifier would turn Backspace/Ctrl+V into a different operation.
        for vk in [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
            if GetAsyncKeyState(vk as i32) < 0 {
                return Err("Отпустите клавиши-модификаторы перед вставкой".into());
            }
        }
        let mut replacement = NativeReplacement {
            target: &fresh,
            cfg: &self.cfg,
            seq: start_seq,
            word: replace,
            text: text.trim(),
            paths: &paths,
            mutation_started: false,
        };
        let result = replace_verified(&mut replacement, replace);
        // Once deletion/paste was sent, retrying the form could delete a second word.
        if from_form && replacement.mutation_started {
            self.pending_invalid = true;
        }
        if result.is_err()
            && !replacement.mutation_started
            && insertion_target_unchanged(&fresh, start_seq)
        {
            if let Some(native) = &fresh.native {
                let _ = scalar_message(
                    fresh.focus,
                    match native.kind {
                        NativeKind::Edit => 0xb1,
                        NativeKind::Scintilla => 2160,
                    },
                    native.position as usize,
                    native.position as isize,
                );
            } else if let Some(caret) = &fresh.caret {
                let _ = caret.Select();
            }
        }
        result?;
        // Do not retry another strategy after partial insertion.
        if !text.trim().is_empty() && !paths.is_empty() {
            std::thread::sleep(Duration::from_millis(120));
            if focus().0 != saved.hwnd || INPUT_SEQ.load(SeqCst) != start_seq {
                return Err("Вложения не вставлены: место ввода изменилось".into());
            }
            crate::rich_clipboard::write_file_list(&paths)?;
            let mut paste = vec![];
            append_paste(&mut paste);
            inject(&paste)?;
        }
        self.status(String::new());
        Ok(())
    }
    unsafe fn command(&mut self, cmd: Command) {
        match cmd {
            Command::Configure(c) => {
                self.cfg = c;
                ENABLED.store(self.cfg.text_suggestions.enabled, SeqCst);
                self.pending = None;
                *self.app.state::<Runtime>().pending.lock().unwrap() = None;
                self.reload();
            }
            Command::Reset => {
                if self.pending.is_none() {
                    self.reset();
                } else if focus().2 != std::process::id() {
                    self.pending_invalid = true;
                }
            }
            Command::Recover => {
                if self.pending.is_none() {
                    self.reset();
                    self.recover = true;
                } else if focus().2 != std::process::id() {
                    self.pending_invalid = true;
                }
            }
            Command::Key {
                vk,
                scan,
                flags,
                up,
                mods,
                hwnd,
                focus,
                seq,
                consumed,
            } => self.key(vk, scan, flags, up, mods, hwnd, focus, seq, consumed),
            Command::Action {
                session,
                action,
                index,
            } => {
                if matches!(
                    action.as_str(),
                    "cancel-pending" | "form-ready" | "form-size"
                ) {
                    if let Some((pending_session, target, _)) = self.pending.clone() {
                        if pending_session != session {
                            return;
                        }
                        if action == "form-size" {
                            if let Some(height) = index.filter(|h| (100..=2048).contains(h)) {
                                self.resize_form(height as i32);
                            }
                        } else if action == "cancel-pending" {
                            if !self.pending_invalid && INPUT_SEQ.load(SeqCst) == self.pending_epoch
                            {
                                let _ = activate_target(&self.app, target.hwnd, target.focus);
                            }
                            self.pending = None;
                            *self.app.state::<Runtime>().pending.lock().unwrap() = None;
                            self.reset();
                        } else if let Err(error) = activate_form(&self.app, target.hwnd) {
                            self.status(error);
                        }
                    }
                    return;
                }
                if session != self.session {
                    return;
                }
                match action.as_str() {
                    "ready" => {
                        if self.seq == INPUT_SEQ.load(SeqCst)
                            && !self.hits.is_empty()
                            && self.pending.is_none()
                            && self.cfg.text_suggestions.enabled
                        {
                            let f = focus();
                            if f.0 == TARGET_HWND.load(SeqCst) && f.1 == TARGET_FOCUS.load(SeqCst) {
                                READY.store(true, SeqCst);
                            }
                        }
                    }
                    "choose" => self.choose(index),
                    "dismiss" => {
                        self.word.dismiss();
                        self.hide();
                    }
                    _ => {}
                }
            }
            Command::Complete {
                session,
                text,
                file_refs,
                reply,
            } => {
                let result = if let Some((s, target, replace)) = self.pending.clone() {
                    if self.pending_invalid || INPUT_SEQ.load(SeqCst) != self.pending_epoch {
                        Err("Место ввода изменилось во время заполнения формы — подстановка отменена".into())
                    } else if s != session {
                        Err("Сессия подстановки устарела".into())
                    } else {
                        self.insert(
                            &target,
                            &replace,
                            &text,
                            &file_refs,
                            true,
                            self.pending_epoch,
                        )
                    }
                } else {
                    Err("Сессия подстановки закрыта".into())
                };
                if result.is_ok() {
                    self.pending = None;
                    *self.app.state::<Runtime>().pending.lock().unwrap() = None;
                    self.reset();
                } else if let Some((_, target, _)) = &self.pending {
                    let _ = activate_form(&self.app, target.hwnd);
                }
                let _ = reply.send(result);
            }
        }
    }
}
trait ReplacementIo {
    fn select_and_verify(&mut self) -> Result<String, String>;
    fn remove_selected(&mut self) -> Result<String, String>;
    fn confirm_removed(&mut self) -> Result<(), String>;
    fn paste(&mut self) -> Result<(), String>;
}
fn replace_verified(io: &mut impl ReplacementIo, word: &str) -> Result<(), String> {
    if io.select_and_verify()? != word {
        return Err("Выделен не весь набранный фрагмент — вставка отменена".into());
    }
    if io.remove_selected()? != word {
        return Err("Не подтверждено удаление команды — вставка отменена".into());
    }
    io.confirm_removed()?;
    io.paste()
}
struct NativeReplacement<'a> {
    target: &'a Target,
    cfg: &'a AppConfig,
    seq: u64,
    word: &'a str,
    text: &'a str,
    paths: &'a [std::path::PathBuf],
    mutation_started: bool,
}
fn native_after_cut(before: &NativeText, after: &NativeText, word: &str) -> bool {
    let length = match before.kind {
        NativeKind::Edit => word.encode_utf16().count(),
        NativeKind::Scintilla => word.len(),
    } as u32;
    before.kind == after.kind
        && before.position.checked_sub(length) == Some(after.position)
        && before.length.checked_sub(length) == Some(after.length)
        && before
            .prefix
            .strip_suffix(word)
            .is_some_and(|left| after.prefix.ends_with(left.trim_start_matches('\u{fffd}')))
}
unsafe fn native_selection_matches(native: &NativeText, hwnd: usize, word: &str) -> bool {
    let Some(start) = native.replacement_start(word) else {
        return false;
    };
    let pair = match native.kind {
        NativeKind::Edit => {
            let (mut a, mut b) = (0u32, 0u32);
            scalar_message(
                hwnd,
                0xb0,
                &mut a as *mut _ as usize,
                &mut b as *mut _ as isize,
            )
            .map(|_| (a, b))
        }
        NativeKind::Scintilla => scalar_message(hwnd, 2009, 0, 0)
            .zip(scalar_message(hwnd, 2008, 0, 0))
            .map(|(a, b)| (a.min(b) as u32, a.max(b) as u32)),
    };
    pair == Some((start, native.position))
}
impl NativeReplacement<'_> {
    unsafe fn check(&self) -> Result<(), String> {
        if insertion_target_unchanged(self.target, self.seq) {
            Ok(())
        } else {
            Err("Место ввода изменилось — вставка отменена".into())
        }
    }
}
impl ReplacementIo for NativeReplacement<'_> {
    fn select_and_verify(&mut self) -> Result<String, String> {
        unsafe {
            self.check()?;
            if let Some(native) = &self.target.native {
                native.select(self.target.focus, self.word)?;
                if !native_selection_matches(native, self.target.focus, self.word) {
                    return Err("Выделение команды не подтверждено — вставка отменена".into());
                }
            } else {
                // UIA Select/GetSelection is not authoritative in Chromium/Qt:
                // it may describe an accessibility range without selecting the
                // actual editor text. Verify keyboard selection through Copy.
                select_verified_fallback(
                    self.target,
                    self.word,
                    &self.cfg.text_suggestions.trigger,
                    self.seq,
                )?;
            }
            Ok(self.word.to_owned())
        }
    }
    fn remove_selected(&mut self) -> Result<String, String> {
        unsafe {
            self.check()?;
            if let Some(native) = &self.target.native {
                if !native_selection_matches(native, self.target.focus, self.word) {
                    return Err("Выделение снято приложением — вставка отменена".into());
                }
                self.mutation_started = true;
                clear_native_selection(native, self.target.focus, self.word)?;
                Ok(self.word.to_owned())
            } else {
                // Recheck the actual editor selection immediately before Cut.
                copy_selection(self.target, self.seq, |before, after, text| {
                    fresh_copy_matches(before, after, text, self.word)
                })?;
                self.check()?;
                self.mutation_started = true;
                clipboard_shortcut(self.target, self.seq, 0x58, |before, after, text| {
                    fresh_copy_matches(before, after, text, self.word)
                })
            }
        }
    }
    fn confirm_removed(&mut self) -> Result<(), String> {
        unsafe {
            self.check()?;
            let Some(original) = &self.target.native else {
                // For editors without a Win32 text adapter, remove_selected
                // already required a fresh exact Cut result. Do not reject a
                // completed Cut because a UIA caret/selection is stale or absent.
                return Ok(());
            };
            let deadline = Instant::now() + Duration::from_millis(700);
            loop {
                self.check()?;
                if native_snapshot(self.target.focus)
                    .is_some_and(|now| native_after_cut(original, &now, self.word))
                {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(
                        "Удаление команды не подтверждено (Win32) — шаблон не вставлен".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    fn paste(&mut self) -> Result<(), String> {
        unsafe {
            self.check()?;
            if self.text.is_empty() {
                crate::rich_clipboard::write_file_list(self.paths)?;
            } else {
                crate::rich_clipboard::write_plain_text(self.text)?;
            }
            self.check()?;
            if let Some(native) = &self.target.native {
                return paste_native(native, self.target.focus);
            }
            let mut inputs = vec![];
            append_paste(&mut inputs);
            inject(&inputs)
        }
    }
}
unsafe fn clear_native_selection(
    native: &NativeText,
    hwnd: usize,
    word: &str,
) -> Result<(), String> {
    if !native_selection_matches(native, hwnd, word) {
        return Err("Выделение снято приложением — вставка отменена".into());
    }
    scalar_message(
        hwnd,
        match native.kind {
            NativeKind::Edit => WM_CLEAR,
            NativeKind::Scintilla => 2180, // SCI_CLEAR
        },
        0,
        0,
    )
    .map(|_| ())
    .ok_or("Приложение не подтвердило удаление команды".into())
}
unsafe fn paste_native(native: &NativeText, hwnd: usize) -> Result<(), String> {
    scalar_message(
        hwnd,
        match native.kind {
            NativeKind::Edit => WM_PASTE,
            NativeKind::Scintilla => 2179, // SCI_PASTE
        },
        0,
        0,
    )
    .map(|_| ())
    .ok_or("Приложение не подтвердило вставку шаблона".into())
}
fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: INJECT_TAG,
            },
        },
    }
}
fn selection_inputs(text: &str) -> Result<Vec<INPUT>, String> {
    if text.is_empty() || text.chars().count() > 128 || !core::backspace_safe(text) {
        return Err("Для этого текста требуется доступный текстовый диапазон".into());
    }
    let mut inputs = vec![key_input(VK_SHIFT, false)];
    for _ in text.chars() {
        inputs.extend([extended_key(VK_LEFT, false), extended_key(VK_LEFT, true)]);
    }
    inputs.push(key_input(VK_SHIFT, true));
    Ok(inputs)
}
fn append_paste(inputs: &mut Vec<INPUT>) {
    inputs.extend([
        key_input(VK_CONTROL, false),
        key_input(0x56, false),
        key_input(0x56, true),
        key_input(VK_CONTROL, true),
    ]);
}
struct ReplacingGuard;
impl ReplacingGuard {
    fn new() -> Self {
        REPLACING.store(true, SeqCst);
        Self
    }
}
struct RestoringGuard;
impl RestoringGuard {
    fn new() -> Self {
        RESTORING.store(true, SeqCst);
        Self
    }
}
impl Drop for RestoringGuard {
    fn drop(&mut self) {
        RESTORING.store(false, SeqCst);
    }
}
impl Drop for ReplacingGuard {
    fn drop(&mut self) {
        REPLACING.store(false, SeqCst);
    }
}
fn extended_key(vk: u16, up: bool) -> INPUT {
    let mut input = key_input(vk, up);
    unsafe {
        input.Anonymous.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }
    input
}
fn fresh_copy_matches(before: u32, after: u32, copied: &str, expected: &str) -> bool {
    after != 0 && after != before && copied == expected
}
unsafe fn insertion_target_unchanged(target: &Target, seq: u64) -> bool {
    let (hwnd, field, _) = focus();
    hwnd == target.hwnd && field == target.focus && INPUT_SEQ.load(SeqCst) == seq
}
fn boundary_fragment(copied: &str, word: &str, trigger: &str) -> Option<bool> {
    if copied == word {
        return Some(false);
    }
    let prefix = copied.strip_suffix(word)?;
    if prefix == "\r\n" {
        return Some(true);
    }
    let mut chars = prefix.chars();
    let first = chars.next()?;
    if chars.next().is_some() || first.is_alphanumeric() || first == '_' || trigger.contains(first)
    {
        return None;
    }
    Some(true)
}
unsafe fn copy_selection(
    target: &Target,
    seq: u64,
    accept: impl Fn(u32, u32, &str) -> bool,
) -> Result<String, String> {
    clipboard_shortcut(target, seq, 0x43, accept)
}
unsafe fn clipboard_shortcut(
    target: &Target,
    seq: u64,
    key: u16,
    accept: impl Fn(u32, u32, &str) -> bool,
) -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    if !insertion_target_unchanged(target, seq) {
        return Err("Место ввода изменилось при проверке выделения".into());
    }
    let before = GetClipboardSequenceNumber();
    let sent = if let Some(native) = &target.native {
        // Pointer-free control commands bypass application hotkey remapping and
        // acknowledge processing, rather than only queuing a keyboard event.
        let message = match (native.kind, key) {
            (NativeKind::Edit, 0x43) => WM_COPY,
            (NativeKind::Edit, 0x58) => WM_CUT,
            (NativeKind::Scintilla, 0x43) => 2178, // SCI_COPY
            (NativeKind::Scintilla, 0x58) => 2177, // SCI_CUT
            _ => return Err("Неизвестная операция с выделением".into()),
        };
        scalar_message(target.focus, message, 0, 0)
            .map(|_| ())
            .ok_or("Приложение не подтвердило операцию с командой".into())
    } else {
        inject(&[
            key_input(VK_CONTROL, false),
            key_input(key, false),
            key_input(key, true),
            key_input(VK_CONTROL, true),
        ])
    };
    if let Err(error) = sent {
        if target.native.is_none() {
            let _ = inject(&[key_input(key, true), key_input(VK_CONTROL, true)]);
        }
        return Err(error);
    }
    let deadline = Instant::now() + Duration::from_millis(700);
    while Instant::now() < deadline {
        if !insertion_target_unchanged(target, seq) {
            return Err("Место ввода изменилось при проверке выделения".into());
        }
        // Do not open the clipboard until the target has published its copy.
        // Polling GetText immediately after SendInput can lock the clipboard
        // while the application's copy/cut handler tries to acquire it.
        if GetClipboardSequenceNumber() != before {
            if let Ok(copied) = crate::snipcast_clipboard_read_text() {
                let after = GetClipboardSequenceNumber();
                if accept(before, after, &copied) {
                    return Ok(copied);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(if key == 0x58 {
        "Результат вырезания не подтверждён — вставка и повтор отменены"
    } else {
        "Не удалось подтвердить выделение команды; исходный текст не удалён"
    }
    .into())
}
unsafe fn select_verified_fallback(
    target: &Target,
    word: &str,
    trigger: &str,
    seq: u64,
) -> Result<(), String> {
    let mut shift_held = false;
    let result = (|| -> Result<(), String> {
        let selection = selection_inputs(word)?;
        shift_held = true;
        for (i, input) in selection.iter().enumerate() {
            if !insertion_target_unchanged(target, seq) {
                return Err("Ввод изменился перед выделением".into());
            }
            inject(std::slice::from_ref(input))?;
            if i > 0 && i % 2 == 0 {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        shift_held = false;
        copy_selection(target, seq, |before, after, copied| {
            fresh_copy_matches(before, after, copied, word)
        })?;
        // Inspect one character before the tracked fragment: an untracked
        // alphanumeric/trigger prefix must never remain after an expansion.
        shift_held = true;
        inject(&[
            key_input(VK_SHIFT, false),
            extended_key(VK_LEFT, false),
            extended_key(VK_LEFT, true),
            key_input(VK_SHIFT, true),
        ])?;
        shift_held = false;
        let candidate = copy_selection(target, seq, |before, after, copied| {
            before != 0 && after != before && copied.ends_with(word)
        })?;
        match boundary_fragment(&candidate, word, trigger) {
            Some(false) => {}
            Some(true) => {
                shift_held = true;
                inject(&[
                    key_input(VK_SHIFT, false),
                    extended_key(VK_RIGHT, false),
                    extended_key(VK_RIGHT, true),
                    key_input(VK_SHIFT, true),
                ])?;
                shift_held = false;
                copy_selection(target, seq, |before, after, copied| {
                    fresh_copy_matches(before, after, copied, word)
                })?;
            }
            None => {
                return Err(
                    "Начало команды не отслежено — подстановка отменена без удаления".into(),
                )
            }
        }
        Ok(())
    })();
    if shift_held {
        let _ = inject(&[key_input(VK_SHIFT, true), extended_key(VK_LEFT, true)]);
    }
    // A partial native copy batch may have stopped before releasing Control.
    if result.is_err() {
        let _ = inject(&[key_input(0x43, true), key_input(VK_CONTROL, true)]);
        if insertion_target_unchanged(target, seq) {
            // Right collapses our failed selection back to its original end.
            let _ = inject(&[extended_key(VK_RIGHT, false), extended_key(VK_RIGHT, true)]);
        }
    }
    result
}
fn inject(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        Err("Windows не приняла всю последовательность вставки; повтор не выполнен".into())
    } else {
        Ok(())
    }
}
fn activate_target(app: &tauri::AppHandle, hwnd: usize, field: usize) -> Result<(), String> {
    let _restoring = RestoringGuard::new();
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = unsafe {
            activate_window_on_ui_thread(hwnd, None).and_then(|_| {
                if field != 0 && focus().1 != field {
                    if IsWindow(field as HWND) == 0
                        || GetAncestor(field as HWND, GA_ROOT) as usize != hwnd
                    {
                        return Err("Исходное поле закрыто".into());
                    }
                    let our_thread = GetCurrentThreadId();
                    let target_thread =
                        GetWindowThreadProcessId(field as HWND, std::ptr::null_mut());
                    let attached = our_thread != target_thread
                        && AttachThreadInput(our_thread, target_thread, 1) != 0;
                    SetFocus(field as HWND);
                    if attached {
                        AttachThreadInput(our_thread, target_thread, 0);
                    }
                }
                Ok(())
            })
        };
        let _ = tx.send(result);
    })
    .map_err(|_| "Не удалось обратиться к окну приложения")?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Возврат фокуса не завершён")?
}
fn activate_form(app: &tauri::AppHandle, source: usize) -> Result<(), String> {
    let app_handle = app.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let window = app_handle
                .get_webview_window(LABEL)
                .ok_or("Быстрая палитра закрыта")?;
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
            unsafe {
                let (current, _, pid) = focus();
                if current != source && pid != std::process::id() {
                    return Err("Целевое окно изменилось".into());
                }
                if FORM_ACTIVE.load(SeqCst) && current == hwnd as usize {
                    return Ok(());
                }
                FORM_ACTIVE.store(true, SeqCst);
                window.set_focusable(true).map_err(|e| e.to_string())?;
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !(WS_EX_NOACTIVATE as isize));
                let _ = window.show();
                activate_window_on_ui_thread(hwnd as usize, Some(source))?;
                window.set_focus().map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|_| "Не удалось открыть поля шаблона")?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Открытие полей не завершено")?
}
unsafe fn activate_window_on_ui_thread(hwnd: usize, source: Option<usize>) -> Result<(), String> {
    let mut msg: MSG = std::mem::zeroed();
    PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
    for _ in 0..3 {
        let (current, _, pid) = focus();
        if current == hwnd {
            return Ok(());
        }
        if pid != std::process::id() && source != Some(current) {
            return Err("Целевое окно изменилось".into());
        }
        let our_thread = GetCurrentThreadId();
        let foreground_thread = GetWindowThreadProcessId(current as HWND, std::ptr::null_mut());
        let attached = our_thread != foreground_thread
            && AttachThreadInput(our_thread, foreground_thread, 1) != 0;
        let target_thread = GetWindowThreadProcessId(hwnd as HWND, std::ptr::null_mut());
        let target_attached = target_thread != our_thread
            && target_thread != foreground_thread
            && AttachThreadInput(our_thread, target_thread, 1) != 0;
        SetForegroundWindow(hwnd as HWND);
        if target_attached {
            AttachThreadInput(our_thread, target_thread, 0);
        }
        if attached {
            AttachThreadInput(our_thread, foreground_thread, 0);
        }
        std::thread::sleep(Duration::from_millis(40));
        if GetForegroundWindow() as usize == hwnd {
            return Ok(());
        }
    }
    Err("Не удалось вернуть фокус в исходное окно".into())
}
fn worker(app: tauri::AppHandle, cfg: AppConfig, rx: mpsc::Receiver<Command>) {
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        let Ok(uia) =
            CoCreateInstance::<_, IUIAutomation>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        else {
            return;
        };
        if let Ok(t) = uia.cast::<IUIAutomation2>() {
            let _ = t.SetConnectionTimeout(200);
            let _ = t.SetTransactionTimeout(200);
        }
        let mut c = Controller {
            app,
            cfg,
            uia,
            index: vec![],
            vars: Default::default(),
            word: Word::default(),
            target: None,
            hits: vec![],
            selected: 0,
            session: 0,
            seq: 0,
            dirty: false,
            confirm: None,
            recover: false,
            ime_active: false,
            unconfirmed: None,
            pending: None,
            pending_invalid: false,
            pending_epoch: 0,
            popup_position: None,
            last_files: vec![],
        };
        ENABLED.store(c.cfg.text_suggestions.enabled, SeqCst);
        c.reload();
        c.last_files = c.files();
        let mut poll = Instant::now();
        loop {
            if LOST.swap(false, SeqCst) {
                c.reset();
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(cmd) => c.command(cmd),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if c.recover {
                        c.recover_word();
                    }
                    if c.dirty {
                        c.publish();
                    }
                    if c.pending.is_none() && !c.hits.is_empty() && c.seq == INPUT_SEQ.load(SeqCst)
                    {
                        let revision = c.seq;
                        let fresh = Target::inspect(&c.uia, &c.cfg).ok();
                        let valid = fresh.as_ref().is_some_and(|f| {
                            c.target.as_ref().is_some_and(|t| {
                                t.same_field(f, &c.uia)
                                    && f.suffix(&c.word.text, &c.cfg.text_suggestions.trigger)
                                    && match (&t.native, &f.native) {
                                        (Some(a), Some(b)) => {
                                            a.position == b.position && a.prefix == b.prefix
                                        }
                                        _ => match (&t.caret, &f.caret) {
                                            (Some(a), Some(b)) => {
                                                a.CompareEndpoints(
                                                    TextPatternRangeEndpoint_End,
                                                    b,
                                                    TextPatternRangeEndpoint_End,
                                                )
                                                .ok()
                                                    == Some(0)
                                            }
                                            _ => t.anchor == f.anchor,
                                        },
                                    }
                            })
                        });
                        if !valid && revision == INPUT_SEQ.load(SeqCst) {
                            c.reset();
                            c.word.dismiss();
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if poll.elapsed() > Duration::from_secs(2) && c.pending.is_none() {
                poll = Instant::now();
                let files = c.files();
                if files != c.last_files {
                    c.last_files = files;
                    c.reload();
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_clipboard_uses_real_native_delete_and_paste() {
        const CHILD: &str = "SNIPCAST_CLIPBOARD_REGRESSION_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "suggestions_windows::tests::isolated_clipboard_uses_real_native_delete_and_paste", "--nocapture"])
                .env(CHILD, "1").output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        // A child process owns an unnamed window station and desktop, including
        // its clipboard. No SwitchDesktop, input injection or user focus access.
        #[link(name = "user32")]
        extern "system" {
            fn CreateWindowStationW(
                name: *const u16,
                flags: u32,
                access: u32,
                sa: *const std::ffi::c_void,
            ) -> HANDLE;
            fn GetProcessWindowStation() -> HANDLE;
            fn SetProcessWindowStation(station: HANDLE) -> i32;
            fn CreateDesktopW(
                name: *const u16,
                device: *const u16,
                mode: *const std::ffi::c_void,
                flags: u32,
                access: u32,
                sa: *const std::ffi::c_void,
            ) -> HANDLE;
            fn GetThreadDesktop(tid: u32) -> HANDLE;
            fn SetThreadDesktop(desktop: HANDLE) -> i32;
            fn CloseDesktop(desktop: HANDLE) -> i32;
            fn CloseWindowStation(station: HANDLE) -> i32;
        }
        unsafe {
            let original_station = GetProcessWindowStation();
            let original_desktop = GetThreadDesktop(GetCurrentThreadId());
            let station = CreateWindowStationW(std::ptr::null(), 0, 0xf037f, std::ptr::null());
            assert!(!station.is_null());
            assert_ne!(SetProcessWindowStation(station), 0);
            let name: Vec<_> = "SnipcastClipboardQA\0".encode_utf16().collect();
            let desktop = CreateDesktopW(
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                0xf01ff,
                std::ptr::null(),
            );
            assert!(!desktop.is_null());
            assert_ne!(SetThreadDesktop(desktop), 0);
            assert!(GetForegroundWindow().is_null());
            for _ in 0..20 {
                for (word, body) in [
                    ("=почта", "Ответ"),
                    ("/+/почта", "Анна\r\nМосква"),
                    ("𐐀тест", "🙂 готово"),
                ] {
                    let edit = HiddenReplacement::new("До ", word, " после", body);
                    edit.original.select(edit.hwnd as usize, word).unwrap();
                    clear_native_selection(&edit.original, edit.hwnd as usize, word).unwrap();
                    assert!(native_after_cut(
                        &edit.original,
                        &native_snapshot(edit.hwnd as usize).unwrap(),
                        word
                    ));
                    crate::rich_clipboard::write_plain_text(body).unwrap();
                    paste_native(&edit.original, edit.hwnd as usize).unwrap();
                    assert_eq!(edit.text(), format!("До {body} после"));
                }
            }
            let lost = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
            assert!(clear_native_selection(&lost.original, lost.hwnd as usize, "=почта").is_err());
            assert_eq!(lost.text(), "До =почта после");
            drop(lost);
            assert_ne!(SetThreadDesktop(original_desktop), 0);
            assert_ne!(SetProcessWindowStation(original_station), 0);
            assert_ne!(CloseDesktop(desktop), 0);
            assert_ne!(CloseWindowStation(station), 0);
        }
    }
    #[test]
    fn tracked_suffix_is_reconciled_to_the_entire_actual_word() {
        assert_eq!(
            whole_fragment("Привет =вписка", true, "писка", "="),
            Some("=вписка".into())
        );
        assert_eq!(
            whole_fragment("=вписка", true, "вписка", "="),
            Some("=вписка".into())
        );
        assert_eq!(
            whole_fragment("Слово вписка", false, "писка", "="),
            Some("вписка".into())
        );
        assert_eq!(whole_fragment("писка", false, "писка", "="), None);
        assert_eq!(whole_fragment("вписка", true, "другое", "="), None);
        assert_eq!(whole_fragment(&"а".repeat(129), true, "ааа", "="), None);
        assert_eq!(
            whole_fragment("Текст /+/почта", true, "почта", "/+/"),
            Some("/+/почта".into())
        );
    }
    #[test]
    fn cut_proof_checks_exact_length_position_and_surviving_context() {
        let old = NativeText {
            kind: NativeKind::Edit,
            position: 10,
            length: 16,
            prefix: "До =вписка".into(),
        };
        let new = NativeText {
            kind: NativeKind::Edit,
            position: 3,
            length: 9,
            prefix: "До ".into(),
        };
        assert!(native_after_cut(&old, &new, "=вписка"));
        assert!(!native_after_cut(
            &old,
            &NativeText {
                length: old.length,
                ..new.clone()
            },
            "=вписка"
        ));
        assert!(!native_after_cut(
            &old,
            &NativeText {
                position: 4,
                ..new.clone()
            },
            "=вписка"
        ));
        assert!(!native_after_cut(
            &old,
            &NativeText {
                prefix: "Да ".into(),
                ..new.clone()
            },
            "=вписка"
        ));
        let bytes = NativeText {
            kind: NativeKind::Scintilla,
            position: 18,
            length: 24,
            prefix: "До =вписка".into(),
        };
        let after = NativeText {
            kind: NativeKind::Scintilla,
            position: 5,
            length: 11,
            prefix: "До ".into(),
        };
        assert!(native_after_cut(&bytes, &after, "=вписка"));
    }
    // Uses a real, hidden EDIT control and the production transaction/proofs.
    // Clipboard transport is local to the fixture: no host clipboard, hooks,
    // SendInput or focus changes. Faults reproduce clipboard-induced selection
    // loss and delayed/ignored/partial deletion before a paste.
    struct HiddenReplacement {
        hwnd: HWND,
        original: NativeText,
        word: String,
        body: String,
        wrong_selection: bool,
        copy_loses_selection: bool,
        cut_mode: u8,
        paste_calls: usize,
        cut_calls: usize,
        polls: usize,
        target_changed: bool,
    }
    impl HiddenReplacement {
        unsafe fn new(prefix: &str, word: &str, suffix: &str, body: &str) -> Self {
            let text: Vec<u16> = format!("{prefix}{word}{suffix}\0").encode_utf16().collect();
            let class: Vec<u16> = "EDIT\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                text.as_ptr(),
                WS_POPUP | 0x4,
                0,
                0,
                400,
                200,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            let end = (prefix.encode_utf16().count() + word.encode_utf16().count()) as usize;
            scalar_message(hwnd as usize, 0xb1, end, end as isize).unwrap();
            let original = native_snapshot(hwnd as usize).unwrap();
            Self {
                hwnd,
                original,
                word: word.into(),
                body: body.into(),
                wrong_selection: false,
                copy_loses_selection: false,
                cut_mode: 0,
                paste_calls: 0,
                cut_calls: 0,
                polls: 0,
                target_changed: false,
            }
        }
        unsafe fn text(&self) -> String {
            let len = scalar_message(self.hwnd as usize, WM_GETTEXTLENGTH, 0, 0).unwrap();
            let mut buf = vec![0u16; len + 1];
            scalar_message(
                self.hwnd as usize,
                WM_GETTEXT,
                buf.len(),
                buf.as_mut_ptr() as isize,
            )
            .unwrap();
            String::from_utf16_lossy(&buf[..len])
        }
        unsafe fn selected(&self) -> String {
            let (mut a, mut b) = (0u32, 0u32);
            scalar_message(
                self.hwnd as usize,
                0xb0,
                &mut a as *mut _ as usize,
                &mut b as *mut _ as isize,
            )
            .unwrap();
            let text: Vec<u16> = self.text().encode_utf16().collect();
            String::from_utf16_lossy(&text[a as usize..b as usize])
        }
        unsafe fn replace(&self, text: &str) {
            let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            scalar_message(self.hwnd as usize, 0xc2, 1, text.as_ptr() as isize).unwrap();
        }
    }
    impl Drop for HiddenReplacement {
        fn drop(&mut self) {
            unsafe {
                assert_eq!(IsWindowVisible(self.hwnd), 0);
                DestroyWindow(self.hwnd);
            }
        }
    }
    impl ReplacementIo for HiddenReplacement {
        fn select_and_verify(&mut self) -> Result<String, String> {
            unsafe {
                self.original.select(self.hwnd as usize, &self.word)?;
                if self.wrong_selection {
                    let start = self.original.replacement_start(&self.word).unwrap() + 1;
                    scalar_message(
                        self.hwnd as usize,
                        0xb1,
                        start as usize,
                        self.original.position as isize,
                    )
                    .unwrap();
                }
                let text = self.selected();
                if self.copy_loses_selection {
                    scalar_message(
                        self.hwnd as usize,
                        0xb1,
                        self.original.position as usize,
                        self.original.position as isize,
                    )
                    .unwrap();
                }
                Ok(text)
            }
        }
        fn remove_selected(&mut self) -> Result<String, String> {
            unsafe {
                if !native_selection_matches(&self.original, self.hwnd as usize, &self.word) {
                    return Err("Selection lost".into());
                }
                self.cut_calls += 1;
                let selected = self.selected();
                match self.cut_mode {
                    0 => self.replace(""),
                    3 => {
                        let start = self.original.replacement_start(&self.word).unwrap();
                        scalar_message(
                            self.hwnd as usize,
                            0xb1,
                            start as usize,
                            (start + 1) as isize,
                        )
                        .unwrap();
                        self.replace("");
                    }
                    _ => {}
                }
                Ok(selected)
            }
        }
        fn confirm_removed(&mut self) -> Result<(), String> {
            unsafe {
                for _ in 0..4 {
                    self.polls += 1;
                    if self.cut_mode == 2 && self.polls == 3 {
                        self.replace("");
                    }
                    if native_snapshot(self.hwnd as usize)
                        .is_some_and(|now| native_after_cut(&self.original, &now, &self.word))
                    {
                        return Ok(());
                    }
                }
                Err("Deletion not confirmed".into())
            }
        }
        fn paste(&mut self) -> Result<(), String> {
            unsafe {
                if self.target_changed {
                    return Err("Target changed".into());
                }
                self.paste_calls += 1;
                // An app reacting to the clipboard write can collapse selection.
                // Cutting first makes this harmless instead of leaving the command.
                let position = native_snapshot(self.hwnd as usize).unwrap().position;
                scalar_message(
                    self.hwnd as usize,
                    0xb1,
                    position as usize,
                    position as isize,
                )
                .unwrap();
                self.replace(&self.body);
                Ok(())
            }
        }
    }
    #[test]
    fn hidden_edit_reproduces_old_residue_and_verifies_replacement_without_foreground() {
        unsafe {
            let mut old = HiddenReplacement::new("До ", "=почта", " после", "Готовый ответ");
            old.select_and_verify().unwrap();
            // Simulate a clipboard listener/provider clearing selection before Ctrl+V.
            scalar_message(
                old.hwnd as usize,
                0xb1,
                old.original.position as usize,
                old.original.position as isize,
            )
            .unwrap();
            old.replace("Готовый ответ");
            assert_eq!(old.text(), "До =почтаГотовый ответ после");
            for _ in 0..20 {
                for (word, body) in [
                    ("=почта", "Готовый ответ"),
                    ("/+/почта", "Анна\r\nМосква"),
                    ("hello", ""),
                    ("𐐀тест", "Ответ 🙂"),
                ] {
                    let mut new = HiddenReplacement::new("До ", word, " после", body);
                    replace_verified(&mut new, word).unwrap();
                    assert_eq!(new.text(), format!("До {body} после"));
                    assert_eq!((new.cut_calls, new.paste_calls), (1, 1));
                }
            }
        }
    }
    #[test]
    fn replacement_aborts_on_partial_selection_or_missing_deletion_without_pasting() {
        unsafe {
            let mut wrong = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
            wrong.wrong_selection = true;
            assert!(replace_verified(&mut wrong, "=почта").is_err());
            assert_eq!((wrong.cut_calls, wrong.paste_calls), (0, 0));
            assert_eq!(wrong.text(), "До =почта после");
            let mut lost = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
            lost.copy_loses_selection = true;
            assert!(replace_verified(&mut lost, "=почта").is_err());
            assert_eq!((lost.cut_calls, lost.paste_calls), (0, 0));
            for cut_mode in [1, 3] {
                let mut ignored = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
                ignored.cut_mode = cut_mode;
                assert!(replace_verified(&mut ignored, "=почта").is_err());
                assert_eq!(ignored.paste_calls, 0);
            }
        }
    }
    #[test]
    fn replacement_waits_for_deletion_and_checks_context_again_before_paste() {
        unsafe {
            let mut slow = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
            slow.cut_mode = 2;
            replace_verified(&mut slow, "=почта").unwrap();
            assert_eq!(slow.polls, 3);
            assert_eq!(slow.text(), "До Ответ после");
            let mut changed = HiddenReplacement::new("До ", "=почта", " после", "Ответ");
            changed.target_changed = true;
            assert!(replace_verified(&mut changed, "=почта").is_err());
            assert_eq!(changed.paste_calls, 0);
        }
    }
    #[test]
    fn first_enter_is_accepted_while_visible_query_ack_is_pending() {
        assert!(consume_visible_key(13, false, false, 0, false, true));
        assert!(!consume_visible_key(13, false, false, 0, false, false));
        assert!(!consume_visible_key(13, true, false, 0, true, true));
        assert!(!consume_visible_key(13, false, false, 1, true, true));
        assert!(!consume_visible_key(0x28, false, false, 0, false, true));
    }
    #[test]
    fn unreadable_field_copy_must_be_fresh_and_exact() {
        assert!(fresh_copy_matches(20, 21, "/вписка", "/вписка"));
        assert!(fresh_copy_matches(0, 1, "/вписка", "/вписка"));
        assert!(!fresh_copy_matches(20, 20, "/вписка", "/вписка"));
        assert!(!fresh_copy_matches(20, 21, "писка", "/вписка"));
        assert!(!fresh_copy_matches(0, 0, "/вписка", "/вписка"));
        assert_eq!(boundary_fragment("вписка", "писка", "/"), None);
        assert_eq!(boundary_fragment("/вписка", "вписка", "/"), None);
        assert_eq!(boundary_fragment("вписка", "вписка", "/"), Some(false));
        assert_eq!(boundary_fragment(" вписка", "вписка", "/"), Some(true));
        assert_eq!(boundary_fragment("\r\nвписка", "вписка", "/"), Some(true));

        let inputs = selection_inputs("/вписка").unwrap();
        let left: Vec<_> = inputs
            .iter()
            .filter(|input| unsafe { input.Anonymous.ki.wVk == VK_LEFT })
            .collect();
        assert_eq!(left.len(), 14);
        assert!(left
            .iter()
            .all(|input| unsafe { input.Anonymous.ki.dwFlags & KEYEVENTF_EXTENDEDKEY != 0 }));
        assert!(inputs
            .iter()
            .all(|input| unsafe { input.Anonymous.ki.wVk != VK_BACK }));
    }
    #[test]
    fn unknown_caret_centers_and_form_uses_the_whole_monitor() {
        let work = Rect {
            x: -1920,
            y: 0,
            w: 1920,
            h: 1040,
        };
        let field = Some(Rect {
            x: -1900,
            y: 1000,
            w: 1800,
            h: 800,
        });
        assert_eq!(place(None, field, work, 360, 162), (-1140, 439, "center"));
        assert_eq!(
            form_bounds((-1100, 900), work, 360, 384, false),
            (-1100, 656, 384)
        );
        assert_eq!(
            form_bounds((-1100, 900), work, 360, 384, true),
            (-1140, 328, 384)
        );
        assert_eq!(quick_form_height("[a][b][c][d]", 2), 344);
    }
    #[test]
    fn popup_origin_stays_fixed_until_hidden() {
        let work = Rect {
            x: -1600,
            y: 0,
            w: 1600,
            h: 900,
        };
        let a = Rect {
            x: -700,
            y: 400,
            w: 2,
            h: 20,
        };
        let mut saved = None;
        let initial = pinned_position(&mut saved, Some(a), None, work, 360, 162, 1.5);
        let moved = Rect {
            x: -400,
            y: 650,
            ..a
        };
        assert_eq!(
            initial,
            pinned_position(&mut saved, Some(moved), None, work, 540, 400, 2.)
        );
        saved = None;
        assert_ne!(
            initial,
            pinned_position(&mut saved, Some(moved), None, work, 360, 162, 1.)
        );
    }
    #[test]
    fn continuous_fallback_is_limited_to_max_text_targets() {
        assert!(max_continuous_field(
            "max.exe",
            "MeWindow_QMLTYPE_2005",
            true,
            false
        ));
        assert!(max_continuous_field("max.exe", "TextEdit", false, true));
        assert!(!max_continuous_field(
            "other.exe",
            "MeWindow_QMLTYPE_2005",
            true,
            false
        ));
        assert!(!max_continuous_field(
            "max.exe",
            "SendPanelButton",
            false,
            false
        ));
    }
    #[test]
    fn native_offsets_distinguish_utf16_and_scintilla_bytes() {
        assert_eq!(quick_form_height("[Имя] [Имя]", 6), 244);
        assert_eq!(quick_form_height("[\"file.pdf\"]", 6), 206);
        let prefix = "prefix /прив".to_owned();
        let edit = NativeText {
            kind: NativeKind::Edit,
            position: prefix.encode_utf16().count() as u32,
            length: prefix.encode_utf16().count() as u32,
            prefix: prefix.clone(),
        };
        let scintilla = NativeText {
            kind: NativeKind::Scintilla,
            position: prefix.len() as u32,
            length: prefix.len() as u32,
            prefix,
        };
        assert_eq!(edit.replacement_start("/прив"), Some(7));
        assert_eq!(scintilla.replacement_start("/прив"), Some(7));
        assert_eq!(edit.replacement_start("/другое"), None);
    }
    #[test]
    fn hidden_edit_and_native_rounding_need_no_foreground() {
        unsafe {
            let previous = GetForegroundWindow();
            let class: Vec<u16> = "EDIT\0".encode_utf16().collect();
            let text: Vec<u16> = "prefix /прив\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                text.as_ptr(),
                WS_POPUP,
                0,
                0,
                360,
                162,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            scalar_message(hwnd as usize, 0xb1, 12, 12).unwrap();
            let snapshot = native_snapshot(hwnd as usize).unwrap();
            assert_eq!(snapshot.prefix, "prefix /прив");
            snapshot.select(hwnd as usize, "/прив").unwrap();
            let mut start = 0u32;
            let mut end = 0u32;
            scalar_message(
                hwnd as usize,
                0xb0,
                &mut start as *mut _ as usize,
                &mut end as *mut _ as isize,
            )
            .unwrap();
            assert_eq!((start, end), (7, 12));
            assert!(native_snapshot(hwnd as usize).is_none());
            for scale in [1., 1.5, 2.] {
                apply_popup_frame(
                    hwnd,
                    (360.0_f64 * scale).round() as i32,
                    (162.0_f64 * scale).round() as i32,
                    scale,
                );
                let region = CreateRectRgn(0, 0, 0, 0);
                assert_ne!(GetWindowRgn(hwnd, region), 0);
                assert_eq!(PtInRegion(region, 0, 0), 0);
                assert_ne!(PtInRegion(region, (12.0_f64 * scale).round() as i32, 1), 0);
                DeleteObject(region);
            }
            assert_eq!(GetForegroundWindow(), previous);
            assert_eq!(IsWindowVisible(hwnd), 0);
            DestroyWindow(hwnd);
        }
    }
    #[test]
    fn released_modifier_does_not_keep_startup_alias_held() {
        let keys = [
            0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c,
        ];
        let saved: Vec<_> = keys.iter().map(|i| HELD[*i].swap(false, SeqCst)).collect();
        HELD[0x11].store(true, SeqCst);
        assert_eq!(mods(), 0);
        HELD[0xa2].store(true, SeqCst);
        assert_eq!(mods(), 1);
        HELD[0xa2].store(false, SeqCst);
        assert_eq!(mods(), 0);
        for (key, value) in keys.into_iter().zip(saved) {
            HELD[key].store(value, SeqCst);
        }
    }
    #[test]
    fn placement_respects_edges_and_negative_monitors() {
        let work = Rect {
            x: -1920,
            y: 0,
            w: 1920,
            h: 1080,
        };
        let (x, y, p) = place(
            Some(Rect {
                x: -5,
                y: 10,
                w: 1,
                h: 20,
            }),
            None,
            work,
            360,
            318,
        );
        assert_eq!((x, y, p), (-360, 38, "caret"));
        let (x, y, p) = place(None, None, work, 360, 318);
        assert_eq!((x, y, p), (-1140, 381, "center"));
    }
    #[test]
    fn insertion_is_tagged_and_bounded() {
        let mut batch = selection_inputs("/прив").unwrap();
        append_paste(&mut batch);
        assert_eq!(batch.len(), 16);
        assert!(batch
            .iter()
            .all(|x| unsafe { x.Anonymous.ki.dwExtraInfo == INJECT_TAG }));
        assert!(selection_inputs("🙂").is_err());
    }
}
