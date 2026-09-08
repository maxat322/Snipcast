//! Самообновление портативной сборки.
//!
//! Проверяем последний релиз на GitHub, скачиваем портативный exe, сверяем SHA-256
//! и подменяем запущенный файл. Windows не позволяет перезаписать работающий exe,
//! но разрешает его переименовать — на этом и построена подмена.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

const REPO: &str = "maxat322/Snipcast";
/// Имя портативного exe среди файлов релиза.
const ASSET_NAME: &str = "snipcast.exe";
/// Рядом с ним ожидается файл с контрольной суммой: `snipcast.exe.sha256`.
const SHA_SUFFIX: &str = ".sha256";
const PROGRESS_EVENT: &str = "snipcast://update-stage";

fn user_agent() -> String {
    format!("Snipcast/{}", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Что именно сейчас делает апдейтер — уходит в интерфейс, чтобы кнопка не выглядела зависшей.
fn emit_stage(app: &tauri::AppHandle, stage: &str) {
    let _ = app.emit(PROGRESS_EVENT, stage);
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent()) // GitHub API отвергает запросы без User-Agent
        .build()
        .map_err(|e| format!("не удалось создать HTTP-клиент: {e}"))
}

async fn fetch_latest_release() -> Result<GhRelease, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("не удалось связаться с GitHub: {e}"))?;

    let resp = resp
        .error_for_status()
        .map_err(|e| format!("GitHub ответил ошибкой: {e}"))?;

    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("неожиданный ответ GitHub: {e}"))
}

/// Тег вида `v0.33.0` и версия из Cargo.toml вида `0.32.0`.
fn is_newer(latest: &str, current: &str) -> bool {
    match (
        semver::Version::parse(latest),
        semver::Version::parse(current),
    ) {
        (Ok(l), Ok(c)) => l > c,
        // Не смогли разобрать как semver — считаем обновлением любое отличие.
        _ => latest != current,
    }
}

fn find_asset<'a>(assets: &'a [GhAsset], name: &str) -> Option<&'a GhAsset> {
    assets.iter().find(|a| a.name.eq_ignore_ascii_case(name))
}

#[tauri::command]
pub async fn snipcast_check_update() -> Result<UpdateInfo, String> {
    let rel = fetch_latest_release().await?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = rel.tag_name.trim().trim_start_matches('v').to_string();

    let exe_asset = find_asset(&rel.assets, ASSET_NAME);
    let has_files = exe_asset.is_some()
        && find_asset(&rel.assets, &format!("{ASSET_NAME}{SHA_SUFFIX}")).is_some();

    Ok(UpdateInfo {
        // Без нужных файлов в релизе обновляться нечем, даже если версия новее.
        available: is_newer(&latest, &current) && has_files,
        current_version: current,
        latest_version: latest,
        notes: rel.body.unwrap_or_default(),
        size: exe_asset.map(|a| a.size).unwrap_or(0),
    })
}

/// Из файла контрольной суммы берём первую последовательность из 64 hex-символов:
/// подходит и голый хеш, и формат `<хеш> *snipcast.exe` от sha256sum.
fn parse_sha256(text: &str) -> Option<String> {
    text.split(|c: char| !c.is_ascii_hexdigit())
        .find(|tok| tok.len() == 64)
        .map(|tok| tok.to_ascii_lowercase())
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let resp = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("не удалось скачать файл: {e}"))?
        .error_for_status()
        .map_err(|e| format!("сервер вернул ошибку при скачивании: {e}"))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("обрыв при скачивании: {e}"))?;
    Ok(bytes.to_vec())
}

/// Подменяет запущенный exe новым и возвращает путь к отложенной старой версии.
fn swap_running_exe(new_bytes: &[u8]) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("не найден путь к exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "у exe нет родительской папки".to_string())?;
    let file_name = exe
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| "не удалось определить имя exe".to_string())?;

    let new_path = dir.join(format!("{file_name}.new"));
    let old_path = dir.join(format!("{file_name}.old"));

    {
        let mut f = fs::File::create(&new_path)
            .map_err(|e| format!("нет доступа на запись в папку с программой: {e}"))?;
        f.write_all(new_bytes)
            .map_err(|e| format!("не удалось записать новый файл: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("не удалось сбросить новый файл на диск: {e}"))?;
    }

    let _ = fs::remove_file(&old_path);

    // Переименовать работающий exe Windows разрешает, перезаписать — нет.
    if let Err(e) = fs::rename(&exe, &old_path) {
        let _ = fs::remove_file(&new_path);
        return Err(format!("не удалось отодвинуть текущую версию: {e}"));
    }

    if let Err(e) = fs::rename(&new_path, &exe) {
        // Откатываемся, чтобы не остаться вообще без исполняемого файла.
        let _ = fs::rename(&old_path, &exe);
        let _ = fs::remove_file(&new_path);
        return Err(format!("не удалось установить новую версию: {e}"));
    }

    Ok(old_path)
}

#[tauri::command]
pub async fn snipcast_install_update(app: tauri::AppHandle) -> Result<(), String> {
    // Ссылки берём из свежего ответа GitHub, а не из того, что прислал интерфейс.
    emit_stage(&app, "check");
    let rel = fetch_latest_release().await?;

    let exe_asset = find_asset(&rel.assets, ASSET_NAME)
        .ok_or_else(|| format!("в релизе нет файла {ASSET_NAME}"))?;
    let sha_name = format!("{ASSET_NAME}{SHA_SUFFIX}");
    let sha_asset = find_asset(&rel.assets, &sha_name)
        .ok_or_else(|| format!("в релизе нет файла контрольной суммы {sha_name}"))?;

    emit_stage(&app, "download");
    let sha_text = download(&sha_asset.browser_download_url).await?;
    let expected = parse_sha256(&String::from_utf8_lossy(&sha_text))
        .ok_or_else(|| "в файле контрольной суммы нет корректного SHA-256".to_string())?;

    let bytes = download(&exe_asset.browser_download_url).await?;

    emit_stage(&app, "verify");
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!(
            "контрольная сумма не совпала: ожидалась {expected}, получена {actual}. Обновление отменено"
        ));
    }

    emit_stage(&app, "install");
    swap_running_exe(&bytes)?;

    emit_stage(&app, "restart");
    app.restart();
}

/// Подчищает следы прошлого обновления. Вызывается при старте: удалить `.old`
/// раньше нельзя — файл занят, пока работает предыдущая версия.
pub fn cleanup_after_update() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name()) else {
        return;
    };
    let name = name.to_string_lossy();
    for suffix in ["old", "new"] {
        let leftover: PathBuf = dir.join(format!("{name}.{suffix}"));
        if leftover.exists() {
            let _ = fs::remove_file(&leftover);
        }
    }
}

/// Есть ли вообще право писать в папку с программой: портативную сборку могли
/// положить в Program Files, где обновление без прав администратора не пройдёт.
#[tauri::command]
pub fn snipcast_update_writable() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    let probe: &Path = &dir.join(".snipcast-write-probe");
    match fs::File::create(probe) {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sha256_in_both_formats() {
        let hash = "a".repeat(64);
        assert_eq!(parse_sha256(&hash).as_deref(), Some(hash.as_str()));
        let sha256sum_style = format!("{hash} *snipcast.exe\n");
        assert_eq!(
            parse_sha256(&sha256sum_style).as_deref(),
            Some(hash.as_str())
        );
        assert_eq!(parse_sha256("не хеш вовсе"), None);
        // Слишком короткая строка не должна приниматься за сумму.
        assert_eq!(parse_sha256("abc123"), None);
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.33.0", "0.32.0"));
        assert!(is_newer("1.0.0", "0.99.9"));
        assert!(!is_newer("0.32.0", "0.32.0"));
        assert!(!is_newer("0.31.0", "0.32.0"));
        // Неразбираемые версии: считаем обновлением любое отличие.
        assert!(is_newer("weird", "0.32.0"));
    }
}
