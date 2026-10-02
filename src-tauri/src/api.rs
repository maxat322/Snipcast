//! Внешний HTTP API для скриптов: `POST /capture` на 127.0.0.1.
//!
//! Аутентификация — токен из файла `api-token` рядом с конфигом
//! (заголовок `X-Snipcast-Token` или `Authorization: Bearer <token>`).
//! Сервер живёт в отдельном потоке; при изменении настроек (вкл/выкл, порт,
//! токен) перезапускается командой `apply_config`.

use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::data::{self, AppConfig};
use crate::screenshot::{self, CaptureJob};

struct ApiServer {
    stop: Arc<AtomicBool>,
    port: u16,
    token: String,
}

static SERVER: OnceLock<Mutex<Option<ApiServer>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<ApiServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Текущее состояние API (для настроек).
pub fn status() -> (bool, u16) {
    match server_slot().lock() {
        Ok(guard) => match guard.as_ref() {
            Some(s) => (true, s.port),
            None => (false, 0),
        },
        Err(_) => (false, 0),
    }
}

/// Привести запущенный сервер к желаемому состоянию конфига
/// (запустить/остановить/перезапустить при смене порта или токена).
pub fn apply_config(app: &AppHandle, cfg: &AppConfig) {
    let desired = if cfg.api_enabled {
        match data::ensure_api_token() {
            Ok(token) => Some((cfg.api_port, token)),
            Err(err) => {
                eprintln!("[snipcast] api token: {err}");
                None
            }
        }
    } else {
        None
    };

    let mut guard = match server_slot().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    match (&guard.as_ref().map(|s| (s.port, s.token.clone())), &desired) {
        (Some(running), Some((port, token))) if *running == (*port, token.clone()) => return,
        _ => {}
    }

    // Остановка прежнего сервера, если был.
    if let Some(old) = guard.take() {
        old.stop.store(true, Ordering::SeqCst);
        unblock_server(old.port);
    }

    if let Some((port, token)) = desired {
        let stop = Arc::new(AtomicBool::new(false));
        let app2 = app.clone();
        let stop2 = stop.clone();
        let port2 = port;
        let token2 = token.clone();
        std::thread::Builder::new()
            .name("snipcast-api".to_string())
            .spawn(move || serve(app2, port2, token2, stop2))
            .map_err(|e| e.to_string())
            .and_then(|h| {
                // Не держим JoinHandle: поток живёт, пока не позовут stop.
                std::mem::forget(h);
                Ok(())
            })
            .unwrap_or_else(|e| eprintln!("[snipcast] api thread: {e}"));
        *guard = Some(ApiServer { stop, port, token });
        eprintln!("[snipcast] api запущен на 127.0.0.1:{port}");
    }
}

/// Разбудить блокирующий `recv` сервера служебным запросом.
fn unblock_server(port: u16) {
    let _ = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(500),
    )
    .and_then(|mut s| {
        use std::io::Write as _;
        s.write_all(b"GET /__stop HTTP/1.0\r\nHost: localhost\r\n\r\n")
    });
}

fn serve(app: AppHandle, port: u16, token: String, stop: Arc<AtomicBool>) {
    let server = match tiny_http::Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[snipcast] api не удалось занять порт {port}: {err}");
            return;
        }
    };

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut request = match server.recv() {
            Ok(r) => r,
            Err(_) => continue,
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let method = request.method().to_string();
        let url = request.url().split('?').next().unwrap_or("").to_string();

        let body_str: String = {
            let mut body = Vec::new();
            let _ = request.as_reader().read_to_end(&mut body);
            String::from_utf8_lossy(&body).into_owned()
        };

        let auth_header = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("X-Snipcast-Token"))
            .map(|h| h.value.as_str().to_string());
        let bearer = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().trim().to_string())
            .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.trim().to_string()));
        let token_ok = auth_header.as_deref().map(str::trim) == Some(token.as_str())
            || bearer.as_deref() == Some(token.as_str());

        let (status, payload) = match (method.as_str(), url.as_str()) {
            ("__stop", "/__stop") => break,
            (_, "/__stop") => continue,
            ("GET", "/health") => (
                200,
                serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
            ),
            ("POST", "/capture") if !token_ok => (
                401,
                serde_json::json!({ "ok": false, "error": "неверный или отсутствующий токен (заголовок X-Snipcast-Token)" }),
            ),
            ("POST", "/capture") => handle_capture(&app, &body_str),
            ("POST", "/preset") if !token_ok => (
                401,
                serde_json::json!({ "ok": false, "error": "неверный или отсутствующий токен (заголовок X-Snipcast-Token)" }),
            ),
            ("POST", "/preset") => handle_preset(&app, &body_str),
            _ => (
                404,
                serde_json::json!({ "ok": false, "error": "нет такого пути (POST /capture, POST /preset, GET /health)" }),
            ),
        };

        let body = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
        let response = tiny_http::Response::from_string(body)
            .with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
            )
            .with_status_code(status);
        if let Err(err) = request.respond(response) {
            eprintln!("[snipcast] api respond: {err}");
        }
    }
}

fn handle_capture(app: &AppHandle, body: &str) -> (u16, serde_json::Value) {
    // Тело — плоский JSON джобы: { name, dir, region, ocr, copy, ... }.
    let parsed: Result<CaptureJob, _> = serde_json::from_str(body);
    let job = match parsed {
        Ok(r) => r,
        Err(err) => {
            return (
                400,
                serde_json::json!({ "ok": false, "error": format!("неверный JSON: {err}") }),
            );
        }
    };
    let cfg = match app.state::<Mutex<AppConfig>>().lock() {
        Ok(c) => c.clone(),
        Err(err) => {
            return (
                500,
                serde_json::json!({ "ok": false, "error": format!("конфиг: {err}") }),
            );
        }
    };
    match screenshot::run_capture_job(app, &cfg, &job) {
        Ok(res) => (
            200,
            serde_json::json!({
                "ok": true,
                "path": res.path,
                "text": res.text,
                "width": res.width,
                "height": res.height,
                "ms": res.ms,
            }),
        ),
        Err(err) => (500, serde_json::json!({ "ok": false, "error": err })),
    }
}

/// Запустить пресет по id: {"id": "..."}.
/// Пресеты с выделением области отвечают сразу (окно откроется), беззвучные
/// выполняются синхронно и возвращают ошибку, если она случилась.
fn handle_preset(app: &AppHandle, body: &str) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    struct PresetRequest {
        id: String,
    }
    let req: PresetRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(err) => {
            return (
                400,
                serde_json::json!({ "ok": false, "error": format!("неверный JSON: {err}") }),
            );
        }
    };
    let cfg = match app.state::<Mutex<AppConfig>>().lock() {
        Ok(c) => c.clone(),
        Err(err) => {
            return (
                500,
                serde_json::json!({ "ok": false, "error": format!("конфиг: {err}") }),
            );
        }
    };
    match crate::run_preset_job(app, &cfg, &req.id) {
        Ok(()) => (200, serde_json::json!({ "ok": true })),
        Err(err) => (500, serde_json::json!({ "ok": false, "error": err })),
    }
}
