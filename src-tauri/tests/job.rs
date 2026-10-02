//! Интеграционные тесты джобы захвата. Манифест для этого таргета
//! встраивается в build.rs (comctl32 v6 нужен для TaskDialogIndirect).

use snipcast_lib::data::AppConfig;
use snipcast_lib::screenshot::{finalize_job, CaptureJob};

/// Финализация джобы на готовом кадре: файл по шаблону,
/// OCR через PaddleOCR (модели должны быть скачаны), защита от перезаписи.
///
/// Картинка: переменная окружения SNIPCAST_OCR_TEST_IMAGE или фикчер с тёмным
/// скриншотом (реальный регресс-кейс пользователя). Запуск:
/// `cargo test --release -- --ignored --nocapture --test job finalize_job`
#[test]
#[ignore]
fn finalize_job_saves_and_recognizes() {
    let img_path = std::env::var("SNIPCAST_OCR_TEST_IMAGE")
        .unwrap_or_else(|_| "tests/fixtures/ocr-sample-dark.png".to_string());
    let img = image::open(&img_path)
        .unwrap_or_else(|e| panic!("тестовая картинка {img_path} не открылась: {e}"))
        .to_rgba8();
    println!("образец: {img_path} ({}×{})", img.width(), img.height());

    let mut tmp = std::env::temp_dir();
    tmp.push(format!("snipcast-job-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();

    // Качество моделей переопределяется окружением: SNIPCAST_OCR_QUALITY=server
    // прогоняет тест на серверном пакете (для сравнения с mobile).
    let cfg = AppConfig {
        screenshot_save_dir: tmp.to_string_lossy().into_owned(),
        screenshot_ocr_engine: "paddle".to_string(),
        screenshot_ocr_quality: std::env::var("SNIPCAST_OCR_QUALITY").unwrap_or_default(),
        ..Default::default()
    };
    let job = CaptureJob {
        name: Some("job test {n}".to_string()),
        ocr: true,
        ..Default::default()
    };

    let res = finalize_job(None, &cfg, &job, img.clone(), (0, 0, img.width(), img.height()), 7)
        .expect("finalize_job");
    println!("path: {}", res.path);
    println!("text ({} мс):\n{}", res.ms, res.text.as_deref().unwrap_or(""));
    assert!(std::path::Path::new(&res.path).is_file(), "файл не создан");
    assert!(res.path.contains("job test 7"), "шаблон имени не применился");
    let text = res.text.expect("ocr текста нет");
    // Ассерт мягкий (непустой результат): качество оцениваем глазами по выводу
    // выше — строгие «должно содержать слово X» ломаются на каждом новом
    // образце, а печатный текст и есть цель этого теста.
    assert!(
        !text.trim().is_empty(),
        "OCR вернул пустой текст на {img_path}"
    );

    // Повторная запись с тем же шаблоном и seq → « (2)».
    let res2 = finalize_job(None, &cfg, &job, img, (0, 0, 10, 10), 7).expect("второй прогон");
    assert!(res2.path.contains("(2)"), "нет защиты от перезаписи: {}", res2.path);

    let _ = std::fs::remove_dir_all(&tmp);
}
