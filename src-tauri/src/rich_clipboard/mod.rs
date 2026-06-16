//! Буфер обмена: plain text и список файлов (CF_HDROP / NSFilenames).

use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
struct ClipboardPayload {
    file_paths: Vec<PathBuf>,
}

pub fn write_plain_text(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .map_err(|e| e.to_string())?
        .set()
        .text(text.to_string())
        .map_err(|e| e.to_string())
}

pub fn write_file_list(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("список файлов пуст".into());
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let payload = ClipboardPayload {
            file_paths: paths.to_vec(),
            ..Default::default()
        };
        return platform::write_native(&payload);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let refs: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
        arboard::Clipboard::new()
            .map_err(|e| e.to_string())?
            .set()
            .file_list(&refs)
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;

    const GMEM: u32 = GMEM_MOVEABLE | GMEM_ZEROINIT;

    pub fn write_native(payload: &ClipboardPayload) -> Result<(), String> {
        unsafe {
            if OpenClipboard(0 as HANDLE) == 0 {
                return Err("OpenClipboard failed".into());
            }
            EmptyClipboard();
            if !payload.file_paths.is_empty() {
                set_file_drop_list(&payload.file_paths)?;
            }
            CloseClipboard();
        }
        Ok(())
    }

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        pt_x: i32,
        pt_y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    fn set_file_drop_list(paths: &[PathBuf]) -> Result<(), String> {
        let mut wide: Vec<u16> = Vec::new();
        for p in paths {
            let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            wide.extend(abs.as_os_str().encode_wide());
            wide.push(0);
        }
        wide.push(0);

        let header = size_of::<DropFiles>();
        let total = header + wide.len() * 2;
        unsafe {
            let h = GlobalAlloc(GMEM, total) as HGLOBAL;
            if h.is_null() {
                return Err("GlobalAlloc HDROP failed".into());
            }
            let ptr = GlobalLock(h) as *mut u8;
            if ptr.is_null() {
                return Err("GlobalLock HDROP failed".into());
            }
            let df = ptr as *mut DropFiles;
            (*df).p_files = size_of::<DropFiles>() as u32;
            (*df).pt_x = 0;
            (*df).pt_y = 0;
            (*df).f_nc = 0;
            (*df).f_wide = 1;
            let files_ptr = ptr.add(header) as *mut u16;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), files_ptr, wide.len());
            GlobalUnlock(h);
            if SetClipboardData(CF_HDROP as u32, h as HANDLE).is_null() {
                return Err("SetClipboardData CF_HDROP failed".into());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn write_native(payload: &ClipboardPayload) -> Result<(), String> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();

        if !payload.file_paths.is_empty() {
            let mut urls: Vec<Retained<NSURL>> = Vec::new();
            for p in &payload.file_paths {
                let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
                let path = NSString::from_str(&abs.to_string_lossy());
                if let Some(url) = NSURL::fileURLWithPath(&path) {
                    urls.push(url);
                }
            }
            if !urls.is_empty() {
                let arr = NSArray::from_retained_slice(&urls);
                pb.writeObjects(&arr);
            }
        }

        Ok(())
    }
}
