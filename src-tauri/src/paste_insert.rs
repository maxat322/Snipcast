//! Вставка шаблонов в целевое приложение (текст и текст + файлы).

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, State};

use crate::paste_target::PasteTarget;
use crate::rich_clipboard;
use crate::template_files;

const PASTE_LEAD_MS: u64 = 280;
const DEFAULT_FILE_DELAY_MS: u64 = 100;
const PASTE_GAP_MS: u64 = 120;

pub fn paste_plain_text(app: &AppHandle, target: &Mutex<PasteTarget>, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }

    crate::refresh_paste_target(app);
    rich_clipboard::write_plain_text(&text)?;
    crate::hide_palette(app);

    let snap = target.lock().map_err(|e| e.to_string())?.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PASTE_LEAD_MS));
        crate::paste_target::paste_into_previous(&snap);
    });

    Ok(())
}

pub fn paste_text_then_files(
    app: &AppHandle,
    target: &Mutex<PasteTarget>,
    text: String,
    file_refs: Vec<String>,
    delay_ms: u64,
) -> Result<(), String> {
    let paths = template_files::resolve_template_file_refs(&file_refs)?;
    let text = text.trim().to_string();
    let has_text = !text.is_empty();
    let has_files = !paths.is_empty();

    if !has_text && !has_files {
        return Ok(());
    }

    crate::refresh_paste_target(app);

    if has_text {
        rich_clipboard::write_plain_text(&text)?;
    } else {
        rich_clipboard::write_file_list(&paths)?;
    }

    crate::hide_palette(app);

    let snap = target.lock().map_err(|e| e.to_string())?.clone();
    let delay = if delay_ms == 0 {
        DEFAULT_FILE_DELAY_MS
    } else {
        delay_ms
    };

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PASTE_LEAD_MS));
        crate::paste_target::paste_into_previous(&snap);

        if has_text && has_files {
            std::thread::sleep(Duration::from_millis(delay));
            if rich_clipboard::write_file_list(&paths).is_err() {
                eprintln!("[snipcast] не удалось положить файлы в буфер");
                return;
            }
            std::thread::sleep(Duration::from_millis(PASTE_GAP_MS));
            crate::paste_target::paste_into_previous(&snap);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn paste_template(
    app: AppHandle,
    target: State<'_, Mutex<PasteTarget>>,
    text: String,
) -> Result<(), String> {
    paste_plain_text(&app, &target, text)
}

#[tauri::command]
pub fn paste_template_text_then_files(
    app: AppHandle,
    target: State<'_, Mutex<PasteTarget>>,
    text: String,
    file_refs: Vec<String>,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    paste_text_then_files(&app, &target, text, file_refs, delay_ms.unwrap_or(DEFAULT_FILE_DELAY_MS))
}
