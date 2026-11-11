use super::*;
use base64::Engine;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicU32;
#[derive(Default)]
pub struct History {
    // Serialize capture with publishing config, so disabling cannot race an in-flight insert.
    pub capture_gate: Mutex<()>,
    db: Mutex<Option<Connection>>,
    own: AtomicBool,
    sequence: AtomicU32,
    pub status: Mutex<String>,
}
pub fn reset_capture_sequence(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    app.state::<History>().sequence.store(super::clipboard_windows::sequence(), Ordering::SeqCst);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub text: String,
    pub files: Vec<String>,
    pub source: String,
    pub source_path: String,
    pub icon: String,
    pub created: i64,
    pub pinned: bool,
    pub width: u32,
    pub height: u32,
    pub characters: usize,
    pub ocr: String,
    #[serde(default)]
    pub image: Option<String>,
}
fn dir() -> std::path::PathBuf {
    crate::data::snipcast_base_dir().join("clipboard")
}
fn open_at(path: &std::path::Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS clips(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, meta TEXT NOT NULL, payload TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS clips_created ON clips(created); DROP INDEX IF EXISTS clips_order; CREATE INDEX IF NOT EXISTS clips_pinned_created ON clips(pinned DESC,created DESC);").map_err(|e|e.to_string())?;
    Ok(db)
}
pub fn suppress<T>(
    app: &AppHandle,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<History>();
    state.own.store(true, Ordering::SeqCst);
    let result = write();
    #[cfg(target_os = "windows")]
    state
        .sequence
        .store(super::clipboard_windows::sequence(), Ordering::SeqCst);
    state.own.store(false, Ordering::SeqCst);
    result
}
pub fn start(app: AppHandle) {
    let _ = std::fs::create_dir_all(dir());
    match open_at(&dir().join("history.sqlite")) {
        Ok(db) => *app.state::<History>().db.lock().unwrap() = Some(db),
        Err(e) => {
            *app.state::<History>().status.lock().unwrap() = e;
            return;
        }
    }
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        super::clipboard_windows::listen(tx);
        std::thread::spawn(move || loop {
            let received = rx.recv_timeout(std::time::Duration::from_secs(60));
            if received.is_err() {
                let _ = prune(&app);
                continue;
            }
            while rx.try_recv().is_ok() {}
            let state = app.state::<History>();
            let _capture_guard = state.capture_gate.lock().unwrap();
            let cfg = config(&app);
            #[cfg(feature = "inline-qa")]
            eprintln!("[qa-history] update enabled={} clipboard={} own={} seen={} current={}", cfg.enabled, cfg.clipboard_enabled, state.own.load(Ordering::SeqCst), state.sequence.load(Ordering::SeqCst), super::clipboard_windows::sequence());
            if !cfg.enabled || !cfg.clipboard_enabled {
                reset_capture_sequence(&app);
                continue;
            }
            if state.own.load(Ordering::SeqCst)
                || state.sequence.load(Ordering::SeqCst) == super::clipboard_windows::sequence()
            {
                continue;
            }
            let mut outcome = None;
            for _ in 0..5 {
                match super::clipboard_windows::capture() {
                    Ok(c) => {
                        outcome = c;
                        break;
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(40)),
                }
            }
            if let Some(c) = outcome {
                if state.sequence.load(Ordering::SeqCst) == c.sequence
                    || state.own.load(Ordering::SeqCst)
                {
                    continue;
                }
                if cfg.excluded_apps.iter().any(|s| {
                    !s.trim().is_empty()
                        && (c.source_path.eq_ignore_ascii_case(s)
                            || c.source.eq_ignore_ascii_case(s)
                            || std::path::Path::new(&c.source_path)
                                .file_name()
                                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(s)))
                }) {
                    continue;
                }
                state.sequence.store(c.sequence, Ordering::SeqCst);
                if let Err(e) = store(&app, c) {
                    #[cfg(feature = "inline-qa")]
                    eprintln!("[qa-history] store failed: {e}");
                    *state.status.lock().unwrap() = e;
                }
                let _ = app.emit("snipcast://clipboard-changed", ());
            }
        });
    }
}
#[cfg(target_os = "windows")]
fn store(app: &AppHandle, c: super::clipboard_windows::Capture) -> Result<(), String> {
    let cfg = config(app);
    prune(app)?;
    let payload = serde_json::to_string(&c.formats).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(payload.as_bytes()));
    let size = payload.len() + c.image.as_ref().map_or(0, |b| b.len());
    let now = chrono::Utc::now().timestamp_millis();
    let state = app.state::<History>();
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or("История недоступна")?;
    let last: Option<String> = db
        .query_row(
            "SELECT hash FROM clips ORDER BY created DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if last.as_deref() == Some(&hash) {
        return Ok(());
    }
    let used: i64 = db
        .query_row("SELECT COALESCE(SUM(size),0) FROM clips", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if size as i64 + used > cfg.storage_mb as i64 * 1024 * 1024 {
        drop(guard);
        prune_to(
            app,
            (cfg.storage_mb as i64 * 1024 * 1024 - size as i64).max(0),
        )?;
        let g = state.db.lock().unwrap();
        let used: i64 = g
            .as_ref()
            .unwrap()
            .query_row("SELECT COALESCE(SUM(size),0) FROM clips", [], |r| r.get(0))
            .unwrap_or(0);
        if used + size as i64 > cfg.storage_mb as i64 * 1024 * 1024 {
            return Err(
                "Хранилище заполнено закреплёнными записями. Увеличьте лимит или удалите записи"
                    .into(),
            );
        }
        drop(g);
        return insert(app, c, payload, hash, size, now);
    }
    drop(guard);
    insert(app, c, payload, hash, size, now)
}
#[cfg(target_os = "windows")]
fn insert(
    app: &AppHandle,
    c: super::clipboard_windows::Capture,
    payload: String,
    hash: String,
    size: usize,
    now: i64,
) -> Result<(), String> {
    let kind = if !c.files.is_empty() {
        "files"
    } else if c.image.is_some() {
        "image"
    } else {
        classify(&c.text)
    };
    let title = match kind {
        "image" => format!("Изображение ({}×{})", c.width, c.height),
        "files" => c
            .files
            .iter()
            .map(|s| {
                std::path::Path::new(s)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => c
            .text
            .lines()
            .find(|s| !s.trim().is_empty())
            .unwrap_or("Текст")
            .chars()
            .take(120)
            .collect(),
    };
    let icon = app
        .state::<Runtime>()
        .apps
        .lock()
        .unwrap()
        .iter()
        .find(|e| {
            !c.source_path.is_empty()
                && e.keywords
                    .to_lowercase()
                    .contains(&c.source_path.to_lowercase())
        })
        .map(|e| e.icon.clone())
        .unwrap_or_default();
    let ocr = if config(app).ocr {
        c.image
            .as_ref()
            .and_then(|b| recognize(app, b).ok())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut clip = Clip {
        id: 0,
        title,
        kind: kind.into(),
        characters: c.text.chars().count(),
        text: c.text,
        files: c.files,
        source: c.source,
        source_path: c.source_path,
        icon,
        created: now,
        pinned: false,
        width: c.width,
        height: c.height,
        ocr,
        image: None,
    };
    let state = app.state::<History>();
    let guard = state.db.lock().unwrap();
    let connection = guard.as_ref().ok_or("История недоступна")?;
    let db = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO clips(hash,meta,payload,size,created) VALUES(?1,'',?2,?3,?4)",
        params![hash, payload, size as i64, now],
    )
    .map_err(|e| e.to_string())?;
    clip.id = db.last_insert_rowid();
    if let Some(bytes) = c.image {
        if let Err(e) = std::fs::write(dir().join(format!("{}.png", clip.id)), bytes) {
            let _ = db.execute("DELETE FROM clips WHERE id=?1", [clip.id]);
            return Err(e.to_string());
        }
    }
    db.execute(
        "UPDATE clips SET meta=?1 WHERE id=?2",
        params![serde_json::to_string(&clip).unwrap(), clip.id],
    )
    .map_err(|e| e.to_string())?;
    db.commit().map_err(|e| e.to_string())?;
    *state.status.lock().unwrap() = String::new();
    Ok(())
}
fn classify(text: &str) -> &'static str {
    let t = text.trim();
    if t.starts_with("https://") || t.starts_with("http://") {
        "link"
    } else if t.contains('@') && !t.contains(char::is_whitespace) {
        "email"
    } else if t.starts_with('#')
        && [4, 7, 9].contains(&t.len())
        && t[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        "color"
    } else {
        "text"
    }
}
fn remove(db: &Connection, id: i64) -> Result<(), String> {
    db.execute("DELETE FROM clips WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    for name in [format!("{id}.png"), format!("{id}.preview.png"), format!("{id}.preview-480.png")] {
        let p = dir().join(name);
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
const SHARED_LINK_PREFIX: &str = "snipcast-link-";
const SHARED_LINK_TTL_MS: i64 = 3 * 24 * 60 * 60 * 1000;
static SHARED_LINK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn shared_dir() -> std::path::PathBuf {
    dir().join("shared")
}

fn shared_expiry(name: &str) -> Option<i64> {
    let rest = name.strip_prefix(SHARED_LINK_PREFIX)?;
    let (stamp, _) = rest.split_once('-')?;
    stamp.parse().ok()
}

/// Удаляет только свои ролики, у которых срок в имени уже наступил.
fn prune_shared_videos_in(folder: &std::path::Path, now_ms: i64) -> Result<usize, String> {
    if !folder.is_dir() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for entry in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(expires) = shared_expiry(&name.to_string_lossy()) else {
            continue;
        };
        if expires > now_ms {
            continue;
        }
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

fn prepare_shared_video(ext: &str) -> Result<String, String> {
    if !matches!(ext, "mp4" | "gif") {
        return Err("Неверный формат".into());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let folder = shared_dir();
    prune_shared_videos_in(&folder, now)?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let seq = SHARED_LINK_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = folder.join(format!(
        "{SHARED_LINK_PREFIX}{}-{seq}.{ext}",
        now.saturating_add(SHARED_LINK_TTL_MS)
    ));
    Ok(path.to_string_lossy().into_owned())
}

fn publish_shared_video(path: &str) -> Result<String, String> {
    let file = std::path::PathBuf::from(path);
    let name = file.file_name().and_then(|item| item.to_str()).unwrap_or("");
    if file.parent() != Some(shared_dir().as_path()) || shared_expiry(name).is_none() {
        return Err("Файл не из папки буфера".into());
    }
    if !file.is_file() {
        return Err("Файл ссылки не найден".into());
    }
    crate::rich_clipboard::write_plain_text(&file.to_string_lossy())?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn snipcast_video_link_prepare(ext: String) -> Result<String, String> {
    prepare_shared_video(&ext)
}

#[tauri::command]
pub fn snipcast_video_link_publish(path: String) -> Result<String, String> {
    publish_shared_video(&path)
}

fn prune(app: &AppHandle) -> Result<(), String> {
    prune_shared_videos_in(&shared_dir(), chrono::Utc::now().timestamp_millis())?;
    let cfg = config(app);
    if cfg.retention_days > 0 {
        let state = app.state::<History>();
        let g = state.db.lock().unwrap();
        let db = g.as_ref().ok_or("История недоступна")?;
        let mut st = db
            .prepare("SELECT id FROM clips WHERE pinned=0 AND created<?1")
            .map_err(|e| e.to_string())?;
        let ids = st
            .query_map(
                [chrono::Utc::now().timestamp_millis() - cfg.retention_days as i64 * 86400000],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        drop(st);
        for id in ids {
            remove(db, id)?;
        }
    }
    prune_to(app, cfg.storage_mb as i64 * 1024 * 1024)
}
fn prune_to(app: &AppHandle, limit: i64) -> Result<(), String> {
    let state = app.state::<History>();
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("История недоступна")?;
    loop {
        let size: i64 = db
            .query_row("SELECT COALESCE(SUM(size),0) FROM clips", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if size <= limit {
            break;
        }
        let id: Option<i64> = db
            .query_row(
                "SELECT id FROM clips WHERE pinned=0 ORDER BY created LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = id {
            remove(db, id)?
        } else {
            break;
        }
    }
    Ok(())
}
fn latest_clip_text(db: &Connection) -> Result<Option<String>, String> {
    let meta = match db.query_row(
        "SELECT meta FROM clips ORDER BY created DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(meta) => meta,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let clip: Clip = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    Ok(if clip.kind == "text" {
        Some(clip.text)
    } else {
        None
    })
}
#[tauri::command]
pub async fn snipcast_history_latest_text(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<History>();
        let guard = state.db.lock().unwrap();
        match guard.as_ref() {
            Some(db) => latest_clip_text(db),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snipcast_history_list(
    app: AppHandle,
    query: String,
    kind: String,
    offset: usize,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || list(&app, query, kind, offset, limit))
        .await.map_err(|e| e.to_string())?
}
fn unsearched_page(
    db: &Connection,
    kind: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<String>, usize), String> {
    let total = db
        .query_row(
            "SELECT COUNT(*) FROM clips WHERE ?1='' OR json_extract(meta,'$.kind')=?1",
            [kind],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())? as usize;
    let mut st = db
        .prepare("SELECT meta FROM clips WHERE ?1='' OR json_extract(meta,'$.kind')=?1 ORDER BY pinned DESC,created DESC LIMIT ?2 OFFSET ?3")
        .map_err(|e| e.to_string())?;
    let records = st
        .query_map(params![kind, limit as i64, offset as i64], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok((records, total))
}
fn list(app: &AppHandle, query: String, kind: String, offset: usize, limit: Option<usize>) -> Result<serde_json::Value, String> {
    // Opening the history reads only the requested SQL page. A text search still
    // needs a metadata snapshot because it also matches OCR and source names.
    let q = query.to_lowercase();
    let limit = limit.unwrap_or(100).clamp(1, 100);
    let state = app.state::<History>();
    if q.is_empty() {
        let (records, total) = {
            let g = state.db.lock().unwrap();
            let db = g.as_ref().ok_or("История недоступна")?;
            unsearched_page(db, &kind, offset, limit)?
        };
        let items = records
            .into_iter()
            .filter_map(|s| serde_json::from_str::<Clip>(&s).ok())
            .map(|mut c| {
                c.text = c.text.chars().take(250).collect();
                c
            })
            .collect::<Vec<_>>();
        return Ok(
            serde_json::json!({"items":items,"total":total,"status":state.status.lock().unwrap().clone()}),
        );
    }
    let records = {
        let g = state.db.lock().unwrap();
        let db = g.as_ref().ok_or("История недоступна")?;
        let mut st = db
            .prepare("SELECT meta FROM clips ORDER BY pinned DESC,created DESC")
            .map_err(|e| e.to_string())?;
        let records = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        records
    };
    let matching = records.into_iter()
        .filter_map(|s| serde_json::from_str::<Clip>(&s).ok())
        .filter(|c| {
            (kind.is_empty() || kind == c.kind)
                && format!("{} {} {} {}", c.title, c.text, c.ocr, c.source)
                    .to_lowercase()
                    .contains(&q)
        });
    let mut total = 0;
    let mut items = Vec::new();
    for mut c in matching {
        if total >= offset && items.len() < limit {
            c.text = c.text.chars().take(250).collect();
            items.push(c);
        }
        total += 1;
    }
    Ok(
        serde_json::json!({"items":items,"total":total,"status":state.status.lock().unwrap().clone()}),
    )
}
fn get(app: &AppHandle, id: i64) -> Result<(Clip, String), String> {
    let state = app.state::<History>();
    let g = state.db.lock().unwrap();
    let db = g.as_ref().ok_or("История недоступна")?;
    let (m, p): (String, String) = db
        .query_row("SELECT meta,payload FROM clips WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|_| "Запись уже удалена")?;
    Ok((serde_json::from_str(&m).map_err(|e| e.to_string())?, p))
}
#[tauri::command]
pub async fn snipcast_history_detail(app: AppHandle, id: i64) -> Result<Clip, String> {
    tauri::async_runtime::spawn_blocking(move || detail(&app, id)).await.map_err(|e| e.to_string())?
}
fn detail(app: &AppHandle, id: i64) -> Result<Clip, String> {
    // Preview needs metadata/image only, not the potentially huge raw clipboard payload.
    let metadata: String = {
        let state = app.state::<History>();
        let g = state.db.lock().unwrap();
        g.as_ref().ok_or("История недоступна")?
            .query_row("SELECT meta FROM clips WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "Запись уже удалена")?
    };
    let mut c: Clip = serde_json::from_str(&metadata).map_err(|e| e.to_string())?;
    if c.kind == "image" {
        c.image = preview_data_url(id);
    }
    Ok(c)
}
/// Превью для панели предпросмотра: уменьшенная копия до 480 px, кэшируется
/// рядом с оригиналом. Полный снимок читается и кодируется один раз, а не на
/// каждое движение стрелкой по истории.
fn preview_data_url(id: i64) -> Option<String> {
    const PREVIEW_MAX: u32 = 480;
    let preview = dir().join(format!("{id}.preview-480.png"));
    let bytes = match std::fs::read(&preview) {
        Ok(bytes) => bytes,
        Err(_) => {
            // Кэш старого размера (720 px) больше не нужен.
            let _ = std::fs::remove_file(dir().join(format!("{id}.preview.png")));
            let data = std::fs::read(dir().join(format!("{id}.png"))).ok()?;
            let image = image::load_from_memory(&data).ok()?;
            let thumb = if image.width() > PREVIEW_MAX || image.height() > PREVIEW_MAX {
                image.thumbnail(PREVIEW_MAX, PREVIEW_MAX)
            } else {
                image
            };
            let mut out = Vec::new();
            thumb
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .ok()?;
            let _ = std::fs::write(&preview, &out);
            out
        }
    };
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
pub async fn snipcast_history_action(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: i64,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    if action == "delete-all" || action == "delete-recent" {
        let cutoff = if action == "delete-all" {
            0
        } else {
            chrono::Utc::now().timestamp_millis()
                - value
                    .as_deref()
                    .unwrap_or("60")
                    .parse::<i64>()
                    .map_err(|_| "Неверный интервал")?
                    .max(1)
                    * 60000
        };
        let state = app.state::<History>();
        let g = state.db.lock().unwrap();
        let db = g.as_ref().ok_or("История недоступна")?;
        let ids = {
            let mut st = db
                .prepare("SELECT id FROM clips WHERE created>=?1")
                .map_err(|e| e.to_string())?;
            let result = st
                .query_map([cutoff], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            result
        };
        for id in ids {
            remove(db, id)?;
        }
        let _ = app.emit("snipcast://clipboard-changed", ());
        return Ok(());
    }
    let (mut c, payload) = get(&app, id)?;
    match action.as_str() {
        "copy" | "paste" | "paste-keep" | "plain" => {
            if c.files.iter().any(|f| !std::path::Path::new(f).exists()) {
                return Err("Один из файлов перемещён или удалён".into());
            }
            if action == "plain" {
                suppress(&app, || crate::rich_clipboard::write_plain_text(&c.text))?;
            } else {
                #[cfg(target_os = "windows")]
                {
                    let formats: Vec<super::clipboard_windows::Format> =
                        serde_json::from_str(&payload)
                            .map_err(|e| format!("Повреждённая запись: {e}"))?;
                    suppress(&app, || super::clipboard_windows::restore(&formats))?;
                }
            }
            if action != "copy" {
                super::paste_current(&app, window, action == "paste-keep").await?;
            }
        }
        "save" => {
            let path = value.ok_or("Не выбран файл")?;
            if c.kind == "image" {
                std::fs::copy(dir().join(format!("{id}.png")), path).map_err(|e| e.to_string())?;
            } else {
                std::fs::write(path, c.text.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
        "ocr" => {
            let bytes =
                std::fs::read(dir().join(format!("{id}.png"))).map_err(|e| e.to_string())?;
            let app2 = app.clone();
            let text = tauri::async_runtime::spawn_blocking(move || recognize(&app2, &bytes))
                .await
                .map_err(|e| e.to_string())??;
            suppress(&app, || crate::rich_clipboard::write_plain_text(&text))?;
            c.ocr = text;
            update(&app, &c)?;
        }
        "pin" => {
            c.pinned = !c.pinned;
            update(&app, &c)?;
        }
        "rename" => {
            c.title = value.unwrap_or_default().chars().take(200).collect();
            update(&app, &c)?;
        }
        "delete" => {
            let state = app.state::<History>();
            let g = state.db.lock().unwrap();
            remove(g.as_ref().ok_or("История недоступна")?, id)?;
        }
        _ => return Err("Неизвестное действие".into()),
    }
    let _ = app.emit("snipcast://clipboard-changed", ());
    Ok(())
}
const MULTI_PASTE_LEAD_MS: u64 = 280;
const MULTI_PASTE_STEP_MS: u64 = 420;

/// Вставляет несколько записей подряд в прежнее приложение. `ids` приходят уже
/// в порядке вставки: первая запись вставляется первой.
#[tauri::command]
pub async fn snipcast_history_paste_many(
    app: AppHandle,
    window: tauri::WebviewWindow,
    ids: Vec<i64>,
) -> Result<(), String> {
    paste_many_into(&app, Some(&window), ids).await
}

async fn paste_many_into(
    app: &AppHandle,
    window: Option<&tauri::WebviewWindow>,
    ids: Vec<i64>,
) -> Result<(), String> {
    if ids.is_empty() {
        return Err("Не выбраны записи для вставки".into());
    }
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
    // Сначала проверяем все записи: недопустимая запись не должна оставить
    // половину вставки.
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        let (c, payload) = get(app, id)?;
        if c.files.iter().any(|f| !std::path::Path::new(f).exists()) {
            return Err("Один из файлов перемещён или удалён".into());
        }
        items.push((c, payload));
    }
    // Первая запись кладётся в буфер, пока палитра ещё видима: ошибка буфера
    // будет показана пользователю, а не исчезнет вместе с окном.
    write_clip(app, &items[0].0, &items[0].1)?;
    match window {
        Some(w) if w.label() == super::WINDOW => super::hide(app),
        Some(w) => w.hide().map_err(|e| e.to_string())?,
        None => {}
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::thread::sleep(std::time::Duration::from_millis(MULTI_PASTE_LEAD_MS));
        crate::paste_target::paste_into_previous(&snap);
        for (c, payload) in items.iter().skip(1) {
            // Даём целевому приложению прочитать буфер до следующей записи.
            std::thread::sleep(std::time::Duration::from_millis(MULTI_PASTE_STEP_MS));
            write_clip(&app2, c, payload)?;
            crate::paste_target::paste_into_previous(&snap);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

fn write_clip(app: &AppHandle, c: &Clip, payload: &str) -> Result<(), String> {
    suppress(app, || {
        #[cfg(target_os = "windows")]
        {
            let _ = c;
            let formats: Vec<super::clipboard_windows::Format> =
                serde_json::from_str(payload).map_err(|e| format!("Повреждённая запись: {e}"))?;
            super::clipboard_windows::restore(&formats)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = payload;
            if c.files.is_empty() {
                crate::rich_clipboard::write_plain_text(&c.text)
            } else {
                crate::rich_clipboard::write_file_list(
                    &c.files.iter().map(std::path::PathBuf::from).collect::<Vec<_>>(),
                )
            }
        }
    })
}

/// QA-сборка (feature `inline-qa`): выполняет мультивставку по запросу из файла,
/// чтобы проверить последовательность без DevTools/событий клавиатуры.
#[cfg(feature = "inline-qa")]
pub fn start_qa_paste_many(app: AppHandle) {
    std::thread::spawn(move || loop {
        let base = crate::data::snipcast_base_dir();
        let request = base.join("paste-many-request.json");
        if let Ok(bytes) = std::fs::read(&request) {
            let _ = std::fs::remove_file(&request);
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                let ids: Vec<i64> = value["ids"]
                    .as_array()
                    .map(|list| list.iter().filter_map(|v| v.as_i64()).collect())
                    .unwrap_or_default();
                if let Some(hwnd) = value["hwnd"].as_i64() {
                    if let Ok(mut target) = app
                        .state::<Mutex<crate::paste_target::PasteTarget>>()
                        .lock()
                    {
                        target.win_hwnd = Some(hwnd as isize);
                        target.last_foreign_hwnd = Some(hwnd as isize);
                    }
                }
                let app2 = app.clone();
                let outcome = tauri::async_runtime::block_on(paste_many_into(&app2, None, ids));
                let result = serde_json::json!({"ok": outcome.is_ok(), "error": outcome.err()});
                let _ = std::fs::write(base.join("paste-many-result.json"), result.to_string());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    });
}

fn recognize(app: &AppHandle, bytes: &[u8]) -> Result<String, String> {
    let cfg = app
        .state::<Mutex<crate::data::AppConfig>>()
        .lock()
        .unwrap()
        .clone();
    #[cfg(target_os = "windows")]
    if cfg.screenshot_ocr_engine == "paddle" {
        return crate::paddle::paddle::recognize(bytes, &cfg.screenshot_ocr_quality);
    }
    crate::ocr::recognize_system(bytes, &cfg.screenshot_ocr_language)
}
fn update(app: &AppHandle, c: &Clip) -> Result<(), String> {
    let state = app.state::<History>();
    let g = state.db.lock().unwrap();
    g.as_ref()
        .ok_or("История недоступна")?
        .execute(
            "UPDATE clips SET meta=?1,pinned=?2 WHERE id=?3",
            params![serde_json::to_string(c).unwrap(), c.pinned, c.id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn categories() {
        assert_eq!(classify("https://example.com"), "link");
        assert_eq!(classify("#f00"), "color");
        assert_eq!(classify("test@example.com"), "email");
    }
    #[test]
    fn database_restart() {
        let p = std::env::temp_dir().join(format!(
            "snipcast-history-test-{}.sqlite",
            std::process::id()
        ));
        {
            let db = open_at(&p).unwrap();
            db.execute(
                "INSERT INTO clips(hash,meta,payload,size,created) VALUES('a','{}','[]',2,1)",
                [],
            )
            .unwrap();
        }
        let db = open_at(&p).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn sql_pages_limit_metadata_reads() {
        let p = std::env::temp_dir().join(format!(
            "snipcast-history-page-test-{}.sqlite",
            std::process::id()
        ));
        let db = open_at(&p).unwrap();
        for i in 0..25 {
            let meta = format!(r#"{{"id":{i},"kind":"text","title":"row {i}"}}"#);
            db.execute(
                "INSERT INTO clips(hash,meta,payload,size,created) VALUES(?1,?2,'[]',2,?3)",
                params![format!("hash{i}"), meta, i as i64],
            )
            .unwrap();
        }
        let (records, total) = unsearched_page(&db, "", 0, 10).unwrap();
        assert_eq!(total, 25);
        assert_eq!(records.len(), 10);
        assert!(records[0].contains("\"id\":24"));
        assert!(records[9].contains("\"id\":15"));
        let (next, _) = unsearched_page(&db, "", 10, 10).unwrap();
        assert_eq!(next.len(), 10);
        assert!(next[0].contains("\"id\":14"));
        assert_eq!(unsearched_page(&db, "image", 0, 10).unwrap().1, 0);
        drop(db);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn latest_text_ignores_pinned_and_non_text() {
        let p = std::env::temp_dir().join(format!(
            "snipcast-history-latest-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        let db = open_at(&p).unwrap();
        let row = |kind: &str, text: &str, created: i64| {
            serde_json::json!({
                "id": created, "title": "t", "kind": kind, "text": text, "files": [],
                "source": "", "sourcePath": "", "icon": "", "created": created,
                "pinned": created == 1, "width": 0, "height": 0, "characters": text.chars().count(), "ocr": ""
            })
            .to_string()
        };
        for (kind, text, created) in [("text", "старый закреп", 1i64), ("image", "", 5), ("text", "полный текст", 9)] {
            db.execute(
                "INSERT INTO clips(hash,meta,payload,size,created,pinned) VALUES(?1,?2,'[]',2,?3,?4)",
                params![format!("h{created}"), row(kind, text, created), created, created == 1],
            )
            .unwrap();
        }
        assert_eq!(latest_clip_text(&db).unwrap().as_deref(), Some("полный текст"));
        drop(db);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn shared_video_links_expire_after_three_days() {
        let folder = std::env::temp_dir().join(format!(
            "snipcast-shared-link-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let now = 1_700_000_000_000_i64;
        let ttl = 3 * 24 * 60 * 60 * 1000;
        let expired = folder.join(format!("snipcast-link-{}-1.mp4", now - 1));
        let fresh = folder.join(format!("snipcast-link-{}-2.gif", now + ttl));
        let foreign = folder.join("notes.txt");
        std::fs::write(&expired, b"old").unwrap();
        std::fs::write(&fresh, b"new").unwrap();
        std::fs::write(&foreign, b"keep").unwrap();
        let removed = prune_shared_videos_in(&folder, now).unwrap();
        assert_eq!(removed, 1);
        assert!(!expired.exists());
        assert!(fresh.exists());
        assert!(foreign.exists());
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
