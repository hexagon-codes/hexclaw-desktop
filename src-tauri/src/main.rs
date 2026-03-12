// HexClaw Desktop — 应用入口
//
// 企业级安全个人 AI Agent 桌面客户端
// 技术栈: Tauri v2 + Vue 3 + hexclaw (Go sidecar)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hexclaw_desktop_lib::run();
}
