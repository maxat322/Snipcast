//! Persistent screenshot sources, separate from disposable capture-cache.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::{Mutex, OnceLock}};

const LIMIT: usize = 30;
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Region { pub x:u32, pub y:u32, pub width:u32, pub height:u32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry {
    pub id:String, pub created_at:String, pub width:u32, pub height:u32,
    pub origin_x:i32, pub origin_y:i32, pub selection:Region,
    pub(crate) source_hash:String,
}
fn dir()->PathBuf {crate::data::snipcast_base_dir().join("screenshots-history")}
fn valid_id(id:&str)->bool {id.len()==24 && id.bytes().all(|c|c.is_ascii_hexdigit())}
fn file(id:&str)->Result<PathBuf,String> {if !valid_id(id){return Err("Неверная запись истории".into());}Ok(dir().join(format!("{id}.png")))}
fn read_index()->Vec<Entry> {
    fs::read(dir().join("index.json")).ok().and_then(|b|serde_json::from_slice::<Vec<Entry>>(&b).ok()).unwrap_or_default()
        .into_iter().filter(|e|valid_id(&e.id)&&file(&e.id).is_ok_and(|p|p.is_file())).take(LIMIT).collect()
}
fn write_index(entries:&[Entry])->Result<(),String> {
    let root=dir();fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let tmp=root.join("index.json.tmp");
    fs::write(&tmp,serde_json::to_vec(entries).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    fs::rename(tmp,root.join("index.json")).map_err(|e|e.to_string())
}
pub fn list()->Vec<Entry> {let _guard=LOCK.get_or_init(||Mutex::new(())).lock().unwrap();read_index()}
pub fn image(id:&str)->Result<(Entry,Vec<u8>),String> {
    let _guard=LOCK.get_or_init(||Mutex::new(())).lock().map_err(|e|e.to_string())?;
    let entry=read_index().into_iter().find(|e|e.id==id).ok_or("Снимок отсутствует в истории")?;
    let bytes=fs::read(file(id)?).map_err(|e|e.to_string())?;
    let decoded=image::load_from_memory(&bytes).map_err(|_|"Повреждённый снимок истории")?;
    if decoded.width()!=entry.width || decoded.height()!=entry.height {return Err("Повреждённые размеры снимка истории".into());}
    Ok((entry,bytes))
}
pub fn record(bytes:&[u8], origin:(i32,i32), size:(u32,u32), selection:Region)->Result<String,String> {
    if selection.width==0||selection.height==0||selection.x.saturating_add(selection.width)>size.0||selection.y.saturating_add(selection.height)>size.1 {
        return Err("Область истории вне исходного снимка".into());
    }
    let _guard=LOCK.get_or_init(||Mutex::new(())).lock().map_err(|e|e.to_string())?;
    let mut entries=read_index();let hash=format!("{:x}",Sha256::digest(bytes));
    if let Some(pos)=entries.iter().position(|e|e.source_hash==hash&&e.selection==selection) {
        let entry=entries.remove(pos);let id=entry.id.clone();entries.insert(0,entry);write_index(&entries)?;return Ok(id);
    }
    let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let id=format!("{:x}",Sha256::digest(format!("{hash}:{stamp}:{}",std::process::id()).as_bytes()))[..24].to_owned();
    let root=dir();fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let path=file(&id)?;fs::write(&path,bytes).map_err(|e|e.to_string())?;
    entries.insert(0,Entry{id:id.clone(),created_at:chrono::Local::now().to_rfc3339(),width:size.0,height:size.1,
        origin_x:origin.0,origin_y:origin.1,selection,source_hash:hash});
    let removed:Vec<_>=entries.drain(LIMIT.min(entries.len())..).collect();
    if let Err(err)=write_index(&entries){let _=fs::remove_file(path);return Err(err);}
    for old in removed {if let Ok(path)=file(&old.id){let _=fs::remove_file(path);}}
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct OpenEntry {pub entry:Entry,pub png:String}
#[tauri::command]
pub async fn snipcast_capture_history_list()->Vec<Entry> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}
#[tauri::command]
pub async fn snipcast_capture_history_open(id:String)->Result<OpenEntry,String> {
    tauri::async_runtime::spawn_blocking(move||{use base64::Engine;let (entry,bytes)=image(&id)?;
        Ok(OpenEntry{entry,png:base64::engine::general_purpose::STANDARD.encode(bytes)})
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn snipcast_capture_history_record(app:tauri::AppHandle,name:String,selection:Region)->Result<String,String> {
    use tauri::Manager;
    let source={let state=app.state::<Mutex<crate::screenshot::ScreenshotState>>();let state=state.lock().map_err(|e|e.to_string())?;
        state.captures.iter().find(|c|c.file.file_name().is_some_and(|f|f.to_string_lossy()==name)).cloned()};
    tauri::async_runtime::spawn_blocking(move||{
        if let Some(source)=source {let bytes=fs::read(source.file).map_err(|e|e.to_string())?;record(&bytes,(source.x,source.y),(source.width,source.height),selection)}
        else {let (entry,bytes)=image(&name)?;record(&bytes,(entry.origin_x,entry.origin_y),(entry.width,entry.height),selection)}
    }).await.map_err(|e|e.to_string())?
}
