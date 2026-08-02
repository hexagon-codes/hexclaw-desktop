//! BUG-20260523 transport timeout regression.
//!
//! The original regression guarded a Tauri HTTP chat command. That command was
//! intentionally removed when chat converged on one authenticated WebSocket.
//! The durable invariant is now: no native HTTP chat fallback, a generous first
//! reply budget, and a short post-first-chunk inactivity budget.

use std::fs;
use std::path::PathBuf;

#[test]
fn bug_20260523_chat_uses_one_websocket_with_split_timeout_budgets() {
    let commands_path = PathBuf::from("src/commands.rs");
    let commands = fs::read_to_string(&commands_path).expect("read commands.rs");
    for retired in ["pub async fn backend_chat", "pub async fn stream_chat"] {
        assert!(
            !commands.contains(retired),
            "BUG-20260523: retired native HTTP chat command returned: {retired}"
        );
    }

    let lib_path = PathBuf::from("src/lib.rs");
    let lib = fs::read_to_string(&lib_path).expect("read lib.rs");
    for retired in ["commands::backend_chat", "commands::stream_chat"] {
        assert!(
            !lib.contains(retired),
            "BUG-20260523: retired native HTTP chat command was registered: {retired}"
        );
    }

    let service_path = PathBuf::from("../src/services/chatService.ts");
    let service = fs::read_to_string(&service_path).expect("read chatService.ts");
    assert!(
        service.contains("WS_FIRST_REPLY_TIMEOUT_MS = 300_000"),
        "BUG-20260523: first WebSocket reply budget must remain 300 seconds"
    );
    assert!(
        service.contains("WS_INACTIVITY_TIMEOUT_MS = 60_000"),
        "BUG-20260523: post-first-chunk inactivity budget must remain 60 seconds"
    );
    assert!(
        service.contains("NativeSidecarWebSocket"),
        "BUG-20260523: chat must remain on the authenticated native WebSocket boundary"
    );
}
