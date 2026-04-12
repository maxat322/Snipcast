//! Цель вставки: последнее «чужое» приложение.
//! macOS: активация через AppKit (`NSRunningApplication`) + вставка через Quartz (`CGEventPostToPid`),
//! без `keystroke` в AppleScript (он часто ломается). Запасная активация — короткий osascript.
//! Windows: enigo.

use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct PasteTarget {
    #[cfg(target_os = "macos")]
    pub macos_pid: Option<i32>,
    #[cfg(target_os = "windows")]
    pub win_hwnd: Option<isize>,
}

/// macOS: если сейчас в фокусе не Snipcast — запоминаем PID; иначе берём последний сохранённый PID.
#[cfg(target_os = "macos")]
pub fn sync_macos_paste_target(last_foreign: &Mutex<Option<i32>>, target: &Mutex<PasteTarget>) {
    let ours = std::process::id() as i32;
    let front = macos::frontmost_pid();
    let Ok(mut lf) = last_foreign.lock() else {
        return;
    };
    let Ok(mut tg) = target.lock() else {
        return;
    };
    match front {
        Some(p) if p != ours => {
            *lf = Some(p);
            tg.macos_pid = Some(p);
        }
        _ => {
            tg.macos_pid = *lf;
        }
    }
}

#[cfg(target_os = "windows")]
pub fn capture_target_windows() -> PasteTarget {
    let mut t = PasteTarget::default();
    t.win_hwnd = win::foreground_hwnd_if_other_process();
    t
}

pub fn paste_into_previous(target: &PasteTarget) {
    #[cfg(target_os = "macos")]
    {
        let ours = std::process::id() as i32;
        // После hide палитры снова в фокусе должен оказаться редактор; надёжнее взять
        // свежий frontmost, чем только снимок с момента открытия палитры.
        let pid = match macos::frontmost_pid() {
            Some(p) if p != ours => Some(p),
            _ => target.macos_pid,
        };
        if let Some(pid) = pid {
            let _ = macos::activate_and_post_cmd_v(pid);
        } else {
            eprintln!("[snipcast] macos_pid отсутствует — не удалось определить приложение для вставки");
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = target.win_hwnd {
        let _ = win::activate_and_paste_ctrl_v(hwnd);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;
    use std::time::Duration;

    use core_graphics::event::{CGEvent, CGEventFlags, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    pub fn frontmost_pid() -> Option<i32> {
        let output = Command::new("osascript")
            .args([
                "-e",
                r#"tell application "System Events" to unix id of first application process whose frontmost is true"#,
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout).trim().parse().ok()
    }

    fn activate_via_appkit(pid: i32) -> bool {
        let Some(app) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t)
        else {
            return false;
        };
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    }

    /// Только поднять окно цели (без keystroke) — если AppKit не смог.
    fn activate_via_osascript(pid: i32) -> Result<(), String> {
        let script = format!(
            r#"tell application "System Events" to tell (first application process whose unix id is {pid}) to set frontmost to true"#
        );
        let output = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            eprintln!("[snipcast] osascript (activate) stderr: {err}");
            Err("не удалось активировать целевое приложение (Доступность / Автоматизация)".into())
        }
    }

    fn post_cmd_v_to_pid(pid: i32) -> Result<(), String> {
        let src_d = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| {
            "CGEventSource: нужны права «Универсальный доступ» для синтеза клавиш".to_string()
        })?;
        let src_u = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| {
            "CGEventSource: нужны права «Универсальный доступ» для синтеза клавиш".to_string()
        })?;

        let flags = CGEventFlags::CGEventFlagCommand;
        let down = CGEvent::new_keyboard_event(src_d, KeyCode::ANSI_V, true)
            .map_err(|_| "CGEvent keydown".to_string())?;
        down.set_flags(flags);
        down.post_to_pid(pid as libc::pid_t);

        let up = CGEvent::new_keyboard_event(src_u, KeyCode::ANSI_V, false)
            .map_err(|_| "CGEvent keyup".to_string())?;
        up.set_flags(flags);
        up.post_to_pid(pid as libc::pid_t);

        Ok(())
    }

    /// Активировать цель, затем Cmd+V через Quartz в очередь процесса `pid`.
    pub fn activate_and_post_cmd_v(pid: i32) -> Result<(), String> {
        if !activate_via_appkit(pid) {
            activate_via_osascript(pid)?;
        }

        std::thread::sleep(Duration::from_millis(150));

        post_cmd_v_to_pid(pid).map_err(|e| {
            eprintln!("[snipcast] {e}");
            e
        })
    }
}

#[cfg(target_os = "windows")]
mod win {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    pub fn foreground_hwnd_if_other_process() -> Option<isize> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
            if pid == 0 || pid == std::process::id() {
                return None;
            }
            Some(hwnd.0 as isize)
        }
    }

    pub fn activate_and_paste_ctrl_v(hwnd: isize) -> Result<(), String> {
        unsafe {
            SetForegroundWindow(HWND(hwnd as *mut std::ffi::c_void));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo
            .key(Key::Control, Direction::Press)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Control, Direction::Release)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
