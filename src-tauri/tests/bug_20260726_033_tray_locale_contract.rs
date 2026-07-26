//! BUG-20260726-033: native tray labels follow the operating-system language.
//!
//! The native status item is created before Vue/localStorage can be a reliable
//! language source. Chinese system locales use the Chinese set; English and
//! unsupported locales use the English set.

mod support;

use support::read_source;

const LABELS: [(&str, &str, &str); 5] = [
    ("open", "Open HexClaw", "打开 HexClaw"),
    ("quick_chat", "Quick Chat...", "快速对话..."),
    ("logs", "Logs", "日志"),
    ("settings", "Settings", "设置"),
    ("quit", "Quit HexClaw", "退出 HexClaw"),
];

fn menu_item_constructor<'a>(source: &'a str, id: &str) -> Option<&'a str> {
    let needle = format!("MenuItem::with_id(app, \"{id}\"");
    let start = source.find(&needle)?;
    let open = source[start..].find('(')? + start;
    let bytes = source.as_bytes();
    let mut depth = 1i32;
    let mut cursor = open + 1;

    while cursor < bytes.len() && depth > 0 {
        match bytes[cursor] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        cursor += 1;
    }

    (depth == 0).then(|| &source[start..cursor])
}

#[test]
fn bug_20260726_033_tray_has_exact_chinese_and_english_label_sets() {
    let tray = read_source("src/tray.rs");
    let mut missing_english = Vec::new();
    let mut missing_chinese = Vec::new();

    for (id, english, chinese) in LABELS {
        let constructor = menu_item_constructor(&tray, id)
            .unwrap_or_else(|| panic!("missing MenuItem::with_id constructor for `{id}`"));
        if !constructor.contains(english) {
            missing_english.push(english);
        }
        if !constructor.contains(chinese) {
            missing_chinese.push(chinese);
        }
    }

    assert!(
        missing_english.is_empty() && missing_chinese.is_empty(),
        "BUG-20260726-033 tray label sets incomplete: missing English={missing_english:?}, missing Chinese={missing_chinese:?}"
    );
}

#[test]
fn bug_20260726_033_tray_resolves_zh_en_and_english_fallback_from_system_locale() {
    let tray = read_source("src/tray.rs");
    let mut violations = Vec::new();

    let reads_system_locale = tray.contains("sys_locale")
        || tray.contains("get_locale")
        || tray.contains("AppleLanguages")
        || tray.contains("NSLocale");
    if !reads_system_locale {
        violations.push("tray setup does not read the operating-system locale");
    }
    if !(tray.contains("starts_with(\"zh\")")
        || tray.contains("starts_with('zh')")
        || tray.contains("\"zh-CN\"")
        || tray.contains("\"zh-Hans"))
    {
        violations.push("missing Chinese locale normalization");
    }
    if !(tray.contains("\"en\"") || tray.contains("English")) {
        violations.push("missing English locale mapping");
    }
    if !(tray.contains("fallback") && tray.contains("English")) {
        violations.push("unsupported locale fallback is not explicitly locked to English");
    }
    if tray.contains("hc-locale") || tray.contains("localStorage") {
        violations.push("native tray must not use the frontend localStorage locale");
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 system-locale contract failed:\n  - {}",
        violations.join("\n  - ")
    );
}
