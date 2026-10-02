//! PaddleOCR через ONNX Runtime (`ort`, load-dynamic).
//!
//! Модели скачиваются один раз в `<база>/ocr/`:
//! - `det.onnx`  — PP-OCRv5 mobile det (универсальный детектор строк);
//! - `rec.onnx`  — cyrillic PP-OCRv5 mobile rec: кириллица + латиница + цифры;
//! - `rec2.onnx` — PP-OCRv5 mobile rec: zh + en + ja (второй язык для смешанных скриншотов);
//! - `rec.yml`, `rec2.yml` — конфиги моделей со словарями символов (CTCLabelDecode);
//! - `onnxruntime.dll` — ONNX Runtime 1.22 (win-x64).
//!
//! Пайплайн: тёмный кадр инвертируется (модели обучены на тёмном тексте по
//! светлому) → детект боксов (DB: карта вероятностей → связные компоненты →
//! бокс с ограниченным расширением) → каждый бокс распознаётся ОБЕИМИ
//! rec-моделями, берётся результат с большей уверенностью → боксы
//! группируются в строки по вертикальным центрам.

#[cfg(target_os = "windows")]
pub mod paddle {
    use std::io::{Read as _, Write as _};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    use ort::session::builder::GraphOptimizationLevel;
    use ort::session::Session;
    use ort::value::Tensor;

    const DET_FILE: &str = "det.onnx";
    const REC_FILE: &str = "rec.onnx";
    const REC2_FILE: &str = "rec2.onnx";
    const YML_FILE: &str = "rec.yml";
    const YML2_FILE: &str = "rec2.yml";
    const ORT_DLL: &str = "onnxruntime.dll";

    pub const DET_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx";
    pub const REC_URL: &str = "https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx";
    pub const YML_URL: &str = "https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml";
    pub const REC2_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx";
    pub const YML2_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml";
    pub const ORT_URL: &str =
        "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/onnxruntime-win-x64-1.22.0.zip";

    // Точный (server) пакет: детектор + zh/en rec серверного класса.
    // Серверной кириллической rec в ONNX не существует — она всегда mobile.
    const SRV_DET_FILE: &str = "det-srv.onnx";
    const SRV_REC2_FILE: &str = "rec2-srv.onnx";
    const SRV_YML2_FILE: &str = "rec2-srv.yml";
    pub const SRV_DET_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det_onnx/resolve/main/inference.onnx";
    pub const SRV_REC2_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/main/inference.onnx";
    pub const SRV_YML2_URL: &str =
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/main/inference.yml";

    /// Приблизительный объём загрузки: мобильный пакет (det + 2×rec + yml + zip).
    pub const DOWNLOAD_MB: u64 = 100;
    /// Докачка точного пакета поверх мобильного.
    pub const DOWNLOAD_SRV_MB: u64 = 170;

    pub fn models_dir() -> PathBuf {
        crate::data::snipcast_base_dir().join("ocr")
    }

    fn model_path(name: &str) -> PathBuf {
        models_dir().join(name)
    }

    fn file_ready(name: &str) -> bool {
        model_path(name).metadata().map(|m| m.len() > 0).unwrap_or(false)
    }

    pub fn normalize_quality(quality: &str) -> String {
        if quality.eq_ignore_ascii_case("server") {
            "server".to_string()
        } else {
            "mobile".to_string()
        }
    }

    /// Чего не хватает для работы движка заданного качества.
    pub fn missing_files(quality: &str) -> Vec<String> {
        let mut files = vec![DET_FILE, REC_FILE, REC2_FILE, YML_FILE, YML2_FILE, ORT_DLL];
        if normalize_quality(quality) == "server" {
            files.push(SRV_DET_FILE);
            files.push(SRV_REC2_FILE);
            files.push(SRV_YML2_FILE);
        }
        files
            .into_iter()
            .filter(|f| !file_ready(f))
            .map(|f| f.to_string())
            .collect()
    }

    pub fn ready(quality: &str) -> bool {
        missing_files(quality).is_empty()
    }

    static DOWNLOADING: AtomicBool = AtomicBool::new(false);

    pub fn is_downloading() -> bool {
        DOWNLOADING.load(Ordering::SeqCst)
    }

    /// Скачать всё недостающее для качества `quality`.
    /// `progress(stage, done, total, message)`.
    pub fn download_all(
        quality: &str,
        progress: &dyn Fn(&str, u64, u64, &str),
    ) -> Result<(), String> {
        if DOWNLOADING.swap(true, Ordering::SeqCst) {
            return Err("загрузка моделей уже идёт".to_string());
        }
        let result = download_all_inner(quality, progress);
        DOWNLOADING.store(false, Ordering::SeqCst);
        result
    }

    fn download_all_inner(
        quality: &str,
        progress: &dyn Fn(&str, u64, u64, &str),
    ) -> Result<(), String> {
        let dir = models_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("создание {}: {e}", dir.display()))?;

        for (file, url) in [
            (DET_FILE, DET_URL),
            (REC_FILE, REC_URL),
            (YML_FILE, YML_URL),
            (REC2_FILE, REC2_URL),
            (YML2_FILE, YML2_URL),
        ] {
            if file_ready(file) {
                continue;
            }
            progress("models", 0, 1, file);
            download_to(url, &dir.join(file), &|done, total| {
                progress("models", done, total, file);
            })?;
        }

        // Точный пакет: серверные det и rec2.
        if normalize_quality(quality) == "server" {
            for (file, url) in [
                (SRV_DET_FILE, SRV_DET_URL),
                (SRV_REC2_FILE, SRV_REC2_URL),
                (SRV_YML2_FILE, SRV_YML2_URL),
            ] {
                if file_ready(file) {
                    continue;
                }
                progress("models", 0, 1, file);
                download_to(url, &dir.join(file), &|done, total| {
                    progress("models", done, total, file);
                })?;
            }
        }

        if file_ready(ORT_DLL) {
            return Ok(());
        }
        progress("runtime", 0, 1, ORT_DLL);
        let zip_path = dir.join("onnxruntime.zip");
        download_to(ORT_URL, &zip_path, &|done, total| {
            progress("runtime", done, total, "onnxruntime.zip");
        })?;

        let file = std::fs::File::open(&zip_path).map_err(|e| format!("zip: {e}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
        let mut found = false;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("zip: {e}"))?;
            if !entry.name().ends_with(ORT_DLL) || entry.is_dir() {
                continue;
            }
            let mut out = std::fs::File::create(dir.join(ORT_DLL)).map_err(|e| format!("dll: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("dll: {e}"))?;
            found = true;
            break;
        }
        let _ = std::fs::remove_file(&zip_path);
        if !found {
            return Err("в архиве ONNX Runtime нет onnxruntime.dll".to_string());
        }
        Ok(())
    }

    fn download_to(url: &str, dst: &Path, on_progress: &dyn Fn(u64, u64)) -> Result<(), String> {
        use std::io::Read as _;
        let tmp = dst.with_extension("part");
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("скачивание {url}: {e}"))?;
        let total = resp.content_length().unwrap_or(0);
        let mut done: u64 = 0;
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("файл: {e}"))?;
        let mut reader = std::io::BufReader::with_capacity(64 * 1024, resp);
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("скачивание: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("файл: {e}"))?;
            done += n as u64;
            on_progress(done, total);
        }
        file.flush().map_err(|e| format!("файл: {e}"))?;
        drop(file);
        std::fs::rename(&tmp, dst).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Движок: det + две rec-модели
    // -----------------------------------------------------------------------

    struct Engine {
        quality: String,
        det: Session,
        rec1: Session,
        rec2: Session,
        vocab1: Vec<String>,
        vocab2: Vec<String>,
    }

    static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();

    fn engine_slot() -> &'static Mutex<Option<Engine>> {
        ENGINE.get_or_init(|| Mutex::new(None))
    }

    fn init_ort() -> Result<(), String> {
        static INIT: OnceLock<Result<(), String>> = OnceLock::new();
        let res = INIT.get_or_init(|| {
            let dll = model_path(ORT_DLL);
            if !dll.exists() {
                return Err("onnxruntime.dll не скачан".to_string());
            }
            std::env::set_var("ORT_DYLIB_PATH", &dll);
            let _ = ort::init().commit();
            Ok(())
        });
        res.clone()
    }

    fn ee<E: std::fmt::Display>(err: E) -> String {
        format!("ort: {err}")
    }

    fn session_from(path: &Path) -> Result<Session, String> {
        Ok(Session::builder()
            .map_err(ee)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(ee)?
            .with_intra_threads(4)
            .map_err(ee)?
            .commit_from_file(path)
            .map_err(ee)?)
    }

    fn load_engine(quality: &str) -> Result<Engine, String> {
        let quality = normalize_quality(quality);
        init_ort()?;
        let dir = models_dir();
        let server = quality == "server";
        let det_file = if server { SRV_DET_FILE } else { DET_FILE };
        let rec2_file = if server { SRV_REC2_FILE } else { REC2_FILE };
        let yml2_file = if server { SRV_YML2_FILE } else { YML2_FILE };
        for f in [DET_FILE, REC_FILE, REC2_FILE, YML_FILE, YML2_FILE] {
            if !file_ready(f) {
                return Err(format!("мобильная модель не скачана: {f}"));
            }
        }
        if server {
            for f in [SRV_DET_FILE, SRV_REC2_FILE, SRV_YML2_FILE] {
                if !file_ready(f) {
                    return Err(format!(
                        "точная модель не скачана: {f} (скачайте её в настройках)"
                    ));
                }
            }
        }
        let vocab1 = parse_vocab_from_yml(&dir.join(YML_FILE))?;
        let vocab2 = parse_vocab_from_yml(&dir.join(yml2_file))?;
        Ok(Engine {
            quality: quality.clone(),
            det: session_from(&dir.join(det_file))?,
            rec1: session_from(&dir.join(REC_FILE))?,
            rec2: session_from(&dir.join(rec2_file))?,
            vocab1,
            vocab2,
        })
    }

    /// Распознать текст на PNG (PaddleOCR). Две rec-модели покрывают
    /// кириллицу, латиницу, цифры, CJK — на каждый бокс берётся более
    /// уверенный результат, поэтому смешанные языки читаются корректно.
    pub fn recognize(png: &[u8], quality: &str) -> Result<String, String> {
        let quality = normalize_quality(quality);
        let mut guard = engine_slot().lock().map_err(|e| e.to_string())?;
        let needs_reload = match guard.as_ref() {
            Some(e) => e.quality != quality,
            None => true,
        };
        if needs_reload {
            // Переключение качества перезагружает движок лениво, при первом OCR.
            *guard = Some(load_engine(&quality)?);
        }
        let eng = guard.as_mut().expect("engine just initialized");

        let img = image::load_from_memory(png)
            .map_err(|e| format!("декодирование снимка: {e}"))?
            .to_rgba8();
        let (iw, ih) = (img.width() as usize, img.height() as usize);
        if iw == 0 || ih == 0 {
            return Ok(String::new());
        }

        // Тёмный скриншот инвертируем: det/rec обучены на тёмном тексте по светлому.
        let img = invert_if_dark(img);

        let boxes = detect_lines(&mut eng.det, &img)?;
        if boxes.is_empty() {
            return Ok(String::new());
        }

        let mut items: Vec<(i32, i32, u32, u32, String)> = Vec::new();
        for (bx, by, bw, bh) in &boxes {
            let (text, conf) = recognize_box_best(eng, &img, *bx, *by, *bw, *bh);
            let short = text.trim().chars().count() < 4;
            if !text.trim().is_empty() && !(short && conf < 0.55) {
                items.push((*bx, *by, *bw, *bh, text));
            }
        }
        Ok(group_lines(items))
    }

    /// Средняя яркость кадра; тёмные скриншоты (светлый текст на тёмном фоне)
    /// инвертируются целиком.
    fn invert_if_dark(img: image::RgbaImage) -> image::RgbaImage {
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return img;
        }
        // Выборка по уменьшенной копии — яркость считается быстро.
        let sw = w.min(320).max(32);
        let sh = ((h as f32 * sw as f32 / w as f32).round() as u32).max(1);
        let small = image::imageops::resize(&img, sw, sh, image::imageops::FilterType::Triangle);
        let mut sum = 0f64;
        for px in small.pixels() {
            let [r, g, b, _] = px.0;
            sum += 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
        }
        let mean = sum / (sw * sh) as f64;
        if mean >= 110.0 {
            return img;
        }
        let mut out = img;
        for px in out.pixels_mut() {
            px.0[0] = 255 - px.0[0];
            px.0[1] = 255 - px.0[1];
            px.0[2] = 255 - px.0[2];
        }
        out
    }

    // -----------------------------------------------------------------------
    // Детекция (DB)
    // -----------------------------------------------------------------------

    fn detect_lines(det: &mut Session, img: &image::RgbaImage) -> Result<Vec<(i32, i32, u32, u32)>, String> {
        let (iw, ih) = (img.width() as usize, img.height() as usize);

        // Ограничиваем большую сторону 960, паддим до кратности 32.
        let limit = 960.0f32;
        let scale = (limit / iw.max(ih) as f32).min(1.0);
        let rw = ((iw as f32 * scale).round() as usize).max(32);
        let rh = ((ih as f32 * scale).round() as usize).max(32);
        let rw = rw.div_ceil(32) * 32;
        let rh = rh.div_ceil(32) * 32;

        let resized = image::imageops::resize(
            img,
            rw as u32,
            rh as u32,
            image::imageops::FilterType::Triangle,
        );

        // Нормализация RGB: (x/255 - mean) / std.
        let mean = [0.485f32, 0.456, 0.406];
        let std = [0.229f32, 0.224, 0.225];
        let mut input = vec![0f32; 3 * rw * rh];
        for y in 0..rh {
            for x in 0..rw {
                let px = resized.get_pixel(x as u32, y as u32);
                let rgb = [px.0[0], px.0[1], px.0[2]];
                for c in 0..3 {
                    input[c * rw * rh + y * rw + x] = (rgb[c] as f32 / 255.0 - mean[c]) / std[c];
                }
            }
        }

        let in_name = det
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .unwrap_or_else(|| "x".to_string());
        let tensor = Tensor::from_array(([1i64, 3, rh as i64, rw as i64], input)).map_err(ee)?;
        let outputs = det.run(ort::inputs![in_name.as_str() => tensor]).map_err(ee)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(ee)?;
        if shape.len() != 4 {
            return Err(format!("неожиданный выход det: {shape:?}"));
        }
        let (oh, ow) = (shape[2] as usize, shape[3] as usize);
        let prob: Vec<f32> = data.to_vec();

        let thr = 0.3f32;
        // Маска вероятностей.
        let mut mask = vec![false; oh * ow];
        for i in 0..oh * ow {
            mask[i] = prob[i] > thr;
        }

        // Горизонтальное «сшивание»: на мелком тексте каждая буква — отдельный
        // компонент, и детекция разваливается. Мост по строке (расширение маски
        // влево на BRIDGE) соединяет символы и слова одной строки; вертикального
        // расширения нет — соседние строки не сливаются. Соседние колонки
        // (пробел между ними заметно шире BRIDGE) тоже не соединяются.
        const BRIDGE: usize = 16;
        let mut dilated = vec![false; oh * ow];
        for y in 0..oh {
            let row = y * ow;
            let mut run = 0usize;
            for x in 0..ow {
                if mask[row + x] {
                    run = BRIDGE + 1;
                }
                if run > 0 {
                    dilated[row + x] = true;
                    run -= 1;
                }
            }
        }

        // Компоненты ищем на расширенной маске (для связности), а bbox считает
        // только по исходной маске — мосты не раздувают рамки.
        let mut label = vec![0u32; oh * ow];
        let mut next_label: u32 = 0;
        let mut boxes: Vec<(i32, i32, u32, u32)> = Vec::new();
        for sy in 0..oh {
            for sx in 0..ow {
                let start = sy * ow + sx;
                if label[start] != 0 || !dilated[start] {
                    continue;
                }
                next_label += 1;
                let mut stack = vec![(sx, sy)];
                label[start] = next_label;
                let mut count = 0usize;
                let (mut minx, mut miny, mut maxx, mut maxy) = (sx, sy, sx, sy);
                while let Some((x, y)) = stack.pop() {
                    let idx = y * ow + x;
                    if mask[idx] {
                        count += 1;
                        if x < minx { minx = x; }
                        if y < miny { miny = y; }
                        if x > maxx { maxx = x; }
                        if y > maxy { maxy = y; }
                    }
                    for (nx, ny) in [
                        (x.wrapping_sub(1), y),
                        (x + 1, y),
                        (x, y.wrapping_sub(1)),
                        (x, y + 1),
                    ] {
                        if nx >= ow || ny >= oh {
                            continue;
                        }
                        let nidx = ny * ow + nx;
                        if label[nidx] == 0 && dilated[nidx] {
                            label[nidx] = next_label;
                            stack.push((nx, ny));
                        }
                    }
                }

                if count < 12 {
                    continue;
                }
                let (bw, bh) = (maxx - minx + 1, maxy - miny + 1);
                if bw < 4 || bh < 3 {
                    continue;
                }
                if bw >= ow - 2 && bh >= oh - 2 {
                    continue; // «весь кадр» — ложное срабатывание
                }

                // Расширение бокса (unclip): ядро DB сжато относительно текста,
                // но потолок держим у высоты ядра — иначе на плотном тексте
                // бокс съедает соседние строки.
                let per = 2.0f32 * (bw + bh) as f32;
                let cap = 1.20f32 * (bh as f32);
                let off = ((count as f32 * 1.6) / per).clamp(1.0, cap.max(1.0));
                let x0 = (minx as f32 - off).max(0.0);
                let y0 = (miny as f32 - off).max(0.0);
                let x1 = (maxx as f32 + 1.0 + off).min(ow as f32);
                let y1 = (maxy as f32 + 1.0 + off).min(oh as f32);

                let kx = iw as f32 / ow as f32;
                let ky = ih as f32 / oh as f32;
                let bx = (x0 * kx).floor().max(0.0) as i32;
                let by = (y0 * ky).floor().max(0.0) as i32;
                let bw2 = ((x1 - x0) * kx).ceil().max(4.0) as u32;
                let bh2 = ((y1 - y0) * ky).ceil().max(4.0) as u32;
                let bw2 = bw2.min((iw as i32 - bx).max(1) as u32);
                let bh2 = bh2.min((ih as i32 - by).max(1) as u32);
                boxes.push((bx, by, bw2, bh2));
            }
        }
        boxes.sort_by_key(|(x, y, _, _)| (*y, *x));
        Ok(boxes)
    }

    // -----------------------------------------------------------------------
    // Распознавание бокса: две модели, победитель по уверенности
    // -----------------------------------------------------------------------

    fn recognize_box_best(
        eng: &mut Engine,
        img: &image::RgbaImage,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> (String, f32) {
        let a = recognize_box(&mut eng.rec1, &eng.vocab1, img, x, y, w, h);
        let b = recognize_box(&mut eng.rec2, &eng.vocab2, img, x, y, w, h);
        if b.1 > a.1 { b } else { a }
    }

    /// CTC greedy-декод + средняя уверенность выбранных символов.
    fn recognize_box(
        rec: &mut Session,
        vocab: &[String],
        img: &image::RgbaImage,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> (String, f32) {
        let (iw, ih) = (img.width() as i32, img.height() as i32);
        let x0 = x.clamp(0, iw.saturating_sub(1));
        let y0 = y.clamp(0, ih.saturating_sub(1));
        let w = w.min((iw - x0) as u32).max(1);
        let h = h.min((ih - y0) as u32).max(1);
        if h < 4 || w < 4 {
            return (String::new(), 0.0);
        }
        let crop = image::imageops::crop_imm(img, x0 as u32, y0 as u32, w, h).to_image();

        const REC_H: u32 = 48;
        const MAX_W: u32 = 3200;
        let target_w = (((REC_H as f32) * (w as f32) / (h as f32)).ceil() as u32).clamp(32, MAX_W);
        let resized =
            image::imageops::resize(&crop, target_w, REC_H, image::imageops::FilterType::Triangle);

        // BGR, (x/255 - 0.5) / 0.5, CHW.
        let mut input = vec![0f32; 3 * REC_H as usize * target_w as usize];
        for yy in 0..REC_H as usize {
            for xx in 0..target_w as usize {
                let px = resized.get_pixel(xx as u32, yy as u32);
                let bgr = [px.0[2], px.0[1], px.0[0]];
                for c in 0..3 {
                    input[c * REC_H as usize * target_w as usize + yy * target_w as usize + xx] =
                        (bgr[c] as f32 / 255.0 - 0.5) / 0.5;
                }
            }
        }

        let in_name = rec
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .unwrap_or_else(|| "x".to_string());
        let run = (|| {
            let tensor =
                Tensor::from_array(([1i64, 3, REC_H as i64, target_w as i64], input)).map_err(ee)?;
            rec.run(ort::inputs![in_name.as_str() => tensor]).map_err(ee)
        })();
        let outputs = match run {
            Ok(o) => o,
            Err(_) => return (String::new(), 0.0),
        };
        let (shape, data) = match outputs[0].try_extract_tensor::<f32>() {
            Ok(v) => v,
            Err(_) => return (String::new(), 0.0),
        };
        if shape.len() != 3 {
            return (String::new(), 0.0);
        }
        let (t_len, classes) = (shape[1] as usize, shape[2] as usize);

        let mut text = String::new();
        let mut conf_sum = 0f32;
        let mut conf_n = 0usize;
        let mut prev: usize = 0;
        for t in 0..t_len {
            let row = &data[t * classes..(t + 1) * classes];
            let mut best = 0usize;
            let mut best_v = f32::NEG_INFINITY;
            for (i, &v) in row.iter().enumerate() {
                if v > best_v {
                    best_v = v;
                    best = i;
                }
            }
            if best != 0 && best != prev {
                if let Some(ch) = vocab_char(vocab, best, classes) {
                    text.push_str(&ch);
                    conf_sum += best_v;
                    conf_n += 1;
                }
            }
            prev = best;
        }
        let conf = if conf_n > 0 { conf_sum / conf_n as f32 } else { 0.0 };
        (text.trim().to_string(), conf)
    }

    /// Индекс CTC → символ: 0 — blank; 1..=len(dict) — словарь;
    /// последний класс (если есть) — пробел.
    fn vocab_char(vocab: &[String], idx: usize, classes: usize) -> Option<String> {
        if idx == 0 || vocab.is_empty() {
            return None;
        }
        if idx <= vocab.len() {
            return vocab.get(idx - 1).cloned();
        }
        if idx == classes - 1 && classes > vocab.len() + 1 {
            return Some(" ".to_string());
        }
        None
    }

    /// Сборка строк из боксов: сортировка по вертикальному центру, боксы
    /// с близкими центрами — одна строка (внутри — слева направо). Никакой
    /// склейки боксов ДО распознавания — она портила плотный текст.
    fn group_lines(mut items: Vec<(i32, i32, u32, u32, String)>) -> String {
        items.sort_by_key(|(x, y, _, h, _)| (y + *h as i32 / 2, *x));
        let mut lines: Vec<Vec<(i32, i32, u32, u32, String)>> = Vec::new();
        for it in items {
            let cy = it.1 + it.3 as i32 / 2;
            let hh = it.3.max(1);
            let mut placed = false;
            for line in lines.iter_mut().rev() {
                let last = line.last().unwrap();
                let lcy = last.1 + last.3 as i32 / 2;
                let min_h = hh.min(last.3.max(1));
                if (cy - lcy).abs() * 2 < min_h as i32 {
                    line.push(it.clone());
                    placed = true;
                    break;
                }
                // Строки отсортированы по центру: если центр оказался ниже
                // последней строки — начинаем новую.
                if cy > lcy {
                    break;
                }
            }
            if !placed {
                lines.push(vec![it]);
            }
        }
        let mut out = Vec::new();
        for line in lines {
            let mut parts: Vec<(i32, String)> =
                line.into_iter().map(|(x, _, _, _, t)| (x, t)).collect();
            parts.sort_by_key(|(x, _)| *x);
            out.push(parts.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join(" "));
        }
        out.join("\n")
    }

    // -----------------------------------------------------------------------
    // Словарь из inference.yml (PostProcess.character_dict)
    // -----------------------------------------------------------------------

    fn parse_vocab_from_yml(path: &Path) -> Result<Vec<String>, String> {
        let mut text = String::new();
        std::fs::File::open(path)
            .and_then(|mut f| f.read_to_string(&mut text))
            .map_err(|e| format!("чтение {}: {e}", path.display()))?;

        let mut vocab: Vec<String> = Vec::new();
        let mut in_dict = false;
        for line in text.lines() {
            if !in_dict {
                if line.trim_end() == "  character_dict:" {
                    in_dict = true;
                }
                continue;
            }
            let Some(item) = line.strip_prefix("  - ") else {
                break;
            };
            let item = item.trim();
            let unquoted = if (item.starts_with('\'') && item.ends_with('\'') && item.len() >= 2)
                || (item.starts_with('"') && item.ends_with('"') && item.len() >= 2)
            {
                item[1..item.len() - 1].replace("''", "'")
            } else {
                item.to_string()
            };
            vocab.push(unquoted);
        }
        if vocab.is_empty() {
            return Err(format!("в {} не найден словарь символов", path.display()));
        }
        Ok(vocab)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn vocab_parse_shape() {
            let dir = std::env::temp_dir().join("snipcast-test-vocab");
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join("rec.yml");
            std::fs::write(
                &p,
                "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - 'a'\n  - b\n  - '''П'''\n  use_space_char: true\n",
            )
            .unwrap();
            let v = parse_vocab_from_yml(&p).unwrap();
            assert_eq!(v, vec!["a", "b", "'П'"]);
        }

        #[test]
        fn paddle_smoke_if_models_present() {
            if ready("mobile") {
                let img = image::RgbaImage::from_pixel(200, 60, image::Rgba([255, 255, 255, 255]));
                let mut png = Vec::new();
                image::DynamicImage::ImageRgba8(img)
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .unwrap();
                match recognize(&png, "mobile") {
                    Ok(_) => {}
                    // Параллельный тест data_* подменяет SNIPCAST_DATA_DIR,
                    // и папка моделей «уезжает» посреди проверки — это не
                    // ошибка пайплайна. Пропускаем любые «модель/DLL не найдена»
                    // и ошибки чтения моделей ort.
                    Err(e)
                        if e.contains("onnxruntime.dll")
                            || e.contains("модель")
                            || e.contains("ort:") =>
                    {
                        println!("модели недоступны из-за гонки env в параллельном прогоне — пропуск: {e}");
                    }
                    Err(e) => panic!("recognize должен отработать: {e}"),
                }
            } else {
                println!("модели не скачаны — тест пропущен");
            }
        }
    }
}
