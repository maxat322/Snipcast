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
use tauri::{Emitter,Manager};
use std::sync::Mutex;
use chrono::{Local,Timelike};

pub const NOTICE_LABEL:&str="update-notice";
#[derive(Default,Serialize,Deserialize)]
#[serde(default,rename_all="camelCase")]
struct ScheduleState { last_attempt:Option<String>, skipped_version:Option<String>, dismissed_day:Option<String> }
#[derive(Default)]
struct BackgroundState { persisted:ScheduleState,pending:Option<UpdateInfo>,shown:bool }
#[derive(Default)]
pub struct UpdateRuntime { check:tauri::async_runtime::Mutex<()>, background:Mutex<BackgroundState> }
fn schedule_path()->PathBuf {crate::data::snipcast_base_dir().join("update-state.json")}
fn persist(state:&ScheduleState)->Result<(),String> {
    let path=schedule_path();if let Some(dir)=path.parent(){fs::create_dir_all(dir).map_err(|e|e.to_string())?;}
    let tmp=path.with_extension("json.tmp");fs::write(&tmp,serde_json::to_vec(state).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    fs::rename(tmp,path).map_err(|e|e.to_string())
}
fn due(state:&ScheduleState,day:&str,hour:u32)->bool {hour>=10 && state.last_attempt.as_deref()!=Some(day)}
fn offer(state:&ScheduleState,info:&UpdateInfo,day:&str)->bool {
    info.available && state.skipped_version.as_deref()!=Some(info.latest_version.as_str()) && state.dismissed_day.as_deref()!=Some(day)
}

pub fn start_scheduler(app:tauri::AppHandle) {
    {
        let runtime=app.state::<UpdateRuntime>();let mut bg=runtime.background.lock().unwrap();
        bg.persisted=fs::read(schedule_path()).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
    }
    std::thread::spawn(move || loop {
        let now=Local::now();let day=now.format("%Y-%m-%d").to_string();
        let run={let runtime=app.state::<UpdateRuntime>();let mut bg=runtime.background.lock().unwrap();
            if due(&bg.persisted,&day,now.hour()) {bg.persisted.last_attempt=Some(day.clone());let _=persist(&bg.persisted);true}else{false}};
        if run {
            let result=tauri::async_runtime::block_on(async {
                let runtime=app.state::<UpdateRuntime>();let _guard=runtime.check.lock().await;
                fetch_latest_release().await.map(release_info)
            });
            match result {
                Ok(info)=>{let runtime=app.state::<UpdateRuntime>();let mut bg=runtime.background.lock().unwrap();
                    if offer(&bg.persisted,&info,&day) {bg.pending=Some(info);}}
                Err(e)=>{
                    let path=crate::data::snipcast_base_dir().join("update-errors.log");
                    if let Ok(mut file)=fs::OpenOptions::new().create(true).append(true).open(path){let _=writeln!(file,"{} {e}",Local::now());}
                }
            }
        }
        show_pending(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

pub(crate) fn show_pending(app:&tauri::AppHandle) {
    if crate::screenshot::capture_active(app) {return}
    {let runtime=app.state::<UpdateRuntime>();let mut bg=runtime.background.lock().unwrap();
        if bg.pending.is_none() || bg.shown {return} bg.shown=true;}
    let app2=app.clone();let _=app.run_on_main_thread(move || {
        let win=if let Some(w)=app2.get_webview_window(NOTICE_LABEL){Ok(w)}else{
            tauri::WebviewWindowBuilder::new(&app2,NOTICE_LABEL,tauri::WebviewUrl::App("index.html".into()))
                .title("Обновление Snipcast").inner_size(520.0,430.0).decorations(false).resizable(false)
                .always_on_top(true).visible(false).center().build()};
        match win {
            Ok(w)=>{
                if crate::screenshot::capture_active(&app2) {
                    app2.state::<UpdateRuntime>().background.lock().unwrap().shown=false;
                    return;
                }
                let _=w.emit("snipcast://update-notice",());let _=w.show();let _=w.set_focus();
            }
            Err(_)=>{app2.state::<UpdateRuntime>().background.lock().unwrap().shown=false;}
        }
    });
}

pub(crate) fn suspend_notice(app:&tauri::AppHandle){
    if let Some(window)=app.get_webview_window(NOTICE_LABEL){let _=window.hide();}
    app.state::<UpdateRuntime>().background.lock().unwrap().shown=false;
}

#[tauri::command]
pub fn snipcast_update_notice_info(app:tauri::AppHandle)->Option<UpdateInfo> {
    app.state::<UpdateRuntime>().background.lock().ok()?.pending.clone()
}
pub fn dismiss_notice(app:&tauri::AppHandle,skip:Option<String>)->Result<(),String> {
    {let runtime=app.state::<UpdateRuntime>();let mut bg=runtime.background.lock().map_err(|e|e.to_string())?;
        if let Some(version)=skip {
            if bg.pending.as_ref().map(|i|&i.latest_version)!=Some(&version){return Err("версия обновления изменилась".into())}
            bg.persisted.skipped_version=Some(version);
        }else {bg.persisted.dismissed_day=Some(Local::now().format("%Y-%m-%d").to_string());}
        persist(&bg.persisted)?;bg.pending=None;bg.shown=false;
    }
    if let Some(win)=app.get_webview_window(NOTICE_LABEL){let _=win.destroy();} Ok(())
}
#[tauri::command]
pub fn snipcast_skip_update(app:tauri::AppHandle,version:String)->Result<(),String>{dismiss_notice(&app,Some(version))}
#[tauri::command]
pub fn snipcast_dismiss_update(app:tauri::AppHandle)->Result<(),String>{dismiss_notice(&app,None)}

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
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("не удалось создать HTTP-клиент: {e}"))
}

async fn fetch_latest_release() -> Result<GhRelease, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    // Isolated native debug QA can exercise the real scheduler against a local fixture.
    #[cfg(debug_assertions)]
    let url=std::env::var("SNIPCAST_UPDATE_TEST_URL").ok().filter(|u|
        std::env::var_os("SNIPCAST_DATA_DIR").is_some() && u.starts_with("http://127.0.0.1:")) .unwrap_or(url);
    let resp = client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
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
pub async fn snipcast_check_update(app:tauri::AppHandle) -> Result<UpdateInfo, String> {
    let runtime=app.state::<UpdateRuntime>();let _guard=runtime.check.lock().await;
    Ok(release_info(fetch_latest_release().await?))
}
fn release_info(rel:GhRelease)->UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = rel.tag_name.trim().trim_start_matches('v').to_string();

    let exe_asset = find_asset(&rel.assets, ASSET_NAME);
    let has_files = exe_asset.is_some()
        && find_asset(&rel.assets, &format!("{ASSET_NAME}{SHA_SUFFIX}")).is_some();

    UpdateInfo {
        // Без нужных файлов в релизе обновляться нечем, даже если версия новее.
        available: is_newer(&latest, &current) && has_files,
        current_version: current,
        latest_version: latest,
        notes: rel.body.unwrap_or_default(),
        size: exe_asset.map(|a| a.size).unwrap_or(0),
    }
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
pub async fn snipcast_install_update(app: tauri::AppHandle,expected_version:Option<String>) -> Result<(), String> {
    let runtime=app.state::<UpdateRuntime>();let _guard=runtime.check.lock().await;
    // Ссылки берём из свежего ответа GitHub, а не из того, что прислал интерфейс.
    emit_stage(&app, "check");
    let rel = fetch_latest_release().await?;
    let version=rel.tag_name.trim().trim_start_matches('v');
    if expected_version.as_deref().is_some_and(|expected|expected!=version) {
        let info=release_info(rel);
        {let mut bg=runtime.background.lock().map_err(|e|e.to_string())?;bg.pending=Some(info);}
        let _=app.emit("snipcast://update-notice",());
        return Err("Релиз изменился. Список изменений обновлён; нажмите «Обновить» повторно.".into())
    }

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
    fn schedule_start_resume_and_day_boundary(){
        let mut state=ScheduleState::default();assert!(!due(&state,"2026-10-07",9));
        assert!(due(&state,"2026-10-07",10));state.last_attempt=Some("2026-10-07".into());
        assert!(!due(&state,"2026-10-07",23));assert!(!due(&state,"2026-10-08",9));assert!(due(&state,"2026-10-08",10));
        let restored:ScheduleState=serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(!due(&restored,"2026-10-07",14));
    }
    #[test]
    fn skip_one_version_and_dismiss_one_day(){
        let mut state=ScheduleState::default();
        let mut info=UpdateInfo{available:true,current_version:"0.35.0".into(),latest_version:"0.36.0".into(),notes:"Changes".into(),size:1};
        assert!(offer(&state,&info,"2026-10-07"));state.skipped_version=Some("0.36.0".into());
        assert!(!offer(&state,&info,"2026-10-08"));info.latest_version="0.37.0".into();assert!(offer(&state,&info,"2026-10-08"));
        state.dismissed_day=Some("2026-10-08".into());assert!(!offer(&state,&info,"2026-10-08"));assert!(offer(&state,&info,"2026-10-09"));
    }

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
