//! BUG-20260726-033: native tray labels follow the operating-system language.
//!
//! The native status item is created before Vue/localStorage can be a reliable
//! language source. Chinese system locales use the Chinese set; English and
//! unsupported locales use the English set.

mod support;

use support::{extract_function_body, read_source};

const LABELS: [(&str, &str, &str); 6] = [
    ("open", "Open HexClaw", "打开 HexClaw"),
    ("quick_chat", "Quick Chat…", "快速对话…"),
    ("logs", "Logs", "日志"),
    ("settings", "Settings", "设置"),
    ("about", "About HexClaw", "关于河蟹"),
    ("quit", "Quit HexClaw", "退出 HexClaw"),
];

#[test]
fn bug_20260726_033_tray_has_exact_chinese_and_english_label_sets() {
    let tray = read_source("src/tray.rs");
    let labels = extract_function_body(&tray, "fn labels_for_locale")
        .expect("tray must retain one canonical system-locale label helper");
    let mut missing_ids = Vec::new();
    let mut missing_english = Vec::new();
    let mut missing_chinese = Vec::new();

    for (id, english, chinese) in LABELS {
        if !tray.contains(&format!("MenuItem::with_id(app, \"{id}\"")) {
            missing_ids.push(id);
        }
        if !labels.contains(english) {
            missing_english.push(english);
        }
        if !labels.contains(chinese) {
            missing_chinese.push(chinese);
        }
    }

    assert!(
        missing_ids.is_empty() && missing_english.is_empty() && missing_chinese.is_empty(),
        "BUG-20260726-033 tray label sets incomplete: missing IDs={missing_ids:?}, English={missing_english:?}, Chinese={missing_chinese:?}"
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
