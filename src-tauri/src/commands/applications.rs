use super::*;
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
pub fn scan(folders: Vec<String>) -> Result<Vec<Entry>, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("applications.ps1").trim_start_matches('\u{feff}'),
        ])
        .env(
            "SNIPCAST_APP_FOLDERS",
            serde_json::to_string(&folders).unwrap(),
        )
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .chars()
            .take(500)
            .collect());
    }
    let mut list: Vec<Entry> =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Каталог приложений: {e}"))?;
    for e in &mut list {
        e.id = format!(
            "app:{:x}",
            Sha256::digest(e.target.to_lowercase().as_bytes())
        );
    }
    Ok(list)
}
#[cfg(not(target_os = "windows"))]
pub fn scan(_: Vec<String>) -> Result<Vec<Entry>, String> {
    Ok(vec![])
}
pub fn refresh(app: AppHandle) {
    if app.state::<Runtime>().scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        match scan(config(&app).folders) {
            Ok(list) => {
                if let Ok(bytes) = serde_json::to_vec(&list) {
                    let _ = std::fs::write(
                        crate::data::snipcast_base_dir().join("applications.json"),
                        bytes,
                    );
                }
                *app.state::<Runtime>().apps.lock().unwrap() = list;
            }
            Err(e) => report(&app, e),
        }
        app.state::<Runtime>()
            .scanning
            .store(false, Ordering::SeqCst);
        let _ = app.emit("snipcast://commands-catalog", ());
    });
}
pub fn launch(entry: &Entry) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let target: Vec<u16> = entry.target.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let r = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        );
        if r as isize <= 32 {
            return Err("Windows не смогла запустить приложение. Обновите список".into());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    Err("Запуск приложений пока доступен в Windows".into())
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut previous = 0;
        loop {
            let mut roots = vec![];
            if let Some(v) = std::env::var_os("APPDATA") {
                roots.push((
                    std::path::PathBuf::from(v).join("Microsoft/Windows/Start Menu/Programs"),
                    8,
                ));
            }
            if let Some(v) = std::env::var_os("PROGRAMDATA") {
                roots.push((
                    std::path::PathBuf::from(v).join("Microsoft/Windows/Start Menu/Programs"),
                    8,
                ));
            }
            if let Some(p) = dirs::desktop_dir() {
                roots.push((p, 0));
            }
            if let Some(v) = std::env::var_os("PUBLIC") {
                roots.push((std::path::PathBuf::from(v).join("Desktop"), 0));
            }
            roots.extend(config(&app).folders.into_iter().map(|s| (s.into(), 3)));
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            for (root, depth) in roots {
                fingerprint(&root, depth, &mut hash);
            }
            use std::hash::Hasher;
            let current = hash.finish();
            if previous != 0 && current != previous {
                refresh(app.clone());
            }
            previous = current;
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}
fn fingerprint(path: &std::path::Path, depth: u8, hash: &mut impl std::hash::Hasher) {
    use std::hash::Hash;
    path.hash(hash);
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                continue;
            }
            if meta.is_dir() {
                if depth > 0 {
                    fingerprint(&entry.path(), depth - 1, hash);
                }
            } else if entry
                .path()
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("lnk") || s.eq_ignore_ascii_case("exe"))
            {
                entry.path().hash(hash);
                meta.len().hash(hash);
                meta.modified().ok().hash(hash);
            }
        }
    }
}
