#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod data;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod paste_target;

#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "paste_target_stub.rs"]
mod paste_target;

#[cfg(target_os = "macos")]
mod macos_window;

use std::sync::Mutex;
use std::str::FromStr;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

use paste_target::PasteTarget;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_autostart::ManagerExt;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{
    Builder as ShortcutPluginBuilder, GlobalShortcutExt, Shortcut, ShortcutState,
};

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
fn refresh_paste_target(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let lf = app.state::<Mutex<Option<i32>>>();
        let pt = app.state::<Mutex<PasteTarget>>();
        paste_target::sync_macos_paste_target(&*lf, &*pt);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(mut g) = app.state::<Mutex<PasteTarget>>().lock() {
            let captured = paste_target::capture_target_windows();
            if captured.win_hwnd.is_some() {
                *g = captured;
            }
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

fn hide_palette(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.hide();
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn apply_palette_hotkey(app: &tauri::AppHandle, previous: Option<&str>, next: &str) -> Result<(), String> {
    let next = next.trim();
    Shortcut::from_str(next).map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    if let Some(p) = previous {
        let p = p.trim();
        if !p.is_empty() && p != next {
            let _ = gs.unregister(p);
        }
    }
    gs.on_shortcut(next, |app, _, e| {
        if e.state == ShortcutState::Pressed {
            show_palette(app);
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn palette_hide(app: tauri::AppHandle) {
    hide_palette(&app);
}

#[tauri::command]
fn paste_template(
    app: tauri::AppHandle,
    target: State<'_, Mutex<PasteTarget>>,
    text: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        hide_palette(&app);
        return Ok(());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }

        refresh_paste_target(&app);

        arboard::Clipboard::new()
            .map_err(|e| e.to_string())?
            .set_text(text)
            .map_err(|e| e.to_string())?;

        hide_palette(&app);

        let snap = target.lock().map_err(|e| e.to_string())?.clone();

        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(280));
            paste_target::paste_into_previous(&snap);
        });

        Ok(())
    }
}

/// Чтение текста из буфера обмена ОС (WebView `navigator.clipboard` в палитре часто недоступен).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_clipboard_read_text() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match cb.get_text() {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_get_paths(state: State<'_, Mutex<data::AppConfig>>) -> Result<data::PathsDto, String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    Ok(data::paths_dto(&cfg))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_get_config(state: State<'_, Mutex<data::AppConfig>>) -> Result<data::AppConfig, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.clone())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_save_config(
    app: tauri::AppHandle,
    state: State<'_, Mutex<data::AppConfig>>,
    incoming: data::AppConfig,
    skip_palette_hotkey_apply: Option<bool>,
) -> Result<(), String> {
    Shortcut::from_str(incoming.palette_hotkey.trim()).map_err(|e| format!("Неверная комбинация клавиш: {e}"))?;

    let skip_hotkey = skip_palette_hotkey_apply.unwrap_or(false);
    let mut cfg = state.lock().map_err(|e| e.to_string())?;
    let prev_hotkey = cfg.palette_hotkey.clone();
    *cfg = incoming;
    data::save_config(&cfg)?;

    if prev_hotkey.trim() != cfg.palette_hotkey.trim() && !skip_hotkey {
        apply_palette_hotkey(&app, Some(&prev_hotkey), &cfg.palette_hotkey)?;
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_palette_hotkey_pause(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let _ = app.global_shortcut().unregister(cfg.palette_hotkey.trim());
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_palette_hotkey_resume(app: tauri::AppHandle, state: State<'_, Mutex<data::AppConfig>>) -> Result<(), String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    let h = cfg.palette_hotkey.trim();
    let _ = app.global_shortcut().unregister(h);
    apply_palette_hotkey(&app, None, h)?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_get_variables() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    data::load_variables_map()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_save_variables(map: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    data::save_variables_map(&map)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_list_templates(state: State<'_, Mutex<data::AppConfig>>) -> Result<Vec<data::TemplateRow>, String> {
    let cfg = state.lock().map_err(|e| e.to_string())?;
    data::load_all_templates(&cfg)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_get_template_store() -> Result<data::TemplateStore, String> {
    data::load_template_store()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_save_template_store(store: data::TemplateStore) -> Result<(), String> {
    data::save_template_store(&store)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_import_master_group(path: String) -> Result<data::TemplateGroup, String> {
    data::import_master_group_from_file(&path)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_import_template_group(path: String) -> Result<data::TemplateGroup, String> {
    data::import_template_group_from_file(&path)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window(SETTINGS_WINDOW_LABEL)
        .ok_or_else(|| "окно настроек не найдено".to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn snipcast_get_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Err(e) = data::init_data_tree() {
            eprintln!("[snipcast] init_data_tree: {e}");
        }
    }

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::Builder::new().build())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(ShortcutPluginBuilder::new().build());
    }

    builder = builder
        .manage(Mutex::new(None::<i32>))
        .manage(Mutex::new(PasteTarget::default()))
        .setup(|app| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let cfg = data::load_config().unwrap_or_default();
                let hotkey = cfg.palette_hotkey.clone();
                let autostart = cfg.autostart;
                if let Err(e) = apply_palette_hotkey(&app.handle(), None, &hotkey) {
                    eprintln!("[snipcast] palette hotkey register failed ({hotkey}): {e}");
                    let fallback = data::DEFAULT_PALETTE_HOTKEY;
                    if hotkey.trim() != fallback {
                        let _ = apply_palette_hotkey(&app.handle(), None, fallback);
                    }
                }
                app.manage(Mutex::new(cfg));

                if autostart {
                    let _ = app.autolaunch().enable();
                }
            }

            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                macos_round_corners_now_and_delayed(&app.handle(), &w, 12.0);
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let show = MenuItem::with_id(app, "show", "Открыть Snipcast", true, None::<&str>)?;
                let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

                let mut tray_builder = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Snipcast")
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| {
                        match event.id.as_ref() {
                            "show" => show_palette(app),
                            "settings" => {
                                let _ = snipcast_open_settings(app.clone());
                            }
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

                tray_builder.build(app)?;
            }

            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            palette_hide,
            paste_template,
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
            snipcast_open_settings,
            snipcast_get_version,
        ]);
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![palette_hide, paste_template,]);
    }

    builder
        .on_window_event(|window, event| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if window.label() == SETTINGS_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
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
