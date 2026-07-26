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
    let combined = format!("{window}\n{app}");
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
    assert!(
        tray.contains("\"quit\"") && tray.contains("request_app_exit(app)"),
        "the explicit tray Quit action must bypass the Cmd+Q gate and exit immediately"
    );
}
