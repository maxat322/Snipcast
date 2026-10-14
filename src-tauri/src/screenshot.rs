//! Снимки экрана: захват мониторов, оверлеи выделения, закреплённые снимки.
//!
//! Схема работы:
//! 1. `start_capture` прячет палитру, ждёт ~120 мс (чтобы палитра исчезла с экрана),
//!    снимает виртуальный рабочий стол в физических пикселях и пишет временный PNG.
//! 2. Единое безрамочное always-on-top окно `capture-0` покрывает все мониторы
//!    (фронтенд рисует снимок + выделение области + панель инструментов).
//! 3. Готовые кропы фронтенд присылает PNG-байтами (base64) — Rust копирует в буфер,
//!    сохраняет в файл или создаёт окно-закреп `pin-N`.
//! 4. Снимки для оверлеев/закрепов отдаются фронтенду командой `capture_image_data`
//!    (сырые байты через `tauri::ipc::Response`), поэтому canvas остаётся чистым.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use std::io::Write as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::data::AppConfig;

const MAIN_WINDOW_LABEL: &str = "main";

/// Префиксы меток окон, участвующих в скриншотере.
pub const CAPTURE_PREFIX: &str = "capture-";
pub const PIN_PREFIX: &str = "pin-";
pub const PIN_PADDING: i32 = 24;
/// Отдельное окно контекстного меню закрепа (не обрезается краями закрепа).
pub const PINMENU_LABEL: &str = "pinmenu";
/// В первые мгновения после показа меню окно получает ложные потери фокуса
/// (гонка за фокус с закрепом) — в этот период `Focused(false)` игнорируется.
pub const MENU_FOCUS_GRACE: Duration = Duration::from_millis(400);

#[derive(Clone)]
pub struct MonitorCapture {
    /// Метка оверлея: "capture-0", "capture-1", ...
    pub label: String,
    /// PNG снимка монитора в физических пикселях.
    pub file: PathBuf,
    /// Физическая позиция монитора в координатах экрана.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Debug, Clone)]
pub struct PinEntry {
    pub file: PathBuf,
    pub ready: bool,
    /// Физические координаты окна при создании (для отладки и будущих фич).
    #[allow(dead_code)]
    pub x: i32,
    #[allow(dead_code)]
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Пресет, активный в текущем оверлее захвата: подменяет папку/шаблон
/// и задаёт действие, которое фронтенд выполняет сразу после выделения.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetOverride {
    pub title: String,
    pub dir: String,
    pub file_template: String,
    /// "save" | "ocr" | "pin"
    pub action: String,
}

#[derive(Default)]
pub struct ScreenshotState {
    pub preparing: bool,
    pub monitors: Vec<ScreenMonitor>,
    pub selected_pin: Option<String>,
    pub detection: crate::capture_detection::Snapshot,
    /// Активная сессия захвата (пустая, когда оверлеев нет).
    pub captures: Vec<MonitorCapture>,
    /// Пресет, с которым запущена текущая сессия (если есть).
    pub active_preset: Option<PresetOverride>,
    /// Метки ЖИВЫХ оверлеев (переиспользуются между захватами: создание
    /// WebView2 — тяжёлая операция, источник «тормозов» при открытии;
    /// после первого захвата оверлеи только показываются/прячутся).
    pub overlay_labels: Vec<String>,
    /// Закреплённые снимки: метка окна -> запись.
    pub pins: HashMap<String, PinEntry>,
    pin_edits: HashMap<String, PinEditSession>,
    pin_edit_seq: u64,
    pub pin_seq: u64,
    /// Счётчик имён файлов для шаблона с {n}.
    pub save_seq: u64,
    /// Закреп, для которого открыто контекстное меню.
    pub menu_for: Option<String>,
    /// Момент показа окна меню (для grace-периода `MENU_FOCUS_GRACE`).
    pub menu_shown_at: Option<Instant>,
    /// Оверлеи, отрисовавшие кадр текущей сессии (ждём все — показываем
    /// разом, иначе на холодной загрузке мониторы «вспыхивают» по очереди).
    pub ready_overlays: Vec<String>,
    /// Сессия уже показана на экран (барьер сработал или сработал таймаут).
    pub session_shown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfoDto {
    pub video_selection: bool,
    pub session_id: String,
    pub monitors: Vec<ScreenMonitor>,
    pub candidates: Vec<crate::capture_detection::Candidate>,
    pub cursor: Option<crate::capture_detection::ScreenPoint>,
    pub label: String,
    /// Имя файла снимка (для `capture_image_data`).
    pub image_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    /// Пресет, с которым открыт оверлей (подменяет сохранение/действие).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<PresetOverride>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInfoDto {
    pub label: String,
    pub image_name: String,
    pub width: u32,
    pub height: u32,
    pub selected: bool,
    pub image_rect: WindowRect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowRect { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
#[derive(Debug, Clone, Serialize)]
pub struct ScreenMonitor { pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub scale: f64 }

#[derive(Clone, Copy)]
struct MonRect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    scale: f64,
}

// ---------------------------------------------------------------------------
// Временные файлы
// ---------------------------------------------------------------------------

pub fn capture_tmp_dir() -> PathBuf {
    // An isolated data profile must also isolate its captures and stale-file cleanup.
    if let Some(dir)=std::env::var_os("SNIPCAST_DATA_DIR").filter(|d|!d.is_empty()) {
        return PathBuf::from(dir).join("capture-cache");
    }
    std::env::temp_dir().join("snipcast")
}

fn write_png_temp(prefix: &str, img: &image::RgbaImage) -> Result<PathBuf, String> {
    let dir = capture_tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать {}: {e}", dir.display()))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let path = dir.join(format!("{prefix}-{}-{ts}.png", std::process::id()));
    // Temp-папка приватна для снимков, атомарность не критична.
    std::fs::write(&path, encode_png(img)).map_err(|e| format!("запись снимка: {e}"))?;
    Ok(path)
}

fn encode_png(img: &image::RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    use image::ImageEncoder;
    let encoder = image::codecs::png::PngEncoder::new_with_quality(&mut out,
        image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Sub);
    encoder.write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .expect("encoding RGBA PNG into Vec cannot fail");
    out
}

/// Журнал ошибок захвата: `<база>/screenshot-errors.log`.
/// Ошибки без журнала невидимы (окно без консоли), а по файлу можно понять,
/// почему скриншот не сработал, даже если уведомление пропустили.
pub fn log_capture_error(context: &str, err: &str) {
    log_capture_line(&format!("ОШИБКА [{context}]: {err}"));
}

pub fn log_capture_line(line: &str) {
    let path = crate::data::snipcast_base_dir().join("screenshot-errors.log");
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let entry = format!("{stamp} [{}] {line}
", env!("CARGO_PKG_VERSION"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(entry.as_bytes());
    }
}

/// Удалить temp-файлы прошлых запусков при старте приложения.
pub fn cleanup_stale() {
    let dir = capture_tmp_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(CAPTURE_PREFIX) || name.starts_with(PIN_PREFIX) || (name.starts_with("video-") && name.ends_with(".mp4")) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Мониторы
// ---------------------------------------------------------------------------

fn monitors_list(app: &AppHandle) -> Result<Vec<MonRect>, String> {
    let monitors = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();

    if !monitors.is_empty() {
        return Ok(monitors
            .into_iter()
            .map(|m| MonRect {
                x: m.position().x,
                y: m.position().y,
                w: m.size().width.max(1),
                h: m.size().height.max(1),
                scale: m.scale_factor(),
            })
            .collect());
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        unsafe {
            let (x, y, w, h) = (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            );
            if w > 0 && h > 0 {
                return Ok(vec![MonRect { x, y, w: w as u32, h: h as u32, scale: 1.0 }]);
            }
        }
    }

    Err("не удалось получить список мониторов".to_string())
}

/// Keep desktop gaps black even when GDI leaves unspecified pixels there.
fn clear_monitor_gaps(img:&mut image::RgbaImage,vx:i32,vy:i32,mons:&[MonRect]) {
    let (vw,vh)=img.dimensions();
    if mons.iter().any(|m|m.x==vx && m.y==vy && m.w==vw && m.h==vh) {return}
    let mut ranges=Vec::with_capacity(mons.len());
    for y in 0..vh {
        ranges.clear();
        for m in mons.iter().filter(|m|vy+y as i32>=m.y && vy+(y as i32)<m.y+m.h as i32) {
            ranges.push(((m.x-vx).max(0) as u32,((m.x-vx) as i64+m.w as i64).clamp(0,vw as i64) as u32));
        }
        ranges.sort_unstable();let mut end=0;
        for (left,right) in ranges.iter().copied().chain(std::iter::once((vw,vw))) {
            let start=(y as usize*vw as usize+end as usize)*4;
            let stop=(y as usize*vw as usize+left.min(vw) as usize)*4;
            if stop>start {for pixel in img.as_mut()[start..stop].chunks_exact_mut(4){pixel.copy_from_slice(&[0,0,0,255]);}}
            end=end.max(right);
        }
    }
}

// ---------------------------------------------------------------------------
// Захват
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub(crate) fn capture_image(x: i32, y: i32, width: u32, height: u32) -> Result<image::RgbaImage, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };

    let (w, h) = (width as i32, height as i32);
    if w <= 0 || h <= 0 {
        return Err("пустая область захвата".to_string());
    }

    unsafe {
        let hdc_screen = GetDC(std::ptr::null_mut());
        if hdc_screen.is_null() {
            return Err("GetDC(NULL) вернул null".to_string());
        }
        let hdc_mem = CreateCompatibleDC(hdc_screen);

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // Отрицательная высота — верхняя строка идёт первой (top-down).
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed()],
        };

        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(hdc_screen, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if hbmp.is_null() || bits.is_null() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            return Err("CreateDIBSection не удалось".to_string());
        }

        let old = SelectObject(hdc_mem, hbmp);
        // CAPTUREBLT — захватывать и layered-окна (иначе пропадают полупрозрачные).
        let rop: u32 = SRCCOPY | CAPTUREBLT;
        let ok = BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, rop);
        let result: Result<image::RgbaImage, String> = if ok == 0 {
            let err = windows_sys::Win32::Foundation::GetLastError();
            Err(format!("BitBlt не удался (GetLastError={err})"))
        } else {
            let len = (w as usize) * (h as usize) * 4;
            let raw = std::slice::from_raw_parts(bits as *const u8, len);
            // GDI отдаёт BGRA (в порядке байт: B, G, R, X) → конвертируем в RGBA.
            let mut rgba = vec![0u8; len];
            for (dst, src) in rgba.chunks_exact_mut(4).zip(raw.chunks_exact(4)) {
                dst[0] = src[2];
                dst[1] = src[1];
                dst[2] = src[0];
                dst[3] = 255;
            }
            image::RgbaImage::from_raw(width, height, rgba)
                .ok_or_else(|| "не удалось собрать изображение".to_string())
        };

        SelectObject(hdc_mem, old);
        DeleteObject(hbmp);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);
        result
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_image(x: i32, y: i32, _width: u32, _height: u32) -> Result<image::RgbaImage, String> {
    use core_graphics::display::CGDisplay;

    let ids = CGDisplay::active_displays().map_err(|_| "нет активных дисплеев".to_string())?;
    for id in ids {
        let d = CGDisplay::new(id);
        let b = d.bounds();
        if (b.origin.x as i32) != x || (b.origin.y as i32) != y {
            continue;
        }
        // Требуется разрешение macOS «Запись экрана» — без него вернётся null.
        let cgimg = d
            .image()
            .map_err(|_| "CGDisplayCreateImage вернул null: проверьте разрешение на запись экрана".to_string())?;
        let w = cgimg.width();
        let h = cgimg.height();
        let bpr = cgimg.bytes_per_row();
        let provider = cgimg.data_provider().ok_or("нет data provider у снимка")?;
        let cfdata = provider.copy_data();
        let bytes = cfdata.bytes();

        let mut rgba = Vec::with_capacity(w * h * 4);
        for row in 0..h {
            let row_start = row * bpr;
            for col in 0..w {
                let i = row_start + col * 4;
                // CG обычно отдаёт BGRA premultiplied; снимок непрозрачный.
                rgba.push(bytes[i + 2]);
                rgba.push(bytes[i + 1]);
                rgba.push(bytes[i]);
                rgba.push(255);
            }
        }
        return image::RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or_else(|| "не удалось собрать изображение монитора".to_string());
    }
    Err(format!("монитор ({x},{y}) не найден среди дисплеев"))
}

/// Запустить сессию захвата: спрятать палитру, снять мониторы, показать оверлеи.
/// `preset` — пресет быстрого скриншота (подменяет сохранение и действие).
pub fn start_capture(app: &AppHandle, preset: Option<PresetOverride>) -> Result<(), String> {
    let preset_label = preset.as_ref().map(|p| p.title.clone()).unwrap_or_else(|| "-".to_string());
    match start_capture_inner(app, preset) {
        Ok(()) => {
            log_capture_line(&format!("захват: ок (пресет: {preset_label})"));
            Ok(())
        }
        Err(err) => {
            close_capture(app);
            log_capture_error("оверлей захвата", &err);
            Err(err)
        }
    }
}

struct CapturePreparation(AppHandle);
impl Drop for CapturePreparation {
    fn drop(&mut self) {
        let state=self.0.state::<Mutex<ScreenshotState>>();
        if let Ok(mut st)=state.lock(){st.preparing=false;}
        crate::updater::show_pending(&self.0);
    }
}

fn start_capture_inner(app: &AppHandle, preset: Option<PresetOverride>) -> Result<(), String> {
    {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        if st.preparing || !st.captures.is_empty() {return Ok(());}
        st.preparing=true;
    }
    let _preparation=CapturePreparation(app.clone());

    // Палитра always-on-top: прячем и даём композитору время убрать её с экрана.
    crate::updater::suspend_notice(app);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.hide();
    }
    std::thread::sleep(Duration::from_millis(120));

    let mons = monitors_list(app)?;
    let (detection, elements) = crate::capture_detection::collect();
    let mut captures = Vec::new();
    let (vx,vy,vw,vh) = virtual_screen_rect(app)?;
    {
        let mut img = capture_image(vx, vy, vw, vh)?;
        clear_monitor_gaps(&mut img,vx,vy,&mons);
        let file = write_png_temp(CAPTURE_PREFIX, &img)?;
        captures.push(MonitorCapture {
            label: format!("{CAPTURE_PREFIX}0"),
            file,
            x: vx, y: vy, width: vw, height: vh,
            scale: mons.first().map(|m|m.scale).unwrap_or(1.0),
        });
    }

    {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.captures = captures.clone();
        st.monitors = mons.iter().map(|m| ScreenMonitor{x:m.x,y:m.y,width:m.w,height:m.h,scale:m.scale}).collect();
        st.detection = detection;
        st.active_preset = preset;
        // Новая сессия: ждём готовности всех оверлеев заново.
        st.ready_overlays.clear();
        st.session_shown = false;
    }

    // Providers run independently of image capture and presentation. Never wait
    // for UI Automation on the hotkey-to-overlay path.
    let detection_app = app.clone();
    let session_files: Vec<_> = captures.iter().map(|c| (c.label.clone(), c.file.clone())).collect();
    std::thread::spawn(move || {
        use tauri::Emitter as _;
        crate::capture_detection::receive_batches(elements, |batch| {
            {
                let state = detection_app.state::<Mutex<ScreenshotState>>();
                let Ok(mut st) = state.lock() else { return; };
                if st.captures.first().map(|c| &c.file) != session_files.first().map(|(_, file)| file) { return; }
                st.detection.candidates.extend(batch.iter().cloned());
            }
            for (label, file) in &session_files {
                let _ = detection_app.emit_to(label.as_str(), "snipcast://capture-candidates", serde_json::json!({
                    "imageName": file.file_name().map(|name| name.to_string_lossy()),
                    "candidates": batch,
                }));
            }
        });
    });

    // Готовим оверлеи БЕЗ показа: живые — позиция/размер, нехватающие — создаём
    // скрытыми. Показывает каждое окно само — командой `snipcast_capture_ready`
    // после загрузки и отрисовки кадра. Показ «пустого» окна до готовности
    // и был источником подёргивания при появлении.
    let app2 = app.clone();
    let captures2 = captures.clone();
    app.run_on_main_thread(move || {
        use tauri::Emitter as _;
        for c in &captures2 {
            if let Some(w) = app2.get_webview_window(&c.label) {
                let _ = w.set_position(PhysicalPosition::new(c.x, c.y));
                let _ = w.set_size(PhysicalSize::new(c.width, c.height));
                // Reload only after native geometry is applied. An event sent
                // from the worker could otherwise race WebView2's resize.
                let _ = app2.emit_to(c.label.as_str(), "snipcast://capture-session", ());
            } else if let Err(e) = create_capture_window(&app2, c) {
                eprintln!("[snipcast] capture window {}: {e}", c.label);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        let mut labels: Vec<String> = st.overlay_labels.clone();
        for c in &captures {
            if !labels.iter().any(|l| l == &c.label) {
                labels.push(c.label.clone());
            }
        }
        labels.truncate(captures.len().max(labels.len()));
        st.overlay_labels = labels;
    }

    Ok(())
}

/// Отключаем DWM-переходы окна (анимации появления/сворачивания): без этого
/// fullscreen-оверлеи при скрытии «сворачиваются в центр экрана», а при
/// первом показе появляются с анимацией разворачивания.
#[cfg(target_os = "windows")]
pub(crate) fn disable_window_animations(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };
    let Ok(hwnd) = w.hwnd() else {
        return;
    };
    let disable: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disable as *const i32 as *const core::ffi::c_void,
            core::mem::size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn disable_window_animations(_w: &tauri::WebviewWindow) {}

/// Прогрев окон оверлеев на старте приложения: создаём СКРЫТЫЕ окна под
/// каждый монитор заранее, чтобы первый после запуска захват не «моргал»
/// экраном — WebView2 и фронт уже созданы и прогружены, останется только
/// подгрузить кадр и показать окно (тот же путь, что у повторных захватов).
pub fn prewarm_capture_windows(app: &AppHandle) {
    let monitors = match monitors_list(app) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[snipcast] прогрев оверлеев: {e}");
            return;
        }
    };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok((x,y,width,height)) = virtual_screen_rect(&app2) {
            let label = format!("{CAPTURE_PREFIX}0");
            if app2.get_webview_window(&label).is_some() {
                return;
            }
            let c = MonitorCapture {
                label,
                file: PathBuf::new(),
                x,y,width,height,
                scale: monitors.first().map(|m|m.scale).unwrap_or(1.0),
            };
            if let Err(e) = create_capture_window(&app2, &c) {
                eprintln!("[snipcast] прогрев оверлея {}: {e}", c.label);
            }
        }
    });
}

fn create_capture_window(app: &AppHandle, c: &MonitorCapture) -> Result<(), String> {
    let builder = WebviewWindowBuilder::new(app, &c.label, WebviewUrl::App("index.html".into()))
        .title("Snipcast")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .transparent(true)
        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .shadow(false)
        .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);

    let win = builder.build().map_err(|e| e.to_string())?;
    disable_window_animations(&win);
    let _ = win.set_position(PhysicalPosition::new(c.x, c.y));
    let _ = win.set_size(PhysicalSize::new(c.width, c.height));
    // Не показываем сами: новое окно видно до отрисовки кадра и «дёргается»
    // при первом захвате. Показ — только через snipcast_capture_ready,
    // когда фронт загрузил и нарисовал снимок (как у переиспользуемых окон).
    Ok(())
}

/// Завершить сессию: прячем живые оверлеи (не уничтожаем — повторный захват
/// открывается мгновенно) и удаляем temp-файлы сессии.
pub fn close_capture(app: &AppHandle) {
    crate::capture_keyboard::close();
    crate::video::selection_cancelled(app);
    let labels: Vec<String> = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().expect("screenshot state poisoned");
        st.overlay_labels.clone()
    };
    // Все оверлеи прячем одним пакетом на главном потоке: поочерёдные hide
    // с маршализацией видны как «дёрганье» экрана при закрытии захвата.
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        for label in labels {
            if let Some(w) = app2.get_webview_window(&label) {
                let _ = w.hide();
            }
        }
    });
    let state = app.state::<Mutex<ScreenshotState>>();
    let mut st = state.lock().expect("screenshot state poisoned");
    for c in st.captures.drain(..) {
        let _ = std::fs::remove_file(&c.file);
    }
    st.active_preset = None;
    st.detection = crate::capture_detection::Snapshot::default();
    st.ready_overlays.clear();
    st.session_shown = false;
    drop(st);
    crate::updater::show_pending(app);
}

/// Оверлей закрыли извне (Alt+F4 и т.п.) — чистим сессию и реестр живых окон.
pub fn on_capture_window_destroyed(app: &AppHandle, label: &str) {
    crate::capture_keyboard::close();
    let state = app.state::<Mutex<ScreenshotState>>();
    let mut st = state.lock().expect("screenshot state poisoned");
    st.overlay_labels.retain(|l| l != label);
    for c in st.captures.drain(..) {
        let _ = std::fs::remove_file(&c.file);
    }
    st.active_preset = None;
}

// ---------------------------------------------------------------------------
// Закрепы
// ---------------------------------------------------------------------------

/// Создать закреп: PNG пишем во временный файл, окно `pin-N` поверх всех окон.
pub fn create_pin(
    app: &AppHandle,
    png_base64: &str,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|e| format!("base64 кропа: {e}"))?;
    let img = image::load_from_memory(&png)
        .map_err(|e| format!("кроп не декодируется: {e}"))?
        .to_rgba8();
    let file = write_png_temp(PIN_PREFIX, &img)?;

    let label = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.pin_seq += 1;
        let label = format!("{PIN_PREFIX}{}", st.pin_seq);
        st.pins.insert(
            label.clone(),
            PinEntry {
                file: file.clone(),
                ready: false,
                x,
                y,
                width,
                height,
            },
        );
        label
    };

    let app2 = app.clone();
    let label2 = label.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = create_pin_window(&app2, &label2, x, y, width, height) {
            eprintln!("[snipcast] pin window {label2}: {e}");
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(label)
}

fn create_pin_window(app: &AppHandle, label: &str, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Snipcast")
        .decorations(false)
        // Нативную рамку ресайза Windows выключаем: она перехватывает край
        // окна ДО вебвью и растягивает стороны только по одной оси.
        // Программный setSize от этого не страдает — пропорциональное
        // растягивание делает сам PinWindow.
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .visible(false)
        .transparent(true)
        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .build()
        .map_err(|e| e.to_string())?;
    disable_window_animations(&win);
    enforce_pin_borderless(&win)?;
    let _ = win.set_position(PhysicalPosition::new(x-PIN_PADDING, y-PIN_PADDING));
    let _ = win.set_size(PhysicalSize::new(width.max(8)+PIN_PADDING as u32*2, height.max(8)+PIN_PADDING as u32*2));
    select_pin(app, Some(label.to_string()));
    Ok(())
}

/// The first visible pin frame already contains its decoded PNG. Repeated
/// acknowledgements must not steal focus or reshow a hidden existing pin.
#[tauri::command]
pub async fn snipcast_pin_ready(app:AppHandle,window:tauri::WebviewWindow)->Result<(),String> {
    let label=window.label().to_string();
    pin_ui(app,move |app| {
        {
            let state=app.state::<Mutex<ScreenshotState>>();
            let st=state.lock().map_err(|e|e.to_string())?;
            if st.pins.get(&label).map(|p|p.ready).unwrap_or(true){return Ok(())}
        }
        let Some(win)=app.get_webview_window(&label) else{return Ok(())};
        enforce_pin_borderless(&win)?;
        win.show().map_err(|e|e.to_string())?;
        if let Some(pin)=app.state::<Mutex<ScreenshotState>>().lock().map_err(|e|e.to_string())?.pins.get_mut(&label){pin.ready=true;}
        let _=win.set_focus();
        Ok(())
    }).await
}

/// Закреп закрыли — убрать запись и файл; если у него было открыто меню,
/// закрыть и меню (иначе останется висеть над пустым местом).
pub fn on_pin_window_destroyed(app: &AppHandle, label: &str) {
    let (file,cover) = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().expect("screenshot state poisoned");
        if st.selected_pin.as_deref()==Some(label) {st.selected_pin=None;}
        let cover=st.pin_edits.remove(label).and_then(|e|e.cover);
        (st.pins.remove(label).map(|p| p.file),cover)
    };
    crate::pin_transition::end(cover);
    if let Some(f) = file {
        let _ = std::fs::remove_file(f);
    }
    let owns_menu = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().expect("screenshot state poisoned");
        st.menu_for.as_deref() == Some(label)
    };
    if owns_menu {
        close_pin_menu(app);
    }
}

pub fn close_all_pins(app: &AppHandle) {
    let labels: Vec<String> = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().expect("screenshot state poisoned");
        st.pins.keys().cloned().collect()
    };
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
}

/// Оверлей загрузил кадр — ждём готовности ВСЕХ оверлеев сессии и показываем
/// их одним пакетом: на холодной загрузке фронты готовы в разное время, и
/// раздельный показ выглядит как поочерёдное «вспыхивание» мониторов.
/// Страховка от зависшего оверлея — таймаут 1.8 с, после которого показываем
/// то, что готово.
pub fn show_capture_ready(app: &AppHandle, label: &str, image_name: Option<&str>) {
    // Решение принимаем под коротким локом; показ — строго ПОСЛЕ освобения
    // мьютекса (show_session_overlays лочит его же — вызов под локом
    // намертво вешал захват и всё, что трогает состояние после).
    let show_all = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let guard = state.lock();
        let Ok(mut st) = guard else {
            return;
        };
        // A delayed image load / paint callback must not show another session.
        let Some(capture) = st.captures.iter().find(|c| c.label == label) else {
            return;
        };
        if image_name.is_some_and(|name| {
            capture.file.file_name().map(|n| n.to_string_lossy()).as_deref() != Some(name)
        }) {
            return;
        }
        if st.session_shown {
            // Пакет уже показан (таймаут сработал раньше) — достаём отстающего.
            drop(st);
            show_overlay_now(app, label);
            return;
        }
        if !st.ready_overlays.iter().any(|l| l == label) {
            st.ready_overlays.push(label.to_string());
        }
        let all_ready = !st.captures.is_empty()
            && st
                .captures
                .iter()
                .all(|c| st.ready_overlays.iter().any(|l| l == &c.label));
        if all_ready {
            st.session_shown = true;
            true
        } else {
            // Первый готовый запускает страховочный таймер пакета.
            if st.ready_overlays.len() == 1 {
                let ah = app.clone();
                let session_file = st.captures.first().map(|c| c.file.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1800));
                    let state = ah.state::<Mutex<ScreenshotState>>();
                    let mut late_show = false;
                    {
                        let guard = state.lock();
                        if let Ok(mut st) = guard {
                            if !st.session_shown
                                && st.captures.first().map(|c| &c.file) == session_file.as_ref()
                            {
                                st.session_shown = true;
                                late_show = true;
                            }
                        }
                    }
                    if late_show {
                        show_session_overlays(&ah);
                    }
                });
            }
            false
        }
    };
    if show_all {
        show_session_overlays(app);
    }
}

/// Show prepared overlays together, then notify each frontend to fade in.
/// Geometry was applied before loading: resizing at show reallocates the
/// WebView2 surface and can reveal an empty or previous frame.
fn show_session_overlays(app: &AppHandle) {
    let focus_label = cursor_capture_label(app);
    let wins: Vec<(String, String)> = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let guard = state.lock();
        match guard {
            Ok(st) => st
                .captures
                .iter()
                .filter(|c| st.ready_overlays.contains(&c.label))
                .filter_map(|c| Some((c.label.clone(), c.file.file_name()?.to_string_lossy().into_owned())))
                .collect(),
            Err(_) => Vec::new(),
        }
    };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::Emitter as _;
        for (label, image_name) in wins {
            if let Some(win) = app2.get_webview_window(&label) {
                if win.show().is_err() { continue; }
                let config=app2.state::<Mutex<AppConfig>>().lock().ok().map(|c|c.clone());
                if let Some(config)=config {if let Err(error)=crate::capture_keyboard::show(&win,&config){log_capture_error("клавиши выделения",&error);}}
                if focus_label.as_deref() == Some(label.as_str()) {
                    let _ = win.set_focus();
                }
                let _ = win.emit("snipcast://capture-shown", image_name);
            }
        }
    });
}

/// Show a late overlay only when its current image is ready.
fn show_overlay_now(app: &AppHandle, label: &str) {
    let image_name = {
        let state = app.state::<Mutex<ScreenshotState>>();
        state.lock().ok().and_then(|st| {
            st.captures
                .iter()
                .find(|c| c.label == label)
                .and_then(|c| c.file.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
    };
    let Some(image_name) = image_name else {
        return;
    };
    let label2 = label.to_string();
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::Emitter as _;
        if let Some(win) = app2.get_webview_window(&label2) {
            if win.show().is_ok() {
                let config=app2.state::<Mutex<AppConfig>>().lock().ok().map(|c|c.clone());
                if let Some(config)=config {if let Err(error)=crate::capture_keyboard::show(&win,&config){log_capture_error("клавиши выделения",&error);}}
                let _ = win.emit("snipcast://capture-shown", image_name);
            }
        }
    });
}

/// Метка оверлея, накрывающего текущую позицию курсора (для фокуса).
fn cursor_capture_label(app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return None;
        }
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().ok()?;
        st.captures
            .iter()
            .find(|c| {
                pt.x >= c.x && pt.x < c.x + c.width as i32 && pt.y >= c.y && pt.y < c.y + c.height as i32
            })
            .map(|c| c.label.clone())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().ok()?;
        st.captures.first().map(|c| c.label.clone())
    }
}

// ---------------------------------------------------------------------------
// Контекстное меню закрепа (отдельное окно)
// ---------------------------------------------------------------------------

/// Показать контекстное меню закрепа в точке экрана (физические px).
/// Окно маленькое и always-on-top, поэтому меню никогда не обрезается
/// краями закрепа. `pin_label` — закреп-владелец (для «Закрыть»).
pub fn show_pin_menu(
    app: &AppHandle,
    x: i32,
    y: i32,
    scale: f64,
    pin_label: &str,
) -> Result<(), String> {
    // Размер окна под DPI вызывающего монитора.
    let scale = if scale.is_finite() && scale > 0.1 && scale < 5.0 {
        scale
    } else {
        1.0
    };
    let mw = (224.0 * scale).round() as i32;
    let mh = (164.0 * scale).round() as i32;

    // Не выезжаем за пределы виртуального экрана.
    let (vx, vy, vw, vh) = virtual_screen_rect(app)?;
    let x = x.clamp(vx, (vx + vw as i32 - mw).max(vx));
    let y = y.clamp(vy, (vy + vh as i32 - mh).max(vy));

    {
        let state = app.state::<Mutex<ScreenshotState>>();
        state.lock().map_err(|e| e.to_string())?.menu_for = Some(pin_label.to_string());
    }

    // Одно меню одновременно. Уже открытое не пересоздаём: close() асинхронен,
    // пересоздание с тем же лейблом гоняется с уничтожением и мерцает — просто
    // переносим окно на новое место.
    if let Some(w) = app.get_webview_window(PINMENU_LABEL) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        let _ = w.set_size(PhysicalSize::new(mw as u32, mh as u32));
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let win = match WebviewWindowBuilder::new(
            &app2,
            PINMENU_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .title("Snipcast")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(true)
        .visible(false)
        .background_color(tauri::utils::config::Color(27, 27, 31, 255))
        .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[snipcast] pinmenu window: {e}");
                return;
            }
        };
        disable_window_animations(&win);
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(mw as u32, mh as u32));
        let _ = win.show();
        // Метка времени ДО set_focus: первый ложный Focused(false) приходит
        // сразу после показа — grace-период должен его накрыть.
        let state = app2.state::<Mutex<ScreenshotState>>();
        if let Ok(mut st) = state.lock() {
            st.menu_shown_at = Some(Instant::now());
        }
        let _ = win.set_focus();
    })
    .map_err(|e| e.to_string())
}

/// Закрыть окно меню (если открыто).
pub fn close_pin_menu(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PINMENU_LABEL) {
        let _ = w.close();
    }
}

/// Действие из меню закрепа.
pub fn pin_menu_action(app: &AppHandle, action: &str) -> Result<(), String> {
    if action == "copy" || action == "annotate" {
        let (label, file) = {
            let state = app.state::<Mutex<ScreenshotState>>();
            let st = state.lock().map_err(|e| e.to_string())?;
            let label = st.menu_for.clone().ok_or("нет активного меню закрепа")?;
            let pin = st.pins.get(&label).ok_or("закреп уже закрыт")?;
            (label, pin.file.clone())
        };
        if action == "copy" {
            let img = image::open(file).map_err(|e| format!("чтение закрепа: {e}"))?.to_rgba8();
            return copy_image_to_clipboard(&img);
        }
        use tauri::Emitter as _;
        close_pin_menu(app);
        return app.emit_to(label.as_str(), "snipcast://pin-annotate", ()).map_err(|e| e.to_string());
    }
    match action {
        "close_all" => {
            close_all_pins(app);
            Ok(())
        }
        "close" => {
            let label = {
                let state = app.state::<Mutex<ScreenshotState>>();
                let guard = state.lock().map_err(|e| e.to_string())?;
                guard.menu_for.clone()
            };
            if let Some(label) = label {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
            }
            Ok(())
        }
        _ => Err(format!("неизвестное действие меню: {action}")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct PinEditGeometry { pub session_id:u64, pub revision:u64, pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub image_rect: WindowRect, pub panel_bounds: WindowRect }

#[derive(Clone)]
struct PinEditSession { geometry:PinEditGeometry, image:WindowRect, monitor:WindowRect, window:WindowRect, panels:Vec<WindowRect>,cover:Option<usize>,closing:bool }

fn pin_window_rect(win:&tauri::WebviewWindow,r:WindowRect)->Result<(),String> {
    #[cfg(target_os="windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos,SWP_NOZORDER,SWP_NOACTIVATE,SWP_NOCOPYBITS};
        if SetWindowPos(win.hwnd().map_err(|e|e.to_string())?.0,std::ptr::null_mut(),r.x,r.y,r.width as i32,r.height as i32,
            SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOCOPYBITS)==0 {return Err("не удалось изменить геометрию закрепа".into())}
    }
    #[cfg(not(target_os="windows"))]
    {win.set_size(PhysicalSize::new(r.width,r.height)).map_err(|e|e.to_string())?;
     win.set_position(PhysicalPosition::new(r.x,r.y)).map_err(|e|e.to_string())?;}
    Ok(())
}

fn pin_image_region(image:WindowRect)->WindowRect {
    WindowRect{x:image.x-PIN_PADDING,y:image.y-PIN_PADDING,width:image.width+PIN_PADDING as u32*2,height:image.height+PIN_PADDING as u32*2}
}

fn freeze_pin(win:&tauri::WebviewWindow,image:WindowRect)->Result<Option<usize>,String> {
    let cover=crate::pin_transition::begin(pin_image_region(image))?;
    if cover.is_some(){if let Err(e)=pin_region(win,Some(&[])){crate::pin_transition::end(cover);return Err(e)}}
    Ok(cover)
}

fn cancel_pin_transition(app:&AppHandle,label:&str,win:&tauri::WebviewWindow,edit:&PinEditSession) {
    let region=std::iter::once(pin_image_region(edit.image)).chain(edit.panels.iter().copied())
        .map(|r|WindowRect{x:r.x-edit.window.x,y:r.y-edit.window.y,..r}).collect::<Vec<_>>();
    let _=pin_region(win,Some(&region));
    crate::pin_transition::end(edit.cover);
    if let Ok(mut state)=app.state::<Mutex<ScreenshotState>>().lock(){
        if let Some(active)=state.pin_edits.get_mut(label){active.cover=None;}
    }
}

// All non-client, region and geometry changes share the window's UI queue.
// A short-lived receiver waits off the UI thread, never under ScreenshotState.
pub async fn pin_ui<T:Send+'static>(app:AppHandle, action:impl FnOnce(&AppHandle)->Result<T,String>+Send+'static)->Result<T,String> {
    let (send,receive)=std::sync::mpsc::sync_channel(1);
    let owner=app.clone();
    app.run_on_main_thread(move || {let _=send.send(action(&owner));}).map_err(|e|e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv().map_err(|e|e.to_string())?).await.map_err(|e|e.to_string())?
}

// Pin windows are entirely client-rendered. Tao rebuilds their styles on
// transitions, and Windows can paint stale non-client chrome even without
// WS_CAPTION. Guard both the style and the non-client rendering lifecycle.
#[cfg(target_os="windows")]
unsafe extern "system" fn pin_style_guard(hwnd:windows_sys::Win32::Foundation::HWND,message:u32,
    wparam:usize,lparam:isize,id:usize,_data:usize)->isize {
    use windows_sys::Win32::UI::{Shell::{DefSubclassProc,RemoveWindowSubclass},WindowsAndMessaging::{
        WM_STYLECHANGING,WM_NCDESTROY,WM_NCCALCSIZE,WM_NCPAINT,WM_NCACTIVATE,GWL_STYLE,STYLESTRUCT,
        WS_POPUP,WS_CHILD,WS_CAPTION,WS_THICKFRAME,WS_SYSMENU,WS_MINIMIZEBOX,WS_MAXIMIZEBOX}};
    if message==WM_STYLECHANGING && wparam as i32==GWL_STYLE && lparam!=0 {
        let styles=&mut *(lparam as *mut STYLESTRUCT);
        styles.styleNew = (styles.styleNew & !(WS_CHILD|WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX)) | WS_POPUP;
        return 0;
    }
    // Returning zero leaves the complete proposed window rect as the client
    // area for both RECT and NCCALCSIZE_PARAMS forms of this message.
    if message==WM_NCCALCSIZE || message==WM_NCPAINT {return 0;}
    // Forward activation so Tao still receives focus/state changes. -1 tells
    // DefWindowProc to update activation without repainting non-client chrome.
    if message==WM_NCACTIVATE {return DefSubclassProc(hwnd,message,wparam,-1);}
    if message==WM_NCDESTROY {RemoveWindowSubclass(hwnd,Some(pin_style_guard),id);}
    DefSubclassProc(hwnd,message,wparam,lparam)
}

fn enforce_pin_borderless(win:&tauri::WebviewWindow)->Result<(),String> {
    #[cfg(target_os="windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW,SetWindowLongPtrW,SetWindowPos,GWL_STYLE,
            WS_POPUP,WS_CHILD,WS_CAPTION,WS_THICKFRAME,WS_SYSMENU,WS_MINIMIZEBOX,WS_MAXIMIZEBOX,SWP_NOMOVE,SWP_NOSIZE,SWP_NOZORDER,SWP_NOACTIVATE,SWP_FRAMECHANGED};
        let hwnd=win.hwnd().map_err(|e|e.to_string())?.0;
        // The same subclass ID replaces its registration; it never stacks.
        if windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd,Some(pin_style_guard),0x534E4950,0)==0 {
            return Err("не удалось закрепить режим окна без рамки".into());
        }
        let style=GetWindowLongPtrW(hwnd,GWL_STYLE);
        let next=(style & !((WS_CHILD|WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX) as isize)) | WS_POPUP as isize;
        if style!=next {
            SetWindowLongPtrW(hwnd,GWL_STYLE,next);
            if SetWindowPos(hwnd,std::ptr::null_mut(),0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED)==0 {
                return Err("не удалось убрать рамку закрепа".into());
            }
        }
    }
    #[cfg(not(target_os="windows"))]
    let _=win;
    Ok(())
}

fn pin_region(win:&tauri::WebviewWindow,rects:Option<&[WindowRect]>)->Result<(),String> {
    #[cfg(target_os="windows")]
    unsafe {
        use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn,CombineRgn,DeleteObject,RGN_OR,SetWindowRgn};
        let hwnd=win.hwnd().map_err(|e|e.to_string())?.0;
        let region=if let Some(rects)=rects {
            let union=CreateRectRgn(0,0,0,0);
            if union.is_null(){return Err("не удалось создать область закрепа".into())}
            for r in rects.iter().take(16) {
                let part=CreateRectRgn(r.x,r.y,r.x+r.width as i32,r.y+r.height as i32);
                if part.is_null(){DeleteObject(union);return Err("не удалось создать область панели".into())}
                CombineRgn(union,union,part,RGN_OR);DeleteObject(part);
            }
            union
        }else{std::ptr::null_mut()};
        if SetWindowRgn(hwnd,region,1)==0 {if !region.is_null(){DeleteObject(region);}return Err("не удалось задать область закрепа".into())}
    }
    #[cfg(not(target_os="windows"))]
    let _=(win,rects);
    Ok(())
}

/// Make room for the existing annotation toolbar without changing the pinned image.
pub fn begin_pin_annotation(app: &AppHandle, label: &str) -> Result<PinEditGeometry, String> {
    {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st=state.lock().map_err(|e| e.to_string())?;
        if !st.pins.contains_key(label) { return Err("закреп уже закрыт".into()); }
        if let Some(edit)=st.pin_edits.get(label){if edit.closing{return Err("редактор ещё закрывается".into())}return Ok(edit.geometry.clone())}
    }
    let win = app.get_webview_window(label).ok_or("окно закрепа закрыто")?;
    enforce_pin_borderless(&win)?;
    pin_region(&win,None)?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let monitor = win.current_monitor().map_err(|e| e.to_string())?.ok_or("монитор не найден")?;
    let iw=size.width.saturating_sub(PIN_PADDING as u32*2).max(1);
    let ih=size.height.saturating_sub(PIN_PADDING as u32*2).max(1);
    let ix=pos.x+PIN_PADDING; let iy=pos.y+PIN_PADDING;
    let tw=(600.0*scale).round() as i32; let th=(360.0*scale).round() as i32;
    let mx=monitor.position().x; let my=monitor.position().y;
    let tx=(ix+iw as i32/2-tw/2).clamp(mx+8,(mx+monitor.size().width as i32-tw-8).max(mx+8));
    let ty=if iy+ih as i32+th+8 < my+monitor.size().height as i32 { iy+ih as i32+8 } else { (iy-th-8).max(my+8) };
    let x=pos.x.min(tx-PIN_PADDING);let y=pos.y.min(ty-PIN_PADDING);
    let width=(pos.x+size.width as i32).max(tx+tw+PIN_PADDING)-x;
    let height=(pos.y+size.height as i32).max(ty+th+PIN_PADDING)-y;
    let session_id={let state=app.state::<Mutex<ScreenshotState>>();let mut st=state.lock().map_err(|e|e.to_string())?;st.pin_edit_seq+=1;st.pin_edit_seq};
    let original = PinEditGeometry { session_id,revision:0,x:pos.x,y:pos.y,width:size.width,height:size.height,
        image_rect:WindowRect{x:ix-x,y:iy-y,width:iw,height:ih},
        panel_bounds:WindowRect{x:mx-x,y:my-y,width:monitor.size().width,height:monitor.size().height} };
    let image=WindowRect{x:ix,y:iy,width:iw,height:ih};
    // Menu dismissal is queued independently of the annotate event. Remove it
    // from the desktop before taking the transition frame, even when it covers
    // the image. These Win32 calls run on the same UI thread as the resize.
    #[cfg(target_os="windows")]
    if let Some(menu)=app.get_webview_window(PINMENU_LABEL){
        if let Ok(hwnd)=menu.hwnd(){unsafe{windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0,windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE);}}
    }
    let cover=freeze_pin(&win,image)?;
    if let Err(e)=pin_window_rect(&win,WindowRect{x,y,width:width as u32,height:height as u32}) {
        let _=pin_region(&win,None);crate::pin_transition::end(cover);return Err(e);
    }
    let edit=PinEditSession {geometry:original.clone(),image:WindowRect{x:ix,y:iy,width:iw,height:ih},
        monitor:WindowRect{x:mx,y:my,width:monitor.size().width,height:monitor.size().height},
        window:WindowRect{x,y,width:width as u32,height:height as u32},panels:Vec::new(),cover,closing:false};
    app.state::<Mutex<ScreenshotState>>().lock().map_err(|e|e.to_string())?.pin_edits.insert(label.to_string(),edit);
    let _ = win.set_focus();
    Ok(original)
}

#[tauri::command]
pub async fn snipcast_pin_end_annotation(app:AppHandle,window:tauri::WebviewWindow,session_id:u64)->Result<Option<u64>,String> {
    let label=window.label().to_string();
    pin_ui(app,move |app| {
        let edit={let state=app.state::<Mutex<ScreenshotState>>();let st=state.lock().map_err(|e|e.to_string())?;
            st.pin_edits.get(&label).filter(|e|e.geometry.session_id==session_id).cloned()};
        let Some(mut edit)=edit else{return Ok(None)};
        if edit.closing{return Ok(Some(edit.geometry.revision))}
        let win=app.get_webview_window(&label).ok_or("закреп закрыт")?;
        enforce_pin_borderless(&win)?;
        if edit.cover.is_none(){edit.cover=freeze_pin(&win,edit.image)?;}
        if let Err(e)=pin_window_rect(&win,WindowRect{x:edit.geometry.x,y:edit.geometry.y,width:edit.geometry.width,height:edit.geometry.height}) {
            cancel_pin_transition(app,&label,&win,&edit);return Err(e)
        }
        edit.closing=true;edit.geometry.revision+=1;
        let revision=edit.geometry.revision;
        app.state::<Mutex<ScreenshotState>>().lock().map_err(|e|e.to_string())?.pin_edits.insert(label,edit);
        Ok(Some(revision))
    }).await
}

pub fn update_pin_image(app: &AppHandle, label: &str, png: &str) -> Result<(), String> {
    let image = decode_base64_png(png)?;
    let file = write_png_temp(PIN_PREFIX, &image)?;
    let old = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        let Some(pin) = st.pins.get_mut(label) else {
            let _ = std::fs::remove_file(file);
            return Err("закреп уже закрыт".into());
        };
        pin.width = image.width(); pin.height = image.height();
        std::mem::replace(&mut pin.file, file)
    };
    let _ = std::fs::remove_file(old);
    Ok(())
}

pub fn select_pin(app: &AppHandle, label: Option<String>) {
    use tauri::Emitter;
    let labels = {
        let state=app.state::<Mutex<ScreenshotState>>();
        let Ok(mut st)=state.lock() else {return};
        let label=label.filter(|l|st.pins.contains_key(l));
        if st.selected_pin==label {return}
        st.selected_pin=label.clone();
        st.pins.keys().map(|l|(l.clone(),Some(l)==label.as_ref())).collect::<Vec<_>>()
    };
    for (l,selected) in labels {let _=app.emit_to(l,"snipcast://pin-selected",selected);}
}

pub fn capture_active(app:&AppHandle)->bool {
    app.state::<Mutex<ScreenshotState>>().lock().map(|s|s.preparing || !s.captures.is_empty()).unwrap_or(true)
}

#[tauri::command]
pub fn snipcast_capture_move_cursor(app:AppHandle,dx:i32,dy:i32)->Result<crate::capture_detection::ScreenPoint,String> {
    if !capture_active(&app) {return Err("захват не активен".into())}
    #[cfg(target_os="windows")]
    unsafe {
        use windows_sys::Win32::{Foundation::POINT,UI::WindowsAndMessaging::{GetCursorPos,SetCursorPos}};
        let mut p=POINT{x:0,y:0};
        if GetCursorPos(&mut p)==0 || SetCursorPos(p.x+dx.clamp(-1,1),p.y+dy.clamp(-1,1))==0 {return Err("не удалось переместить курсор".into())}
        GetCursorPos(&mut p);
        Ok(crate::capture_detection::ScreenPoint{x:p.x,y:p.y})
    }
    #[cfg(not(target_os="windows"))]
    {let _=(dx,dy);Err("перемещение курсора доступно в Windows".into())}
}

#[tauri::command]
pub async fn snipcast_pin_regions(app:AppHandle,window:tauri::WebviewWindow,rects:Vec<WindowRect>,session_id:u64,revision:u64)->Result<Option<PinEditGeometry>,String> {
    let label=window.label().to_string();
    pin_ui(app,move |app| {
        let edit={let state=app.state::<Mutex<ScreenshotState>>();let st=state.lock().map_err(|e|e.to_string())?;
            st.pin_edits.get(&label).filter(|e|e.geometry.session_id==session_id).cloned()};
        let Some(mut edit)=edit else{return Ok(None)};
        if edit.closing{return Ok(None)}
        if edit.geometry.revision!=revision{return Ok(Some(edit.geometry))}
        let win=app.get_webview_window(&label).ok_or("закреп закрыт")?;
        let panels=rects.into_iter().take(15).filter(|r|r.width>0&&r.height>0&&r.width<20000&&r.height<20000)
            .map(|r|WindowRect{x:r.x+edit.window.x,y:r.y+edit.window.y,..r}).collect::<Vec<_>>();
        let image=pin_image_region(edit.image);
        let mut union=image;
        for r in &panels {
            let x=union.x.min(r.x);let y=union.y.min(r.y);
            union=WindowRect{x,y,width:((union.x+union.width as i32).max(r.x+r.width as i32)-x) as u32,
                height:((union.y+union.height as i32).max(r.y+r.height as i32)-y) as u32};
        }
        if union!=edit.window {
            enforce_pin_borderless(&win)?;
            if edit.cover.is_none(){edit.cover=freeze_pin(&win,edit.image)?;}
            if let Err(e)=pin_window_rect(&win,union){cancel_pin_transition(app,&label,&win,&edit);return Err(e)}
            edit.window=union;edit.geometry.revision+=1;
            edit.geometry.image_rect=WindowRect{x:edit.image.x-union.x,y:edit.image.y-union.y,..edit.image};
            edit.geometry.panel_bounds=WindowRect{x:edit.monitor.x-union.x,y:edit.monitor.y-union.y,..edit.monitor};
        }
        if panels!=edit.panels || edit.geometry.revision!=revision {
            let region=std::iter::once(image).chain(panels.iter().copied())
                .map(|r|WindowRect{x:r.x-union.x,y:r.y-union.y,..r}).collect::<Vec<_>>();
            if edit.cover.is_none(){pin_region(&win,Some(&region))?;}
            edit.panels=panels;
        }
        let geometry=edit.geometry.clone();
        app.state::<Mutex<ScreenshotState>>().lock().map_err(|e|e.to_string())?.pin_edits.insert(label,edit);
        Ok(Some(geometry))
    }).await
}

/// Reveal only the frame matching the DOM's already painted layout. Old
/// acknowledgements cannot uncover a newer resize or a finished session.
#[tauri::command]
pub async fn snipcast_pin_present(app:AppHandle,window:tauri::WebviewWindow,session_id:u64,revision:u64)->Result<(),String> {
    let label=window.label().to_string();
    pin_ui(app,move |app| {
        let edit={let state=app.state::<Mutex<ScreenshotState>>();let st=state.lock().map_err(|e|e.to_string())?;
            st.pin_edits.get(&label).filter(|e|e.geometry.session_id==session_id&&e.geometry.revision==revision).cloned()};
        let Some(edit)=edit else{return Ok(())};
        let win=app.get_webview_window(&label).ok_or("закреп закрыт")?;
        if edit.closing {pin_region(&win,None)?;}else{
            let region=std::iter::once(pin_image_region(edit.image)).chain(edit.panels.iter().copied())
                .map(|r|WindowRect{x:r.x-edit.window.x,y:r.y-edit.window.y,..r}).collect::<Vec<_>>();
            pin_region(&win,Some(&region))?;
        }
        crate::pin_transition::end(edit.cover);
        let state=app.state::<Mutex<ScreenshotState>>();let mut st=state.lock().map_err(|e|e.to_string())?;
        if edit.closing{st.pin_edits.remove(&label);}else if let Some(e)=st.pin_edits.get_mut(&label){e.cover=None;}
        Ok(())
    }).await
}

// ---------------------------------------------------------------------------
// Общий доступ к PNG
// ---------------------------------------------------------------------------

/// Найти файл снимка по имени среди активной сессии и закрепов.
fn find_capture_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let state = app.state::<Mutex<ScreenshotState>>();
    let st = state.lock().expect("screenshot state poisoned");
    let matches = |p: &Path| p.file_name().map(|f| f == std::ffi::OsStr::new(name)).unwrap_or(false);
    st.captures
        .iter()
        .find(|c| matches(&c.file))
        .map(|c| c.file.clone())
        .or_else(|| st.pins.values().find(|p| matches(&p.file)).map(|p| p.file.clone()))
}

pub fn capture_info_for_label(app: &AppHandle, label: &str) -> Result<CaptureInfoDto, String> {
    let state = app.state::<Mutex<ScreenshotState>>();
    let st = state.lock().map_err(|e| e.to_string())?;
    let c = st
        .captures
        .iter()
        .find(|c| c.label == label)
        .ok_or_else(|| format!("нет активного захвата {label}"))?;
    let name = c
        .file
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(CaptureInfoDto {
        video_selection: crate::video::is_selecting(app),
        session_id: name.clone(),
        monitors: st.monitors.clone(),
        candidates: st.detection.candidates.clone(),
        cursor: st.detection.cursor.clone(),
        label: c.label.clone(),
        image_name: name,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        scale: c.scale,
        preset: st.active_preset.clone(),
    })
}

pub fn pin_info_for_label(app: &AppHandle, label: &str) -> Result<PinInfoDto, String> {
    let state = app.state::<Mutex<ScreenshotState>>();
    let st = state.lock().map_err(|e| e.to_string())?;
    let p = st
        .pins
        .get(label)
        .ok_or_else(|| format!("нет закрепа {label}"))?;
    let name = p
        .file
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    let selected=st.selected_pin.as_deref()==Some(label);
    let (width,height)=(p.width,p.height);
    drop(st);
    let size=app.get_webview_window(label).and_then(|w|w.inner_size().ok());
    Ok(PinInfoDto {
        label: label.to_string(),
        image_name: name,
        width,
        height,
        selected,
        image_rect: WindowRect{x:PIN_PADDING,y:PIN_PADDING,
            width:size.map(|s|s.width.saturating_sub(2*PIN_PADDING as u32)).unwrap_or(width),
            height:size.map(|s|s.height.saturating_sub(2*PIN_PADDING as u32)).unwrap_or(height)},
    })
}

pub fn image_data_bytes(app: &AppHandle, name: &str) -> Result<Vec<u8>, String> {
    let path = find_capture_file(app, name).ok_or_else(|| format!("снимок {name} не найден"))?;
    std::fs::read(&path).map_err(|e| format!("чтение снимка: {e}"))
}

// ---------------------------------------------------------------------------
// Действия над кропом
// ---------------------------------------------------------------------------

fn decode_base64_png(png_base64: &str) -> Result<image::RgbaImage, String> {
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|e| format!("base64 кропа: {e}"))?;
    Ok(image::load_from_memory(&png)
        .map_err(|e| format!("кроп не декодируется: {e}"))?
        .to_rgba8())
}

/// Скопировать кроп в буфер обмена как изображение.
pub fn copy_to_clipboard(png_base64: &str) -> Result<(), String> {
    copy_image_to_clipboard(&decode_base64_png(png_base64)?)
}

pub(crate) fn copy_image_to_clipboard(img: &image::RgbaImage) -> Result<(), String> {
    let image_data = arboard::ImageData {
        width: img.width() as usize,
        height: img.height() as usize,
        bytes: std::borrow::Cow::Owned(img.as_raw().clone()),
    };
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_image(image_data))
        .map_err(|e| format!("буфер обмена: {e}"))
}

/// Имя файла по шаблону из настроек: {date}, {time}, {datetime}, {n}.
/// Если файл уже существует — добавляет " (2)", " (3)" и т.д.
pub fn prepare_save_path(dir: &str, template: &str, ext: &str, seq: u64) -> Result<PathBuf, String> {
    if dir.trim().is_empty() {
        return Err("не указана папка сохранения".to_string());
    }
    let now = chrono::Local::now();
    let stem = template
        .replace("{date}", &now.format("%Y-%m-%d").to_string())
        .replace("{time}", &now.format("%H-%M-%S").to_string())
        .replace("{datetime}", &now.format("%Y-%m-%d_%H-%M-%S").to_string())
        .replace("{n}", &seq.to_string());
    let stem = sanitize_file_name(&stem);
    let mut path = PathBuf::from(dir).join(format!("{stem}.{ext}"));
    let mut n = 2u64;
    while path.exists() {
        path = PathBuf::from(dir).join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    Ok(path)
}

fn sanitize_file_name(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => c,
        })
        .collect();
    let s = s.trim();
    if s.is_empty() {
        "Snip".to_string()
    } else {
        s.to_string()
    }
}

/// Сохранить кроп в файл (формат и качество — из настроек, ext может быть
/// переопределён расширением из диалога).
pub fn save_to_file(png_base64: &str, path: &Path, format: &str, quality: u8) -> Result<(), String> {
    let img = decode_base64_png(png_base64)?;
    write_image(&img, path, format, quality)
}

/// Записать изображение в файл (формат определяется расширением пути,
/// при неизвестном расширении — по `format`).
pub(crate) fn write_image(img: &image::RgbaImage, path: &Path, format: &str, quality: u8) -> Result<(), String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_jpeg = match ext.as_str() {
        "jpg" | "jpeg" => true,
        "png" => false,
        _ => format.eq_ignore_ascii_case("jpeg"),
    };

    // Папка может не существовать (первый запуск, пресет с новой папкой,
    // путь из внешнего API) — создаём, иначе запись падает os error 3.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("создание папки {}: {e}", parent.display()))?;
    }
    let mut file = std::fs::File::create(path).map_err(|e| format!("создание файла: {e}"))?;
    if is_jpeg {
        let q = quality.clamp(1, 100);
        let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, q);
        image::DynamicImage::ImageRgb8(rgb)
            .write_with_encoder(encoder)
            .map_err(|e| format!("кодирование JPEG: {e}"))
    } else {
        drop(file);
        std::fs::write(path, encode_png(img)).map_err(|e| format!("запись файла: {e}"))
    }
}

/// Кроп из исходного (чистого, без аннотаций) снимка монитора для OCR.
pub fn crop_from_capture(app: &AppHandle, label: &str, x: u32, y: u32, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let file = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().map_err(|e| e.to_string())?;
        let c = st
            .captures
            .iter()
            .find(|c| c.label == label)
            .ok_or_else(|| format!("нет активного захвата {label}"))?;
        c.file.clone()
    };
    let img = image::open(&file)
        .map_err(|e| format!("чтение снимка: {e}"))?
        .to_rgba8();
    let (iw, ih) = (img.width(), img.height());
    let x = x.min(iw);
    let y = y.min(ih);
    let w = w.min(iw.saturating_sub(x)).max(1);
    let h = h.min(ih.saturating_sub(y)).max(1);
    let crop = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    Ok(encode_png(&crop))
}

// ---------------------------------------------------------------------------
// Беззвучная джоба захвата (внешний API + пресеты)
// ---------------------------------------------------------------------------

/// Задача беззвучного захвата: снять экран, сохранить/распознать/закрепить,
/// ничего не показывая. Поля `None`/пустые берутся из настроек.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptureJob {
    /// Шаблон имени файла (те же подстановки {date}/{time}/{datetime}/{n}).
    pub name: Option<String>,
    /// Папка сохранения; если пусто — общая папка из настроек.
    pub dir: Option<String>,
    /// [x, y, w, h] в физических пикселях виртуального экрана; иначе весь экран.
    pub region: Option<Vec<i64>>,
    /// "png" | "jpeg"; иначе из настроек.
    pub format: Option<String>,
    pub quality: Option<u8>,
    /// Распознать текст и вернуть его в ответе.
    #[serde(default)]
    pub ocr: bool,
    /// "system" | "paddle"; иначе из настроек.
    pub ocr_engine: Option<String>,
    pub ocr_language: Option<String>,
    /// "image" — снимок в буфер, "path" — путь файла в буфер, "none"/None — ничего.
    pub copy: Option<String>,
    #[serde(default)]
    pub pin: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub path: String,
    pub text: Option<String>,
    pub width: u32,
    pub height: u32,
    pub ms: u128,
}

/// Объединённый прямоугольник всех мониторов (виртуальный экран).
pub fn virtual_screen_rect(app: &AppHandle) -> Result<(i32, i32, u32, u32), String> {
    let mons = monitors_list(app)?;
    let minx = mons.iter().map(|m| m.x).min().unwrap_or(0);
    let miny = mons.iter().map(|m| m.y).min().unwrap_or(0);
    let maxx = mons.iter().map(|m| m.x + m.w as i32).max().unwrap_or(0);
    let maxy = mons.iter().map(|m| m.y + m.h as i32).max().unwrap_or(0);
    let (w, h) = (maxx - minx, maxy - miny);
    if w <= 0 || h <= 0 {
        return Err("не удалось определить размер экрана".to_string());
    }
    Ok((minx, miny, w as u32, h as u32))
}

/// Выполнить джобу: захват → файл → OCR → буфер → закреп.
pub fn run_capture_job(
    app: &AppHandle,
    cfg: &AppConfig,
    job: &CaptureJob,
) -> Result<JobResult, String> {
    let result = run_capture_job_inner(app, cfg, job);
    match &result {
        Ok(res) => log_capture_line(&format!("джоба: ок ({} мс, {})", res.ms, res.path)),
        Err(err) => log_capture_error("джоба захвата", err),
    }
    result
}

fn run_capture_job_inner(
    app: &AppHandle,
    cfg: &AppConfig,
    job: &CaptureJob,
) -> Result<JobResult, String> {
    let seq = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.save_seq += 1;
        st.save_seq
    };
    let rect = job_rect(app, job)?;
    let full = virtual_screen_rect(app)?;
    // A fullscreen preset pressed during selection must export the frozen
    // source, without the interactive overlay, toolbar or Alt guides.
    let active_source = {
        let state = app.state::<Mutex<ScreenshotState>>();
        let st = state.lock().map_err(|e| e.to_string())?;
        st.captures.iter().find(|c| (c.x,c.y,c.width,c.height)==full &&
            app.get_webview_window(&c.label).is_some_and(|w|w.is_visible().unwrap_or(false))).map(|c|c.file.clone())
    };
    let source_image = if let Some(path) = active_source {
        image::open(path).map_err(|e|format!("исходный экран: {e}"))?.to_rgba8()
    } else { capture_image(full.0, full.1, full.2, full.3)? };
    let img = image::imageops::crop_imm(&source_image,(rect.0-full.0) as u32,(rect.1-full.1) as u32,rect.2,rect.3).to_image();
    let result=finalize_job(Some(app), cfg, job, img, rect, seq)?;
    let source=encode_png(&source_image);
    if let Err(err)=crate::capture_history::record(&source,(full.0,full.1),(full.2,full.3),crate::capture_history::Region{x:(rect.0-full.0) as u32,y:(rect.1-full.1) as u32,width:rect.2,height:rect.3}) {
        log_capture_error("история скриншотов",&err);
    }
    Ok(result)
}

/// Прямоугольник захвата для джобы: заданная область (с обрезкой по экрану)
/// или весь виртуальный экран.
fn job_rect(app: &AppHandle, job: &CaptureJob) -> Result<(i32, i32, u32, u32), String> {
    let virtual_rect = virtual_screen_rect(app)?;
    Ok(match &job.region {
        Some(r) if r.len() == 4 => {
            let (rx, ry) = (r[0] as i32, r[1] as i32);
            let (rw, rh) = (r[2].max(1) as u32, r[3].max(1) as u32);
            // Пересечение с виртуальным экраном, чтобы не снимать пустоту.
            let (vx, vy, vw, vh) = virtual_rect;
            let x0 = rx.max(vx);
            let y0 = ry.max(vy);
            let x1 = (rx + rw as i32).min(vx + vw as i32);
            let y1 = (ry + rh as i32).min(vy + vh as i32);
            if x1 - x0 < 1 || y1 - y0 < 1 {
                return Err("область вне экрана".to_string());
            }
            (x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
        }
        _ => virtual_rect,
    })
}

/// Финализация джобы над уже снятым кадром: файл → OCR → буфер → закреп.
/// Выделена отдельно, чтобы покрыть тестами без GDI-захвата.
pub fn finalize_job(
    app: Option<&AppHandle>,
    cfg: &AppConfig,
    job: &CaptureJob,
    img: image::RgbaImage,
    (x, y, w, h): (i32, i32, u32, u32),
    seq: u64,
) -> Result<JobResult, String> {
    let t0 = std::time::Instant::now();

    let dir = {
        let d = job.dir.clone().unwrap_or_default();
        if d.trim().is_empty() {
            cfg.screenshot_save_dir.clone()
        } else {
            d
        }
    };
    if dir.trim().is_empty() {
        return Err(
            "не указана папка сохранения: задайте dir в запросе или папку по умолчанию в настройках"
                .to_string(),
        );
    }
    let fmt = {
        let f = job.format.clone().unwrap_or_default();
        if f.trim().is_empty() {
            cfg.screenshot_format.clone()
        } else {
            f.to_lowercase()
        }
    };
    let ext = if fmt == "jpeg" { "jpg" } else { "png" };
    let template = {
        let t = job.name.clone().unwrap_or_default();
        if t.trim().is_empty() {
            cfg.screenshot_file_template.clone()
        } else {
            t
        }
    };
    let path = prepare_save_path(&dir, &template, ext, seq)?;
    let quality = job.quality.unwrap_or(cfg.screenshot_jpeg_quality);
    write_image(&img, &path, &fmt, quality)?;

    let mut text = None;
    if job.ocr {
        let png = encode_png(&img);
        let engine = job
            .ocr_engine
            .clone()
            .unwrap_or_else(|| cfg.screenshot_ocr_engine.clone());
        let lang = job
            .ocr_language
            .clone()
            .unwrap_or_else(|| cfg.screenshot_ocr_language.clone());
        text = Some(match engine.as_str() {
            "paddle" => {
                #[cfg(target_os = "windows")]
                {
                    crate::paddle::paddle::recognize(&png, &cfg.screenshot_ocr_quality)?
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = &png;
                    return Err("PaddleOCR доступен только в Windows".to_string());
                }
            }
            _ => crate::ocr::recognize_system(&png, &lang)?,
        });
    }

    match job.copy.as_deref() {
        Some("image") => copy_image_to_clipboard(&img)?,
        Some("path") => {
            crate::rich_clipboard::write_plain_text(&path.to_string_lossy())?;
        }
        _ => {}
    }

    if job.pin {
        let app = app.ok_or("закреп доступен только из приложения")?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(encode_png(&img));
        create_pin(app, &b64, x, y, w, h)?;
    }

    Ok(JobResult {
        path: path.to_string_lossy().into_owned(),
        text,
        width: w,
        height: h,
        ms: t0.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn virtual_desktop_negative_origin_and_gaps() {
        let mons=[MonRect{x:-6,y:-2,w:3,h:4,scale:1.0},MonRect{x:-1,y:0,w:3,h:2,scale:2.0}];
        let mut img=image::RgbaImage::from_pixel(8,4,image::Rgba([12,34,56,255]));
        clear_monitor_gaps(&mut img,-6,-2,&mons);
        for y in 0..4 {for x in 0..8 {
            let on_monitor=x<3 || (y>=2 && x>=5);
            assert_eq!(img.get_pixel(x,y).0,if on_monitor{[12,34,56,255]}else{[0,0,0,255]});
        }}
    }
}
