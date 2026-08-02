//! BUG-20260523-v2 streaming architecture regression.
//!
//! The former SSE-over-Tauri command was retired. Chat now has one authenticated
//! WebSocket transport, so the regression guard follows the current authority
//! instead of requiring the removed `backend_chat` command.

use std::fs;
use std::path::PathBuf;

#[test]
fn bug_20260523_v2_chat_must_be_websocket_streaming() {
    let commands = fs::read_to_string(PathBuf::from("src/commands.rs")).expect("read commands.rs");
    assert!(!commands.contains("pub async fn backend_chat"));
    assert!(!commands.contains("pub async fn stream_chat"));

    let websocket =
        fs::read_to_string(PathBuf::from("../src/api/websocket.ts")).expect("read websocket.ts");
    assert!(
        websocket.contains("NativeSidecarWebSocket"),
        "BUG-20260523-v2: browser WebSocket must stay behind the native sidecar socket"
    );
    assert!(
        websocket.contains("onmessage"),
        "BUG-20260523-v2: WebSocket transport must consume incremental messages"
    );

    let service = fs::read_to_string(PathBuf::from("../src/services/chatService.ts"))
        .expect("read chatService.ts");
    assert!(service.contains("openWebSocketStream"));
    assert!(service.contains("onChunk"));
}

#[test]
fn bug_20260523_v2_idle_timeout_must_follow_first_reply() {
    let service = fs::read_to_string(PathBuf::from("../src/services/chatService.ts"))
        .expect("read chatService.ts");
    assert!(service.contains("WS_FIRST_REPLY_TIMEOUT_MS = 300_000"));
    assert!(service.contains("WS_INACTIVITY_TIMEOUT_MS = 60_000"));
    assert!(service.contains("if (firstReplyTimer)"));
    assert!(service.contains("inactivityTimer = setTimeout"));
}
