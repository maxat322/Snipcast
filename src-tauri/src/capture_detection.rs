//! Bounded, per-capture geometry snapshot. Never queries providers from pointer events.
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: u32,
    pub parent: Option<u32>,
    pub kind: &'static str,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub window_order: u32,
    pub depth: u32,
}

#[derive(Clone, Serialize)]
pub struct ScreenPoint { pub x: i32, pub y: i32 }

#[derive(Default)]
pub struct Snapshot {
    pub candidates: Vec<Candidate>,
    pub cursor: Option<ScreenPoint>,
}

pub fn receive_batches<T>(rx: std::sync::mpsc::Receiver<T>, mut publish: impl FnMut(Vec<T>)) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut batch = Vec::new();
    let mut next_flush = Instant::now() + Duration::from_millis(32);
    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        match rx.recv_timeout(remaining.min(next_flush.saturating_duration_since(Instant::now()))) {
            Ok(value) => batch.push(value),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= next_flush {
            if !batch.is_empty() { publish(std::mem::take(&mut batch)); }
            next_flush = Instant::now() + Duration::from_millis(32);
        }
    }
    if !batch.is_empty() { publish(batch); }
}

#[cfg(not(target_os = "windows"))]
pub fn collect() -> (Snapshot, std::sync::mpsc::Receiver<Candidate>) {
    let (_, rx) = std::sync::mpsc::channel();
    (Snapshot::default(), rx)
}

#[cfg(target_os = "windows")]
pub fn collect() -> (Snapshot, std::sync::mpsc::Receiver<Candidate>) {
    use std::sync::{atomic::{AtomicBool, Ordering}, mpsc};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::{Foundation::{HWND, LPARAM, POINT, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{EnumWindows, GetCursorPos, GetWindowRect, GetWindowThreadProcessId, GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT, IsIconic, IsWindowVisible}};

    // A hung third-party provider must not accumulate a new thread on every capture.
    static WORKING: AtomicBool = AtomicBool::new(false);
    struct Windows { items: Vec<(usize, Candidate)> }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
        let out = &mut *(data as *mut Windows);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || pid == std::process::id()
            || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT != 0 { return 1; }
        let mut cloaked: u32 = 0;
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked as *mut _ as _, 4);
        if cloaked != 0 { return 1; }
        let mut r: RECT = std::mem::zeroed();
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut _ as _, std::mem::size_of::<RECT>() as u32) < 0 {
            if GetWindowRect(hwnd, &mut r) == 0 { return 1; }
        }
        if r.right-r.left <= 16 || r.bottom-r.top <= 16 { return 1; }
        let order = out.items.len() as u32;
        out.items.push((hwnd as usize, Candidate { id: order + 1, parent: None, kind: "window",
            x: r.left, y: r.top, width: r.right-r.left, height: r.bottom-r.top, window_order: order, depth: 0 }));
        1
    }
    let mut windows = Windows { items: Vec::new() };
    let mut point: POINT = unsafe { std::mem::zeroed() };
    let cursor = unsafe { (GetCursorPos(&mut point) != 0).then_some(ScreenPoint { x: point.x, y: point.y }) };
    unsafe { EnumWindows(Some(visit), &mut windows as *mut _ as LPARAM); }
    let snapshot = Snapshot { candidates: windows.items.iter().map(|(_, c)| c.clone()).collect(), cursor };
    let (tx, rx) = mpsc::channel();
    if WORKING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() { return (snapshot, rx); }
    let deadline = Instant::now() + Duration::from_millis(500);
    std::thread::spawn(move || {
        struct Guard;
        impl Drop for Guard { fn drop(&mut self) { WORKING.store(false, Ordering::Release); } }
        let _guard = Guard;
        unsafe {
            use windows::Win32::{Foundation::HWND, System::Com::{CoInitializeEx, CoUninitialize, CoCreateInstance, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER},
                UI::Accessibility::{CUIAutomation, IUIAutomation}};
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return; }
            struct ComGuard;
            impl Drop for ComGuard { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
            let _com = ComGuard;
            let Ok(uia): Result<IUIAutomation, _> = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return; };
            let Ok(walker) = uia.ControlViewWalker() else { return; };
            let mut id = windows.items.len() as u32 + 1;
            // Breadth first across windows: a large document cannot starve other panes.
            let mut queue = std::collections::VecDeque::new();
            for (handle, win) in &windows.items {
                if Instant::now() >= deadline { return; }
                if let Ok(root) = uia.ElementFromHandle(HWND(*handle as _)) {
                    queue.push_back((root, win.id, win.clone(), 1));
                }
            }
            let mut visited = 0;
            while let Some((parent, parent_id, win, depth)) = queue.pop_front() {
                if Instant::now() >= deadline || visited >= 6000 { break; }
                let mut child = walker.GetFirstChildElement(&parent).ok();
                while let Some(el) = child {
                    if Instant::now() >= deadline || visited >= 6000 { return; }
                    visited += 1;
                    let mut next_parent = parent_id;
                    if !el.CurrentIsOffscreen().unwrap_or(windows::core::BOOL(1)).as_bool() {
                        if let Ok(r) = el.CurrentBoundingRectangle() {
                            let x = r.left.max(win.x); let y = r.top.max(win.y);
                            let right = r.right.min(win.x + win.width); let bottom = r.bottom.min(win.y + win.height);
                            if right > x && bottom > y {
                                next_parent = id; id += 1;
                                if tx.send(Candidate { id: next_parent, parent: Some(parent_id), kind: "element", x, y,
                                    width: right-x, height: bottom-y, window_order: win.window_order, depth }).is_err() { return; }
                            }
                        }
                        if depth < 24 { queue.push_back((el.clone(), next_parent, win.clone(), depth+1)); }
                    }
                    child = walker.GetNextSiblingElement(&el).ok();
                }
            }
        }
    });
    (snapshot, rx)
}

#[cfg(test)]
mod tests {
    use super::receive_batches;
    use std::{sync::mpsc, time::{Duration, Instant}};

    #[test]
    #[cfg(target_os = "windows")]
    fn initial_snapshot_does_not_wait_for_element_discovery() {
        let started = Instant::now();
        let (_snapshot, receiver) = super::collect();
        let elapsed = started.elapsed();
        drop(receiver);
        println!("Initial detection snapshot: {} ms", elapsed.as_millis());
        assert!(elapsed < Duration::from_millis(250), "UIA discovery delayed initial snapshot: {elapsed:?}");
    }

    #[test]
    fn stalled_provider_preserves_partial_results_and_returns_by_deadline() {
        let (tx, rx) = mpsc::channel();
        tx.send(7).unwrap();
        let started = Instant::now();
        let mut results = vec![1]; // Window fallback already available.
        receive_batches(rx, |batch| results.extend(batch));
        assert_eq!(results, vec![1, 7]);
        assert!(started.elapsed() < Duration::from_millis(750));
        drop(tx);
    }

    #[test]
    fn disconnected_provider_keeps_window_fallback() {
        let (tx, rx) = mpsc::channel::<u32>();
        drop(tx);
        let mut results = vec![1];
        receive_batches(rx, |batch| results.extend(batch));
        assert_eq!(results, vec![1]);
    }
}
