//! Папки данных Snipcast и загрузка шаблонов с диска.
//! Windows: `C:\Snipcast` · macOS: `~/Documents/Snipcast`
//!
//! Пользовательские шаблоны (0.21+): `user/structure.json` + файлы `*.txt`
//! (имя файла без `.txt` = заголовок; превью — сокращённая первая строка тела).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_PALETTE_HOTKEY: &str = "CommandOrControl+Shift+Backslash";

pub const USER_STRUCTURE_FILE: &str = "structure.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateChild {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub paste_text: String,
    #[serde(default)]
    pub is_separator: bool,
    #[serde(default)]
    pub children: Option<Vec<TemplateChild>>,
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
    #[serde(default)]
    pub is_separator: bool,
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
    pub user_structure_path: String,
}

// --- Дерево «Свои шаблоны» (structure.json) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStructureRoot {
    #[serde(default = "default_structure_version")]
    pub version: u32,
    pub items: Vec<UserStructureItem>,
}

fn default_structure_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserStructureItem {
    #[serde(rename = "template")]
    Template { file: String },
    #[serde(rename = "folder")]
    Folder {
        id: String,
        title: String,
        items: Vec<UserStructureItem>,
    },
    #[serde(rename = "separator")]
    Separator { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTxtReadDto {
    pub file: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTxtWriteResultDto {
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTemplateCreateResultDto {
    pub file: String,
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

pub fn user_structure_path() -> PathBuf {
    user_templates_dir().join(USER_STRUCTURE_FILE)
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
    ensure_user_structure_file()?;

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

/// Если `structure.json` ещё нет — создать по списку `*.txt` в `user/`.
pub fn ensure_user_structure_file() -> Result<(), String> {
    let p = user_structure_path();
    if p.exists() {
        return Ok(());
    }
    let dir = user_templates_dir();
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|path| path.extension().and_then(|x| x.to_str()) == Some("txt"))
        .collect();
    paths.sort();
    let items: Vec<UserStructureItem> = paths
        .into_iter()
        .filter_map(|path| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .map(|file| UserStructureItem::Template { file })
        .collect();
    let root = UserStructureRoot {
        version: 1,
        items,
    };
    save_user_structure(&root)
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

fn collect_master_templates_in_dir(dir: &Path) -> Result<Vec<TemplateRow>, String> {
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

fn preview_from_body(body: &str) -> String {
    let line = body.lines().next().unwrap_or("").trim();
    const MAX: usize = 120;
    let count = line.chars().count();
    if count > MAX {
        line.chars().take(MAX).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

fn validate_txt_filename(name: &str) -> Result<String, String> {
    let safe = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "некорректное имя файла".to_string())?;
    if !safe.ends_with(".txt") {
        return Err("ожидается имя файла .txt".into());
    }
    if safe.contains("..") || Path::new(safe).components().count() != 1 {
        return Err("недопустимый путь".into());
    }
    Ok(safe.to_string())
}

fn title_to_stem(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        "template".to_string()
    } else {
        s
    }
}

fn validate_structure_items(_items: &[UserStructureItem]) -> Result<(), String> {
    Ok(())
}

fn read_user_txt_as_row(dir: &Path, file: &str) -> Result<TemplateRow, String> {
    let safe = validate_txt_filename(file)?;
    let path = dir.join(&safe);
    let body = fs::read_to_string(&path).map_err(|e| format!("{safe}: {e}"))?;
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(TemplateRow {
        id: format!("u:{safe}"),
        title,
        preview: preview_from_body(&body),
        paste_text: Some(body),
        children: None,
        is_separator: false,
    })
}

/// Корневой шаблон: `имя.txt` или `подпапка/имя.txt`.
fn read_user_txt_as_row_any(dir: &Path, file: &str) -> Result<TemplateRow, String> {
    if file.contains('/') {
        let ch = read_user_txt_as_child_rel(dir, file)?;
        Ok(TemplateRow {
            id: ch.id.clone(),
            title: ch.title,
            preview: ch.preview.clone(),
            paste_text: Some(ch.paste_text.clone()),
            children: None,
            is_separator: false,
        })
    } else {
        read_user_txt_as_row(dir, file)
    }
}

fn read_user_txt_as_child(dir: &Path, file: &str) -> Result<TemplateChild, String> {
    let safe = validate_txt_filename(file)?;
    let path = dir.join(&safe);
    let body = fs::read_to_string(&path).map_err(|e| format!("{safe}: {e}"))?;
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(TemplateChild {
        id: format!("u:{safe}"),
        title,
        preview: preview_from_body(&body),
        paste_text: body,
        is_separator: false,
        children: None,
    })
}

/// Элемент папки: `имя.txt` или `подпапка/имя.txt` (один уровень вложенности).
fn read_user_txt_as_child_any(dir: &Path, file: &str) -> Result<TemplateChild, String> {
    if file.contains('/') {
        read_user_txt_as_child_rel(dir, file)
    } else {
        read_user_txt_as_child(dir, file)
    }
}

fn first_preview_in_children(children: &[TemplateChild]) -> String {
    for c in children {
        if c.is_separator {
            continue;
        }
        if let Some(ref subs) = c.children {
            if !subs.is_empty() {
                let p = first_preview_in_children(subs);
                if !p.is_empty() {
                    return p;
                }
            }
        } else if !c.preview.is_empty() {
            return c.preview.clone();
        }
    }
    String::new()
}

fn structure_items_to_children(dir: &Path, items: &[UserStructureItem]) -> Result<Vec<TemplateChild>, String> {
    let mut out = Vec::new();
    for it in items {
        match it {
            UserStructureItem::Template { file } => {
                out.push(read_user_txt_as_child_any(dir, file)?);
            }
            UserStructureItem::Separator { id } => {
                out.push(TemplateChild {
                    id: format!("us:{id}"),
                    title: String::new(),
                    preview: String::new(),
                    paste_text: String::new(),
                    is_separator: true,
                    children: None,
                });
            }
            UserStructureItem::Folder {
                id,
                title,
                items: inner,
            } => {
                let children_vec = structure_items_to_children(dir, inner)?;
                let preview = first_preview_in_children(&children_vec);
                out.push(TemplateChild {
                    id: format!("uf:{id}"),
                    title: title.clone(),
                    preview,
                    paste_text: String::new(),
                    is_separator: false,
                    children: Some(children_vec),
                });
            }
        }
    }
    Ok(out)
}

fn user_items_to_rows(dir: &Path, items: &[UserStructureItem]) -> Result<Vec<TemplateRow>, String> {
    let mut rows = Vec::new();
    for it in items {
        match it {
            UserStructureItem::Template { file } => {
                rows.push(read_user_txt_as_row_any(dir, file)?);
            }
            UserStructureItem::Folder {
                id,
                title,
                items: inner,
            } => {
                let children = structure_items_to_children(dir, inner)?;
                let preview = children
                    .iter()
                    .find(|c| !c.is_separator)
                    .map(|c| c.preview.clone())
                    .unwrap_or_default();
                rows.push(TemplateRow {
                    id: format!("uf:{id}"),
                    title: title.clone(),
                    preview,
                    paste_text: None,
                    children: Some(children),
                    is_separator: false,
                });
            }
            UserStructureItem::Separator { id } => {
                rows.push(TemplateRow {
                    id: format!("us:{id}"),
                    title: "—".to_string(),
                    preview: String::new(),
                    paste_text: None,
                    children: None,
                    is_separator: true,
                });
            }
        }
    }
    Ok(rows)
}

pub fn load_user_structure() -> Result<UserStructureRoot, String> {
    let p = user_structure_path();
    if !p.exists() {
        ensure_user_structure_file()?;
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let root: UserStructureRoot = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    validate_structure_items(&root.items)?;
    Ok(root)
}

pub fn save_user_structure(root: &UserStructureRoot) -> Result<(), String> {
    validate_structure_items(&root.items)?;
    fs::create_dir_all(user_templates_dir()).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    fs::write(user_structure_path(), s).map_err(|e| e.to_string())
}

/// Все `file` из structure.json (рекурсивно).
fn collect_referenced_txt_files(items: &[UserStructureItem]) -> HashSet<String> {
    let mut set = HashSet::new();
    fn walk(items: &[UserStructureItem], set: &mut HashSet<String>) {
        for it in items {
            match it {
                UserStructureItem::Template { file } => {
                    set.insert(file.clone());
                }
                UserStructureItem::Folder { items: inner, .. } => walk(inner, set),
                UserStructureItem::Separator { .. } => {}
            }
        }
    }
    walk(items, &mut set);
    set
}

/// Относительный путь: `имя.txt` или `подпапка/имя.txt` (без `..` и `\`).
fn validate_user_txt_relative(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\\') || rel.contains("..") {
        return Err("недопустимый путь к шаблону".into());
    }
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err("недопустимая глубина пути".into());
    }
    for p in &parts {
        if p.is_empty() || *p == "." || *p == ".." {
            return Err("недопустимый путь".into());
        }
    }
    let last = parts[parts.len() - 1];
    if !last.ends_with(".txt") {
        return Err("ожидается .txt".into());
    }
    let mut full = dir.to_path_buf();
    for part in &parts {
        full.push(part);
    }
    Ok(full)
}

fn read_user_txt_as_child_rel(dir: &Path, rel: &str) -> Result<TemplateChild, String> {
    let path = validate_user_txt_relative(dir, rel)?;
    let body = fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))?;
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rel_norm = rel.replace('\\', "/");
    Ok(TemplateChild {
        id: format!("u:{rel_norm}"),
        title,
        preview: preview_from_body(&body),
        paste_text: body,
        is_separator: false,
        children: None,
    })
}

/// Шаблоны и папки на диске, которых нет в structure.json, добавляются в конец списка.
fn append_orphan_disk_items(
    dir: &Path,
    structure_items: &[UserStructureItem],
    rows: &mut Vec<TemplateRow>,
) -> Result<(), String> {
    let referenced = collect_referenced_txt_files(structure_items);
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    let mut root_txt: Vec<String> = Vec::new();
    let mut subdirs: Vec<String> = Vec::new();

    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name == USER_STRUCTURE_FILE {
            continue;
        }
        if p.is_dir() {
            subdirs.push(name);
        } else if p.extension().and_then(|x| x.to_str()) == Some("txt") {
            root_txt.push(name);
        }
    }

    root_txt.sort();
    for file in root_txt {
        if referenced.contains(&file) {
            continue;
        }
        rows.push(read_user_txt_as_row(dir, &file)?);
    }

    subdirs.sort();
    for sub in subdirs {
        let sub_path = dir.join(&sub);
        if !sub_path.is_dir() {
            continue;
        }
        let mut rel_files: Vec<String> = Vec::new();
        if let Ok(srd) = fs::read_dir(&sub_path) {
            for e in srd.flatten() {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("txt") {
                    let fname = e.file_name().to_string_lossy().into_owned();
                    rel_files.push(format!("{sub}/{fname}"));
                }
            }
        }
        if rel_files.is_empty() {
            continue;
        }
        rel_files.retain(|rel| !referenced.contains(rel));
        if rel_files.is_empty() {
            continue;
        }
        rel_files.sort();
        let mut children: Vec<TemplateChild> = Vec::new();
        for rel in &rel_files {
            children.push(read_user_txt_as_child_rel(dir, rel)?);
        }
        let preview = first_preview_in_children(&children);
        rows.push(TemplateRow {
            id: format!("uf:orphan-dir:{sub}"),
            title: sub.clone(),
            preview,
            paste_text: None,
            children: Some(children),
            is_separator: false,
        });
    }

    Ok(())
}

fn load_user_template_rows() -> Result<Vec<TemplateRow>, String> {
    let dir = user_templates_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let root = load_user_structure()?;
    let mut rows = user_items_to_rows(&dir, &root.items)?;
    append_orphan_disk_items(&dir, &root.items, &mut rows)?;
    Ok(rows)
}

pub fn load_all_templates(config: &AppConfig) -> Result<Vec<TemplateRow>, String> {
    let master = resolve_master_dir(config);
    let mut rows = Vec::new();
    if master.exists() {
        rows.extend(collect_master_templates_in_dir(&master)?);
    }
    rows.extend(load_user_template_rows()?);
    Ok(rows)
}

pub fn paths_dto(config: &AppConfig) -> PathsDto {
    PathsDto {
        base_dir: snipcast_base_dir().to_string_lossy().into(),
        master_dir: resolve_master_dir(config).to_string_lossy().into(),
        user_dir: user_templates_dir().to_string_lossy().into(),
        config_path: config_path().to_string_lossy().into(),
        variables_path: variables_path().to_string_lossy().into(),
        user_structure_path: user_structure_path().to_string_lossy().into(),
    }
}

pub fn read_user_template_txt(file: &str) -> Result<UserTxtReadDto, String> {
    let safe = validate_txt_filename(file)?;
    let dir = user_templates_dir();
    let path = dir.join(&safe);
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(UserTxtReadDto {
        file: safe,
        title,
        content,
    })
}

pub fn write_user_template_txt(
    old_file: Option<&str>,
    title: &str,
    content: &str,
) -> Result<UserTxtWriteResultDto, String> {
    let dir = user_templates_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = title_to_stem(title);
    let mut candidate = format!("{stem}.txt");
    let old = old_file.map(|o| validate_txt_filename(o)).transpose()?;

    if let Some(ref o) = old {
        if o == &candidate {
            fs::write(dir.join(o), content).map_err(|e| e.to_string())?;
            return Ok(UserTxtWriteResultDto { file: o.clone() });
        }
    }

    let mut n = 2u32;
    while dir.join(&candidate).exists() && Some(candidate.as_str()) != old.as_deref() {
        candidate = format!("{stem}_{n}.txt");
        n += 1;
    }

    fs::write(dir.join(&candidate), content).map_err(|e| e.to_string())?;

    if let Some(o) = old {
        if o != candidate {
            let op = dir.join(o);
            if op.exists() {
                fs::remove_file(&op).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(UserTxtWriteResultDto { file: candidate })
}

pub fn create_user_template_file() -> Result<UserTemplateCreateResultDto, String> {
    let dir = user_templates_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = "Новый шаблон";
    let mut candidate = format!("{stem}.txt");
    let mut n = 2u32;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem}_{n}.txt");
        n += 1;
    }
    fs::write(dir.join(&candidate), "\n").map_err(|e| e.to_string())?;
    Ok(UserTemplateCreateResultDto { file: candidate })
}

pub fn delete_user_template_txt(file: &str) -> Result<(), String> {
    let safe = validate_txt_filename(file)?;
    let path = user_templates_dir().join(&safe);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
