//! Распознавание текста (OCR) по снимку (PNG-байты).
//!
//! Движки:
//! - `system` — встроенные средства ОС: Windows.Media.Ocr (Windows 10/11),
//!   Vision / VNRecognizeTextRequest (macOS). Быстро и локально, без загрузок.
//! - `paddle` — PaddleOCR через ONNX Runtime (этап 2).

#[cfg(target_os = "windows")]
pub mod win_ocr {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    /// WinRT-вызовы требуют инициализированного COM на текущем потоке.
    /// Команды Tauri выполняются в пуле потоков без COM — инициализируем MTA.
    fn ensure_com() {
        unsafe {
            // RPC_E_CHANGED_MODE и S_FALSE — тоже рабочий результат.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn engine_for(lang: &str) -> Result<OcrEngine, String> {
        ensure_com();
        let res = if lang.trim().is_empty() || lang.eq_ignore_ascii_case("auto") {
            OcrEngine::TryCreateFromUserProfileLanguages()
        } else {
            let l = Language::CreateLanguage(&HSTRING::from(lang))
                .map_err(|e| format!("язык {lang}: {e}"))?;
            OcrEngine::TryCreateFromLanguage(&l)
        };
        res.map_err(|_| {
            "Системный OCR недоступен. Проверьте, что в Windows установлены языковые пакеты (Параметры → Время и язык → Язык)."
                .to_string()
        })
    }

    /// Таймаут одного вызова WinRT OCR: без него зависший async op
    /// «вешает программу намертво» — .get() не возвращается никогда.
    const OCR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

    /// Список языков по значению настройки:
    /// "" / "auto" — языки профиля Windows; "all" — все установленные;
    /// "ru-RU, en-US" — перечисленные через запятую.
    pub fn language_list(lang: &str) -> Vec<String> {
        let lang = lang.trim();
        if lang.is_empty() || lang.eq_ignore_ascii_case("auto") {
            return vec!["auto".to_string()];
        }
        if lang.eq_ignore_ascii_case("all") {
            let mut langs = available_languages();
            langs.truncate(6); // каждая попытка до 8 с — не даём уехать в минуты
            return if langs.is_empty() {
                vec!["auto".to_string()]
            } else {
                langs
            };
        }
        let list: Vec<String> = lang
            .split(',')
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if list.is_empty() {
            vec!["auto".to_string()]
        } else {
            list
        }
    }

    pub fn recognize(png: &[u8], lang: &str) -> Result<String, String> {
        // Смешанный текст: пробуем каждый язык и берём результат с наибольшим
        // числом непробельных символов (Windows OCR читает латиницу и цифры
        // любым из языков, но экзотика покрывается только «своим» движком).
        let langs = language_list(lang);
        let started = std::time::Instant::now();
        let mut best: Option<(usize, String)> = None;
        let mut last_err = String::new();
        for l in &langs {
            if best.is_some() && started.elapsed() > std::time::Duration::from_secs(20) {
                break; // общий бюджет на мультиязычный прогон
            }
            match recognize_with_timeout(png, l) {
                Ok(text) => {
                    let score = text.chars().filter(|c| !c.is_whitespace()).count();
                    if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                        best = Some((score, text));
                    }
                }
                Err(e) => last_err = e,
            }
        }
        match best {
            Some((_, text)) => Ok(text),
            None if last_err.is_empty() => Err("ни один язык не дал результата".to_string()),
            None => Err(last_err),
        }
    }

    /// Один вызов движка в отдельном потоке с жёстким таймаутом.
    /// Зависший поток остаётся висеть, но приложение больше не блокируется.
    pub fn recognize_with_timeout(png: &[u8], lang: &str) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let png = png.to_vec();
        let lang = lang.to_string();
        std::thread::Builder::new()
            .name("snipcast-winocr".to_string())
            .spawn(move || {
                let _ = tx.send(recognize_blocking(&png, &lang));
            })
            .map_err(|e| format!("поток OCR: {e}"))?;
        match rx.recv_timeout(OCR_TIMEOUT) {
            Ok(res) => res,
            Err(_) => Err(format!(
                "Windows OCR не завершился за {} с (движок завис). Попробуйте PaddleOCR или другой язык.",
                OCR_TIMEOUT.as_secs()
            )),
        }
    }

    fn recognize_blocking(png: &[u8], lang: &str) -> Result<String, String> {
        let eng = engine_for(lang)?;
        ensure_com();

        // Windows OCR не принимает изображения крупнее MaxImageDimension — уменьшаем.
        let max_dim = OcrEngine::MaxImageDimension().unwrap_or(u32::MAX);
        let mut img = image::load_from_memory(png)
            .map_err(|e| format!("декодирование снимка: {e}"))?
            .to_rgba8();
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return Err("пустая область распознавания".to_string());
        }
        if w.max(h) > max_dim {
            let k = max_dim as f64 / w.max(h) as f64;
            let nw = ((w as f64) * k).round().max(1.0) as u32;
            let nh = ((h as f64) * k).round().max(1.0) as u32;
            img = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Lanczos3);
        }
        let png_scaled = {
            let mut out = Vec::new();
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .map_err(|e| format!("кодирование снимка: {e}"))?;
            out
        };

        let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
        writer.WriteBytes(&png_scaled).map_err(|e| e.to_string())?;
        writer.StoreAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
        writer.FlushAsync().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;

        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let mut swbmp = decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        // OcrEngine принимает Bgra8 — декодер PNG может вернуть Rgba8, конвертируем.
        if swbmp.BitmapPixelFormat().map_err(|e: windows::core::Error| e.to_string())?.0
            != BitmapPixelFormat::Bgra8.0
        {
            swbmp = SoftwareBitmap::Convert(&swbmp, BitmapPixelFormat::Bgra8)
                .map_err(|e| e.to_string())?;
        }

        let result = eng
            .RecognizeAsync(&swbmp)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        // Собираем по строкам с явными переводами строк: result.Text()
        // склеивает весь текст в одну строку без переносов.
        let lines = result.Lines().map_err(|e| e.to_string())?;
        let mut parts: Vec<String> = Vec::new();
        for line in lines.into_iter() {
            if let Ok(t) = line.Text() {
                let t = t.to_string();
                if !t.trim().is_empty() {
                    parts.push(t);
                }
            }
        }
        if parts.is_empty() {
            let text = result.Text().map_err(|e| e.to_string())?;
            Ok(text.to_string())
        } else {
            Ok(parts.join("\n"))
        }
    }

    /// BCP-47 теги языков, установленных для системного OCR.
    pub fn available_languages() -> Vec<String> {
        ensure_com();
        match OcrEngine::AvailableRecognizerLanguages() {
            Ok(langs) => langs
                .into_iter()
                .filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string()))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(target_os = "macos")]
pub mod mac_vision {
    //! Vision / VNRecognizeTextRequest. Модуль собирается только на macOS —
    //! локально (Windows) не проверить, сигнатуры objc2-vision уточнить при
    //! первой macOS-сборке (помечено `NOTE(macOS)`).

    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSData, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    pub fn recognize(png: &[u8], lang: &str) -> Result<String, String> {
        unsafe {
            let data = NSData::with_bytes(png);
            let handler = VNImageRequestHandler::initWithData_options(
                objc2_vision::VNImageRequestHandler::alloc(),
                &data,
                None,
            );

            let request =
                VNRecognizeTextRequest::initWithCompletionHandler(VNRecognizeTextRequest::alloc(), None);
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            request.setUsesLanguageCorrection(true);

            let langs: Vec<Retained<NSString>> =
                if lang.trim().is_empty() || lang.eq_ignore_ascii_case("auto") {
                    vec![NSString::from_str("ru-RU"), NSString::from_str("en-US")]
                } else {
                    vec![NSString::from_str(lang)]
                };
            let langs_arr = NSArray::from_slice(&langs);
            request.setRecognitionLanguages(&langs_arr);
            drop(langs_arr);

            // VNRecognizeTextRequest -> VNRequest: поднимаем тип указателя
            // до суперкласса для performRequests (NOTE(macOS): Retained::into_super).
            let request_any: Retained<VNRequest> = Retained::into_super(request);
            let requests = NSArray::from_slice(std::slice::from_ref(&request_any));
            handler
                .performRequests_error(&requests)
                .map_err(|e| format!("Vision: {e}"))?;

            let observations = request_any.results();
            let mut out = Vec::new();
            for obs in observations.iter() {
                // VNObservation -> VNRecognizedTextObservation
                // (NOTE(macOS): уточнить имя метода downcast в objc2 0.6).
                let text_obs: Option<&VNRecognizedTextObservation> =
                    unsafe { obs.downcast_ref::<VNRecognizedTextObservation>() };
                if let Some(t) = text_obs {
                    let candidates = t.topCandidates(1);
                    if let Some(first) = candidates.first() {
                        out.push(first.string().to_string());
                    }
                }
            }
            Ok(out.join("\n"))
        }
    }

    pub fn available_languages() -> Vec<String> {
        // Vision поддерживает десятки языков; для UI хватает двух основных.
        vec!["ru-RU".to_string(), "en-US".to_string()]
    }
}

/// Распознать текст системным движком по PNG-байтам.
pub fn recognize_system(png: &[u8], lang: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return win_ocr::recognize(png, lang);
    }
    #[cfg(target_os = "macos")]
    {
        return mac_vision::recognize(png, lang);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (png, lang);
        Err("OCR не поддерживается на этой платформе".to_string())
    }
}

/// Список языков системного движка (для выпадающего списка в настройках).
pub fn available_languages() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        return win_ocr::available_languages();
    }
    #[cfg(target_os = "macos")]
    {
        return mac_vision::available_languages();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}
