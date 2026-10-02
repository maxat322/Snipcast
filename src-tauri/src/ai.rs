//! ИИ-агент: чат по скриншотам через OpenAI-совместимый API Polza.
//!
//! Оверлей захвата присылает выделенную область (base64 PNG) командой
//! `ai_attach`, открывается окно чата `aiagent`. Промпт с историей и
//! картинками уходит в `POST /chat/completions` со стримингом (SSE),
//! дельты прилетают в окно чата событием `snipcast://ai-delta`.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt as _;
use serde::Serialize;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder,
};

use crate::data::AppConfig;
use crate::screenshot;

/// Метка окна чата агента.
pub const AI_WINDOW_LABEL: &str = "aiagent";

const POLZA_CHAT_URL: &str = "https://polza.ai/api/v1/chat/completions";
const POLZA_MODELS_URL: &str = "https://polza.ai/api/v1/models";

/// Логические размеры окна: сначала открываем компактное поле ввода,
/// после первого ответа фронтенд разворачивает окно до полного чата.
const WIN_W: f64 = 420.0;
const WIN_FULL_H: f64 = 560.0;
const WIN_COMPACT_H: f64 = 72.0;
const WIN_MIN_W: f64 = 360.0;
const WIN_MIN_H: f64 = 64.0;

/// Кап картинок в памяти: старые (за пределами капа) удаляем. Действует,
/// пока окно чата открыто — при закрытии чат стирается целиком.
const MAX_IMAGES: usize = 48;
/// Максимальная длинная сторона картинки для отправки в модель.
const MAX_IMAGE_SIDE: u32 = 1568;

const SYSTEM_PROMPT: &str = "Ты — встроенный ИИ-ассистент приложения Snipcast. Пользователь присылает скриншоты выделенных областей экрана и вопросы к ним. Отвечай кратко и по делу, на языке пользователя. Код оформляй в markdown-блоках кода.";

pub struct AiAgentState(Mutex<Inner>);

impl AiAgentState {
    /// Полный сброс: история, картинки, pending.
    pub fn reset(&self) {
        if let Ok(mut inner) = self.0.lock() {
            *inner = Inner::default();
        }
    }
}

impl Default for AiAgentState {
    fn default() -> Self {
        Self(Mutex::new(Inner::default()))
    }
}

#[derive(Default)]
struct Inner {
    /// Счётчик id картинок с 1; id монотонны, меньший id = более старая.
    next_image_id: i64,
    /// PNG-байты картинок (уже нормализованные до MAX_IMAGE_SIDE).
    images: HashMap<i64, Vec<u8>>,
    /// История диалога.
    messages: Vec<StoredMessage>,
    /// Картинки, ждущие отправки со следующим сообщением пользователя.
    pending: Vec<i64>,
}

#[derive(Clone)]
struct StoredMessage {
    /// "user" | "assistant"
    role: String,
    text: String,
    image_ids: Vec<i64>,
}

/// Сохранить картинку под новым id; при переполнении капа удаляем самые
/// старые (минимальные id) вместе со ссылками из истории и pending.
fn add_image(inner: &mut Inner, png: Vec<u8>) -> i64 {
    inner.next_image_id += 1;
    let id = inner.next_image_id;
    inner.images.insert(id, png);
    while inner.images.len() > MAX_IMAGES {
        let Some(oldest) = inner.images.keys().copied().min() else {
            break;
        };
        inner.images.remove(&oldest);
        for m in &mut inner.messages {
            m.image_ids.retain(|i| *i != oldest);
        }
        inner.pending.retain(|i| *i != oldest);
    }
    id
}

/// Позиция окна ввода ПОД панелью инструментов оверлея: (x, y, w, h) —
/// физический прямоугольник тулбара. Окно центрируем по тулбару и ставим
/// ниже на 12 px; если снизу не влезает в рабочую область — над тулбаром;
/// края и панель задач не пересекаем.
fn fit_window_position(app: &AppHandle, bx: i32, by: i32, bw: u32, bh: u32) -> PhysicalPosition<i32> {
    const GAP: i32 = 12;
    let mon = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            bx >= p.x && by >= p.y && bx < p.x + s.width as i32 && by < p.y + s.height as i32
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(mon) = mon else {
        // Мониторы недоступны — просто под прямоугольником.
        return PhysicalPosition::new(bx, by + bh as i32 + GAP);
    };
    let scale = mon.scale_factor();
    let w = (WIN_W * scale).round() as i32;
    let h = (WIN_COMPACT_H * scale).round() as i32;
    let wa = mon.work_area();
    let ax = wa.position.x;
    let ay = wa.position.y;
    let aw = wa.size.width as i32;
    let ah = wa.size.height as i32;
    // По центру тулбара, но не дальше краёв рабочей области.
    let cx = bx + bw as i32 / 2;
    let px = (cx - w / 2).min(ax + aw - w).max(ax);
    // Под тулбаром; не влезает вниз — над ним; совсем тесно — прижать к низу.
    let below = by + bh as i32 + GAP;
    let above = by - GAP - h;
    let py = if below + h <= ay + ah {
        below
    } else if above >= ay {
        above
    } else {
        (ay + ah - h).max(ay)
    };
    PhysicalPosition::new(px, py)
}

/// Показать окно чата: существующее — просто показать (позицию не трогаем),
/// новое — создать без рамки, скрытым и сразу в нужной позиции под кнопкой
/// «ИИ Агент», чтобы окно не мигало и не «переезжало» после появления.
fn create_or_show_ai_window(app: &AppHandle, bx: i32, by: i32, bw: u32, bh: u32) {
    if let Some(w) = app.get_webview_window(AI_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let pos = fit_window_position(app, bx, by, bw, bh);
    let win = match WebviewWindowBuilder::new(
        app,
        AI_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("ИИ Агент — Snipcast")
    .inner_size(WIN_W, WIN_COMPACT_H)
    .min_inner_size(WIN_MIN_W, WIN_MIN_H)
    .resizable(true)
    // Компактное поле ввода — без рамки и заголовка окна; перетаскивание
    // и закрытие делает фронтенд окна чата.
    .decorations(false)
    // Открывается поверх полноэкранного оверлея захвата.
    .always_on_top(true)
    // Позиция задаётся до показа — физические пиксели, как в fit_window_position.
    .position(pos.x as f64, pos.y as f64)
    .visible(false)
    .background_color(tauri::utils::config::Color(27, 27, 31, 255))
    .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[snipcast] окно ИИ-агента: {e}");
            return;
        }
    };
    screenshot::disable_window_animations(&win);
    let _ = win.show();
    let _ = win.set_focus();
    // WebView2 при загрузке контента сбивает фокус окна — добираем его
    // повторно с задержкой, чтобы поле ввода было активно сразу.
    {
        let w2 = win.clone();
        std::thread::spawn(move || {
            for delay in [200u64, 600, 1200] {
                std::thread::sleep(Duration::from_millis(delay));
                let _ = w2.set_focus();
            }
        });
    }
}

/// Нормализация картинки для модели: длинная сторона больше MAX_IMAGE_SIDE —
/// уменьшаем (Lanczos3, пропорции сохраняются) и кодируем обратно в PNG;
/// мелкие проходят как есть.
fn normalize_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("картинка не декодируется: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= MAX_IMAGE_SIDE {
        return Ok(bytes.to_vec());
    }
    let scale = MAX_IMAGE_SIDE as f64 / long as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("кодирование PNG: {e}"))?;
    Ok(out)
}

// --- SSE-парсер (чистые функции, покрыты юнит-тестами) ---

/// Достаёт из буфера все полные `data:`-строки (разделитель `\n`);
/// неполная строка остаётся в буфере до следующего чанка. Пустые строки и
/// комментарии (`: ping` — keep-alive) игнорируются.
fn sse_extract_data_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(nl) = buf.find('\n') {
        let line: String = buf.drain(..=nl).collect();
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            // после двоеточия может стоять пробел — по спецификации SSE
            out.push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }
    }
    out
}

/// Маркер конца стрима OpenAI.
fn is_sse_done(data: &str) -> bool {
    data.trim() == "[DONE]"
}

/// `choices[0].delta.content` из data-строки; None — контента нет
/// (role-порция, `"content": null`, битый JSON).
fn parse_delta_content(data: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    v.get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

/// Обрезать строку до ~n символов (кусок тела ответа для текста ошибки).
fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Тело запроса chat/completions: system-промпт + вся история.
/// Сообщения с картинками идут массивом частей (text + image_url).
fn build_request_body(model: &str, inner: &Inner) -> serde_json::Value {
    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    for m in &inner.messages {
        let content = if m.image_ids.is_empty() {
            json!(m.text)
        } else {
            let mut parts = vec![json!({ "type": "text", "text": m.text })];
            for id in &m.image_ids {
                // Кап мог уже удалить картинку — просто пропускаем её.
                if let Some(bytes) = inner.images.get(id) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:image/png;base64,{b64}") },
                    }));
                }
            }
            json!(parts)
        };
        messages.push(json!({ "role": m.role, "content": content }));
    }
    json!({ "model": model, "stream": true, "messages": messages })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttachPayload {
    image_id: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHistoryDto {
    pub messages: Vec<AiMessageDto>,
    pub pending_image_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessageDto {
    pub role: String,
    pub text: String,
    pub image_ids: Vec<i64>,
}

/// Прикрепить выделенную область (base64 PNG) к следующему сообщению и
/// открыть окно чата под панелью инструментов оверлея, по её центру
/// (x, y, width, height — физ. прямоугольник тулбара). Оверлей захвата
/// НЕ закрываем — это произойдёт при отправке промпта.
#[tauri::command]
pub async fn snipcast_ai_attach(
    app: AppHandle,
    png: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png.as_bytes())
        .map_err(|e| format!("base64 картинки: {e}"))?;
    // Декодирование/ресайз PNG — CPU-работа, выносим с потока рантайма.
    let normalized = tauri::async_runtime::spawn_blocking(move || normalize_png(&bytes))
        .await
        .map_err(|e| format!("join: {e}"))??;

    let image_id = {
        let state = app.state::<AiAgentState>();
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        let id = add_image(&mut inner, normalized);
        // Картинка уйдёт в модель со следующим сообщением пользователя.
        inner.pending.push(id);
        id
    };

    create_or_show_ai_window(&app, x, y, width, height);
    let _ = app.emit_to(
        AI_WINDOW_LABEL,
        "snipcast://ai-attach",
        AttachPayload { image_id },
    );
    Ok(())
}

/// История диалога + картинки, ждущие отправки.
#[tauri::command]
pub async fn snipcast_ai_history(state: State<'_, AiAgentState>) -> Result<AiHistoryDto, String> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(AiHistoryDto {
        messages: inner
            .messages
            .iter()
            .map(|m| AiMessageDto {
                role: m.role.clone(),
                text: m.text.clone(),
                image_ids: m.image_ids.clone(),
            })
            .collect(),
        pending_image_ids: inner.pending.clone(),
    })
}

/// PNG-байты картинки по id сырым ответом (как capture_image_data).
#[tauri::command]
pub async fn snipcast_ai_image(
    id: i64,
    state: State<'_, AiAgentState>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        inner
            .images
            .get(&id)
            .cloned()
            .ok_or_else(|| "Изображение не найдено".to_string())?
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// Целевая позиция (физ. px) окна чата при развороте в полный размер.
/// Вертикальный центр полного окна совпадает с центром текущего (компактного
/// «Думаю») окна — разворот идёт вверх и вниз одновременно. Если так окно
/// выходит за рабочую область — сдвигаем внутрь, под панель задач не заходим.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandOriginDto {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
pub async fn snipcast_ai_expand_origin(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<ExpandOriginDto, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (WIN_W * scale).round() as i32;
    let h = (WIN_FULL_H * scale).round() as i32;
    let mon = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            pos.x >= p.x && pos.y >= p.y && pos.x < p.x + s.width as i32 && pos.y < p.y + s.height as i32
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(mon) = mon else {
        return Ok(ExpandOriginDto { x: pos.x, y: pos.y });
    };
    let wa = mon.work_area();
    let ax = wa.position.x;
    let ay = wa.position.y;
    let aw = wa.size.width as i32;
    let ah = wa.size.height as i32;
    // Верх полного окна с тем же вертикальным центром, что у текущего.
    let cy = pos.y + size.height as i32 / 2;
    Ok(ExpandOriginDto {
        x: pos.x.min(ax + aw - w).max(ax),
        y: (cy - h / 2).min(ay + ah - h).max(ay),
    })
}

/// Отправить промпт с историей в Polza и проследить стрим дельт.
#[tauri::command]
pub async fn snipcast_ai_send(
    app: AppHandle,
    window: tauri::WebviewWindow,
    text: String,
    state: State<'_, AiAgentState>,
    cfg: State<'_, Mutex<AppConfig>>,
) -> Result<String, String> {
    let (api_key, model) = {
        let c = cfg.lock().map_err(|e| e.to_string())?;
        (c.ai_api_key.trim().to_string(), c.ai_model.trim().to_string())
    };
    if api_key.is_empty() {
        return Err("Не задан API-ключ Polza (Настройки → ИИ)".to_string());
    }
    if model.is_empty() {
        return Err("Не задана модель ИИ (Настройки → ИИ)".to_string());
    }

    // pending-картинки уходят вместе с этим сообщением пользователя.
    let body = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        let image_ids = std::mem::take(&mut inner.pending);
        inner.messages.push(StoredMessage {
            role: "user".to_string(),
            text: text.clone(),
            image_ids,
        });
        build_request_body(&model, &inner)
    };

    // Скриншот обсудили — область захвата закрываем, чат уходит из-под оверлея.
    screenshot::close_capture(&app);
    let _ = window.set_always_on_top(false);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("не удалось создать HTTP-клиент: {e}"))?;
    let resp = client
        .post(POLZA_CHAT_URL)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("не удалось связаться с Polza: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Polza HTTP {code}: {}", truncate_chars(&text, 300)));
    }

    // SSE-стрим: каждую дельту отдаём в окно чата сразу по поступлению.
    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut full = String::new();
    let mut done = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("обрыв ответа Polza: {e}"))?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));
        for data in sse_extract_data_lines(&mut sse_buf) {
            if is_sse_done(&data) {
                done = true;
                break;
            }
            if let Some(delta) = parse_delta_content(&data) {
                full.push_str(&delta);
                let _ = app.emit_to(
                    AI_WINDOW_LABEL,
                    "snipcast://ai-delta",
                    DeltaPayload { text: delta },
                );
            }
        }
        if done {
            break;
        }
    }

    if full.is_empty() {
        return Err("Пустой ответ модели".to_string());
    }

    // Окно чата могли закрыть прямо во время стрима: ответ показывать некому,
    // а закрытие чата стирает диалог — не оставляем хвост истории.
    if app.get_webview_window(AI_WINDOW_LABEL).is_none() {
        state.reset();
        return Ok(full);
    }

    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .messages
        .push(StoredMessage {
            role: "assistant".to_string(),
            text: full.clone(),
            image_ids: Vec::new(),
        });

    Ok(full)
}

/// Полный сброс агента: история, картинки, pending.
#[tauri::command]
pub async fn snipcast_ai_clear(state: State<'_, AiAgentState>) -> Result<(), String> {
    state.reset();
    Ok(())
}

/// Проверка ключа: GET /models с Bearer.
#[tauri::command]
pub async fn snipcast_ai_test(cfg: State<'_, Mutex<AppConfig>>) -> Result<String, String> {
    let api_key = {
        let c = cfg.lock().map_err(|e| e.to_string())?;
        c.ai_api_key.trim().to_string()
    };
    if api_key.is_empty() {
        return Err("Не задан API-ключ Polza (Настройки → ИИ)".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("не удалось создать HTTP-клиент: {e}"))?;
    let resp = client
        .get(POLZA_MODELS_URL)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("не удалось связаться с Polza: {e}"))?;
    if resp.status().is_success() {
        return Ok("Подключение работает".to_string());
    }
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Err(format!(
        "Polza HTTP {code}: {}",
        truncate_chars(&text, 200)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_plain_delta() {
        let mut buf = String::new();
        buf.push_str("data: {\"choices\":[{\"delta\":{\"content\":\"При\"}}]}\n\n");
        let lines = sse_extract_data_lines(&mut buf);
        assert_eq!(
            lines,
            vec!["{\"choices\":[{\"delta\":{\"content\":\"При\"}}]}".to_string()]
        );
        assert_eq!(parse_delta_content(&lines[0]).as_deref(), Some("При"));
        assert!(buf.is_empty());
    }

    #[test]
    fn sse_done_marker() {
        let mut buf = String::new();
        buf.push_str("data: [DONE]\n");
        let lines = sse_extract_data_lines(&mut buf);
        assert_eq!(lines, vec!["[DONE]".to_string()]);
        assert!(is_sse_done(&lines[0]));
        assert!(buf.is_empty());
    }

    #[test]
    fn sse_multiple_lines_in_one_chunk() {
        let mut buf = String::new();
        buf.push_str(
            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n",
        );
        let lines = sse_extract_data_lines(&mut buf);
        assert_eq!(lines.len(), 2);
        assert_eq!(parse_delta_content(&lines[0]).as_deref(), Some("a"));
        assert_eq!(parse_delta_content(&lines[1]).as_deref(), Some("b"));
    }

    #[test]
    fn sse_chunk_splits_json_in_half() {
        let mut buf = String::new();
        buf.push_str("data: {\"choices\":[{\"delta\":{\"content\":\"hel");
        // неполная строка остаётся в буфере
        assert!(sse_extract_data_lines(&mut buf).is_empty());
        assert!(!buf.is_empty());
        buf.push_str("lo\"}}]}\n");
        let lines = sse_extract_data_lines(&mut buf);
        assert_eq!(lines.len(), 1);
        assert_eq!(parse_delta_content(&lines[0]).as_deref(), Some("hello"));
    }

    #[test]
    fn sse_skip_empty_lines_and_comments() {
        let mut buf = String::new();
        buf.push_str(": ping\n\ndata: {\"choices\":[{\"delta\":{}}]}\n");
        let lines = sse_extract_data_lines(&mut buf);
        assert_eq!(lines.len(), 1);
        // контента в порции нет — пропускаем
        assert_eq!(parse_delta_content(&lines[0]), None);
        assert!(!is_sse_done(&lines[0]));
    }
}
