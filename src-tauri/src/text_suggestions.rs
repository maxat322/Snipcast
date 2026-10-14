//! Inline templates. The platform backend owns input; this module is pure search/session logic.
use crate::data::{AppConfig, TemplateChild, TemplateRow};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SuggestionsConfig {
    pub enabled: bool,
    pub mode: String,
    pub trigger: String,
    pub search_text: bool,
    pub min_chars: u32,
    pub toggle_hotkey: String,
    pub excluded_apps: Vec<String>,
}
impl Default for SuggestionsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: "automatic".into(),
            trigger: "=".into(),
            search_text: false,
            min_chars: 3,
            toggle_hotkey: "F9".into(),
            excluded_apps: vec![],
        }
    }
}
pub fn validate(cfg: &AppConfig) -> Result<(), String> {
    let s = &cfg.text_suggestions;
    if !(1..=128).contains(&s.min_chars) {
        return Err("Количество символов: от 1 до 128".into());
    }
    if !matches!(s.mode.as_str(), "trigger" | "automatic") {
        return Err("Неизвестный режим подсказок".into());
    }
    if s.trigger.chars().count() > 8
        || s.trigger
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c.is_alphanumeric())
    {
        return Err("Триггер: до 8 знаков без букв, цифр и пробелов".into());
    }
    if s.enabled && s.mode == "trigger" && s.trigger.is_empty() {
        return Err("Укажите текстовый триггер".into());
    }
    if s.excluded_apps.len() > 100 || s.excluded_apps.iter().any(|x| x.len() > 260) {
        return Err("Слишком большой список исключений".into());
    }
    let other = cfg
        .screenshot_presets
        .iter()
        .map(|p| p.hotkey.as_str())
        .chain([
            cfg.palette_hotkey.as_str(),
            cfg.screenshot_hotkey.as_str(),
            cfg.screenshot_save_hotkey.as_str(),
            cfg.screenshot_pin_hotkey.as_str(),
            cfg.screenshot_copy_hotkey.as_str(),
        ]);
    let occupied: Vec<_> = other
        .filter_map(|h| Shortcut::from_str(h.trim()).ok())
        .collect();
    for (label, value) in [("Включение подсказок", &s.toggle_hotkey)] {
        if value.trim().is_empty() {
            continue;
        }
        let sc = Shortcut::from_str(value.trim())
            .map_err(|_| format!("{label}: неверная горячая клавиша"))?;
        if sc.mods.is_empty()
            && !matches!(
                sc.key,
                Code::F1
                    | Code::F2
                    | Code::F3
                    | Code::F4
                    | Code::F5
                    | Code::F6
                    | Code::F7
                    | Code::F8
                    | Code::F9
                    | Code::F10
                    | Code::F11
                    | Code::F13
                    | Code::F14
                    | Code::F15
                    | Code::F16
                    | Code::F17
                    | Code::F18
                    | Code::F19
                    | Code::F20
                    | Code::F21
                    | Code::F22
                    | Code::F23
                    | Code::F24
            )
        {
            return Err(format!(
                "{label}: используйте модификатор или функциональную клавишу"
            ));
        }
        if sc.key == Code::F12 || sc.mods.contains(Modifiers::SUPER) {
            return Err(format!("{label}: комбинация зарезервирована системой"));
        }
        if occupied.contains(&sc) {
            return Err(format!("{label}: сочетание уже используется в Snipcast"));
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub path: String,
    pub content: String,
    title_key: String,
    content_key: String,
}
pub fn build_index(rows: &[TemplateRow]) -> Vec<Entry> {
    fn add(out: &mut Vec<Entry>, id: String, title: &str, path: &str, body: &str) {
        if body.trim().is_empty() {
            return;
        }
        out.push(Entry {
            id,
            title: title.into(),
            path: path.into(),
            content: body.into(),
            title_key: title.to_lowercase(),
            content_key: body.to_lowercase(),
        });
    }
    fn walk(out: &mut Vec<Entry>, children: &[TemplateChild], prefix: &str, id: &str) {
        for c in children {
            if c.is_separator {
                continue;
            }
            let next_id = format!("{id}/{}", c.id);
            if let Some(kids) = &c.children {
                walk(out, kids, &format!("{prefix} / {}", c.title), &next_id);
            } else {
                add(out, next_id, &c.title, prefix, &c.paste_text);
            }
        }
    }
    let mut out = vec![];
    for row in rows {
        if row.is_separator {
            continue;
        }
        let group = row.group_title.as_deref().unwrap_or("");
        if let Some(kids) = &row.children {
            walk(&mut out, kids, &format!("{group} / {}", row.title), &row.id);
        } else {
            add(
                &mut out,
                row.id.clone(),
                &row.title,
                group,
                row.paste_text.as_deref().unwrap_or(""),
            );
        }
    }
    out
}
pub fn search(index: &[Entry], query: &str, search_text: bool) -> Vec<usize> {
    if query.is_empty() {
        return vec![];
    }
    let q = query.to_lowercase();
    let mut hits: Vec<_> = index
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let tier = if e.title_key.starts_with(&q) {
                0
            } else if e.title_key.contains(&q) {
                1
            } else if search_text && e.content_key.contains(&q) {
                2
            } else {
                return None;
            };
            Some((tier, i))
        })
        .collect();
    hits.sort_by_key(|x| *x);
    hits.into_iter().take(5).map(|(_, i)| i).collect()
}

#[derive(Default)]
pub struct Word {
    pub text: String,
    cancelled: bool,
}
impl Word {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn dismiss(&mut self) {
        self.cancelled = true;
    }
    pub fn push(&mut self, text: &str, trigger: &str) {
        if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
            self.reset();
            return;
        }
        // Keep punctuation while a multicharacter trigger is being formed.
        for c in text.chars() {
            if !c.is_alphanumeric() && c != '_' && !trigger.contains(c) {
                self.reset();
                continue;
            }
            self.text.push(c);
        }
        if self.text.chars().count() > 128 {
            self.reset();
            self.cancelled = true; // The next characters still belong to this oversized word.
        }
    }
    pub fn backspace(&mut self) {
        self.text.pop();
        if self.text.is_empty() {
            self.reset();
        }
    }
    pub fn query<'a>(&'a self, cfg: &SuggestionsConfig) -> Option<&'a str> {
        if !cfg.enabled || self.cancelled {
            return None;
        }
        let q = if cfg.mode == "automatic" {
            self.text.as_str()
        } else {
            self.text
                .strip_prefix(&cfg.trigger)
                .filter(|_| !cfg.trigger.is_empty())?
        };
        (q.chars().count() >= cfg.min_chars as usize
            && q.chars().all(|c| c.is_alphanumeric() || c == '_'))
        .then_some(q)
    }
}
pub fn substitute_variables(
    text: &str,
    vars: &serde_json::Map<String, serde_json::Value>,
) -> String {
    // Match the existing palette's String(value) conversion, including arrays.
    fn variable_text(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Object(_) => "[object Object]".into(),
            serde_json::Value::Array(items) => items
                .iter()
                .map(|v| {
                    if v.is_null() {
                        String::new()
                    } else {
                        variable_text(v)
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            _ => value.to_string(),
        }
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find('}') {
            let key = &rest[1..end];
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                if let Some(value) = vars.get(key) {
                    out.push_str(&variable_text(value));
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        out.push('{');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}
pub fn has_fields(text: &str) -> bool {
    text.split('[')
        .skip(1)
        .any(|p| p.find(']').is_some_and(|end| !p[..end].trim().is_empty()))
}
pub fn backspace_safe(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_ascii() || ('\u{0400}'..='\u{04ff}').contains(&c))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub path: String,
    pub preview: String,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub ready: bool,
    pub session: u64,
    pub query: String,
    pub hits: Vec<Hit>,
    pub selected: usize,
    pub theme: String,
    pub placement: String,
    pub form: Option<Pending>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub session: u64,
    pub text: String,
    pub title: String,
    pub page_size: usize,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub message: String,
}
#[derive(Default)]
pub struct Runtime {
    pub view: Mutex<View>,
    pub status: Mutex<Status>,
    pub pending: Mutex<Option<Pending>>,
    pub hotkeys: Mutex<Vec<String>>,
    pub hotkeys_paused: Mutex<bool>,
    pub hotkey_error: Mutex<Option<String>>,
    #[cfg(target_os = "windows")]
    pub sender: Mutex<Option<std::sync::mpsc::SyncSender<crate::suggestions_windows::Command>>>,
}
pub fn prepare(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    validate(cfg)?;
    #[cfg(target_os = "windows")]
    {
        crate::suggestions_windows::start(app, cfg.clone())?;
        let rt = app.state::<Runtime>();
        let mut installed = rt.hotkeys.lock().map_err(|e| e.to_string())?;
        let requested = [&cfg.text_suggestions.toggle_hotkey];
        let mut added: Vec<String> = vec![];
        for value in &requested {
            if *rt.hotkeys_paused.lock().map_err(|e| e.to_string())? {
                break;
            }
            if value.trim().is_empty()
                || installed
                    .iter()
                    .any(|x| Shortcut::from_str(x).ok() == Shortcut::from_str(value).ok())
            {
                continue;
            }
            if let Err(e) =
                app.global_shortcut()
                    .on_shortcut(value.trim(), move |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            toggle(app);
                        }
                    })
            {
                for key in added {
                    let _ = app.global_shortcut().unregister(key.as_str());
                }
                let message = format!("Не удалось назначить клавишу подсказок: {e}");
                *rt.hotkey_error.lock().map_err(|e| e.to_string())? = Some(message.clone());
                rt.status.lock().map_err(|e| e.to_string())?.message = message.clone();
                return Err(message);
            }
            added.push((*value).clone());
        }
        for value in installed.iter().filter(|x| {
            !requested
                .iter()
                .any(|r| Shortcut::from_str(r).ok() == Shortcut::from_str(x).ok())
        }) {
            let _ = app.global_shortcut().unregister(value.as_str());
        }
        *installed = if *rt.hotkeys_paused.lock().map_err(|e| e.to_string())? {
            vec![]
        } else {
            requested
                .into_iter()
                .filter(|x| !x.trim().is_empty())
                .cloned()
                .collect()
        };
        drop(installed);
        *rt.hotkey_error.lock().map_err(|e| e.to_string())? = None;
    }
    #[cfg(not(target_os = "windows"))]
    {
        *app.state::<Runtime>()
            .status
            .lock()
            .map_err(|e| e.to_string())? = Status {
            supported: false,
            enabled: false,
            message: "Подсказки во время ввода доступны в Windows".into(),
        };
    }
    Ok(())
}
pub fn apply(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    prepare(app, cfg)?;
    configure(app, cfg);
    Ok(())
}
pub fn configure(app: &tauri::AppHandle, cfg: &AppConfig) {
    #[cfg(target_os = "windows")]
    crate::suggestions_windows::send(
        app,
        crate::suggestions_windows::Command::Configure(cfg.clone()),
    );
}
#[tauri::command]
pub fn snipcast_suggestions_hotkeys_pause(app: tauri::AppHandle) {
    let rt = app.state::<Runtime>();
    *rt.hotkeys_paused.lock().unwrap() = true;
    for key in rt.hotkeys.lock().unwrap().drain(..) {
        let _ = app.global_shortcut().unregister(key.as_str());
    }
}
#[tauri::command]
pub fn snipcast_suggestions_hotkeys_resume(app: tauri::AppHandle) -> Result<(), String> {
    *app.state::<Runtime>()
        .hotkeys_paused
        .lock()
        .map_err(|e| e.to_string())? = false;
    let cfg = app
        .state::<Mutex<AppConfig>>()
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    apply(&app, &cfg)
}
pub fn toggle(app: &tauri::AppHandle) {
    let result = (|| -> Result<(), String> {
        let config = app.state::<Mutex<AppConfig>>();
        let lock = config.lock().map_err(|e| e.to_string())?;
        let previous = lock.clone();
        let mut next = previous.clone();
        next.text_suggestions.enabled = !next.text_suggestions.enabled;
        drop(lock);
        validate(&next)?;
        prepare(app, &next)?;
        if let Err(e) = crate::data::save_config(&next) {
            let _ = prepare(app, &previous);
            return Err(e);
        }
        *config.lock().map_err(|e| e.to_string())? = next.clone();
        apply(app, &next)?;
        crate::refresh_tray_menu(app);
        use tauri::Emitter;
        let _ = app.emit("snipcast://suggestions-config", &next.text_suggestions);
        Ok(())
    })();
    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app.emit("snipcast://suggestions-error", e);
    }
}
#[tauri::command]
pub fn snipcast_suggestions_view(rt: State<'_, Runtime>) -> View {
    let mut view = rt.view.lock().unwrap_or_else(|e| e.into_inner()).clone();
    #[cfg(target_os = "windows")]
    {
        view.ready = crate::suggestions_windows::ready();
    }
    view
}
#[tauri::command]
pub fn snipcast_suggestions_status(rt: State<'_, Runtime>) -> Status {
    rt.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
#[tauri::command]
pub fn snipcast_suggestions_pending(rt: State<'_, Runtime>) -> Option<Pending> {
    rt.pending.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
#[tauri::command]
pub fn snipcast_suggestions_action(
    app: tauri::AppHandle,
    session: u64,
    action: String,
    index: Option<usize>,
) {
    #[cfg(target_os = "windows")]
    crate::suggestions_windows::send(
        &app,
        crate::suggestions_windows::Command::Action {
            session,
            action,
            index,
        },
    );
    #[cfg(not(target_os = "windows"))]
    let _ = (app, session, action, index);
}
#[tauri::command]
pub async fn snipcast_suggestions_complete(
    app: tauri::AppHandle,
    session: u64,
    text: String,
    file_refs: Vec<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        crate::suggestions_windows::send(
            &app,
            crate::suggestions_windows::Command::Complete {
                session,
                text,
                file_refs,
                reply: tx,
            },
        );
        return tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(8))
                .map_err(|_| "Вставка не завершена: проверьте целевое окно".to_string())?
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, session, text, file_refs);
        Err("Доступно только в Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_or_oversized_word_never_expands_a_partial_suffix() {
        let cfg = SuggestionsConfig {
            enabled: true,
            mode: "automatic".into(),
            ..Default::default()
        };
        let mut word = Word::default();
        word.dismiss();
        word.push("писка", &cfg.trigger);
        assert!(word.query(&cfg).is_none());
        word.push(" ", &cfg.trigger);
        word.push("вписка", &cfg.trigger);
        assert_eq!(word.query(&cfg), Some("вписка"));
        word.push(&"а".repeat(129), &cfg.trigger);
        word.push("писка", &cfg.trigger);
        assert!(word.query(&cfg).is_none());
    }
    #[test]
    fn trigger_word_and_backspace() {
        let mut cfg = SuggestionsConfig {
            enabled: true,
            mode: "trigger".into(),
            trigger: "/+/".into(),
            ..Default::default()
        };
        let mut w = Word::default();
        w.push("/+", &cfg.trigger);
        assert_eq!(w.query(&cfg), None);
        w.push("/Прив", &cfg.trigger);
        assert_eq!(w.query(&cfg), Some("Прив"));
        w.backspace();
        assert_eq!(w.query(&cfg), Some("При"));
        w.dismiss();
        w.push("вет", &cfg.trigger);
        assert_eq!(w.query(&cfg), None);
        w.push(" ", &cfg.trigger);
        cfg.mode = "automatic".into();
        w.push("текст", &cfg.trigger);
        assert_eq!(w.query(&cfg), Some("текст"));
    }
    #[test]
    fn modes_and_boundaries() {
        let mut cfg = SuggestionsConfig {
            enabled: true,
            mode: "trigger".into(),
            ..Default::default()
        };
        let mut w = Word::default();
        w.push("word", "/");
        assert!(w.query(&cfg).is_none());
        cfg.mode = "automatic".into();
        w.reset();
        w.push("Прив", "/");
        assert_eq!(w.query(&cfg), Some("Прив"));
        w.push(".", "/");
        assert!(w.query(&cfg).is_none());
        w.push(&"а".repeat(129), "/");
        assert!(w.text.is_empty());
    }
    #[test]
    fn defaults_and_conflicts() {
        let mut c = AppConfig::default();
        assert!(c.text_suggestions.enabled);
        assert_eq!(c.text_suggestions.mode, "automatic");
        assert_eq!(c.text_suggestions.trigger, "=");
        assert_eq!(c.text_suggestions.toggle_hotkey, "F9");
        assert!(c.text_suggestions.excluded_apps.is_empty());
        assert!(!c.text_suggestions.search_text);
        assert_eq!(c.text_suggestions.min_chars, 3);
        let missing: SuggestionsConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(missing, c.text_suggestions);
        let existing: SuggestionsConfig = serde_json::from_str(
            r#"{"enabled":false,"mode":"trigger","trigger":"/","toggleHotkey":"Control+Alt+T","excludedApps":["editor.exe"]}"#,
        ).unwrap();
        assert!(!existing.enabled);
        assert_eq!(existing.mode, "trigger");
        assert_eq!(existing.trigger, "/");
        assert_eq!(existing.toggle_hotkey, "Control+Alt+T");
        assert_eq!(existing.excluded_apps, vec!["editor.exe"]);
        assert!(validate(&c).is_ok());
        c.text_suggestions.toggle_hotkey = c.palette_hotkey.clone();
        assert!(validate(&c).is_err());
        c.text_suggestions.toggle_hotkey = "F2".into();
        assert!(validate(&c).is_ok());
        c.text_suggestions.trigger = "abc".into();
        assert!(validate(&c).is_err());
        c.text_suggestions.trigger.clear();
        c.text_suggestions.enabled = true;
        c.text_suggestions.mode = "trigger".into();
        assert_eq!(validate(&c).unwrap_err(), "Укажите текстовый триггер");
        c.text_suggestions.mode = "automatic".into();
        assert!(validate(&c).is_ok());
    }
    #[test]
    fn ranking_and_limit() {
        let entries: Vec<_> = (0..8)
            .map(|i| Entry {
                id: i.to_string(),
                title: "".into(),
                path: "".into(),
                content: "".into(),
                title_key: if i == 6 {
                    "привет".into()
                } else {
                    "ответ".into()
                },
                content_key: "привет".into(),
            })
            .collect();
        assert_eq!(search(&entries, "ПРИ", true), vec![6, 0, 1, 2, 3]);
        assert!(search(&entries, "", true).is_empty());
        assert_eq!(search(&entries, "ПРИ", false), vec![6]);
    }
    #[test]
    fn threshold_counts_query_characters_and_migrates_old_config() {
        let mut cfg: SuggestionsConfig = serde_json::from_str(
            r#"{"enabled":true,"mode":"trigger","trigger":"/+/","activationHotkey":"F2"}"#,
        )
        .unwrap();
        assert_eq!(cfg.min_chars, 3);
        assert!(!cfg.search_text);
        assert!(serde_json::to_value(&cfg)
            .unwrap()
            .get("activationHotkey")
            .is_none());
        let mut word = Word::default();
        word.push("/+/пр", &cfg.trigger);
        assert_eq!(word.query(&cfg), None);
        word.push("и", &cfg.trigger);
        assert_eq!(word.query(&cfg), Some("при"));
        word.backspace();
        assert_eq!(word.query(&cfg), None);
        cfg.min_chars = 2;
        assert_eq!(word.query(&cfg), Some("пр"));
        cfg.mode = "automatic".into();
        word.reset();
        word.push("ab", &cfg.trigger);
        assert_eq!(word.query(&cfg), Some("ab"));
        let mut app = AppConfig::default();
        app.text_suggestions.min_chars = 0;
        assert!(validate(&app).is_err());
        app.text_suggestions.min_chars = 129;
        assert!(validate(&app).is_err());
    }
    #[test]
    fn variables_and_complexity() {
        let vars = serde_json::from_str(r#"{"name":"Анна","n":2}"#).unwrap();
        assert_eq!(
            substitute_variables("{name}: {n} {unknown}", &vars),
            "Анна: 2 {unknown}"
        );
        let values =
            serde_json::from_str(r#"{"array":["a",null,2],"object":{},"null":null}"#).unwrap();
        assert_eq!(
            substitute_variables("{array}|{object}|{null}", &values),
            "a,,2|[object Object]|null"
        );
        assert!(has_fields("[Имя]"));
        assert!(has_fields("[\"file.pdf\"]"));
        assert!(!has_fields("[] [ ]"));
        assert!(backspace_safe("/Прив"));
        assert!(!backspace_safe("e\u{0301}"));
    }
}
