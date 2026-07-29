//! BUG-20260726-033: every approved About entry must reuse one native controller.

mod support;

use support::{extract_between, extract_function_body, occurrences, read_source};

#[test]
fn bug_20260726_033_tray_about_reuses_the_existing_single_about_window() {
    let tray = read_source("src/tray.rs");
    let app_menu = read_source("src/menu.rs");
    let window = read_source("src/window.rs");
    let about_composable = read_source("../src/composables/useAboutWindow.ts");
    let settings = read_source("../src/views/SettingsView.vue");
    let sidebar = read_source("../src/components/layout/Sidebar.vue");
    let mut violations = Vec::new();

    if !tray.contains("MenuItem::with_id(app, \"about\"") {
        violations.push("tray menu is missing the approved `about` item");
    }
    let listener_count =
        occurrences(&app_menu, ".on_menu_event(") + occurrences(&tray, ".on_menu_event(");
    if listener_count != 1 {
        violations.push("app and tray menus must share exactly one global MenuEvent listener");
    }
    if tray.contains(".on_menu_event(") {
        violations.push(
            "TrayIconBuilder::on_menu_event is global and must not register a second listener",
        );
    }
    let dispatcher =
        extract_function_body(&app_menu, "fn dispatch_native_menu_action").unwrap_or_default();
    let about_arm =
        extract_between(&dispatcher, "\"about\" =>", "\"preferences\"").unwrap_or_default();
    if !about_arm.contains("crate::window::open_about(app)") {
        violations.push("the shared dispatcher does not call canonical window::open_about");
    }
    if about_arm.contains("show_main_window") || about_arm.contains("emit(\"navigate\"") {
        violations.push("tray About must not navigate or reveal the main/settings window first");
    }
    if occurrences(&dispatcher, "crate::window::open_about(app)") != 1 {
        violations.push("one native About event must call window::open_about exactly once");
    }
    if occurrences(
        &app_menu,
        "dispatch_native_menu_action(app, event.id().as_ref())",
    ) != 1
    {
        violations.push("the one global listener must delegate once to the canonical dispatcher");
    }

    let native_about_arm =
        extract_between(&app_menu, "\"about\" =>", "\"preferences\" =>").unwrap_or_default();
    if !native_about_arm.contains("crate::window::open_about(app)") {
        violations.push("the top-left native app menu no longer uses window::open_about");
    }
    let open_about = extract_function_body(&window, "pub fn open_about")
        .expect("one canonical window::open_about function must exist");
    if !open_about.contains("get_webview_window(\"about\")")
        || !open_about.contains("WebviewWindowBuilder::new(app, \"about\"")
        || !open_about.contains("WebviewUrl::App(\"/about\".into())")
    {
        violations.push("open_about must focus-or-create the single `about` window at `/about`");
    }
    if !about_composable.contains("invoke('open_about')")
        || !settings.contains("@click=\"openAbout\"")
        || !settings.contains("t('about.learnMore'")
        || !sidebar.contains("@click=\"openAbout\"")
        || !sidebar.contains("HexClaw 0.5.0-beta")
    {
        violations.push(
            "settings Learn more and sidebar version must keep using the shared About composable",
        );
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 shared About contract failed:\n  - {}",
        violations.join("\n  - ")
    );
}
