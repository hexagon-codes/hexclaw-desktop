//! BUG-20260726-033: macOS close/quit lifecycle contract.
//!
//! Approved behavior:
//! - red X hides the app and preserves background engines;
//! - first Cmd+Q hides and presents a native lightweight hint;
//! - a second Cmd+Q before 2 seconds exits;
//! - at 2 seconds the gate has expired and the request is a new first press;
//! - the explicit tray Quit action exits immediately.

mod support;

use std::time::Duration;

use support::{extract_function_body, read_source};

#[test]
fn bug_20260726_033_red_x_hides_without_stopping_background_engines() {
    let window = read_source("src/window.rs");
    let body = extract_function_body(&window, "pub fn setup_close_behavior")
        .expect("setup_close_behavior must remain the single main-window close adapter");

    assert!(
        body.contains("WindowEvent::CloseRequested")
            && body.contains("prevent_close")
            && body.contains("hide_app_to_background"),
        "red X must prevent native close and hide the app"
    );
    assert!(
        !body.contains("request_app_exit")
            && !body.contains("stop_sidecar")
            && !body.contains("stop_ollama"),
        "red X must not exit or stop background engines"
    );
}

#[test]
fn bug_20260726_033_first_cmd_q_arms_two_second_native_quit_hint() {
    let window = read_source("src/window.rs");
    let app = read_source("src/lib.rs");
    let menu = read_source("src/menu.rs");
    let combined = format!("{window}\n{app}\n{menu}");
    let mut violations = Vec::new();

    let configured_window = if combined.contains("Duration::from_secs(2)") {
        Some(Duration::from_secs(2))
    } else if combined.contains("Duration::from_millis(2000)") {
        Some(Duration::from_millis(2000))
    } else {
        None
    };

    if configured_window != Some(Duration::from_millis(2000)) {
        violations.push("missing the approved 2-second Cmd+Q confirmation window");
    }
    if !combined.contains("Instant") {
        violations.push("Cmd+Q confirmation must use a monotonic Instant-based gate");
    }

    let has_cmd_q_hint = (combined.contains("Cmd+Q") || combined.contains("⌘Q"))
        && (combined.contains("2 秒") || combined.contains("2 seconds"))
        && combined.contains("notification()");
    if !has_cmd_q_hint {
        violations.push("first Cmd+Q must emit a native hint that states the 2-second window");
    }

    if menu.contains("PredefinedMenuItem::quit") {
        violations.push(
            "Cmd+Q must not use the predefined Quit item that bypasses the lifecycle controller",
        );
    }
    if !(menu.contains("MenuItemBuilder::with_id(\"system_quit\", system_quit_label())")
        && menu.contains(".accelerator(\"CmdOrCtrl+Q\")"))
    {
        violations.push("Cmd+Q must use the system_quit menu item with the approved accelerator");
    }
    let dispatcher = extract_function_body(&menu, "fn dispatch_native_menu_action")
        .expect("app and tray must share one native menu action dispatcher");
    if !(dispatcher.contains("\"system_quit\"")
        && dispatcher.contains("handle_system_quit_request(app)"))
    {
        violations.push("the system_quit menu event must enter the shared SystemQuit controller");
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 Cmd+Q lifecycle contract failed:\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn bug_20260726_033_1999ms_is_second_press_but_2000ms_is_expired() {
    let window = read_source("src/window.rs");
    let app = read_source("src/lib.rs");
    let combined = format!("{window}\n{app}");

    let configured_window = if combined.contains("Duration::from_secs(2)") {
        Duration::from_secs(2)
    } else if combined.contains("Duration::from_millis(2000)") {
        Duration::from_millis(2000)
    } else {
        panic!("production has no 2-second monotonic Cmd+Q gate");
    };

    assert!(
        Duration::from_millis(1999) < configured_window,
        "1999ms must still be inside the second-press window"
    );
    assert!(
        Duration::from_millis(2000) >= configured_window,
        "2000ms must be expired and re-arm as a new first press"
    );
}

#[test]
fn bug_20260726_033_tray_quit_remains_explicit_single_press_exit() {
    let tray = read_source("src/tray.rs");
    let menu = read_source("src/menu.rs");
    let dispatcher = extract_function_body(&menu, "fn dispatch_native_menu_action")
        .expect("app and tray must share one native menu action dispatcher");
    assert!(
        tray.contains("MenuItem::with_id(app, \"quit\"")
            && dispatcher.contains("\"quit\"")
            && dispatcher.contains("request_app_exit(app)"),
        "the explicit tray Quit action must bypass the Cmd+Q gate and exit immediately"
    );
}

#[test]
fn bug_20260726_033_orderly_exit_stops_background_engines_before_app_exit() {
    let window = read_source("src/window.rs");
    let app = read_source("src/lib.rs");
    let shutdown = extract_function_body(&window, "pub fn stop_background_engines")
        .expect("background engine shutdown must have one shared implementation");
    let request_exit = extract_function_body(&window, "pub fn request_app_exit")
        .expect("request_app_exit must remain the orderly exit adapter");

    assert!(
        shutdown.contains("ollama::stop_ollama()")
            && shutdown.contains("sidecar::stop_sidecar()"),
        "the shared shutdown must stop both managed engines"
    );
    assert_eq!(
        request_exit.matches("stop_background_engines();").count(),
        1,
        "request_app_exit must call the shared shutdown exactly once"
    );
    assert!(
        request_exit.find("stop_background_engines();") < request_exit.find("app.exit(0)"),
        "background engines must stop before the Tauri exit request"
    );
    assert!(
        app.contains("WindowEvent::Destroyed if window.label() == \"main\"")
            && app.contains("window::stop_background_engines();"),
        "main-window destruction and explicit exit must share the same shutdown"
    );
}
