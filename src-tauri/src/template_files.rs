//! Файлы вложений шаблонов: `["имя"]` → путь в `Snipcast/files/`.

use std::path::PathBuf;

pub fn template_files_dir() -> PathBuf {
    crate::data::snipcast_base_dir().join("files")
}

pub fn ensure_template_files_dir() -> Result<PathBuf, String> {
    let dir = template_files_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn resolve_template_file_ref(reference: &str) -> Result<PathBuf, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("пустая ссылка на файл".into());
    }

    let direct = PathBuf::from(reference);
    if direct.is_absolute() {
        if direct.is_file() {
            return Ok(direct);
        }
        return Err(format!("файл не найден: {}", direct.display()));
    }

    let base = template_files_dir();
    let candidate = base.join(reference);
    if candidate.is_file() {
        return Ok(candidate);
    }

    Err(format!(
        "файл «{reference}» не найден в {}",
        base.display()
    ))
}

pub fn resolve_template_file_refs(refs: &[String]) -> Result<Vec<PathBuf>, String> {
    refs.iter().map(|r| resolve_template_file_ref(r)).collect()
}
