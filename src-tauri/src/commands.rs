// Tauri Commands
//
// 前端可通过 invoke() 调用的系统级操作。
// 业务逻辑不放在这里，业务 API 全部走 hexclaw REST API。

use serde::Serialize;
use tauri::Manager;

use crate::sidecar;

/// Sidecar 状态信息
#[derive(Serialize)]
pub struct SidecarStatus {
    /// 是否就绪
    pub ready: bool,
    /// API 基础 URL
    pub base_url: String,
    /// 端口号
    pub port: u16,
}

/// 获取 sidecar 状态
#[tauri::command]
pub fn get_sidecar_status(app: tauri::AppHandle) -> SidecarStatus {
    SidecarStatus {
        ready: sidecar::is_ready(&app),
        base_url: sidecar::base_url(),
        port: sidecar::HEXCLAW_PORT,
    }
}

/// 获取平台信息
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// 平台信息
#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub version: String,
}
