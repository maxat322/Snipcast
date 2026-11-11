//! Mouse-button shortcuts share configuration and conflict checks with keyboard shortcuts.
use crate::data::AppConfig;
use std::{
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering::SeqCst},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::Shortcut as KeyboardShortcut;
pub const PALETTE: u32 = 1;
pub const SCREENSHOT: u32 = 2;
pub const PRESETS: u32 = 4;
pub const SUGGESTIONS: u32 = 8;
pub const COMMANDS: u32 = 16;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Chord {
    pub mods: u8,
    pub buttons: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Shortcut {
    Keyboard(KeyboardShortcut),
    Mouse(Chord),
}
pub fn is_mouse(value: &str) -> bool {
    value
        .split('+')
        .any(|v| v.trim().to_ascii_lowercase().starts_with("mouse"))
}
pub fn parse(value: &str) -> Result<Shortcut, String> {
    if !is_mouse(value) {
        return KeyboardShortcut::from_str(value)
            .map(Shortcut::Keyboard)
            .map_err(|e| e.to_string());
    }
    let mut chord = Chord {
        mods: 0,
        buttons: 0,
    };
    for part in value.split('+') {
        let (modifier, bit) = match part.trim().to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "commandorcontrol" => (true, 1),
            "shift" => (true, 2),
            "alt" | "option" => (true, 4),
            "super" | "meta" | "command" | "cmd" => (true, 8),
            "mouseleft" => (false, 1),
            "mouseright" => (false, 2),
            "mousemiddle" => (false, 4),
            "mouse4" | "mouseback" | "mousex1" => (false, 8),
            "mouse5" | "mouseforward" | "mousex2" => (false, 16),
            _ => return Err("Используйте модификаторы и кнопки мыши".into()),
        };
        let mask = if modifier {
            &mut chord.mods
        } else {
            &mut chord.buttons
        };
        if *mask & bit != 0 {
            return Err("Кнопка или модификатор повторяется".into());
        }
        *mask |= bit;
    }
    if chord.buttons == 0 || chord.mods == 0 && matches!(chord.buttons, 1 | 2) {
        return Err("Для ЛКМ или ПКМ добавьте модификатор либо вторую кнопку".into());
    }
    Ok(Shortcut::Mouse(chord))
}
impl Chord {
    pub fn text(self) -> String {
        let mut parts = vec![];
        for (bit, name) in [
            (2, "Shift"),
            (4, "Alt"),
            (1, "CommandOrControl"),
            (8, "Super"),
        ] {
            if self.mods & bit != 0 {
                parts.push(name)
            }
        }
        for (bit, name) in [
            (1, "MouseLeft"),
            (2, "MouseRight"),
            (4, "MouseMiddle"),
            (8, "Mouse4"),
            (16, "Mouse5"),
        ] {
            if self.buttons & bit != 0 {
                parts.push(name)
            }
        }
        parts.join("+")
    }
}
#[derive(Clone, Debug)]
enum Action {
    Palette,
    Screenshot,
    Preset(String),
    Command(String),
    Suggestions,
    Capture(&'static str),
}
#[derive(Clone)]
struct Binding {
    chord: Chord,
    group: u32,
    action: Action,
}
fn select(bindings: &[Binding], chord: Chord, capture: bool, paused: u32) -> Option<Binding> {
    let active = |b: &&Binding| paused & b.group == 0;
    if capture {
        if let Some(binding) = bindings.iter().filter(active).find(|b| {
            matches!(b.action, Action::Capture(_))
                && b.chord.buttons == chord.buttons
                && (b.chord.mods == chord.mods || b.chord.mods | 4 == chord.mods)
        }) {
            return Some(binding.clone());
        }
    }
    bindings
        .iter()
        .filter(active)
        .find(|b| !matches!(b.action, Action::Capture(_)) && b.chord == chord)
        .cloned()
}
#[derive(Default)]
struct Inner {
    #[cfg(feature = "inline-qa")]
    seen: AtomicU32,
    #[cfg(feature = "inline-qa")]
    matched: AtomicU32,
    bindings: Mutex<Vec<Binding>>,
    paused: AtomicU32,
    recording: AtomicBool,
    settings: AtomicUsize,
    generation: AtomicU32,
}
#[derive(Default)]
pub struct Runtime(Arc<Inner>);
pub fn pause(app: &AppHandle, group: u32, paused: bool) {
    let rt = app.state::<Runtime>();
    if paused {
        rt.0.paused.fetch_or(group, SeqCst);
    } else {
        rt.0.paused.fetch_and(!group, SeqCst);
    }
}
fn bindings(cfg: &AppConfig) -> Result<Vec<Binding>, String> {
    let mut bindings = vec![];
    let mut add = |value: &str, group, action| -> Result<(), String> {
        if value.trim().is_empty() {
            return Ok(());
        }
        if let Shortcut::Mouse(chord) = parse(value)? {
            bindings.push(Binding {
                chord,
                group,
                action,
            });
        }
        Ok(())
    };
    add(&cfg.palette_hotkey, PALETTE, Action::Palette)?;
    add(&cfg.palette_hotkey_secondary, PALETTE, Action::Palette)?;
    add(&cfg.screenshot_hotkey, SCREENSHOT, Action::Screenshot)?;
    add(&cfg.screenshot_hotkey_secondary, SCREENSHOT, Action::Screenshot)?;
    add(
        &cfg.text_suggestions.toggle_hotkey,
        SUGGESTIONS,
        Action::Suggestions,
    )?;
    for preset in &cfg.screenshot_presets {
        add(&preset.hotkey, PRESETS, Action::Preset(preset.id.clone()))?;
    }
    for (id, key) in crate::commands::bindings(cfg) {
        add(&key, COMMANDS, Action::Command(id))?;
    }
    for (key, action) in [
        (&cfg.screenshot_save_hotkey, "save"),
        (&cfg.screenshot_pin_hotkey, "pin"),
        (&cfg.screenshot_copy_hotkey, "copy"),
    ] {
        add(key, 0, Action::Capture(action))?;
    }
    let mut seen = std::collections::HashSet::new();
    for binding in &bindings {
        if binding.group != 0 && !seen.insert(binding.chord) {
            return Err(format!(
                "Комбинация {} уже используется",
                binding.chord.text()
            ));
        }
    }
    Ok(bindings)
}
pub fn validate(cfg: &AppConfig) -> Result<(), String> {
    bindings(cfg).map(|_| ())
}
pub fn prepare(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let bindings = bindings(cfg)?;
    if !bindings.is_empty() {
        install(app)?;
    }
    let rt = app.state::<Runtime>();
    let mut current = rt.0.bindings.lock().map_err(|e| e.to_string())?;
    *current = bindings;
    rt.0.generation.fetch_add(1, SeqCst);
    Ok(())
}
#[tauri::command]
pub fn snipcast_mouse_hotkey_recording(
    app: AppHandle,
    window: tauri::WebviewWindow,
    active: bool,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Запись доступна только в настройках".into());
    }
    if active {
        install(&app)?;
    }
    let rt = app.state::<Runtime>();
    #[cfg(target_os = "windows")]
    rt.0.settings
        .store(window.hwnd().map_err(|e| e.to_string())?.0 as usize, SeqCst);
    rt.0.recording.store(active, SeqCst);
    Ok(())
}
#[cfg(not(target_os = "windows"))]
fn install(_: &AppHandle) -> Result<(), String> {
    Err("Сочетания мыши поддерживаются в Windows".into())
}
#[cfg(target_os = "windows")]
fn install(app: &AppHandle) -> Result<(), String> {
    win::install(app)
}
#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::sync::{mpsc, OnceLock};
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::*},
    };
    struct Event {
        binding: Option<Binding>,
        chord: Chord,
        foreground: usize,
        generation: u32,
    }
    struct Hook {
        inner: Arc<Inner>,
        sender: mpsc::SyncSender<Event>,
    }
    static CONTEXT: OnceLock<Hook> = OnceLock::new();
    static WORKER: OnceLock<Result<(), String>> = OnceLock::new();
    static BUTTONS: AtomicU32 = AtomicU32::new(0);
    static CONSUMED: AtomicU32 = AtomicU32::new(0);
    unsafe extern "system" fn hook(code: i32, message: usize, param: isize) -> isize {
        if code < 0 {
            return CallNextHookEx(std::ptr::null_mut(), code, message, param);
        }
        let data = &*(param as *const MSLLHOOKSTRUCT);
        let (bit, down) = match message as u32 {
            WM_LBUTTONDOWN => (1, true),
            WM_LBUTTONUP => (1, false),
            WM_RBUTTONDOWN => (2, true),
            WM_RBUTTONUP => (2, false),
            WM_MBUTTONDOWN => (4, true),
            WM_MBUTTONUP => (4, false),
            WM_XBUTTONDOWN | WM_XBUTTONUP => (
                (if data.mouseData >> 16 == 1 { 8 } else { 16 }),
                message as u32 == WM_XBUTTONDOWN,
            ),
            _ => return CallNextHookEx(std::ptr::null_mut(), code, message, param),
        };
        #[cfg(feature = "inline-qa")]
        if let Some(ctx) = CONTEXT.get() {
            ctx.inner.seen.fetch_add(1, SeqCst);
        }
        if !down {
            BUTTONS.fetch_and(!bit, SeqCst);
            if CONSUMED.fetch_and(!bit, SeqCst) & bit != 0 {
                return 1;
            }
            return CallNextHookEx(std::ptr::null_mut(), code, message, param);
        }
        let buttons = (BUTTONS.fetch_or(bit, SeqCst) | bit) as u8;
        let mut mods = 0;
        for (vk, mask) in [(0x11, 1), (0x10, 2), (0x12, 4), (0x5b, 8), (0x5c, 8)] {
            if GetAsyncKeyState(vk) < 0 {
                mods |= mask;
            }
        }
        let foreground = GetForegroundWindow() as usize;
        if let Some(recorded) = crate::capture_keyboard::recording_modifiers(foreground) {
            mods = recorded;
        }
        let chord = Chord { mods, buttons };
        let Some(context) = CONTEXT.get() else {
            return CallNextHookEx(std::ptr::null_mut(), code, message, param);
        };
        let rt = &context.inner;
        let recording = rt.recording.load(SeqCst);
        let binding = if recording {
            if foreground != rt.settings.load(SeqCst) || parse(&chord.text()).is_err() {
                return CallNextHookEx(std::ptr::null_mut(), code, message, param);
            }
            None
        } else {
            let Ok(bindings) = rt.bindings.try_lock() else {
                return CallNextHookEx(std::ptr::null_mut(), code, message, param);
            };
            let capture = crate::capture_keyboard::mouse_ready(foreground);
            let selected = select(&bindings, chord, capture, rt.paused.load(SeqCst));
            let Some(binding) = selected else {
                return CallNextHookEx(std::ptr::null_mut(), code, message, param);
            };
            Some(binding)
        };
        if context
            .sender
            .try_send(Event {
                binding,
                chord,
                foreground,
                generation: rt.generation.load(SeqCst),
            })
            .is_ok()
        {
            #[cfg(feature = "inline-qa")]
            rt.matched.fetch_add(1, SeqCst);
            CONSUMED.fetch_or(bit, SeqCst);
            return 1;
        }
        CallNextHookEx(std::ptr::null_mut(), code, message, param)
    }
    pub fn install(app: &AppHandle) -> Result<(), String> {
        WORKER.get_or_init(||{
        let (sender,receiver)=mpsc::sync_channel::<Event>(64);let inner=app.state::<Runtime>().0.clone();
        CONTEXT.set(Hook{inner:inner.clone(),sender}).map_err(|_|"Обработчик мыши уже создан".to_string())?;
        let (ready_tx,ready_rx)=mpsc::sync_channel(1);
        std::thread::spawn(move||unsafe{
            let hook=SetWindowsHookExW(WH_MOUSE_LL,Some(hook),std::ptr::null_mut(),0);
            let _=GetCurrentThreadId();let _=ready_tx.send(if hook.is_null(){Err(format!("Не удалось включить сочетания мыши: {}",std::io::Error::last_os_error()))}else{Ok(())});
            if hook.is_null(){return} let mut message=std::mem::zeroed();while GetMessageW(&mut message,std::ptr::null_mut(),0,0)>0{TranslateMessage(&message);DispatchMessageW(&message);}UnhookWindowsHookEx(hook);
        });
        ready_rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e|e.to_string())??;
        let app=app.clone();std::thread::spawn(move||{while let Ok(event)=receiver.recv(){let app=app.clone();let main=app.clone();let inner=inner.clone();let _=app.run_on_main_thread(move||{
            use tauri::Emitter;
            if event.generation!=inner.generation.load(SeqCst){return}
            if let Some(binding)=event.binding {
                if inner.recording.load(SeqCst)||inner.paused.load(SeqCst)&binding.group!=0{return}
                let result=match binding.action {
                    Action::Palette=>{crate::show_palette(&main);Ok(())},Action::Screenshot=>crate::start_capture_notify(&main,None),
                    Action::Preset(id)=>{crate::run_preset_by_id(&main,&id);Ok(())},Action::Command(id)=>crate::commands::execute(&main,&id),Action::Suggestions=>{crate::text_suggestions::toggle(&main);Ok(())},
                    Action::Capture(action)=>{for (label,window) in main.webview_windows(){if window.hwnd().ok().is_some_and(|h|h.0 as usize==event.foreground)&&label.starts_with(crate::screenshot::CAPTURE_PREFIX){let _=window.emit("snipcast://capture-mouse-action",serde_json::json!({"action":action,"alt":event.chord.mods&4!=0}));}}Ok(())},
                };if let Err(error)=result{crate::commands::report(&main,error);}
            }else if inner.recording.load(SeqCst)&&unsafe{GetForegroundWindow() as usize}==inner.settings.load(SeqCst){let _=main.emit_to("settings","snipcast://mouse-hotkey-recorded",event.chord.text());}
        });}});Ok(())
    }).clone()
    }
}
#[cfg(feature = "inline-qa")]
#[tauri::command]
pub fn snipcast_mouse_hotkeys_qa_state(app: AppHandle) -> serde_json::Value {
    let rt = app.state::<Runtime>();
    serde_json::json!({"seen":rt.0.seen.load(SeqCst),"matched":rt.0.matched.load(SeqCst),"recording":rt.0.recording.load(SeqCst),"paused":rt.0.paused.load(SeqCst),"bindings":rt.0.bindings.lock().unwrap().iter().map(|b|b.chord.text()).collect::<Vec<_>>()})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_and_normalize() {
        for value in [
            "Alt+MouseRight",
            "MouseRight+MouseLeft",
            "Control+Mouse4",
            "Ctrl+Mouse5",
        ] {
            let Shortcut::Mouse(chord) = parse(value).unwrap() else {
                panic!()
            };
            assert_eq!(parse(&chord.text()).unwrap(), Shortcut::Mouse(chord));
        }
        assert_eq!(parse("Ctrl+MouseBack"), parse("CommandOrControl+Mouse4"));
        assert_eq!(parse("MouseLeft+MouseRight"), parse("MouseRight+MouseLeft"));
    }
    #[test]
    fn switches_conflicts_and_saved_commands() {
        let mut cfg = AppConfig::default();
        cfg.palette_hotkey = "Alt+MouseRight".into();
        cfg.commands.items.insert(
            "app:test".into(),
            crate::commands::ItemConfig {
                hotkey: "Control+Mouse4".into(),
                ..Default::default()
            },
        );
        assert!(validate(&cfg).is_ok());
        assert_eq!(bindings(&cfg).unwrap().len(), 2);
        cfg.commands.applications_enabled = false;
        assert_eq!(bindings(&cfg).unwrap().len(), 1);
        cfg.commands.applications_enabled = true;
        cfg.commands.enabled = false;
        assert_eq!(bindings(&cfg).unwrap().len(), 1);
        cfg.commands.enabled = true;
        assert_eq!(bindings(&cfg).unwrap().len(), 2);
        cfg.screenshot_hotkey = "MouseRight+Alt".into();
        assert!(validate(&cfg).is_err());
        cfg.screenshot_hotkey = "MouseLeft+MouseRight".into();
        assert!(validate(&cfg).is_ok());
        let restarted: AppConfig =
            serde_json::from_value(serde_json::to_value(&cfg).unwrap()).unwrap();
        assert_eq!(bindings(&restarted).unwrap().len(), 3);
        assert!(crate::commands::validate(&cfg).is_ok());
        assert!(crate::text_suggestions::validate(&cfg).is_ok());
        cfg.text_suggestions.toggle_hotkey = "Ctrl+Mouse4".into();
        assert!(crate::commands::validate(&cfg).is_err());
        assert!(validate(&cfg).is_err());
    }
    #[test]
    fn exact_modifiers_pause_and_capture_priority() {
        let mut cfg = AppConfig::default();
        cfg.palette_hotkey = "Alt+MouseRight".into();
        cfg.screenshot_copy_hotkey = "Mouse4".into();
        let list = bindings(&cfg).unwrap();
        let chord = Chord {
            mods: 4,
            buttons: 2,
        };
        assert!(matches!(
            select(&list, chord, false, 0).unwrap().action,
            Action::Palette
        ));
        assert!(select(&list, chord, false, PALETTE).is_none());
        assert!(select(
            &list,
            Chord {
                mods: 0,
                buttons: 2
            },
            false,
            0
        )
        .is_none());
        assert!(select(
            &list,
            Chord {
                mods: 5,
                buttons: 2
            },
            false,
            0
        )
        .is_none());
        assert!(matches!(
            select(&list, chord, true, 0).unwrap().action,
            Action::Palette
        ));
        assert!(matches!(
            select(
                &list,
                Chord {
                    mods: 4,
                    buttons: 8
                },
                true,
                0
            )
            .unwrap()
            .action,
            Action::Capture("copy")
        ));
        assert!(select(
            &list,
            Chord {
                mods: 0,
                buttons: 8
            },
            false,
            0
        )
        .is_none());
        cfg.palette_hotkey = "MouseRight+MouseLeft".into();
        let list = bindings(&cfg).unwrap();
        assert!(select(
            &list,
            Chord {
                mods: 0,
                buttons: 1
            },
            false,
            0
        )
        .is_none());
        assert!(matches!(
            select(
                &list,
                Chord {
                    mods: 0,
                    buttons: 3
                },
                false,
                0
            )
            .unwrap()
            .action,
            Action::Palette
        ));
    }
    #[test]
    fn secondary_mouse_bindings_dispatch_and_pause_with_primary() {
        let mut cfg=AppConfig::default();
        cfg.palette_hotkey_secondary="Alt+Mouse4".into();
        cfg.screenshot_hotkey_secondary="Control+Mouse5".into();
        let list=bindings(&cfg).unwrap();
        for (value,group) in [(&cfg.palette_hotkey_secondary,PALETTE),(&cfg.screenshot_hotkey_secondary,SCREENSHOT)] {
            let Shortcut::Mouse(chord)=parse(value).unwrap() else { panic!("expected mouse binding") };
            let binding=select(&list,chord,false,0).unwrap();
            assert_eq!(binding.group,group);
            assert!(matches!((group,binding.action),(PALETTE,Action::Palette)|(SCREENSHOT,Action::Screenshot)));
            assert!(select(&list,chord,false,group).is_none());
        }
        cfg.screenshot_hotkey_secondary=cfg.palette_hotkey_secondary.clone();
        assert!(validate(&cfg).is_err());
    }
    #[test]
    fn reject_unsafe_or_malformed() {
        for value in [
            "MouseLeft",
            "MouseRight",
            "Control+Mouse99",
            "A+MouseRight",
            "Alt+Alt+MouseRight",
            "Mouse4+Mouse4",
        ] {
            assert!(parse(value).is_err(), "{value}");
        }
        assert!(matches!(parse("Alt+E"), Ok(Shortcut::Keyboard(_))));
    }
}
