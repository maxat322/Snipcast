use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    ptr,
    sync::{mpsc, OnceLock},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{DataExchange::*, Memory::*, Threading::*},
    UI::{Shell::DragQueryFileW, WindowsAndMessaging::*},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Format {
    pub id: u32,
    pub name: String,
    pub data: String,
}
#[derive(Default)]
pub struct Capture {
    pub formats: Vec<Format>,
    pub text: String,
    pub files: Vec<String>,
    pub image: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub source_path: String,
    pub sequence: u32,
}
struct Close;
impl Drop for Close {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}
unsafe fn bytes(id: u32) -> Option<Vec<u8>> {
    let h = GetClipboardData(id);
    if h.is_null() {
        return None;
    }
    let size = GlobalSize(h);
    if size == 0 || size > 32 * 1024 * 1024 {
        return None;
    }
    let p = GlobalLock(h);
    if p.is_null() {
        return None;
    }
    let b = std::slice::from_raw_parts(p as *const u8, size).to_vec();
    GlobalUnlock(h);
    Some(b)
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn capture() -> Result<Option<Capture>, String> {
    unsafe {
        let seq = sequence();
        if OpenClipboard(ptr::null_mut()) == 0 {
            return Err("Буфер занят".into());
        }
        let guard = Close;
        for marker in [
            "ExcludeClipboardContentFromMonitorProcessing",
            "Clipboard Viewer Ignore",
        ] {
            if IsClipboardFormatAvailable(RegisterClipboardFormatW(wide(marker).as_ptr())) != 0 {
                return Ok(None);
            }
        }
        let allowed = RegisterClipboardFormatW(wide("CanIncludeInClipboardHistory").as_ptr());
        if bytes(allowed).is_some_and(|b| b.len() >= 4 && b[..4] == [0, 0, 0, 0]) {
            return Ok(None);
        }
        let mut c = Capture {
            sequence: seq,
            ..Default::default()
        };
        let owner = GetClipboardOwner();
        if !owner.is_null() {
            let mut pid = 0;
            GetWindowThreadProcessId(owner, &mut pid);
            let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !proc.is_null() {
                let mut path = vec![0u16; 32768];
                let mut len = path.len() as u32;
                if QueryFullProcessImageNameW(proc, 0, path.as_mut_ptr(), &mut len) != 0 {
                    c.source_path = String::from_utf16_lossy(&path[..len as usize]);
                    c.source = std::path::Path::new(&c.source_path)
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into();
                }
                CloseHandle(proc);
            }
        }
        let mut id = 0;
        let mut total = 0;
        loop {
            id = EnumClipboardFormats(id);
            if id == 0 {
                break;
            }
            let mut name = vec![0u16; 256];
            let n = GetClipboardFormatNameW(id, name.as_mut_ptr(), 256);
            let name = if n > 0 {
                String::from_utf16_lossy(&name[..n as usize])
            } else {
                String::new()
            };
            if ![13, 15, 8, 17].contains(&id)
                && !["HTML Format", "Rich Text Format", "PNG"].contains(&name.as_str())
            {
                continue;
            }
            if let Some(b) = bytes(id) {
                total += b.len();
                if total > 32 * 1024 * 1024 {
                    return Err("Запись буфера превышает 32 МБ".into());
                }
                if id == 13 {
                    let chars: Vec<u16> = b
                        .chunks_exact(2)
                        .map(|s| u16::from_le_bytes([s[0], s[1]]))
                        .take_while(|v| *v != 0)
                        .collect();
                    c.text = String::from_utf16_lossy(&chars);
                }
                if id == 15 {
                    let h = GetClipboardData(id);
                    let count = DragQueryFileW(h, 0xffff_ffff, ptr::null_mut(), 0);
                    for i in 0..count.min(10000) {
                        let n = DragQueryFileW(h, i, ptr::null_mut(), 0);
                        let mut b = vec![0u16; n as usize + 1];
                        DragQueryFileW(h, i, b.as_mut_ptr(), n + 1);
                        c.files.push(String::from_utf16_lossy(&b[..n as usize]));
                    }
                }
                c.formats.push(Format {
                    id,
                    name,
                    data: base64::engine::general_purpose::STANDARD.encode(b),
                });
            }
        }
        drop(guard);
        if c.formats
            .iter()
            .any(|f| [8, 17].contains(&f.id) || f.name == "PNG")
        {
            if let Ok(im) = arboard::Clipboard::new().and_then(|mut b| b.get_image()) {
                c.width = im.width as u32;
                c.height = im.height as u32;
                if let Some(img) =
                    image::RgbaImage::from_raw(c.width, c.height, im.bytes.into_owned())
                {
                    let mut out = std::io::Cursor::new(Vec::new());
                    image::DynamicImage::ImageRgba8(img)
                        .write_to(&mut out, image::ImageFormat::Png)
                        .map_err(|e| e.to_string())?;
                    c.image = Some(out.into_inner());
                }
            }
        }
        if seq != sequence() {
            return Err("Буфер изменился во время чтения".into());
        }
        Ok(if c.formats.is_empty() { None } else { Some(c) })
    }
}
pub fn restore(formats: &[Format]) -> Result<(), String> {
    unsafe {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return Err("Буфер занят, повторите вставку".into());
        }
        let _g = Close;
        let mut buffers = vec![];
        for f in formats {
            let b = base64::engine::general_purpose::STANDARD
                .decode(&f.data)
                .map_err(|e| e.to_string())?;
            let h = GlobalAlloc(GMEM_MOVEABLE, b.len());
            if h.is_null() {
                for (_, h) in buffers {
                    GlobalFree(h);
                }
                return Err("Недостаточно памяти".into());
            }
            let p = GlobalLock(h);
            if p.is_null() {
                GlobalFree(h);
                for (_, h) in buffers {
                    GlobalFree(h);
                }
                return Err("Не удалось подготовить буфер".into());
            }
            ptr::copy_nonoverlapping(b.as_ptr(), p as *mut u8, b.len());
            GlobalUnlock(h);
            let id = if f.name.is_empty() {
                f.id
            } else {
                RegisterClipboardFormatW(wide(&f.name).as_ptr())
            };
            buffers.push((id, h));
        }
        EmptyClipboard();
        let mut failed = false;
        for (id, h) in buffers {
            if SetClipboardData(id, h).is_null() {
                GlobalFree(h);
                failed = true;
            }
        }
        if failed {
            return Err("Не удалось восстановить часть форматов".into());
        }
        Ok(())
    }
}
static UPDATES: OnceLock<mpsc::Sender<()>> = OnceLock::new();
unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE {
        if let Some(tx) = UPDATES.get() {
            let _ = tx.send(());
        }
        return 0;
    }
    DefWindowProcW(hwnd, msg, w, l)
}
pub fn listen(tx: mpsc::Sender<()>) {
    std::thread::spawn(move || unsafe {
        let _ = UPDATES.set(tx);
        let name = wide("SnipcastClipboardHistory");
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            lpszClassName: name.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            0,
            name.as_ptr(),
            name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }
        if AddClipboardFormatListener(hwnd) == 0 {
            return;
        }
        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            DispatchMessageW(&msg);
        }
        RemoveClipboardFormatListener(hwnd);
        DestroyWindow(hwnd);
    });
}
