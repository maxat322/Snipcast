//! Embedded wcap recording and bounded-memory native video exports.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicI32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const CONTROL: &str = "video-control";
pub const EDITOR: &str = "video-editor";
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[derive(Default)]
pub struct VideoState(pub Mutex<Option<Arc<Session>>>);
pub struct Session {
    pub status: Mutex<VideoStatus>,
    control: AtomicI32,
    cancel: AtomicI32,
    file: PathBuf,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatus {
    pub id: u64,
    pub phase: String,
    pub duration_ms: u64,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub audio: bool,
    pub hardware: bool,
    pub frames: u64,
    pub export_percent: u32,
    pub error: String,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub audio: bool,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub start_ms: u64,
    pub end_ms: u64,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub quality: String,
    pub gif_width: u32,
    pub gif_fps: u32,
}
#[repr(C)]
#[derive(Default)]
struct NativeInfo {
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    audio: u32,
}
#[cfg(target_os = "windows")]
extern "C" {
    fn snipcast_video_record(
        path: *mut u16,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        audio: u32,
        control: *mut i32,
        progress: unsafe extern "C" fn(*mut std::ffi::c_void, u64, u64, u32),
        user: *mut std::ffi::c_void,
    ) -> i32;
    fn snipcast_video_probe(path: *const u16, info: *mut NativeInfo) -> i32;
    #[link_name = "snipcast_video_export"]
    fn native_export(
        source: *const u16,
        target: *mut u16,
        start: u64,
        end: u64,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        bitrate: u32,
        best: u32,
        gif_width: u32,
        gif_fps: u32,
        cancel: *mut i32,
        progress: unsafe extern "C" fn(*mut std::ffi::c_void, u32),
        user: *mut std::ffi::c_void,
    ) -> i32;
}
#[cfg(target_os = "windows")]
fn wide(path: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn error(hr: i32, action: &str) -> String {
    format!("Не удалось {action} (Windows 0x{:08X}).", hr as u32)
}
fn session(app: &AppHandle) -> Result<Arc<Session>, String> {
    app.state::<VideoState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Нет записи видео".into())
}
fn publish(app: &AppHandle, s: &Session) {
    let status = s.status.lock().unwrap().clone();
    for label in [CONTROL, EDITOR] {
        let _ = app.emit_to(label, "snipcast://video-status", &status);
    }
}
pub fn is_selecting(app: &AppHandle) -> bool {
    session(app).is_ok_and(|s| s.status.lock().unwrap().phase == "selecting")
}
pub fn selection_cancelled(app: &AppHandle) {
    if is_selecting(app) {
        if let Ok(mut slot) = app.state::<VideoState>().0.lock() {
            *slot = None;
        }
    }
}
fn bitrate(width: u32, height: u32, fps: u32, quality: &str) -> u32 {
    let bpp = match quality {
        "small" => 0.04,
        "sharp" => 0.16,
        "best" => 0.32,
        _ => 0.08,
    };
    let (min, max) = if quality == "best" { (2000, 100000) } else { (300, 20000) };
    ((width as f64 * height as f64 * fps as f64 * bpp / 1000.).round() as u32).clamp(min, max)
}
pub fn start_selection(app: &AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Запись видео доступна в Windows 10/11".into());
    }
    let video_state = app.state::<VideoState>();
    let mut slot = video_state.0.lock().map_err(|e| e.to_string())?;
    if slot
        .as_ref()
        .is_some_and(|s| !["error", "selecting"].contains(&s.status.lock().unwrap().phase.as_str()))
    {
        return Err("Сначала завершите текущую запись или закройте редактор видео".into());
    }
    let id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    *slot = Some(Arc::new(Session {
        status: Mutex::new(VideoStatus {
            id,
            phase: "selecting".into(),
            duration_ms: 0,
            bytes: 0,
            width: 0,
            height: 0,
            fps: 30,
            audio: false,
            hardware: false,
            frames: 0,
            export_percent: 0,
            error: String::new(),
        }),
        control: AtomicI32::new(0),
        cancel: AtomicI32::new(0),
        file: crate::screenshot::capture_tmp_dir().join(format!("video-{id}.mp4")),
    }));
    drop(slot);
    if let Err(e) = crate::screenshot::start_capture(app, None) {
        selection_cancelled(app);
        return Err(e);
    }
    Ok(())
}
fn open_window(
    app: &AppHandle,
    label: &str,
    width: f64,
    height: f64,
    position: Option<(i32, i32)>,
) -> Result<(), String> {
    let win = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?snipcast={label}").into()),
    )
    .title(if label == EDITOR {
        "Обрезка видео — Snipcast"
    } else {
        "Запись — Snipcast"
    })
    .inner_size(width, height)
    .min_inner_size(
        if label == EDITOR { 640. } else { 300. },
        if label == EDITOR { 440. } else { 44. },
    )
    .decorations(false)
    .resizable(label == EDITOR)
    .always_on_top(label == CONTROL)
    .skip_taskbar(label == CONTROL)
    .visible(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::utils::config::Color(0, 0, 0, 0))
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    crate::screenshot::disable_window_animations(&win);
    #[cfg(target_os = "windows")]
    if label == CONTROL {
        if let Ok(hwnd) = win.hwnd() {unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity(hwnd.0, 0x11);
        }}
    }
    if let Some((x, y)) = position {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    configure_window_frame(&win);
    Ok(())
}

// CSS draws one antialiased contour on a transparent WebView. A second DWM
// contour has a different radius and clips the border of the editor/controller.
pub fn configure_window_frame(win: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
            let css_corners:u32=1; // DWMWCP_DONOTROUND; also safe on Windows 10.
            DwmSetWindowAttribute(hwnd.0,33,&css_corners as *const _ as *const _,4);
            let no_border:u32=0xfffffffe;
            DwmSetWindowAttribute(hwnd.0,34,&no_border as *const _ as *const _,4);
        }
    }
}

#[tauri::command]
pub async fn snipcast_video_select(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_selection(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn snipcast_video_status(app: AppHandle) -> Result<VideoStatus, String> {
    Ok(session(&app)?.status.lock().unwrap().clone())
}
#[tauri::command]
pub fn snipcast_video_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if ![CONTROL, EDITOR].contains(&window.label()) {
        return Err("Неизвестное окно видео".into());
    }
    let _ = session(&app)?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
fn validate_record(app: &AppHandle, o: &RecordOptions) -> Result<(), String> {
    if ![15, 30].contains(&o.fps)
        || o.width < 16
        || o.height < 16
        || o.width > 7680
        || o.height > 4320
    {
        return Err(
            "Выберите область от 16 × 16 до 7680 × 4320 и частоту 15 или 30 кадров/с".into(),
        );
    }
    let state = app.state::<Mutex<crate::screenshot::ScreenshotState>>();
    let shot = state.lock().map_err(|e| e.to_string())?;
    if !shot.monitors.iter().any(|m| {
        o.x >= m.x
            && o.y >= m.y
            && o.x as i64 + o.width as i64 <= m.x as i64 + m.width as i64
            && o.y as i64 + o.height as i64 <= m.y as i64 + m.height as i64
    }) {
        return Err("Область записи должна целиком находиться на одном мониторе".into());
    }
    Ok(())
}
#[cfg(target_os = "windows")]
unsafe extern "C" fn recording_progress(
    user: *mut std::ffi::c_void,
    elapsed: u64,
    frames: u64,
    hardware: u32,
) {
    let (app, s) = unsafe { &*(user as *const (AppHandle, Arc<Session>)) };
    {
        let mut state = s.status.lock().unwrap();
        if ["starting", "recording", "paused"].contains(&state.phase.as_str()) {
            state.phase = if s.control.load(Ordering::Acquire)==1 {"paused"} else {"recording"}.into();
        }
        state.duration_ms = elapsed;
        state.frames = frames;
        state.hardware = hardware != 0;
        state.bytes = fs::metadata(&s.file).map(|m| m.len()).unwrap_or(0);
    }
    publish(app, s);
}
#[tauri::command]
pub async fn snipcast_video_start(app: AppHandle, options: RecordOptions) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, options);
        return Err("Запись видео доступна в Windows 10/11".into());
    }
    #[cfg(target_os = "windows")]
    {
        validate_record(&app, &options)?;
        if session(&app).is_err() {
            // A video action is also available on an ordinary screenshot selection.
            let id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            *app.state::<VideoState>().0.lock().unwrap() = Some(Arc::new(Session {
                status: Mutex::new(VideoStatus {
                    id,
                    phase: "selecting".into(),
                    duration_ms: 0,
                    bytes: 0,
                    width: 0,
                    height: 0,
                    fps: 30,
                    audio: false,
                    hardware: false,
                    frames: 0,
                    export_percent: 0,
                    error: String::new(),
                }),
                control: AtomicI32::new(0),
                cancel: AtomicI32::new(0),
                file: crate::screenshot::capture_tmp_dir().join(format!("video-{id}.mp4")),
                    }));
        }
        let s = session(&app)?;
        {
            let mut st = s.status.lock().unwrap();
            if st.phase != "selecting" {
                return Err("Уже открыта запись или редактор видео".into());
            }
            st.width = options.width & !1;
            st.height = options.height & !1;
            st.fps = options.fps;
            st.audio = options.audio;
            st.phase = "starting".into();
            st.error.clear();
        }
        let placement = unsafe {
            use windows_sys::Win32::{Foundation::POINT,Graphics::Gdi::{MonitorFromPoint,GetMonitorInfoW,MONITORINFO,MONITOR_DEFAULTTONEAREST}};
            let monitor=MonitorFromPoint(POINT{x:options.x,y:options.y},MONITOR_DEFAULTTONEAREST);
            let mut info:MONITORINFO=std::mem::zeroed();info.cbSize=std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor,&mut info)==0 {
                s.status.lock().unwrap().phase="selecting".into();return Err("Не удалось определить рабочую область монитора".into());
            }
            let scale=app.available_monitors().unwrap_or_default().iter().find(|m|{
                let p=m.position();let z=m.size();options.x>=p.x&&options.y>=p.y&&options.x<p.x+z.width as i32&&options.y<p.y+z.height as i32
            }).map(|m|m.scale_factor()).unwrap_or(1.);
            let width=(300.*scale).round() as i32;let height=(44.*scale).round() as i32;let margin=(16.*scale).round() as i32;
            (info.rcWork.left+(info.rcWork.right-info.rcWork.left-width)/2,info.rcWork.bottom-height-margin)
        };
        if let Err(e) = open_window(&app, CONTROL, 300., 44., Some(placement)) {
            s.status.lock().unwrap().phase = "selecting".into();
            return Err(e);
        }
        crate::screenshot::close_capture(&app);
        // A recording can stay open for hours. Release the frozen full-desktop
        // WebViews instead of retaining their canvas/GPU surfaces throughout it.
        // The next screenshot recreates its overlay through the existing path.
        let labels = {
            let state = app.state::<Mutex<crate::screenshot::ScreenshotState>>();
            let mut shot = state.lock().unwrap();
            std::mem::take(&mut shot.overlay_labels)
        };
        let capture_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            for label in labels {
                if let Some(window) = capture_app.get_webview_window(&label) {
                    let _ = window.close();
                }
            }
        });
        let app2 = app.clone();
        let worker = s.clone();
        std::thread::spawn(move || {
            // Let the compositor remove the frozen selection before WGC starts.
            std::thread::sleep(Duration::from_millis(160));
            let mut path = wide(&worker.file);
            let context = (app2.clone(), worker.clone());
            let st = worker.status.lock().unwrap().clone();
            let hr = unsafe {
                snipcast_video_record(
                    path.as_mut_ptr(),
                    options.x,
                    options.y,
                    st.width,
                    st.height,
                    st.fps,
                    // Preserve detail in the source: export cannot recover pixels
                    // already lost to the compact recording bitrate.
                    bitrate(st.width, st.height, st.fps, "best"),
                    u32::from(st.audio),
                    worker.control.as_ptr(),
                    recording_progress,
                    &context as *const _ as *mut std::ffi::c_void,
                )
            };
            let mut info = NativeInfo::default();
            let probe = if hr >= 0 {
                unsafe { snipcast_video_probe(path.as_ptr(), &mut info) }
            } else {
                hr
            };
            {
                let mut state = worker.status.lock().unwrap();
                if probe < 0 {
                    state.phase = "error".into();
                    state.error = error(probe, "записать видео");
                } else {
                    state.phase = "editing".into();
                    state.duration_ms = info.duration_ms;
                    state.width = info.width;
                    state.height = info.height;
                    state.fps = info.fps;
                    state.audio = info.audio != 0;
                    state.bytes = fs::metadata(&worker.file).map(|m| m.len()).unwrap_or(0);
                }
            }
            publish(&app2, &worker);
            if probe >= 0 {
                let ah = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    match open_window(&ah, EDITOR, 900., 660., None) {
                        Ok(()) => {
                            if let Some(w) = ah.get_webview_window(CONTROL) {
                                let _ = w.close();
                            }
                        }
                        Err(e) => {
                            if let Ok(s) = session(&ah) {
                                let mut st = s.status.lock().unwrap();
                                st.phase = "error".into();
                                st.error = e;
                                drop(st);
                                publish(&ah, &s);
                            }
                        }
                    }
                });
            }
        });
        Ok(())
    }
}
#[tauri::command]
pub fn snipcast_video_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    let s = session(&app)?;
    {
        let mut st = s.status.lock().unwrap();
        if !["recording", "paused"].contains(&st.phase.as_str()) {
            return Err("Запись не запущена".into());
        }
        st.phase = if paused { "paused" } else { "recording" }.into();
        s.control.store(i32::from(paused), Ordering::Release);
    }
    publish(&app, &s);
    Ok(())
}
#[tauri::command]
pub fn snipcast_video_stop(app: AppHandle) -> Result<(), String> {
    let s = session(&app)?;
    {
        let mut st = s.status.lock().unwrap();
        if !["starting", "recording", "paused"].contains(&st.phase.as_str()) {
            return Err("Запись не запущена".into());
        }
        st.phase = "stopping".into();
        s.control.store(2, Ordering::Release);
    }
    publish(&app, &s);
    Ok(())
}
fn validate_export(st: &VideoStatus, o: &ExportOptions) -> Result<(), String> {
    if o.end_ms <= o.start_ms
        || o.end_ms - o.start_ms < 100
        || o.end_ms > st.duration_ms + 50
        || o.width < 16
        || o.height < 16
        || o.x as u64 + o.width as u64 > st.width as u64
        || o.y as u64 + o.height as u64 > st.height as u64
    {
        return Err("Проверьте границы фрагмента и область обрезки".into());
    }
    if !["mp4", "gif"].contains(&o.format.as_str())
        || !["small", "balanced", "sharp", "best"].contains(&o.quality.as_str())
        || ![480, 640, 800, 960].contains(&o.gif_width)
        || ![10, 15].contains(&o.gif_fps)
    {
        return Err("Неверные параметры экспорта".into());
    }
    Ok(())
}
#[cfg(target_os = "windows")]
unsafe extern "C" fn export_progress(user: *mut std::ffi::c_void, percent: u32) {
    let (app, s) = unsafe { &*(user as *const (AppHandle, Arc<Session>)) };
    s.status.lock().unwrap().export_percent = percent;
    publish(app, s);
}
#[tauri::command]
pub async fn snipcast_video_export(
    app: AppHandle,
    options: ExportOptions,
    path: String,
) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, options, path);
        return Err("Экспорт видео доступен в Windows".into());
    }
    #[cfg(target_os = "windows")]
    {
        let s = session(&app)?;
        {
            let mut st = s.status.lock().unwrap();
            if st.phase != "editing" {
                return Err("Редактор пока не готов".into());
            }
            validate_export(&st, &options)?;
            st.phase = "exporting".into();
            st.export_percent = 0;
            st.error.clear();
            s.cancel.store(0, Ordering::Release);
        }
        publish(&app, &s);
        let target = PathBuf::from(&path);
        let context = (app.clone(), s.clone());
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            if target == context.1.file {
                return Err("Нельзя перезаписывать исходную запись".into());
            }
            let parent = target
                .parent()
                .filter(|p| p.is_dir())
                .ok_or("Папка сохранения не найдена")?;
            // Render to a sibling file first. Existing destination contents survive
            // cancellation, encoder errors and disk failures.
            let id = context.1.status.lock().unwrap().id;
            let partial = parent.join(format!(
                ".snipcast-video-{id}-{}.{}",
                SEQUENCE.fetch_add(1, Ordering::Relaxed),
                options.format
            ));
            let source = wide(&context.1.file);
            let mut output = wide(&partial);
            let st = context.1.status.lock().unwrap().clone();
            let hr = unsafe {
                native_export(
                    source.as_ptr(),
                    output.as_mut_ptr(),
                    options.start_ms,
                    options.end_ms,
                    options.x & !1,
                    options.y & !1,
                    options.width & !1,
                    options.height & !1,
                    bitrate(options.width, options.height, st.fps, &options.quality),
                    u32::from(options.quality == "best"),
                    if options.format == "gif" {
                        options.gif_width
                    } else {
                        0
                    },
                    options.gif_fps,
                    context.1.cancel.as_ptr(),
                    export_progress,
                    &context as *const _ as *mut std::ffi::c_void,
                )
            };
            if hr < 0 {
                let _ = fs::remove_file(&partial);
                return Err(if hr as u32 == 0x80004004 {
                    "Сохранение отменено".into()
                } else {
                    error(hr, "сохранить видео")
                });
            }
            // MoveFileEx replaces atomically within the destination directory.
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let destination = wide(&target);
            if unsafe {
                MoveFileExW(
                    output.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                let err = std::io::Error::last_os_error();
                let _ = fs::remove_file(&partial);
                return Err(format!("Не удалось сохранить файл: {err}"));
            }
            Ok(target.to_string_lossy().into_owned())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        {
            let mut st = s.status.lock().unwrap();
            st.phase = "editing".into();
            st.error = result.as_ref().err().cloned().unwrap_or_default();
        }
        publish(&app, &s);
        result
    }
}
#[tauri::command]
pub fn snipcast_video_cancel_export(app: AppHandle) -> Result<(), String> {
    session(&app)?.cancel.store(2, Ordering::Release);
    Ok(())
}
pub fn window_closed(app: &AppHandle, label: &str) {
    if let Ok(s) = session(app) {
        let phase = s.status.lock().unwrap().phase.clone();
        if label == CONTROL && ["starting", "recording", "paused"].contains(&phase.as_str()) {
            s.control.store(2, Ordering::Release);
        } else if label == EDITOR || label == CONTROL && phase == "error" {
            s.cancel.store(2, Ordering::Release);
            if let Ok(mut slot) = app.state::<VideoState>().0.lock() {
                *slot = None;
            }
        }
    }
}

// The protocol authorizes only the current clip id and serves bounded chunks.
// Video playback never copies an entire recording into JS/Rust memory.
pub fn media_response(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;
    let response = |code: u16| {
        Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };
    let Ok(s) = session(app) else {
        return response(404);
    };
    let id = s.status.lock().unwrap().id;
    if request.uri().path() != format!("/{id}.mp4") {
        return response(404);
    }
    let Ok(mut file) = fs::File::open(&s.file) else {
        return response(404);
    };
    let Ok(metadata) = file.metadata() else {
        return response(500);
    };
    let length = metadata.len();
    if length == 0 {
        return response(404);
    }
    let range = request.headers().get("Range").and_then(|v| v.to_str().ok());
    let parsed = range.map(|r| parse_range(r, length)).transpose();
    let Ok(parsed) = parsed else {
        return response(416);
    };
    let (start, end) = parsed.unwrap_or((0, length - 1));
    let end = end.min(start.saturating_add(2 * 1024 * 1024 - 1));
    let mut bytes = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut bytes).is_err() {
        return response(500);
    }
    Response::builder()
        .status(206)
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .header("Content-Range", format!("bytes {start}-{end}/{length}"))
        .header("Content-Length", bytes.len())
        .body(if request.method() == "HEAD" {
            Vec::new()
        } else {
            bytes
        })
        .unwrap()
}
fn parse_range(value: &str, length: u64) -> Result<(u64, u64), ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = value.split_once('-').ok_or(())?;
    let (start, end) = if a.is_empty() {
        let tail = b.parse::<u64>().map_err(|_| ())?;
        if tail == 0 {
            return Err(());
        }
        (length.saturating_sub(tail), length - 1)
    } else {
        (
            a.parse::<u64>().map_err(|_| ())?,
            if b.is_empty() {
                length - 1
            } else {
                b.parse::<u64>().map_err(|_| ())?.min(length - 1)
            },
        )
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok((start, end))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_ranges() {
        assert_eq!(parse_range("bytes=10-19", 100), Ok((10, 19)));
        assert_eq!(parse_range("bytes=-20", 100), Ok((80, 99)));
        assert_eq!(parse_range("bytes=80-", 100), Ok((80, 99)));
    }
    #[test]
    fn invalid_ranges() {
        for v in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=0-1,2-3",
            "garbage",
        ] {
            assert!(parse_range(v, 100).is_err());
        }
    }
    #[test]
    fn size_settings() {
        assert!(bitrate(1280, 720, 30, "small") < bitrate(1280, 720, 30, "balanced"));
        assert!(bitrate(1280, 720, 30, "balanced") < bitrate(1280, 720, 30, "sharp"));
        assert!(bitrate(1280, 720, 30, "sharp") < bitrate(1280, 720, 30, "best"));
        assert_eq!(bitrate(1920, 1080, 30, "best"), 19907);
        assert_eq!(bitrate(3840, 2160, 30, "best"), 79626);
        assert_eq!(bitrate(7680, 4320, 30, "best"), 100000);
        assert_eq!(bitrate(16, 16, 15, "best"), 2000);
    }
}
