use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
mod applications;
#[cfg(target_os = "windows")]
mod clipboard_windows;
pub mod history;
pub mod translate;
pub const WINDOW: &str = "command-tool";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ItemConfig {
    pub enabled: bool,
    pub alias: String,
    pub hotkey: String,
}
impl Default for ItemConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            alias: String::new(),
            hotkey: String::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub applications_enabled: bool,
    pub items: BTreeMap<String, ItemConfig>,
    pub folders: Vec<String>,
    pub clipboard_enabled: bool,
    pub retention_days: u32,
    pub storage_mb: u32,
    pub ocr: bool,
    pub excluded_apps: Vec<String>,
    pub emoji_columns: u8,
    pub emoji_action: String,
    pub skin_tone: String,
    pub source_language: String,
    pub target_language: String,
    #[serde(default)]
    pub language_usage: BTreeMap<String, u32>,
}
impl Default for Config {
    fn default() -> Self {
        let mut items = BTreeMap::new();
        for (id, key) in [
            ("clipboard", "Alt+V"),
            ("emoji", "Alt+E"),
            ("translate", "Alt+T"),
        ] {
            items.insert(
                id.into(),
                ItemConfig {
                    hotkey: key.into(),
                    ..Default::default()
                },
            );
        }
        Self {
            enabled: true,
            applications_enabled: true,
            items,
            folders: vec![],
            clipboard_enabled: true,
            retention_days: 30,
            storage_mb: 1024,
            ocr: false,
            excluded_apps: vec![],
            emoji_columns: 7,
            emoji_action: "paste".into(),
            skin_tone: String::new(),
            source_language: "en".into(),
            target_language: "ru".into(),
            language_usage: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub icon: String,
    pub keywords: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub count: u64,
    #[serde(default)]
    pub last_used: i64,
}
#[derive(Default)]
pub struct Runtime {
    pub settings_target: Mutex<Option<String>>,
    pub apps: Mutex<Vec<Entry>>,
    pub registered: Mutex<Vec<String>>,
    pub section: Mutex<String>,
    opening: Mutex<Opening>,
    pub scanning: AtomicBool,
    pub error: Mutex<String>,
    pub usage: Mutex<BTreeMap<String, (u64, i64)>>,
}
#[derive(Clone, Serialize)]
pub struct OpenRequest {
    id: u64,
    section: String,
}
#[derive(Default)]
struct Opening {
    serial: u64,
    pending: Option<OpenRequest>,
}
pub fn config(app: &AppHandle) -> Config {
    app.state::<Mutex<crate::data::AppConfig>>()
        .lock()
        .unwrap()
        .commands
        .clone()
}
pub fn entries(app: &AppHandle) -> Vec<Entry> {
    let cfg = app
        .state::<Mutex<crate::data::AppConfig>>()
        .lock()
        .unwrap()
        .clone();
    let mut list = vec![];
    for (id, title, icon, keywords) in [
        (
            "clipboard",
            "Буфер обмена",
            "📋",
            "clipboard history история",
        ),
        ("emoji", "Emoji", "😀", "эмодзи смайлы символы"),
        (
            "translate",
            "Переводчик",
            "🌐",
            "translate translation перевод",
        ),
        ("calculator", "Калькулятор", "🧮", "calculator вычислить"),
        ("templates", "Палитра шаблонов", "▤", "templates snippets"),
        ("screenshot", "Скриншот", "▣", "screenshot capture снимок"),
        ("video", "Запись экрана", "⏺", "video record видео"),
        ("ai", "ИИ-агент", "✦", "AI чат"),
        ("settings", "Настройки", "⚙", "settings команды"),
        (
            "suggestions",
            "Переключить быструю палитру",
            "▤",
            "подсказки suggestions",
        ),
        (
            "close-pins",
            "Закрыть закреплённые снимки",
            "×",
            "pins закрепы",
        ),
        ("quit", "Выйти из Snipcast", "⏻", "exit выход"),
    ] {
        list.push(Entry {
            id: id.into(),
            title: title.into(),
            kind: "command".into(),
            icon: icon.into(),
            keywords: keywords.into(),
            target: String::new(),
            count: 0,
            last_used: 0,
        });
    }
    for p in &cfg.screenshot_presets {
        list.push(Entry {
            id: format!("preset:{}", p.id),
            title: format!("Скриншот: {}", p.title),
            kind: "command".into(),
            icon: "▣".into(),
            keywords: "preset пресет".into(),
            target: String::new(),
            count: 0,
            last_used: 0,
        });
    }
    list.extend(app.state::<Runtime>().apps.lock().unwrap().clone());
    let rt = app.state::<Runtime>();
    let usage = rt.usage.lock().unwrap();
    for item in &mut list {
        if let Some((n, t)) = usage.get(&item.id) {
            item.count = *n;
            item.last_used = *t;
        }
    }
    list
}
fn command_enabled(cfg: &Config, id: &str) -> bool {
    let independent = matches!(id, "root" | "templates" | "unified" | "settings" | "command-settings" | "quit");
    (independent || cfg.enabled && (!id.starts_with("app:") || cfg.applications_enabled))
        && cfg.items.get(id).is_none_or(|item| item.enabled)
}
pub(crate) fn bindings(cfg: &crate::data::AppConfig) -> Vec<(String, String)> {
    let mut v = vec![];
    for (id, item) in &cfg.commands.items {
        if item.enabled && command_enabled(&cfg.commands, id)
            && !["root", "templates", "screenshot", "suggestions", "unified"].contains(&id.as_str())
            && !id.starts_with("preset:")
        {
            v.push((id.clone(), item.hotkey.clone()));
        }
    }
    v
}
pub fn validate(cfg: &crate::data::AppConfig) -> Result<(), String> {
    let mut occupied = std::collections::HashSet::new();
    for h in cfg
        .screenshot_presets
        .iter()
        .map(|p| p.hotkey.as_str())
        .chain([
            cfg.palette_hotkey.as_str(),
            cfg.screenshot_hotkey.as_str(),
            cfg.palette_hotkey_secondary.as_str(),
            cfg.screenshot_hotkey_secondary.as_str(),
            cfg.text_suggestions.toggle_hotkey.as_str(),
        ])
    {
        if let Ok(s) = crate::mouse_hotkeys::parse(h) {
            occupied.insert(s);
        }
    }
    for (id, h) in bindings(cfg) {
        if h.is_empty() {
            continue;
        }
        let s = crate::mouse_hotkeys::parse(&h).map_err(|e| format!("{id}: {e}"))?;
        if !occupied.insert(s) {
            return Err(format!("Комбинация {h} уже используется"));
        }
    }
    if !(6..=10).contains(&cfg.commands.emoji_columns) || cfg.commands.storage_mb < 32 {
        return Err("Проверьте количество колонок и лимит хранилища (не менее 32 МБ)".into());
    }
    Ok(())
}
pub fn apply(app: &AppHandle, cfg: &crate::data::AppConfig) -> Result<(), String> {
    rebind(app, cfg, true)
}
pub fn hotkeys_changed(a: &crate::data::AppConfig, b: &crate::data::AppConfig) -> bool {
    bindings(a) != bindings(b)
}
pub fn restore_available(app: &AppHandle, cfg: &crate::data::AppConfig) {
    if let Err(e) = rebind(app, cfg, false) {
        report(app, e)
    }
}
fn rebind(app: &AppHandle, cfg: &crate::data::AppConfig, strict: bool) -> Result<(), String> {
    pause(app);
    let mut added: Vec<String> = vec![];
    let mut errors = vec![];
    for (id, h) in bindings(cfg) {
        if h.is_empty() || crate::mouse_hotkeys::is_mouse(&h) {
            continue;
        }
        let action = id.clone();
        if let Err(e) = app
            .global_shortcut()
            .on_shortcut(h.as_str(), move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    let id = action.clone();
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Err(e) = execute(&app2, &id) {
                            report(&app2, e);
                        }
                    });
                }
            })
        {
            let error = format!("Не удалось назначить {h}: {e}");
            if strict {
                for key in added {
                    let _ = app.global_shortcut().unregister(key.as_str());
                }
                return Err(error);
            }
            errors.push(error);
            continue;
        }
        added.push(h);
    }
    *app.state::<Runtime>().registered.lock().unwrap() = added;
    crate::mouse_hotkeys::pause(app,crate::mouse_hotkeys::COMMANDS,false);
    if errors.is_empty() {
        *app.state::<Runtime>().error.lock().unwrap() = String::new();
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
pub fn pause(app: &AppHandle) {
    crate::mouse_hotkeys::pause(app,crate::mouse_hotkeys::COMMANDS,true);
    // Native shortcut calls can synchronously dispatch back to the UI thread.
    // Never keep our state mutex while waiting for them.
    let keys = std::mem::take(&mut *app.state::<Runtime>().registered.lock().unwrap());
    for h in keys {
        let _ = app.global_shortcut().unregister(h.as_str());
    }
}
pub fn report(app: &AppHandle, error: String) {
    *app.state::<Runtime>().error.lock().unwrap() = error.clone();
    let _ = app.emit("snipcast://commands-error", error);
}
fn create_tool_window(app:&AppHandle)->Result<tauri::WebviewWindow,String> {
    if let Some(window)=app.get_webview_window(WINDOW){return Ok(window)}
    let mut config=app.config().app.windows.iter().find(|w|w.label==crate::MAIN_WINDOW_LABEL)
        .ok_or("Шаблон палитры недоступен")?.clone();
    config.label=WINDOW.into();config.title="Инструмент — Snipcast".into();config.visible=false;
    config.url=tauri::WebviewUrl::App("index.html?snipcast=command-tool".into());
    let builder=tauri::WebviewWindowBuilder::from_config(app,&config).map_err(|e|e.to_string())?;
    #[cfg(feature="inline-qa")]
    let builder=builder.data_directory(crate::data::snipcast_base_dir().join("webview"));
    builder.build().map_err(|e|e.to_string())
}
pub fn show(app: &AppHandle, section: &str) -> Result<(), String> {
    if !command_enabled(&config(app), section) {
        return Err("Команды отключены".into());
    }
    if section == "root" { crate::show_palette(app); return Ok(()); }
    let rt = app.state::<Runtime>();
    crate::refresh_paste_target(app);
    let w = app.get_webview_window(WINDOW).ok_or("Окно инструмента недоступно")?;
    let title=match section {"clipboard"=>"Буфер обмена","emoji"=>"Emoji","translate"=>"Переводчик","calculator"=>"Калькулятор",_=>return Err("Неизвестный инструмент".into())};
    let _=w.set_title(&format!("{title} — Snipcast"));
    let mut opening = rt.opening.lock().unwrap();
    if (w.is_visible().unwrap_or(false) && *rt.section.lock().unwrap() == section)
        || opening.pending.as_ref().is_some_and(|p| p.section == section) {
        opening.pending = None;
        w.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }
    crate::hide_palette(app);
    // Keep the previous section off screen until React has committed the requested one.
    w.hide().map_err(|e| e.to_string())?;
    opening.serial += 1;
    let request = OpenRequest { id: opening.serial, section: section.into() };
    opening.pending = Some(request.clone());
    frame(&w);
    w.center().map_err(|e| e.to_string())?;
    app.emit_to(WINDOW, "snipcast://commands-open", request).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn frame(w: &tauri::WebviewWindow) {
    // Windows uses exactly the ordinary palette frame; no custom HWND region.
    #[cfg(not(target_os = "macos"))]
    let _ = w;
    #[cfg(target_os = "macos")]
    crate::macos_round_corners_now_and_delayed(w.app_handle(), w, 12.0);
}
pub fn cancel_opening(app: &AppHandle) {
    let pending = app.state::<Runtime>().opening.lock().unwrap().pending.take().is_some();
    if pending || app.get_webview_window(WINDOW).is_some() { hide(app); }
}
pub fn hide(app: &AppHandle) {
    app.state::<Runtime>().opening.lock().unwrap().pending = None;
    *app.state::<Runtime>().section.lock().unwrap() = "root".into();
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.hide();
    }
}
pub fn execute(app: &AppHandle, id: &str) -> Result<(), String> {
    if !command_enabled(&config(app), id) {
        return Err("Команда отключена".into());
    }
    if id == "unified" {
        // Compatibility for a direct call from the experimental release, without a hotkey.
        crate::show_palette(app);
        return Ok(());
    }
    if id == "root" {
        return show(app, "root");
    }
    if config(app).items.get(id).is_some_and(|i| !i.enabled) {
        return Err("Команда отключена".into());
    }
    if ["clipboard", "emoji", "translate", "calculator"].contains(&id) {
        return show(app, id);
    }
    if id == "screenshot" {
        crate::start_capture_notify(app,None)?;record_use(app,id);return Ok(());
    }
    hide(app);
    match id {
        "templates" => crate::show_palette(app),
        "settings" => {
            crate::snipcast_open_settings(app.clone())?;
        }
        "command-settings" => {
            *app.state::<Runtime>().settings_target.lock().unwrap() = Some("commands".into());
            crate::snipcast_open_settings(app.clone())?;
            let _ = app.emit_to("settings", "snipcast://commands-settings", ());
        }
        "video" => {
            crate::video::start_selection(app)?;
        }
        "ai" => crate::ai::create_or_show_ai_window(app, 200, 200, 760, 50),
        "suggestions" => crate::text_suggestions::toggle(app),
        "close-pins" => crate::screenshot::close_all_pins(app),
        "quit" => app.exit(0),
        _ if id.starts_with("preset:") => crate::run_preset_by_id(app, &id[7..]),
        _ => {
            let entry = app
                .state::<Runtime>()
                .apps
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.id == id)
                .cloned()
                .ok_or("Приложение не найдено. Обновите список")?;
            applications::launch(&entry)?;
        }
    }
    record_use(app, id);
    Ok(())
}
pub fn record_use(app: &AppHandle, id: &str) {
    let rt = app.state::<Runtime>();
    let mut u = rt.usage.lock().unwrap();
    let e = u.entry(id.into()).or_default();
    e.0 += 1;
    e.1 = chrono::Utc::now().timestamp();
    if let Ok(bytes) = serde_json::to_vec(&*u) {
        let _ = std::fs::write(
            crate::data::snipcast_base_dir().join("command-usage.json"),
            bytes,
        );
    }
}
pub fn start(app: &AppHandle) {
    let rt = app.state::<Runtime>();
    let base = crate::data::snipcast_base_dir();
    *rt.apps.lock().unwrap() = std::fs::read(base.join("applications.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    *rt.usage.lock().unwrap() = std::fs::read(base.join("command-usage.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let cfg = app
        .state::<Mutex<crate::data::AppConfig>>()
        .lock()
        .unwrap()
        .clone();
    if let Err(e) = validate(&cfg) {
        report(app, e);
    } else {
        restore_available(app, &cfg);
    }
    // Prepare the hidden tool during setup, never synchronously inside an IPC callback.
    if let Err(error)=create_tool_window(app){report(app,format!("Не удалось подготовить инструмент: {error}"));}
    applications::refresh(app.clone());
    applications::watch(app.clone());
    history::start(app.clone());
}
#[tauri::command]
pub fn snipcast_commands_catalog(app: AppHandle) -> serde_json::Value {
    let rt = app.state::<Runtime>();
    let pending = rt.opening.lock().unwrap().pending.clone();
    serde_json::json!({"entries":entries(&app),"usage":rt.usage.lock().unwrap().clone(),"config":config(&app),"section":rt.section.lock().unwrap().clone(),"pending":pending,"scanning":rt.scanning.load(Ordering::Relaxed),"error":rt.error.lock().unwrap().clone()})
}
#[tauri::command]
pub fn snipcast_commands_ready(app: AppHandle, id: u64) -> Result<(), String> {
    let rt = app.state::<Runtime>();
    let mut opening = rt.opening.lock().unwrap();
    if let Some(request) = opening.pending.as_ref().filter(|p| p.id == id) {
        let w = app.get_webview_window(WINDOW).ok_or("Палитра шаблонов недоступна")?;
        *rt.section.lock().unwrap() = request.section.clone();
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        opening.pending = None;
    }
    Ok(())
}
#[tauri::command]
pub fn snipcast_commands_settings_target(app: AppHandle) -> Option<String> {
    app.state::<Runtime>().settings_target.lock().unwrap().take()
}
#[tauri::command]
pub fn snipcast_commands_run(app: AppHandle, id: String) -> Result<(), String> {
    execute(&app, &id)
}
#[tauri::command]
pub fn snipcast_commands_refresh(app: AppHandle) {
    applications::refresh(app);
}
#[tauri::command]
pub fn snipcast_commands_section(app: AppHandle, section: String) {
    if ["root", "clipboard", "emoji", "translate", "calculator"].contains(&section.as_str()) {
        let rt = app.state::<Runtime>();
        let opening = rt.opening.lock().unwrap();
        if opening.pending.is_none() {
            *rt.section.lock().unwrap() = section;
        }
    }
}
#[tauri::command]
pub fn snipcast_commands_hide(app: AppHandle) {
    hide(&app)
}
#[tauri::command]
pub fn snipcast_commands_hotkeys_pause(app: AppHandle) {
    pause(&app)
}
#[tauri::command]
pub fn snipcast_commands_hotkeys_resume(app: AppHandle) {
    let cfg = app
        .state::<Mutex<crate::data::AppConfig>>()
        .lock()
        .unwrap()
        .clone();
    restore_available(&app, &cfg)
}
#[tauri::command]
pub async fn snipcast_commands_translate(
    text: String,
    source: String,
    target: String,
) -> Result<String, String> {
    translate::run(text, source, target).await
}
#[tauri::command]
pub async fn snipcast_commands_text(
    app: AppHandle,
    window: tauri::WebviewWindow,
    text: String,
    paste: bool,
    usage_id: Option<String>,
) -> Result<(), String> {
    if let Some(id) = usage_id {
        record_use(&app, &id)
    }
    history::suppress(&app, || crate::rich_clipboard::write_plain_text(&text))?;
    if paste {
        paste_current(&app, window, false).await?;
    }
    Ok(())
}
pub async fn paste_current(app: &AppHandle, window: tauri::WebviewWindow, keep: bool) -> Result<(), String> {
    let snap = app
        .state::<Mutex<crate::paste_target::PasteTarget>>()
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    #[cfg(target_os = "windows")]
    {
        let hwnd = snap
            .win_hwnd
            .or(snap.last_foreign_hwnd)
            .ok_or("Нет приложения для вставки. Содержимое осталось в буфере")?;
        if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(hwnd as _) } == 0 {
            return Err("Окно для вставки закрыто. Содержимое осталось в буфере".into());
        }
    }
    if window.label() == WINDOW {
        hide(app);
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(280));
        crate::paste_target::paste_into_previous(&snap);
        if keep {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_conflicts() {
        let mut c = crate::data::AppConfig::default();
        assert!(validate(&c).is_ok());
        c.commands.items.get_mut("emoji").unwrap().hotkey = c.palette_hotkey.clone();
        assert!(validate(&c).is_err());
    }
    #[test]
    fn retired_command_palette_has_no_shortcut_or_config_field() {
        let mut cfg = crate::data::AppConfig::default();
        cfg.commands = serde_json::from_str(r#"{"hotkey":"Alt+Space","items":{"root":{"hotkey":"Control+Q"}}}"#).unwrap();
        assert!(!serde_json::to_value(&cfg.commands).unwrap().as_object().unwrap().contains_key("hotkey"));
        assert!(!bindings(&cfg).iter().any(|(id,_)|id=="root"));
    }
    #[test]
    fn migration_defaults() {
        let c: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(c.retention_days, 30);
        assert_eq!(c.items["emoji"].hotkey, "Alt+E");
        assert!(c.language_usage.is_empty());
        assert!(c.enabled && c.applications_enabled);
    }
    #[test]
    fn group_switches_preserve_items_and_control_bindings() {
        let mut cfg = crate::data::AppConfig::default();
        cfg.commands.items.insert("app:test".into(), ItemConfig { hotkey: "Control+Shift+F6".into(), ..Default::default() });
        cfg.commands.items.insert("unified".into(), ItemConfig { hotkey: "Control+Shift+F7".into(), ..Default::default() });
        let original = cfg.commands.items.clone();
        let enabled_bindings = bindings(&cfg);
        cfg.commands.applications_enabled = false;
        assert!(!bindings(&cfg).iter().any(|(id, _)| id.starts_with("app:")));
        assert!(bindings(&cfg).iter().any(|(id, _)| id == "emoji"));
        assert!(!command_enabled(&cfg.commands, "app:test"));
        cfg.commands.enabled = false;
        assert!(bindings(&cfg).is_empty());
        for id in ["emoji", "clipboard", "translate", "calculator", "app:test"] {
            assert!(!command_enabled(&cfg.commands, id));
        }
        for id in ["root", "templates", "settings", "command-settings", "quit", "unified"] {
            assert!(command_enabled(&cfg.commands, id));
        }
        cfg.commands.enabled = true;
        cfg.commands.applications_enabled = true;
        assert_eq!(cfg.commands.items, original);
        assert_eq!(bindings(&cfg), enabled_bindings);
    }
    #[test]
    fn reenable_revalidates_retained_shortcuts() {
        let mut cfg = crate::data::AppConfig::default();
        cfg.commands.enabled = false;
        cfg.commands.items.get_mut("emoji").unwrap().hotkey = cfg.palette_hotkey.clone();
        assert!(validate(&cfg).is_ok());
        cfg.commands.enabled = true;
        assert!(validate(&cfg).is_err());
    }
    #[test]
    fn retired_unified_hotkey_is_not_registered_or_validated() {
        let mut cfg = crate::data::AppConfig::default();
        assert!(!bindings(&cfg).iter().any(|(id, _)| id == "unified"));
        cfg.commands.items.insert("unified".into(), ItemConfig { hotkey: "Control+Shift+F6".into(), ..Default::default() });
        assert!(validate(&cfg).is_ok());
        assert!(!bindings(&cfg).iter().any(|(id, _)| id == "unified"));
        cfg.commands.items.get_mut("unified").unwrap().hotkey = cfg.palette_hotkey.clone();
        assert!(validate(&cfg).is_ok());
    }
}
