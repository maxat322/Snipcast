mod ai;
mod capture_detection;
mod api;
pub mod data;
mod ocr;
mod paste_insert;
mod paste_target;
mod rich_clipboard;
pub mod screenshot;
mod pin_transition;
mod template_files;
mod updater;
mod video;
mod capture_history;
mod capture_keyboard;
mod text_suggestions;
#[cfg(target_os = "windows")]
mod suggestions_windows;

#[cfg(target_os = "windows")]
mod paddle;

#[cfg(target_os = "macos")]
mod macos_window;

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::str::FromStr;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

use paste_target::PasteTarget;

use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{
    Builder as ShortcutPluginBuilder, GlobalShortcutExt, Shortcut, ShortcutState,
};
use tauri_plugin_notification::NotificationExt;

use sha2::Digest as _;

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";

#[cfg(target_os = "macos")]
fn macos_round_corners_now_and_delayed(app: &tauri::AppHandle, win: &tauri::webview::WebviewWindow, radius: f64) {
    let _ = macos_window::apply_rounded_corners(win.as_ref(), radius);
    let app = app.clone();
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(160));
        let _ = app.run_on_main_thread(move || {
            let _ = macos_window::apply_rounded_corners(win.as_ref(), radius);
        });
    });
}

#[cfg(target_os = "macos")]
fn macos_round_corners_on_window_resize(window: &tauri::Window) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    for wv in window.webviews() {
        let _ = macos_window::apply_rounded_corners(&wv, 12.0);
    }
}

/// Обновить цель вставки (macOS: с запасным PID; Windows: HWND переднего окна).
pub(crate) fn refresh_paste_target(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let lf = app.state::<Mutex<Option<i32>>>();
        let pt = app.state::<Mutex<PasteTarget>>();
        paste_target::sync_macos_paste_target(&*lf, &*pt);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(mut g) = app.state::<Mutex<PasteTarget>>().lock() {
            paste_target::sync_windows_paste_target(&mut g);
        }
    }
}

/// Зарегистрированные комбинации пресетов (для снятия при пересохранении).
#[derive(Default)]
struct PresetHotkeys(HashSet<String>);

/// Меню трея: базовые пункты + пресеты быстрого скриншота.
fn build_tray_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Открыть Snipcast", true, None::<&str>)?;
    let screenshot_item =
        MenuItem::with_id(app, "screenshot", "Новый скриншот", true, None::<&str>)?;
    let video_item = MenuItem::with_id(app, "video", "Записать видео области", cfg!(target_os = "windows"), None::<&str>)?;
    let mut preset_items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    let presets: Vec<data::ScreenshotPreset> = {
        match app.state::<Mutex<data::AppConfig>>().lock() {
            Ok(c) => c.screenshot_presets.clone(),
            Err(_) => vec![],
        }
    };
    for p in presets.iter().take(8) {
        preset_items.push(MenuItem::with_id(
            app,
            format!("preset-{}", p.id),
            format!("Скриншот: {}", p.title),
            true,
            None::<&str>,
        )?);
    }

    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let close_pins = MenuItem::with_id(app, "close_all_pins", "Закрыть все закрепы", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let suggestions_on = app.state::<Mutex<data::AppConfig>>().lock().map(|c|c.text_suggestions.enabled).unwrap_or(false);
    let suggestions = MenuItem::with_id(app, "suggestions", if suggestions_on {"Подсказки при вводе: включены"} else {"Подсказки при вводе: выключены"}, cfg!(target_os="windows"), None::<&str>)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&show, &screenshot_item, &video_item];
    for item in &preset_items {
        items.push(item);
    }
    items.push(&close_pins);
    items.push(&settings);
    items.push(&suggestions);
    items.push(&quit);
    Menu::with_items(app, &items)
}

/// Выполнить пресет быстрого скриншота по id (ошибка — уведомлением).
pub(crate) fn run_preset_by_id(app: &tauri::AppHandle, preset_id: &str) {
    let cfg = match app.state::<Mutex<data::AppConfig>>().lock() {
        Ok(c) => c.clone(),
        Err(err) => {
            eprintln!("[snipcast] preset config: {err}");
            return;
        }
    };
    if let Err(err) = run_preset_job(app, &cfg, preset_id) {
        eprintln!("[snipcast] пресет {preset_id}: {err}");
        let _ = app
            .notification()
            .builder()
            .title("Snipcast — скриншот")
            .body(&err)
            .show();
    }
}

/// Логика пресета: оверлей выделения (select) или беззвучная джоба.
/// Ошибки возвращаются — их показ зависит от точки вызова.
pub(crate) fn run_preset_job(
    app: &tauri::AppHandle,
    cfg: &data::AppConfig,
    preset_id: &str,
) -> Result<(), String> {
    let Some(preset) = cfg.screenshot_presets.iter().find(|p| p.id == preset_id) else {
        return Err(format!("пресет {preset_id} не найден"));
    };

    let result = if preset.select {
        screenshot::start_capture(
            app,
            Some(screenshot::PresetOverride {
                title: preset.title.clone(),
                dir: preset.dir.clone(),
                file_template: preset.file_template.clone(),
                action: preset.action.clone(),
            }),
        )
        .map(|_| ())
    } else {
        let job = screenshot::CaptureJob {
            name: if preset.file_template.trim().is_empty() {
                None
            } else {
                Some(preset.file_template.clone())
            },
            dir: if preset.dir.trim().is_empty() {
                None
            } else {
                Some(preset.dir.clone())
            },
            ocr: preset.action == "ocr",
            pin: preset.action == "pin",
            ..Default::default()
        };
        screenshot::run_capture_job(app, &cfg, &job).map(|_| ())
    };

    result
}

/// Перерегистрировать хоткеи пресетов: снять все прежние, назначить из конфига.
fn apply_preset_hotkeys(app: &tauri::AppHandle, cfg: &data::AppConfig) -> Result<(), String> {
    validate_preset_hotkeys(cfg)?;

    let gs = app.global_shortcut();
    {
        let reg = app.state::<Mutex<PresetHotkeys>>();
        let mut r = reg.lock().map_err(|e| e.to_string())?;
        for h in r.0.drain() {
            let _ = gs.unregister(h.as_str());
        }
    }

    let mut registered: Vec<String> = Vec::new();
    for p in &cfg.screenshot_presets {
        let h = p.hotkey.trim();
        if h.is_empty() {
            continue;
        }
        let pid = p.id.clone();
        let title = p.title.clone();
        let res = gs.on_shortcut(h, move |app, _sc, e| {
            if e.state == ShortcutState::Pressed {
                run_preset_by_id(app, &pid);
            }
        });
        if let Err(err) = res {
            // Скатываем всё зарегистрированное в этой сессии, чтобы не остаться
            // с частично назначенными пресетами.
            for rh in &registered {
                let _ = gs.unregister(rh.as_str());
            }
            return Err(format!(
                "Пресет «{title}»: не удалось зарегистрировать «{h}»: {err}"
            ));
        }
        registered.push(h.to_string());
    }

    let reg = app.state::<Mutex<PresetHotkeys>>();
    reg.lock().map_err(|e| e.to_string())?.0 = registered.into_iter().collect();
    Ok(())
}

/// Перестроить меню трея (после изменения пресетов).
fn refresh_tray_menu(app: &tauri::AppHandle) {
    let tray_state = app.state::<Mutex<Option<TrayIcon>>>();
    let tray = match tray_state.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };
    if let Some(tray) = tray {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(menu) = build_tray_menu(&app2) {
                let _ = tray.set_menu(Some(menu));
            }
        });
    }
}

/// Запуск скриншота с видимым уведомлением об ошибке: без этого все пути
/// (хоткей/трей/палитра) молча глотали сбой, и «скриншот не вызывается»
/// невозможно было продиагностировать.
fn start_capture_notify(app: &tauri::AppHandle, preset: Option<screenshot::PresetOverride>) -> Result<(), String> {
    match screenshot::start_capture(app, preset) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = app
                .notification()
                .builder()
                .title("Snipcast — скриншот не удался")
                .body(&err)
                .show();
            Err(err)
        }
    }
}

fn show_palette(app: &tauri::AppHandle) {
    refresh_paste_target(app);

    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        #[cfg(target_os = "macos")]
        macos_round_corners_now_and_delayed(app, &w, 12.0);
    }
}

pub(crate) fn hide_palette(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.hide();
    }
}

fn apply_palette_hotkey(app: &tauri::AppHandle, previous: Option<&str>, next: &str) -> Result<(), String> {
    let next = next.trim();
    let gs = app.global_shortcut();
    if let Some(p) = previous {
        let p = p.trim();
        if !p.is_empty() && p != next {
            let _ = gs.unregister(p);
        }
    }
    // Пустой хоткей допустим: палитра открывается из трея (и скриншотом не занят).
    if next.is_empty() {
        return Ok(());
    }
    Shortcut::from_str(next).map_err(|e| e.to_string())?;
    gs.on_shortcut(next, |app, _, e| {
        if e.state == ShortcutState::Pressed {
            show_palette(app);
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Регистрация хоткея скриншота. Пустая строка = хоткей не назначен
/// (запуск остаётся доступным из трея и палитры).
fn apply_screenshot_hotkey(app: &tauri::AppHandle, previous: Option<&str>, next: &str) -> Result<(), String> {
    let next = next.trim();
    let gs = app.global_shortcut();
    if let Some(p) = previous {
        let p = p.trim();
        if !p.is_empty() && p != next {
            let _ = gs.unregister(p);
        }
    }
    if next.is_empty() {
        return Ok(());
    }
    Shortcut::from_str(next).map_err(|e| e.to_string())?;
    gs.on_shortcut(next, |app, _, e| {
        if e.state == ShortcutState::Pressed {
            if let Err(err) = start_capture_notify(app, None) {
                eprintln!("[snipcast] start_capture: {err}");
            }
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn palette_hide(app: tauri::AppHandle) {
    #[cfg(target_os="windows")]
    if let Some(pending)=app.state::<text_suggestions::Runtime>().pending.lock().ok().and_then(|p|p.clone()) {
        suggestions_windows::send(&app,suggestions_windows::Command::Action{session:pending.session,action:"cancel-pending".into(),index:None});
    }
    hide_palette(&app);
}

/// Чтение текста из буфера обмена ОС (WebView `navigator.clipboard` в палитре часто недоступен).
#[tauri::command]
fn snipcast_clipboard_read_text() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match cb.get_text() {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
fn snipcast_get_paths(state: State<'_, Mutex<data::AppConfig>>) -> Result<data::PathsDto, String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    Ok(data::paths_dto(&cfg))
}

#[tauri::command]
fn snipcast_get_config(state: State<'_, Mutex<data::AppConfig>>) -> Result<data::AppConfig, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn snipcast_save_config(
    app: tauri::AppHandle,
    state: State<'_, Mutex<data::AppConfig>>,
    incoming: data::AppConfig,
    skip_palette_hotkey_apply: Option<bool>,
) -> Result<(), String> {
    let skip_hotkey = skip_palette_hotkey_apply.unwrap_or(false);
    text_suggestions::validate(&incoming)?;
    let mut cfg = state.lock().map_err(|e| e.to_string())?;
    let prev_hotkey = cfg.palette_hotkey.clone();
    let hotkey_changed = prev_hotkey.trim() != incoming.palette_hotkey.trim();
    let prev_shot_hotkey = cfg.screenshot_hotkey.clone();
    let shot_hotkey_changed = prev_shot_hotkey.trim() != incoming.screenshot_hotkey.trim();
    let prev_presets = cfg.screenshot_presets.clone();
    let presets_changed = prev_presets != incoming.screenshot_presets;

    // Комбинации проверяем только когда их реально меняли: неверный хоткей
    // не должен мешать сохранить тему, автозапуск и остальные настройки.
    let mut incoming = incoming;
    validate_capture_action_hotkeys(&incoming)?;
    if hotkey_changed && !incoming.palette_hotkey.trim().is_empty() {
        if let Err(e) = Shortcut::from_str(incoming.palette_hotkey.trim()) {
            // Оставляем прежнюю рабочую комбинацию, всё остальное сохраняем.
            incoming.palette_hotkey = prev_hotkey;
            *cfg = incoming;
            data::save_config(&cfg)?;
            return Err(format!("Неверная комбинация клавиш: {e}"));
        }
    }
    if shot_hotkey_changed && !incoming.screenshot_hotkey.trim().is_empty() {
        if let Err(e) = Shortcut::from_str(incoming.screenshot_hotkey.trim()) {
            incoming.screenshot_hotkey = prev_shot_hotkey;
            *cfg = incoming;
            data::save_config(&cfg)?;
            return Err(format!("Неверная комбинация клавиш: {e}"));
        }
    }
    // Пресеты валидируем целиком до записи: дубль комбинации не должен
    // сохраняться и ломать все хоткеи разом.
    if presets_changed {
        if let Err(e) = validate_preset_hotkeys(&incoming) {
            return Err(e);
        }
        // Присвоим id пресетам, у которых его нет.
        for p in incoming.screenshot_presets.iter_mut() {
            if p.id.trim().is_empty() {
                let seed = format!(
                    "{}|{}|{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or_default(),
                    std::process::id(),
                    p.title,
                );
                p.id = format!("{:x}", sha2::Sha256::digest(seed.as_bytes()))[..12].to_string();
            }
        }
    }

    // Validate/register suggestions before persisting: a rejected OS shortcut must not become a saved setting.
    let suggestions_changed = cfg.text_suggestions != incoming.text_suggestions;
    let previous_cfg=cfg.clone();
    drop(cfg);
    if suggestions_changed { text_suggestions::prepare(&app, &incoming)?; }
    if let Err(e)=data::save_config(&incoming) {
        if suggestions_changed {let _=text_suggestions::prepare(&app,&previous_cfg);}
        return Err(e);
    }
    let mut cfg=state.lock().map_err(|e|e.to_string())?;
    *cfg=incoming;
    // Native callbacks can run inline on the UI thread. Rebuilding the tray
    // reads AppConfig again, so no config guard may survive into these calls.
    let saved_cfg = cfg.clone();
    drop(cfg);

    if hotkey_changed && !skip_hotkey {
        apply_palette_hotkey(&app, Some(&prev_hotkey), &saved_cfg.palette_hotkey)?;
    }
    if shot_hotkey_changed && !skip_hotkey {
        apply_screenshot_hotkey(&app, Some(&prev_shot_hotkey), &saved_cfg.screenshot_hotkey)?;
    }
    if presets_changed {
        if let Err(e) = apply_preset_hotkeys(&app, &saved_cfg) {
            refresh_tray_menu(&app);
            return Err(e);
        }
        refresh_tray_menu(&app);
    }
    api::apply_config(&app, &saved_cfg);
    text_suggestions::configure(&app, &saved_cfg);
    if suggestions_changed {refresh_tray_menu(&app);}

    Ok(())
}

/// Проверить комбинации пресетов без применения.
fn validate_capture_action_hotkeys(cfg:&data::AppConfig)->Result<(),String> {
    let mut used=HashSet::new();
    for (label,value) in [("Сохранить",&cfg.screenshot_save_hotkey),("Закрепить",&cfg.screenshot_pin_hotkey),("Копировать",&cfg.screenshot_copy_hotkey)] {
        if value.trim().is_empty(){continue;}
        let shortcut=Shortcut::from_str(value.trim()).map_err(|e|format!("{label}: неверная комбинация ({e})"))?;
        let base=value.split('+').filter(|v|!v.eq_ignore_ascii_case("alt")).collect::<Vec<_>>().join("+");
        let base=Shortcut::from_str(&base).unwrap_or(shortcut);
        if !used.insert(base){return Err("Горячие клавиши действий должны различаться".into());}
        if cfg.screenshot_presets.iter().map(|p|p.hotkey.as_str()).chain([cfg.palette_hotkey.as_str(),cfg.screenshot_hotkey.as_str()])
            .any(|key|!key.is_empty()&&Shortcut::from_str(key).ok()==Some(shortcut)) {return Err(format!("{label}: комбинация занята глобальной горячей клавишей"));}
        let upper=value.to_ascii_uppercase();let main=upper.rsplit('+').next().unwrap_or("");
        let bare=upper.split('+').all(|part|part==main||matches!(part,"ALT"|"SHIFT"));
        let reserved=bare && matches!(main,"A"|"V"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"NUMPAD1"|"NUMPAD2"|"NUMPAD3"|"NUMPAD4"|"NUMPAD5"|"NUMPAD6"|"NUMPAD7"|"NUMPAD8"|"MINUS"|"EQUAL"|"NUMPADADD"|"NUMPADSUBTRACT"|"ARROWLEFT"|"ARROWRIGHT"|"ARROWUP"|"ARROWDOWN");
        let undo=["CommandOrControl+Z","CommandOrControl+Shift+Z","CommandOrControl+Y","Control+Z","Control+Shift+Z","Control+Y","Shift+Equal"].iter()
            .any(|v|Shortcut::from_str(v).ok()==Some(base));
        if reserved||main=="ESCAPE"||undo{return Err(format!("{label}: эта комбинация используется в редакторе"));}
    }
    Ok(())
}

#[cfg(test)]
mod capture_hotkey_tests {
    use super::*;
    #[test]
    fn defaults_and_control_remapping_are_valid() {
        let mut cfg=data::AppConfig::default();assert!(validate_capture_action_hotkeys(&cfg).is_ok());
        cfg.screenshot_copy_hotkey="CommandOrControl+K".into();assert!(validate_capture_action_hotkeys(&cfg).is_ok());
    }
    #[test]
    fn alt_does_not_allow_duplicate_actions() {
        let mut cfg=data::AppConfig::default();cfg.screenshot_copy_hotkey="Alt+Enter".into();
        assert!(validate_capture_action_hotkeys(&cfg).is_err());
    }
    #[test]
    fn tool_and_undo_conflicts_include_shift_and_alt() {
        let mut cfg=data::AppConfig::default();
        for value in ["1","Shift+1","Alt+Shift+1","Shift+V","NumpadSubtract","Alt+CommandOrControl+Z"] {
            cfg.screenshot_copy_hotkey=value.into();assert!(validate_capture_action_hotkeys(&cfg).is_err(),"{value}");
        }
    }
}

fn validate_preset_hotkeys(cfg: &data::AppConfig) -> Result<(), String> {
    let mut seen: HashSet<Shortcut> = HashSet::new();
    for (label, combo) in [
        ("палитры", cfg.palette_hotkey.as_str()),
        ("скриншота", cfg.screenshot_hotkey.as_str()),
    ] {
        let h = combo.trim();
        if h.is_empty() {
            continue;
        }
        let sc =
            Shortcut::from_str(h).map_err(|e| format!("Хоткей {label} «{h}»: {e}"))?;
        if !seen.insert(sc) {
            return Err(format!("Комбинация «{h}» уже используется"));
        }
    }
    for p in &cfg.screenshot_presets {
        let h = p.hotkey.trim();
        if h.is_empty() {
            continue;
        }
        let sc = Shortcut::from_str(h)
            .map_err(|e| format!("Пресет «{}»: неверная комбинация «{h}»: {e}", p.title))?;
        if !seen.insert(sc) {
            return Err(format!(
                "Комбинация «{h}» уже используется (пресет «{}»)",
                p.title
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn snipcast_preset_hotkeys_pause(app: tauri::AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    let reg = app.state::<Mutex<PresetHotkeys>>();
    let mut r = reg.lock().map_err(|e| e.to_string())?;
    for h in r.0.drain() {
        let _ = gs.unregister(h.as_str());
    }
    Ok(())
}

#[tauri::command]
fn snipcast_preset_hotkeys_resume(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?.clone();
    apply_preset_hotkeys(&app, &cfg)
}

/// Статус внешнего API (для настроек).
#[tauri::command]
fn snipcast_api_status() -> Result<serde_json::Value, String> {
    let (running, port) = api::status();
    let token = data::ensure_api_token().unwrap_or_default();
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "token": token,
        "tokenPath": data::api_token_path().to_string_lossy(),
        "enabled": running,
    }))
}

/// Перевыпустить токен внешнего API (старый перестаёт работать сразу).
#[tauri::command]
fn snipcast_api_token_regenerate(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<String, String> {
    let token_path = data::api_token_path();
    let _ = std::fs::remove_file(&token_path);
    let token = data::ensure_api_token()?;
    let cfg = state.lock().map_err(|e| e.to_string())?.clone();
    api::apply_config(&app, &cfg);
    Ok(token)
}

#[tauri::command]
fn snipcast_palette_hotkey_pause(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let _ = app.global_shortcut().unregister(cfg.palette_hotkey.trim());
    Ok(())
}

#[tauri::command]
fn snipcast_palette_hotkey_resume(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let h = cfg.palette_hotkey.trim();
    let _ = app.global_shortcut().unregister(h);
    apply_palette_hotkey(&app, None, h)?;
    Ok(())
}

#[tauri::command]
fn snipcast_screenshot_hotkey_pause(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let h = cfg.screenshot_hotkey.trim();
    if !h.is_empty() {
        let _ = app.global_shortcut().unregister(h);
    }
    Ok(())
}

#[tauri::command]
fn snipcast_screenshot_hotkey_resume(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let h = cfg.screenshot_hotkey.trim();
    let _ = app.global_shortcut().unregister(h);
    apply_screenshot_hotkey(&app, None, h)?;
    Ok(())
}

#[tauri::command]
fn snipcast_get_variables() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    data::load_variables_map()
}

#[tauri::command]
fn snipcast_save_variables(map: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    data::save_variables_map(&map)
}

#[tauri::command]
fn snipcast_list_templates(state: State<'_, Mutex<data::AppConfig>>) -> Result<Vec<data::TemplateRow>, String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    data::load_all_templates(&cfg)
}

#[tauri::command]
fn snipcast_get_template_store() -> Result<data::TemplateStore, String> {
    data::load_template_store()
}

#[tauri::command]
fn snipcast_save_template_store(store: data::TemplateStore) -> Result<(), String> {
    data::save_template_store(&store)
}

#[tauri::command]
fn snipcast_import_master_group(path: String) -> Result<data::TemplateGroup, String> {
    data::import_master_group_from_file(&path)
}

#[tauri::command]
fn snipcast_import_template_group(path: String) -> Result<data::TemplateGroup, String> {
    data::import_template_group_from_file(&path)
}

#[tauri::command]
fn snipcast_export_template_group(group_id: String, path: String) -> Result<(), String> {
    data::export_template_group_to_file(&group_id, &path)
}

#[tauri::command]
fn snipcast_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    refresh_paste_target(&app);
    let w = app
        .get_webview_window(SETTINGS_WINDOW_LABEL)
        .ok_or_else(|| "окно настроек не найдено".to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn snipcast_get_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

// --- Скриншоты ---

/// Тяжёлые команды скриншотера — async: синхронные команды Tauri выполняет
/// в главном потоке, и захват/OCR/создание окна замораживали UI (вплоть до
/// дедлока при создании окна закрепа из контекста события).
#[tauri::command]
async fn snipcast_start_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_capture_notify(&app, None))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
async fn snipcast_close_capture(app: tauri::AppHandle) {
    screenshot::close_capture(&app);
}

/// Оверлей загрузил кадр — показать окно (без «пустого» кадра при появлении).
#[tauri::command]
async fn snipcast_capture_ready(app: tauri::AppHandle, label: String, image_name: Option<String>) {
    screenshot::show_capture_ready(&app, &label, image_name.as_deref());
}

/// Инфо о мониторе для оверлея `capture-N` (позиция, размер, имя файла снимка).
#[tauri::command]
fn snipcast_capture_info(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<screenshot::CaptureInfoDto, String> {
    screenshot::capture_info_for_label(&app, window.label())
}

/// PNG-байты снимка/закрепа сырым ответом (ArrayBuffer на фронте, canvas не «пачкается»).
#[tauri::command]
async fn snipcast_capture_image_data(
    app: tauri::AppHandle,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || screenshot::image_data_bytes(&app2, &name))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn snipcast_capture_copy(png: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || screenshot::copy_to_clipboard(&png))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn snipcast_capture_save(
    cfg: State<'_, Mutex<data::AppConfig>>,
    png: String,
    path: String,
    format: Option<String>,
    quality: Option<u8>,
) -> Result<(), String> {
    let (fmt, q) = {
        let c = cfg.lock().map_err(|e| e.to_string())?;
        (
            format.unwrap_or_else(|| c.screenshot_format.clone()),
            quality.unwrap_or(c.screenshot_jpeg_quality),
        )
    };
    tauri::async_runtime::spawn_blocking(move || screenshot::save_to_file(&png, Path::new(&path), &fmt, q))
        .await
        .map_err(|e| e.to_string())?
}

/// Полный путь для быстрого сохранения: шаблон имени из настроек + защита от перезаписи.
#[tauri::command]
fn snipcast_capture_save_path(
    state: State<'_, Mutex<data::AppConfig>>,
    shot: State<'_, Mutex<screenshot::ScreenshotState>>,
    dir: String,
    ext: Option<String>,
    template: Option<String>,
) -> Result<String, String> {
    let c = state.lock().map_err(|e| e.to_string())?;
    let ext = ext.unwrap_or_else(|| {
        if c.screenshot_format.eq_ignore_ascii_case("jpeg") {
            "jpg".to_string()
        } else {
            "png".to_string()
        }
    });
    // Шаблон пресета имеет приоритет над общим шаблоном из настроек.
    let tpl = match template {
        Some(t) if !t.trim().is_empty() => t,
        _ => c.screenshot_file_template.clone(),
    };
    let seq = {
        let mut st = shot.lock().map_err(|e| e.to_string())?;
        st.save_seq += 1;
        st.save_seq
    };
    let p = screenshot::prepare_save_path(&dir, &tpl, &ext, seq)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn snipcast_capture_pin(
    app: tauri::AppHandle,
    png: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || screenshot::create_pin(&app2, &png, x, y, width, height))
        .await
        .map_err(|e| e.to_string())?
}

/// Инфо о закрепе для окна `pin-N`.
#[tauri::command]
fn snipcast_pin_info(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<screenshot::PinInfoDto, String> {
    screenshot::pin_info_for_label(&app, window.label())
}

#[tauri::command]
async fn snipcast_close_all_pins(app: tauri::AppHandle) {
    screenshot::close_all_pins(&app);
}

/// Открыть контекстное меню закрепа в точке экрана (физ. px) отдельным окном.
#[tauri::command]
async fn snipcast_pin_menu(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    scale: f64,
    label: String,
) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        screenshot::show_pin_menu(&app2, x, y, scale, &label)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Действие из контекстного меню закрепа.
#[tauri::command]
async fn snipcast_pin_menu_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let action_app = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || screenshot::pin_menu_action(&action_app, &action))
        .await.map_err(|e| e.to_string())?;
    if res.is_ok() { screenshot::close_pin_menu(&app); }
    res
}

#[tauri::command]
async fn snipcast_pin_begin_annotation(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<screenshot::PinEditGeometry, String> {
    let label = window.label().to_string();
    screenshot::pin_ui(app,move |app| screenshot::begin_pin_annotation(app,&label)).await
}

#[tauri::command]
async fn snipcast_pin_update(app: tauri::AppHandle, window: tauri::WebviewWindow, png: String) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || screenshot::update_pin_image(&app, &label, &png))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn snipcast_clipboard_write_text(text: String) -> Result<(), String> {
    rich_clipboard::write_plain_text(&text)
}

/// Распознать текст в области активного захвата (кроп берётся из чистого снимка).
#[tauri::command]
async fn snipcast_ocr_region(
    app: tauri::AppHandle,
    cfg: State<'_, Mutex<data::AppConfig>>,
    label: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    engine: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    let (eng, lang, quality) = {
        let c = cfg.lock().map_err(|e| e.to_string())?;
        (
            engine.unwrap_or_else(|| c.screenshot_ocr_engine.clone()),
            language.unwrap_or_else(|| c.screenshot_ocr_language.clone()),
            c.screenshot_ocr_quality.clone(),
        )
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let png = screenshot::crop_from_capture(&app2, &label, x, y, width, height)?;
        match eng.as_str() {
            "paddle" => {
                #[cfg(target_os = "windows")]
                {
                    paddle::paddle::recognize(&png, &quality)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = &quality;
                    Err("PaddleOCR доступен только в Windows".to_string())
                }
            }
            _ => ocr::recognize_system(&png, &lang),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Статус моделей PaddleOCR: установлены/чего не хватает.
#[tauri::command]
fn snipcast_ocr_models_status(
    cfg: State<'_, Mutex<data::AppConfig>>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let c = cfg.lock().map_err(|e| e.to_string())?;
        let quality = paddle::paddle::normalize_quality(&c.screenshot_ocr_quality);
        let missing = paddle::paddle::missing_files(&quality);
        Ok(serde_json::json!({
            "installed": missing.is_empty(),
            "downloading": paddle::paddle::is_downloading(),
            "missing": missing,
            "quality": quality,
            "downloadMb": if quality == "server" { paddle::paddle::DOWNLOAD_SRV_MB } else { paddle::paddle::DOWNLOAD_MB },
        }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "installed": false, "downloading": false, "missing": [], "unsupported": true, "downloadMb": 0 }))
    }
}

/// Скачать модели PaddleOCR (в фоне, прогресс через `snipcast://ocr-progress`).
#[tauri::command]
fn snipcast_ocr_download_models(
    app: tauri::AppHandle,
    cfg: State<'_, Mutex<data::AppConfig>>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Emitter;
        if paddle::paddle::is_downloading() {
            return Err("загрузка уже идёт".to_string());
        }
        let quality = {
            let c = cfg.lock().map_err(|e| e.to_string())?;
            paddle::paddle::normalize_quality(&c.screenshot_ocr_quality)
        };
        if paddle::paddle::ready(&quality) {
            return Ok(());
        }
        let app2 = app.clone();
        std::thread::spawn(move || {
            let emit = |stage: &str, done: u64, total: u64, message: &str| {
                let _ = app2.emit(
                    "snipcast://ocr-progress",
                    serde_json::json!({ "stage": stage, "done": done, "total": total, "message": message }),
                );
            };
            match paddle::paddle::download_all(&quality, &emit) {
                Ok(()) => emit("done", 1, 1, "Модели загружены"),
                Err(err) => emit("error", 0, 0, &err),
            }
        });
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("PaddleOCR доступен только в Windows".to_string())
    }
}

/// Языки системного OCR (для выпадающего списка в настройках).
#[tauri::command]
fn snipcast_ocr_languages() -> Vec<String> {
    ocr::available_languages()
}

pub fn run() {
    #[cfg(target_os="windows")]
    {
        // GDI sources already contain the display's RGB values. WebView2's
        // monitor-profile conversion would transform them a second time.
        // Set this before creating the shared environment; retain QA/debug args.
        let args=std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !args.split_whitespace().any(|arg|arg=="--force-color-profile=srgb") {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",format!("{args} --force-color-profile=srgb"));
        }
    }
    // Файл прошлой версии занят, пока она работает, — убираем его уже после перезапуска.
    updater::cleanup_after_update();

    if let Err(e) = data::init_data_tree() {
        eprintln!("[snipcast] init_data_tree: {e}");
    }

    // Temp-файлы снимков прошлой сессии (оверлеи/закрепы не закрылись штатно).
    screenshot::cleanup_stale();

    // Загружаем до setup: окно палитры может вызвать IPC сразу после load, а state из setup приходит позже.
    let initial_cfg = data::load_config().unwrap_or_default();
    let setup_hotkey = initial_cfg.palette_hotkey.clone();
    let setup_autostart = initial_cfg.autostart;
    let setup_screenshot_hotkey = initial_cfg.screenshot_hotkey.clone();

    let mut builder = tauri::Builder::default()
        .register_uri_scheme_protocol("snipcast-video", |ctx, request| video::media_response(ctx.app_handle(), request))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Повторный запуск: показать палитру уже работающего экземпляра.
            show_palette(app);
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(ShortcutPluginBuilder::new().build());

    builder = builder
        .manage(Mutex::new(None::<i32>))
        .manage(Mutex::new(PasteTarget::default()))
        .manage(Mutex::new(initial_cfg.clone()))
        .manage(Mutex::new(screenshot::ScreenshotState::default()))
        .manage(video::VideoState::default())
        .manage(ai::AiAgentState::default())
        .manage(updater::UpdateRuntime::default())
        .manage(text_suggestions::Runtime::default())
        .manage(Mutex::new(PresetHotkeys::default()))
        .manage(Mutex::new(None::<TrayIcon>))
        .setup(move |app| {
            let hotkey = setup_hotkey;
            if let Err(e) = apply_palette_hotkey(&app.handle(), None, &hotkey) {
                eprintln!("[snipcast] palette hotkey register failed ({hotkey}): {e}");
                let fallback = data::DEFAULT_PALETTE_HOTKEY;
                if hotkey.trim() != fallback {
                    let _ = apply_palette_hotkey(&app.handle(), None, fallback);
                }
            }

            let shot_hotkey = setup_screenshot_hotkey;
            if let Err(e) = apply_screenshot_hotkey(&app.handle(), None, &shot_hotkey) {
                eprintln!("[snipcast] screenshot hotkey register failed ({shot_hotkey}): {e}");
            }

            if let Err(e) = apply_preset_hotkeys(&app.handle(), &initial_cfg) {
                eprintln!("[snipcast] preset hotkeys: {e}");
            }

            api::apply_config(&app.handle(), &initial_cfg);
            if let Err(e)=text_suggestions::apply(app.handle(),&initial_cfg) {
                eprintln!("[snipcast] inline suggestions: {e}");
            }
            updater::start_scheduler(app.handle().clone());

            // Прогрев скрытых окон оверлеев захвата: первый после запуска
            // захват открывается бесшовно, без «холодного» моргания WebView2.
            // После старта — чтобы не тормозить запуск приложения.
            {
                let ah = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    screenshot::prewarm_capture_windows(&ah);
                });
            }

            if setup_autostart {
                let _ = app.autolaunch().enable();
            }

            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                macos_round_corners_now_and_delayed(&app.handle(), &w, 12.0);
            }

            let menu = build_tray_menu(&app.handle()).map_err(|e| e.to_string())?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Snipcast")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();
                    if let Some(preset_id) = id.strip_prefix("preset-") {
                        run_preset_by_id(app, preset_id);
                        return;
                    }
                    match id {
                        "show" => show_palette(app),
                        "screenshot" => {
                            if let Err(e) = start_capture_notify(app, None) {
                                eprintln!("[snipcast] start_capture (tray): {e}");
                            }
                        }
                        "close_all_pins" => screenshot::close_all_pins(app),
                        "video" => {
                            let ah=app.clone();
                            std::thread::spawn(move||{if let Err(e)=video::start_selection(&ah){eprintln!("[snipcast] video: {e}");}});
                        }
                        "settings" => {
                            refresh_paste_target(app);
                            let _ = snipcast_open_settings(app.clone());
                        }
                        "suggestions" => text_suggestions::toggle(app),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_palette(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let tray = tray_builder.build(app)?;
            if let Ok(mut slot) = app.state::<Mutex<Option<TrayIcon>>>().lock() {
                *slot = Some(tray);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            text_suggestions::snipcast_suggestions_view,
            text_suggestions::snipcast_suggestions_status,
            text_suggestions::snipcast_suggestions_pending,
            text_suggestions::snipcast_suggestions_action,
            text_suggestions::snipcast_suggestions_complete,
            text_suggestions::snipcast_suggestions_hotkeys_pause,
            text_suggestions::snipcast_suggestions_hotkeys_resume,
            palette_hide,
            paste_insert::paste_template,
            paste_insert::paste_template_text_then_files,
            snipcast_clipboard_read_text,
            snipcast_get_paths,
            snipcast_get_config,
            snipcast_save_config,
            snipcast_palette_hotkey_pause,
            snipcast_palette_hotkey_resume,
            snipcast_get_variables,
            snipcast_save_variables,
            snipcast_list_templates,
            snipcast_get_template_store,
            snipcast_save_template_store,
            snipcast_import_master_group,
            snipcast_import_template_group,
            snipcast_export_template_group,
            snipcast_open_settings,
            snipcast_get_version,
            video::snipcast_video_select,
            video::snipcast_video_start,
            video::snipcast_video_status,
            video::snipcast_video_ready,
            video::snipcast_video_pause,
            video::snipcast_video_stop,
            video::snipcast_video_export,
            video::snipcast_video_cancel_export,
            snipcast_start_screenshot,
            capture_history::snipcast_capture_history_list,
            capture_history::snipcast_capture_history_open,
            capture_history::snipcast_capture_history_record,
            snipcast_close_capture,
            capture_keyboard::snipcast_capture_keyboard_state,
            snipcast_capture_ready,
            snipcast_capture_info,
            snipcast_capture_image_data,
            snipcast_capture_copy,
            snipcast_capture_save,
            snipcast_capture_save_path,
            snipcast_capture_pin,
            snipcast_pin_info,
            screenshot::snipcast_pin_ready,
            snipcast_close_all_pins,
            snipcast_pin_menu,
            snipcast_pin_menu_action,
            snipcast_pin_begin_annotation,
            snipcast_pin_update,
            screenshot::snipcast_pin_regions,
            screenshot::snipcast_pin_end_annotation,
            screenshot::snipcast_pin_present,
            screenshot::snipcast_capture_move_cursor,
            snipcast_clipboard_write_text,
            snipcast_ocr_region,
            snipcast_ocr_languages,
            snipcast_ocr_models_status,
            snipcast_ocr_download_models,
            snipcast_api_status,
            snipcast_api_token_regenerate,
            snipcast_preset_hotkeys_pause,
            snipcast_preset_hotkeys_resume,
            snipcast_screenshot_hotkey_pause,
            snipcast_screenshot_hotkey_resume,
            ai::snipcast_ai_attach,
            ai::snipcast_ai_history,
            ai::snipcast_ai_image,
            ai::snipcast_ai_expand_origin,
            ai::snipcast_ai_send,
            ai::snipcast_ai_clear,
            ai::snipcast_ai_test,
            updater::snipcast_check_update,
            updater::snipcast_install_update,
            updater::snipcast_update_writable,
            updater::snipcast_update_notice_info,
            updater::snipcast_skip_update,
            updater::snipcast_dismiss_update,
        ]);

    builder
        .on_window_event(|window, event| {
            let label = window.label();
            if [video::CONTROL,video::EDITOR].contains(&label) {
                if let tauri::WindowEvent::Destroyed=event {video::window_closed(window.app_handle(),label);}
                if let tauri::WindowEvent::Resized(_)=event {if let Some(w)=window.app_handle().get_webview_window(label){video::configure_window_frame(&w);}}
                return;
            }
            if label == updater::NOTICE_LABEL {
                if let tauri::WindowEvent::CloseRequested{api,..}=event {
                    api.prevent_close();let _=updater::dismiss_notice(window.app_handle(),None);
                }
                return;
            }
            // Оверлеи захвата и закрепы: чистим состояние при любом закрытии.
            if label.starts_with(screenshot::CAPTURE_PREFIX) {
                if let tauri::WindowEvent::Destroyed = event {
                    let l = label.to_string();
                    screenshot::on_capture_window_destroyed(&window.app_handle(), &l);
                }
                return;
            }
            if label == screenshot::PINMENU_LABEL {
                // Клик мимо меню = потеря фокуса: закрываем, как нативное меню.
                // Исключение — grace-период после показа (MENU_FOCUS_GRACE):
                // при создании окно соревнуется за фокус с закрепом, и ложная
                // потеря фокуса закрывала меню сразу после открытия.
                if let tauri::WindowEvent::Focused(false) = event {
                    let in_grace = {
                        let state = window
                            .app_handle()
                            .state::<Mutex<screenshot::ScreenshotState>>();
                        state
                            .lock()
                            .ok()
                            .and_then(|st| st.menu_shown_at)
                            .map(|t| t.elapsed() < screenshot::MENU_FOCUS_GRACE)
                            .unwrap_or(false)
                    };
                    if in_grace {
                        let _ = window.set_focus();
                    } else {
                        let selected = {let state=window.app_handle().state::<Mutex<screenshot::ScreenshotState>>();
                            state.lock().ok().and_then(|s|s.selected_pin.clone())};
                        if selected.as_ref().is_some_and(|l|window.app_handle().get_webview_window(l)
                            .and_then(|w|w.is_focused().ok())!=Some(true)) {
                            screenshot::select_pin(window.app_handle(),None);
                        }
                        let _ = window.close();
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    let state=window.app_handle().state::<Mutex<screenshot::ScreenshotState>>();
                    if let Ok(mut st)=state.lock(){st.menu_for=None;st.menu_shown_at=None;};
                }
                return;
            }

            if label.starts_with(screenshot::PIN_PREFIX) {
                if let tauri::WindowEvent::Focused(focused)=event {
                    if *focused { screenshot::select_pin(window.app_handle(),Some(label.to_string())); }
                    else {
                        let clear={let state=window.app_handle().state::<Mutex<screenshot::ScreenshotState>>();
                            state.lock().map(|s|s.selected_pin.as_deref()==Some(label) && s.menu_for.as_deref()!=Some(label)).unwrap_or(false)};
                        if clear {screenshot::select_pin(window.app_handle(),None);}
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    screenshot::on_pin_window_destroyed(&window.app_handle(), &label);
                }
                return;
            }

            if window.label() == ai::AI_WINDOW_LABEL {
                // Чат закрыли — диалог стирается целиком: следующий запуск
                // «ИИ Агент» начинается с чистого листа.
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().state::<ai::AiAgentState>().reset();
                }
                return;
            }

            if window.label() == SETTINGS_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                } else if let tauri::WindowEvent::Focused(false) = event {
                    refresh_paste_target(&window.app_handle());
                }
                return;
            }

            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                macos_round_corners_on_window_resize(window);
            }
            if let tauri::WindowEvent::Focused(false) = event {
                refresh_paste_target(&window.app_handle());
                let app = window.app_handle().clone();
                let label = MAIN_WINDOW_LABEL.to_string();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    if let Some(w) = app.get_webview_window(&label) {
                        if let Ok(focused) = w.is_focused() {
                            if !focused {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Snipcast");
}
