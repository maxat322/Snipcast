#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod paste_target;

#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "paste_target_stub.rs"]
mod paste_target;

#[cfg(target_os = "macos")]
mod macos_window;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

use paste_target::PasteTarget;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{Builder as ShortcutPluginBuilder, ShortcutState};

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";

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
            *g = paste_target::capture_target_windows();
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

        // Пока палитра в фокусе, frontmost = Snipcast; подставляем последний «чужой» PID/HWND.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(
        ShortcutPluginBuilder::new()
            .with_shortcuts([DEFAULT_HOTKEY])
            .expect("invalid default global shortcut")
            .with_handler(|app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                show_palette(app);
            })
            .build(),
    );

    builder
        .manage(Mutex::new(None::<i32>))
        .manage(Mutex::new(PasteTarget::default()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                macos_round_corners_now_and_delayed(&app.handle(), &w, 12.0);
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let show = MenuItem::with_id(app, "show", "Show palette", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Snipcast", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;

                let mut tray_builder = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Snipcast")
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| {
                        match event.id.as_ref() {
                            "show" => show_palette(app),
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
        })
        .invoke_handler(tauri::generate_handler![palette_hide, paste_template])
        .on_window_event(|window, event| {
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
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Snipcast");
}
