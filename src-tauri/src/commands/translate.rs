use serde::{Deserialize, Serialize};
pub fn chunks(text: &str) -> Vec<String> {
    let mut chunks = vec![];
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(500);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        if end < rest.len() {
            if let Some((i, c)) = rest[..end]
                .char_indices()
                .rev()
                .find(|(_, c)| matches!(c, '.' | '!' | '?' | '\n' | ' '))
            {
                if i > 0 {
                    end = i + c.len_utf8();
                }
            }
        }
        chunks.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    chunks
}
const LANGUAGES: [&str; 13] = [
    "ru", "en", "de", "fr", "es", "it", "pt", "zh-CN", "ja", "ko", "uk", "tr", "pl",
];
fn known_language(code: &str) -> bool {
    LANGUAGES.contains(&code)
}
pub fn validate_pair(source: &str, target: &str) -> Result<(), String> {
    if !known_language(target) || (source != "auto" && !known_language(source)) {
        return Err("Выберите язык перевода".into());
    }
    Ok(())
}
pub fn guess_source(text: &str) -> &'static str {
    let mut cyr = 0i32;
    let mut lat = 0i32;
    let mut kana = 0i32;
    let mut hang = 0i32;
    let mut han = 0i32;
    let mut uk = false;
    for c in text.chars() {
        let code = c as u32;
        if matches!(c, 'і' | 'ї' | 'є' | 'ґ' | 'І' | 'Ї' | 'Є' | 'Ґ') {
            uk = true;
            cyr += 1;
        } else if (0x0400..=0x04FF).contains(&code) {
            cyr += 1;
        } else if c.is_ascii_alphabetic() || (0x00C0..=0x024F).contains(&code) {
            lat += 1;
        } else if (0x3040..=0x30FF).contains(&code) {
            kana += 1;
        } else if (0xAC00..=0xD7AF).contains(&code) {
            hang += 1;
        } else if (0x4E00..=0x9FFF).contains(&code) {
            han += 1;
        }
    }
    let ranked = [
        (hang, "ko"),
        (kana, "ja"),
        (han, "zh-CN"),
        (cyr, if uk { "uk" } else { "ru" }),
        (lat, "en"),
    ];
    let mut best = "en";
    let mut seen = 0;
    for (count, name) in ranked {
        if count > seen {
            seen = count;
            best = name;
        }
    }
    best
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub input: String,
    pub output: String,
    pub source: String,
    pub target: String,
    pub at: i64,
}
pub fn push_memory(mut items: Vec<Memory>, entry: Memory) -> Vec<Memory> {
    if items
        .first()
        .map(|item| item.input == entry.input && item.output == entry.output)
        .unwrap_or(false)
    {
        return items;
    }
    items.insert(0, entry);
    items.truncate(10);
    items
}
fn memory_path() -> std::path::PathBuf {
    crate::data::snipcast_base_dir().join("translation-history.json")
}
fn load_memory() -> Vec<Memory> {
    std::fs::read(memory_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn save_memory(items: &[Memory]) -> Result<(), String> {
    let path = memory_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_vec(items).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn snipcast_translation_history() -> Vec<Memory> {
    load_memory()
}
#[tauri::command]
pub fn snipcast_translation_remember(
    input: String,
    output: String,
    source: String,
    target: String,
) -> Result<Vec<Memory>, String> {
    let entry = Memory {
        input,
        output,
        source,
        target,
        at: chrono::Utc::now().timestamp_millis(),
    };
    let items = push_memory(load_memory(), entry);
    save_memory(&items)?;
    Ok(items)
}
struct PairError {
    retryable: bool,
    message: String,
}
async fn translate_pair(
    client: &reqwest::Client,
    text: &str,
    source: &str,
    target: &str,
) -> Result<String, PairError> {
    let mut result = String::new();
    for part in chunks(text) {
        if part.trim().is_empty() {
            result.push_str(&part);
            continue;
        }
        let mut url = reqwest::Url::parse("https://api.mymemory.translated.net/get").unwrap();
        url.query_pairs_mut()
            .append_pair("q", part.trim())
            .append_pair("langpair", &format!("{source}|{target}"));
        let value: serde_json::Value = client
            .get(url)
            .send()
            .await
            .map_err(|_| PairError {
                retryable: false,
                message: "Сервис перевода недоступен. Проверьте подключение".into(),
            })?
            .error_for_status()
            .map_err(|e| PairError {
                retryable: false,
                message: format!("Ошибка сервиса перевода: {e}"),
            })?
            .json()
            .await
            .map_err(|_| PairError {
                retryable: false,
                message: "Некорректный ответ сервиса".into(),
            })?;
        let quota = value["quotaFinished"].as_bool() == Some(true);
        let status = value["responseStatus"].as_i64();
        if quota || status != Some(200) {
            return Err(PairError {
                retryable: !quota && status != Some(200),
                message: value["responseDetails"]
                    .as_str()
                    .unwrap_or("Лимит перевода исчерпан или сервис недоступен")
                    .into(),
            });
        }
        let translated = value["responseData"]["translatedText"]
            .as_str()
            .ok_or_else(|| PairError {
                retryable: false,
                message: "Перевод отсутствует".into(),
            })?;
        let lead = part.len() - part.trim_start().len();
        let tail = part.trim_end().len();
        result.push_str(&part[..lead]);
        result.push_str(translated);
        result.push_str(&part[tail..]);
    }
    Ok(result)
}
pub async fn run(text: String, source: String, target: String) -> Result<String, String> {
    validate_pair(&source, &target)?;
    if text.chars().count() > 5000 {
        return Err("Не более 5 000 символов за перевод".into());
    }
    if source != "auto" && source == target {
        return Ok(text);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let pair = if source == "auto" {
        "autodetect"
    } else {
        source.as_str()
    };
    match translate_pair(&client, &text, pair, &target).await {
        Ok(value) => Ok(value),
        Err(err) if source == "auto" && err.retryable => {
            let guessed = guess_source(&text);
            if guessed == target {
                Ok(text)
            } else {
                translate_pair(&client, &text, guessed, &target)
                    .await
                    .map_err(|retry| retry.message)
            }
        }
        Err(err) => Err(err.message),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_chunks() {
        let t = "Привет мир.\n".repeat(200);
        let p = chunks(&t);
        assert_eq!(p.concat(), t);
        assert!(p.iter().all(|s| s.len() <= 500));
    }
    #[test]
    fn auto_source_is_allowed_and_unknown_is_not() {
        assert!(validate_pair("auto", "ru").is_ok());
        assert!(validate_pair("en", "ru").is_ok());
        assert!(validate_pair("auto", "auto").is_err());
        assert!(validate_pair("xx", "ru").is_err());
    }
    #[test]
    fn script_guess_matches_the_palette() {
        assert_eq!(guess_source("Привет"), "ru");
        assert_eq!(guess_source("Київ"), "uk");
        assert_eq!(guess_source("こんにちは"), "ja");
        assert_eq!(guess_source("안녕"), "ko");
        assert_eq!(guess_source("你好"), "zh-CN");
        assert_eq!(guess_source("Hello"), "en");
    }
    #[test]
    fn memory_keeps_ten_newest_and_skips_duplicate() {
        let mut items = vec![];
        for i in 0..12 {
            items = push_memory(
                items,
                Memory {
                    input: format!("in{i}"),
                    output: format!("out{i}"),
                    source: "en".into(),
                    target: "ru".into(),
                    at: i,
                },
            );
        }
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].input, "in11");
        assert_eq!(items[9].input, "in2");
        let again = push_memory(
            items.clone(),
            Memory {
                input: "in11".into(),
                output: "out11".into(),
                source: "en".into(),
                target: "ru".into(),
                at: 99,
            },
        );
        assert_eq!(again, items);
    }
}
