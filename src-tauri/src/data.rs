//! Единое хранилище данных Snipcast.
//! Шаблоны: каталог `templates/`, по одному JSON на группу (полная `TemplateGroup`) и манифест `groups.json`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_PALETTE_HOTKEY: &str = "CommandOrControl+Shift+Backslash";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateChild {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub paste_text: String,
    #[serde(default)]
    pub group_id: Option<String>,
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
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_title: Option<String>,
    #[serde(default)]
    pub group_color: Option<String>,
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
    #[serde(default = "default_ui_theme")]
    pub theme: String,
    #[serde(default = "default_palette_list_density")]
    pub palette_list_density: String,
}

fn default_autostart() -> bool {
    true
}

fn default_palette_hotkey() -> String {
    DEFAULT_PALETTE_HOTKEY.to_string()
}

fn default_ui_theme() -> String {
    "dark".to_string()
}

fn default_palette_list_density() -> String {
    "normal".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            palette_hotkey: DEFAULT_PALETTE_HOTKEY.to_string(),
            autostart: true,
            theme: default_ui_theme(),
            palette_list_density: default_palette_list_density(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsDto {
    pub base_dir: String,
    pub config_path: String,
    pub variables_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TemplateNode {
    #[serde(rename = "template")]
    Template {
        id: String,
        title: String,
        content: String,
    },
    #[serde(rename = "folder")]
    Folder {
        id: String,
        title: String,
        items: Vec<TemplateNode>,
    },
    #[serde(rename = "separator")]
    Separator { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateGroup {
    pub id: String,
    pub title: String,
    pub color: String,
    #[serde(default)]
    pub is_master: bool,
    #[serde(default)]
    pub items: Vec<TemplateNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateStore {
    #[serde(default = "default_template_store_version")]
    pub version: u32,
    #[serde(default)]
    pub groups: Vec<TemplateGroup>,
}

fn default_template_store_version() -> u32 {
    1
}

fn default_template_store() -> TemplateStore {
    TemplateStore {
        version: 1,
        groups: vec![],
    }
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

pub fn config_path() -> PathBuf {
    snipcast_base_dir().join("config.json")
}

pub fn variables_path() -> PathBuf {
    snipcast_base_dir().join("variables.json")
}

pub fn templates_path() -> PathBuf {
    snipcast_base_dir().join("templates.json")
}

pub fn template_groups_dir() -> PathBuf {
    snipcast_base_dir().join("templates")
}

pub fn groups_manifest_path() -> PathBuf {
    template_groups_dir().join("groups.json")
}

pub fn init_data_tree() -> Result<(), String> {
    let base = snipcast_base_dir();
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    if !config_path().exists() {
        save_config(&AppConfig::default())?;
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

    let manifest = groups_manifest_path();
    let legacy = templates_path();
    if !manifest.exists() && !legacy.exists() {
        save_template_store(&default_template_store())?;
    }

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

pub fn load_template_store() -> Result<TemplateStore, String> {
    let manifest_path = groups_manifest_path();
    if manifest_path.exists() {
        return load_template_store_from_group_files();
    }

    // Миграция со старой схемы `templates.json` (единый файл).
    let legacy = templates_path();
    if legacy.exists() {
        let s = fs::read_to_string(&legacy).map_err(|e| e.to_string())?;
        let mut store: TemplateStore = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if store.groups.is_empty() {
            store = default_template_store();
        }
        save_template_store(&store)?;
        return Ok(store);
    }

    let store = default_template_store();
    save_template_store(&store)?;
    Ok(store)
}

pub fn save_template_store(store: &TemplateStore) -> Result<(), String> {
    fs::create_dir_all(template_groups_dir()).map_err(|e| e.to_string())?;

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GroupManifestEntry {
        id: String,
        title: String,
        color: String,
        is_master: bool,
        #[serde(skip_serializing_if = "String::is_empty")]
        file: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        master_source_path: Option<String>,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GroupsManifest {
        version: u32,
        groups: Vec<GroupManifestEntry>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedGroupFile<'a> {
        id: &'a str,
        title: &'a str,
        color: &'a str,
        items: &'a [TemplateNode],
    }

    fn sanitize_title_for_filename(title: &str) -> String {
        let trimmed = title.trim();
        let mut out = String::with_capacity(trimmed.chars().count().min(200));
        for ch in trimmed.chars() {
            match ch {
                '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\0' => out.push('_'),
                c if c.is_control() => {}
                c => out.push(c),
            }
        }
        let out = out
            .trim_end_matches(|c: char| c.is_whitespace() || c == '.')
            .to_string();
        const MAX_CHARS: usize = 180;
        let out: String = if out.chars().count() > MAX_CHARS {
            out.chars().take(MAX_CHARS).collect()
        } else {
            out
        };
        if out.is_empty() {
            "group".to_string()
        } else {
            out
        }
    }

    fn unique_group_filename(title: &str, used: &mut std::collections::HashSet<String>) -> String {
        let stem = sanitize_title_for_filename(title);
        let mut n = 0u32;
        loop {
            let file = if n == 0 {
                format!("{stem}.json")
            } else {
                format!("{stem}_{}.json", n + 1)
            };
            if used.insert(file.clone()) {
                return file;
            }
            n += 1;
        }
    }

    let mut manifest_groups: Vec<GroupManifestEntry> = Vec::new();
    let mut keep_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    keep_files.insert("groups.json".to_string());
    let mut used_filenames: std::collections::HashSet<String> = std::collections::HashSet::new();

    for g in &store.groups {
        let linked_master = g.is_master
            && g.master_source_path
                .as_ref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

        if linked_master {
            let src = g.master_source_path.clone().unwrap();
            manifest_groups.push(GroupManifestEntry {
                id: g.id.clone(),
                title: g.title.clone(),
                color: g.color.clone(),
                is_master: true,
                file: String::new(),
                master_source_path: Some(src),
            });
            continue;
        }

        let file = unique_group_filename(&g.title, &mut used_filenames);
        keep_files.insert(file.clone());
        manifest_groups.push(GroupManifestEntry {
            id: g.id.clone(),
            title: g.title.clone(),
            color: g.color.clone(),
            is_master: false,
            file: file.clone(),
            master_source_path: None,
        });
        let body = PersistedGroupFile {
            id: g.id.as_str(),
            title: g.title.as_str(),
            color: g.color.as_str(),
            items: g.items.as_slice(),
        };
        let s = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
        fs::write(template_groups_dir().join(&file), s).map_err(|e| e.to_string())?;
    }

    // Удаляем json-файлы групп, которых больше нет в манифесте.
    if let Ok(rd) = fs::read_dir(template_groups_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if keep_files.contains(&name) {
                continue;
            }
            let _ = fs::remove_file(p);
        }
    }

    let manifest = GroupsManifest {
        version: 1,
        groups: manifest_groups,
    };
    let manifest_s = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(groups_manifest_path(), manifest_s).map_err(|e| e.to_string())?;

    // Поддержка миграции: удаляем legacy файл после успешной записи новой схемы.
    let legacy = templates_path();
    if legacy.exists() {
        let _ = fs::remove_file(legacy);
    }

    Ok(())
}

fn load_template_store_from_group_files() -> Result<TemplateStore, String> {
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GroupManifestEntry {
        id: String,
        title: String,
        color: String,
        #[serde(default)]
        is_master: bool,
        #[serde(default)]
        file: String,
        #[serde(default)]
        master_source_path: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GroupItemsFile {
        #[serde(default)]
        #[allow(dead_code)]
        version: u32,
        #[serde(default)]
        items: Vec<TemplateNode>,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GroupsManifest {
        #[serde(default)]
        #[allow(dead_code)]
        version: u32,
        #[serde(default)]
        groups: Vec<GroupManifestEntry>,
    }

    fn normalize_group_color(mut g: TemplateGroup) -> TemplateGroup {
        if g.color.trim().is_empty() {
            g.color = "#5164f2".to_string();
        }
        g
    }

    let ms = fs::read_to_string(groups_manifest_path()).map_err(|e| e.to_string())?;
    let manifest: GroupsManifest = serde_json::from_str(&ms).map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    for g in manifest.groups {
        let ext = g
            .master_source_path
            .clone()
            .filter(|s| !s.trim().is_empty());

        if g.is_master && ext.is_some() {
            let path_str = ext.unwrap();
            let pb = PathBuf::from(&path_str);
            match load_group_from_import_path(&pb) {
                Ok(mut loaded) => {
                    loaded.id = g.id.clone();
                    loaded.is_master = true;
                    loaded.master_source_path = Some(path_str);
                    groups.push(normalize_group_color(loaded));
                }
                Err(_) => {
                    groups.push(normalize_group_color(TemplateGroup {
                        id: g.id,
                        title: g.title,
                        color: g.color,
                        is_master: true,
                        items: vec![],
                        master_source_path: Some(path_str),
                    }));
                }
            }
            continue;
        }

        if g.file.trim().is_empty() {
            groups.push(normalize_group_color(TemplateGroup {
                id: g.id,
                title: g.title,
                color: g.color,
                is_master: false,
                items: vec![],
                master_source_path: None,
            }));
            continue;
        }

        let file_path = template_groups_dir().join(&g.file);
        if !file_path.exists() {
            groups.push(normalize_group_color(TemplateGroup {
                id: g.id,
                title: g.title,
                color: g.color,
                is_master: false,
                items: vec![],
                master_source_path: None,
            }));
            continue;
        }
        let raw = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        if let Ok(mut file_group) = serde_json::from_str::<TemplateGroup>(&raw) {
            file_group.id = g.id.clone();
            file_group.is_master = false;
            file_group.master_source_path = None;
            groups.push(normalize_group_color(file_group));
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<GroupItemsFile>(&raw) {
            groups.push(normalize_group_color(TemplateGroup {
                id: g.id,
                title: g.title,
                color: g.color,
                is_master: false,
                items: parsed.items,
                master_source_path: None,
            }));
            continue;
        }
        if let Ok(arr) = serde_json::from_str::<Vec<TemplateNode>>(&raw) {
            groups.push(normalize_group_color(TemplateGroup {
                id: g.id,
                title: g.title,
                color: g.color,
                is_master: false,
                items: arr,
                master_source_path: None,
            }));
            continue;
        }
        groups.push(normalize_group_color(TemplateGroup {
            id: g.id,
            title: g.title,
            color: g.color,
            is_master: false,
            items: vec![],
            master_source_path: None,
        }));
    }

    if groups.is_empty() {
        return Ok(default_template_store());
    }

    Ok(TemplateStore { version: 1, groups })
}

fn generated_id(prefix: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{ms}")
}

fn stem_title_or(path: &Path, fallback: &str) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_group_from_json_value(value: &serde_json::Value, path: &Path) -> Result<TemplateGroup, String> {
    if let Ok(mut g) = serde_json::from_value::<TemplateGroup>(value.clone()) {
        g.master_source_path = None;
        return Ok(g);
    }
    if let Ok(store) = serde_json::from_value::<TemplateStore>(value.clone()) {
        let mut g = store
            .groups
            .into_iter()
            .next()
            .ok_or_else(|| "В файле нет групп".to_string())?;
        g.master_source_path = None;
        return Ok(g);
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyItems {
        #[serde(default)]
        items: Vec<TemplateNode>,
    }
    if let Ok(legacy) = serde_json::from_value::<LegacyItems>(value.clone()) {
        return Ok(TemplateGroup {
            id: generated_id("group"),
            title: stem_title_or(path, "group"),
            color: "#5164f2".to_string(),
            is_master: false,
            items: legacy.items,
            master_source_path: None,
        });
    }
    if let Ok(nodes) = serde_json::from_value::<Vec<TemplateNode>>(value.clone()) {
        return Ok(TemplateGroup {
            id: generated_id("group"),
            title: stem_title_or(path, "group"),
            color: "#5164f2".to_string(),
            is_master: false,
            items: nodes,
            master_source_path: None,
        });
    }
    Err("Неподдерживаемый формат JSON группы шаблонов".into())
}

fn load_group_from_import_path(path: &Path) -> Result<TemplateGroup, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    parse_group_from_json_value(&value, path)
}

pub fn import_master_group_from_file(path: &str) -> Result<TemplateGroup, String> {
    let p = PathBuf::from(path);
    let mut parsed = load_group_from_import_path(&p)?;
    let id = {
        let t = parsed.id.trim();
        if t.is_empty() {
            generated_id("group")
        } else {
            parsed.id.clone()
        }
    };
    parsed.id = id;
    parsed.is_master = true;
    if parsed.color.trim().is_empty() {
        parsed.color = "#5164f2".to_string();
    }
    parsed.master_source_path = None;
    Ok(parsed)
}

pub fn import_template_group_from_file(path: &str) -> Result<TemplateGroup, String> {
    let p = PathBuf::from(path);
    let mut parsed = load_group_from_import_path(&p)?;
    let id = {
        let t = parsed.id.trim();
        if t.is_empty() {
            generated_id("group")
        } else {
            parsed.id.clone()
        }
    };
    parsed.id = id;
    parsed.is_master = false;
    if parsed.color.trim().is_empty() {
        parsed.color = "#5164f2".to_string();
    }
    parsed.master_source_path = None;
    Ok(parsed)
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

fn first_preview_in_children(children: &[TemplateChild]) -> String {
    for c in children {
        if c.is_separator {
            continue;
        }
        if let Some(ref subs) = c.children {
            let p = first_preview_in_children(subs);
            if !p.is_empty() {
                return p;
            }
        } else if !c.preview.is_empty() {
            return c.preview.clone();
        }
    }
    String::new()
}

fn node_to_child(group: &TemplateGroup, node: &TemplateNode) -> TemplateChild {
    match node {
        TemplateNode::Template { id, title, content } => TemplateChild {
            id: format!("{}:{id}", group.id),
            title: title.clone(),
            preview: preview_from_body(content),
            paste_text: content.clone(),
            group_id: Some(group.id.clone()),
            is_separator: false,
            children: None,
        },
        TemplateNode::Separator { id } => TemplateChild {
            id: format!("{}:sep:{id}", group.id),
            title: String::new(),
            preview: String::new(),
            paste_text: String::new(),
            group_id: Some(group.id.clone()),
            is_separator: true,
            children: None,
        },
        TemplateNode::Folder { id, title, items } => {
            let children: Vec<TemplateChild> = items.iter().map(|n| node_to_child(group, n)).collect();
            TemplateChild {
                id: format!("{}:folder:{id}", group.id),
                title: title.clone(),
                preview: first_preview_in_children(&children),
                paste_text: String::new(),
                group_id: Some(group.id.clone()),
                is_separator: false,
                children: Some(children),
            }
        }
    }
}

fn node_to_row(group: &TemplateGroup, node: &TemplateNode) -> TemplateRow {
    match node {
        TemplateNode::Template { id, title, content } => TemplateRow {
            id: format!("{}:{id}", group.id),
            title: title.clone(),
            preview: preview_from_body(content),
            paste_text: Some(content.clone()),
            group_id: Some(group.id.clone()),
            group_title: Some(group.title.clone()),
            group_color: Some(group.color.clone()),
            children: None,
            is_separator: false,
        },
        TemplateNode::Separator { id } => TemplateRow {
            id: format!("{}:sep:{id}", group.id),
            title: "—".to_string(),
            preview: String::new(),
            paste_text: None,
            group_id: Some(group.id.clone()),
            group_title: Some(group.title.clone()),
            group_color: Some(group.color.clone()),
            children: None,
            is_separator: true,
        },
        TemplateNode::Folder { id, title, items } => {
            let children: Vec<TemplateChild> = items.iter().map(|n| node_to_child(group, n)).collect();
            TemplateRow {
                id: format!("{}:folder:{id}", group.id),
                title: title.clone(),
                preview: first_preview_in_children(&children),
                paste_text: None,
                group_id: Some(group.id.clone()),
                group_title: Some(group.title.clone()),
                group_color: Some(group.color.clone()),
                children: Some(children),
                is_separator: false,
            }
        }
    }
}

pub fn load_all_templates(_config: &AppConfig) -> Result<Vec<TemplateRow>, String> {
    let store = load_template_store()?;
    let mut rows = Vec::new();
    for group in &store.groups {
        for item in &group.items {
            rows.push(node_to_row(group, item));
        }
    }
    Ok(rows)
}

pub fn paths_dto(_config: &AppConfig) -> PathsDto {
    PathsDto {
        base_dir: snipcast_base_dir().to_string_lossy().into(),
        config_path: config_path().to_string_lossy().into(),
        variables_path: variables_path().to_string_lossy().into(),
    }
}
