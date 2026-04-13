//! Папки данных Snipcast и загрузка шаблонов с диска.
//! Windows: `C:\Snipcast` · macOS: `~/Documents/Snipcast`

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_PALETTE_HOTKEY: &str = "CommandOrControl+Shift+Backslash";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateChild {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub paste_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRow {
    pub id: String,
    pub title: String,
    pub preview: String,
    #[serde(default)]
    pub paste_text: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<TemplateChild>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_palette_hotkey")]
    pub palette_hotkey: String,
    #[serde(default = "default_autostart")]
    pub autostart: bool,
    #[serde(default)]
    pub master_templates_path: Option<String>,
}

fn default_autostart() -> bool {
    true
}

fn default_palette_hotkey() -> String {
    DEFAULT_PALETTE_HOTKEY.to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            palette_hotkey: DEFAULT_PALETTE_HOTKEY.to_string(),
            autostart: true,
            master_templates_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsDto {
    pub base_dir: String,
    pub master_dir: String,
    pub user_dir: String,
    pub config_path: String,
    pub variables_path: String,
}

pub fn snipcast_base_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\Snipcast")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Snipcast")
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".snipcast")
    }
}

pub fn default_master_dir() -> PathBuf {
    snipcast_base_dir().join("master")
}

pub fn user_templates_dir() -> PathBuf {
    snipcast_base_dir().join("user")
}

pub fn config_path() -> PathBuf {
    snipcast_base_dir().join("config.json")
}

pub fn variables_path() -> PathBuf {
    snipcast_base_dir().join("variables.json")
}

fn resolve_master_dir(config: &AppConfig) -> PathBuf {
    if let Some(p) = &config.master_templates_path {
        let t = p.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    default_master_dir()
}

/// Создаёт папки и дефолтные файлы при первом запуске.
pub fn init_data_tree() -> Result<(), String> {
    let base = snipcast_base_dir();
    let master = default_master_dir();
    let user = user_templates_dir();
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    fs::create_dir_all(&master).map_err(|e| e.to_string())?;
    fs::create_dir_all(&user).map_err(|e| e.to_string())?;

    if !config_path().exists() {
        let cfg = AppConfig::default();
        save_config(&cfg)?;
    }

    if !variables_path().exists() {
        let vars: serde_json::Map<String, serde_json::Value> = serde_json::json!({
            "user": "Алексей",
            "mail": "alex@example.com"
        })
        .as_object()
        .unwrap()
        .clone();
        save_variables_map(&vars)?;
    }

    seed_master_if_empty(&master)?;

    Ok(())
}

fn seed_master_if_empty(master: &Path) -> Result<(), String> {
    let mut has_json = false;
    if let Ok(rd) = fs::read_dir(master) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
                has_json = true;
                break;
            }
        }
    }
    if has_json {
        return Ok(());
    }

    let seed = include_str!("../templates/default_master.json");
    let path = master.join("default.json");
    fs::write(&path, seed).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_config() -> Result<AppConfig, String> {
    let p = config_path();
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path(), s).map_err(|e| e.to_string())
}

pub fn load_variables_map() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let p = variables_path();
    if !p.exists() {
        return Ok(serde_json::Map::new());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    match v {
        serde_json::Value::Object(m) => Ok(m),
        _ => Err("variables.json must be a JSON object".into()),
    }
}

pub fn save_variables_map(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let v = serde_json::Value::Object(map.clone());
    let s = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    fs::write(variables_path(), s).map_err(|e| e.to_string())
}

fn read_template_file(path: &Path) -> Result<Vec<TemplateRow>, String> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if let Ok(row) = serde_json::from_value::<TemplateRow>(v.clone()) {
        return Ok(vec![row]);
    }
    if let Some(arr) = v.as_array() {
        let mut out = Vec::new();
        for item in arr {
            out.push(serde_json::from_value(item.clone()).map_err(|e| e.to_string())?);
        }
        return Ok(out);
    }
    Err(format!("Invalid template JSON: {}", path.display()))
}

fn collect_templates_in_dir(dir: &Path) -> Result<Vec<TemplateRow>, String> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    paths.sort();
    let mut all = Vec::new();
    for p in paths {
        all.extend(read_template_file(&p)?);
    }
    Ok(all)
}

pub fn load_all_templates(config: &AppConfig) -> Result<Vec<TemplateRow>, String> {
    let master = resolve_master_dir(config);
    let user = user_templates_dir();
    let mut rows = Vec::new();
    if master.exists() {
        rows.extend(collect_templates_in_dir(&master)?);
    }
    if user.exists() {
        rows.extend(collect_templates_in_dir(&user)?);
    }
    Ok(rows)
}

pub fn paths_dto(config: &AppConfig) -> PathsDto {
    PathsDto {
        base_dir: snipcast_base_dir().to_string_lossy().into(),
        master_dir: resolve_master_dir(config).to_string_lossy().into(),
        user_dir: user_templates_dir().to_string_lossy().into(),
        config_path: config_path().to_string_lossy().into(),
        variables_path: variables_path().to_string_lossy().into(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTemplateFile {
    pub name: String,
    pub content: String,
}

pub fn list_user_template_files() -> Result<Vec<UserTemplateFile>, String> {
    let dir = user_templates_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for p in paths {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        out.push(UserTemplateFile { name, content });
    }
    Ok(out)
}

pub fn write_user_template_file(name: &str, content: &str) -> Result<(), String> {
    let safe = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    if !safe.ends_with(".json") {
        return Err("template file must end with .json".into());
    }
    let path = user_templates_dir().join(safe);
    let _: serde_json::Value = serde_json::from_str(content).map_err(|e| format!("invalid JSON: {e}"))?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn delete_user_template_file(name: &str) -> Result<(), String> {
    let safe = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let path = user_templates_dir().join(safe);
    fs::remove_file(&path).map_err(|e| e.to_string())
}
