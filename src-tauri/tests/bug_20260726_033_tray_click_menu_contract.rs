//! BUG-20260726-033: left and right tray clicks open the same native menu.
//!
//! There is one menu and one tray icon. A left click must not independently
//! show/focus the main window; choosing the `open` menu item is the only path.

mod support;

use support::{extract_between, extract_function_body, occurrences, read_source};

fn without_whitespace(source: &str) -> String {
    source
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

#[test]
fn bug_20260726_033_left_and_right_click_share_one_native_menu() {
    let tray = read_source("src/tray.rs");
    let mut violations = Vec::new();

    if occurrences(&tray, "Menu::with_items") != 1 {
        violations.push("tray must construct exactly one native Menu");
    }
    if occurrences(&tray, "TrayIconBuilder::new") != 1 {
        violations.push("tray must construct exactly one TrayIconBuilder");
    }
    if occurrences(&tray, ".menu(&menu)") != 1 {
        violations.push("the one tray icon must bind the one shared menu exactly once");
    }
    if !tray.contains(".show_menu_on_left_click(true)") {
        violations.push("left click must ask Tauri to show the bound native menu");
    }
    if tray.contains(".popup(") || tray.contains("ContextMenu") {
        violations.push("manual popup/second context-menu paths are forbidden");
    }
    if occurrences(&tray, "MenuItem::with_id(app,") != 6 {
        violations.push("tray must construct exactly the six approved business items");
    }
    if occurrences(&tray, "PredefinedMenuItem::separator(app)") != 2 {
        violations.push("tray must construct exactly two separators");
    }
    let normalized = without_whitespace(&tray);
    if !normalized.contains(
        "Menu::with_items(app,&[&open,&separator1,&quick_chat,&logs,&settings,&about,&separator2,&quit,]",
    ) {
        violations.push(
            "tray exact structure must be open/separator/quick_chat/logs/settings/about/separator/quit",
        );
    }

    if let Some(click_handler) = extract_between(&tray, ".on_tray_icon_event", ".build(app)") {
        if click_handler.contains("MouseButton::Left") && click_handler.contains("show_main_window")
        {
            violations.push("left click still opens the main window directly");
        }
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 shared tray-menu contract failed:\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn bug_20260726_033_open_is_the_only_menu_action_that_opens_main_window() {
    let tray = read_source("src/tray.rs");
    let app_menu = read_source("src/menu.rs");

    for id in ["open", "quick_chat", "logs", "settings", "about", "quit"] {
        assert!(
            tray.contains(&format!("\"{id}\"")),
            "approved tray menu item `{id}` was removed"
        );
    }

    assert_eq!(
        occurrences(&app_menu, ".on_menu_event(") + occurrences(&tray, ".on_menu_event("),
        1,
        "app and tray menus must share exactly one process-wide MenuEvent dispatcher"
    );
    let menu_handler = extract_function_body(&app_menu, "fn dispatch_native_menu_action")
        .expect("native menus must retain one canonical menu action dispatcher");

    assert!(
        menu_handler.contains("\"open\"") && menu_handler.contains("show_main_window(app)"),
        "the `open` menu item must remain the explicit main-window entry"
    );
}
