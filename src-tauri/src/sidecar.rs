// hexclaw sidecar 进程管理
//
// 负责 hexclaw serve 进程的完整生命周期：
//   - 应用启动时自动启动 hexclaw serve --desktop --port 16060
//   - 周期性健康检查 (GET /health)
//   - 应用退出时优雅关闭进程
//
// 架构对标: Docker Desktop 管理 Docker Engine

use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// Sidecar 状态，存储在 Tauri 全局状态中
pub struct SidecarState {
    /// hexclaw 进程是否就绪
    pub ready: Mutex<bool>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            ready: Mutex::new(false),
        }
    }
}

/// hexclaw serve 的端口
pub const HEXCLAW_PORT: u16 = 16060;

/// hexclaw API 基础 URL
pub fn base_url() -> String {
    format!("http://localhost:{}", HEXCLAW_PORT)
}

/// 健康检查 URL
pub fn health_url() -> String {
    format!("{}/health", base_url())
}

/// 等待 hexclaw 就绪
///
/// 轮询 /health 端点，最多等待 timeout_secs 秒。
/// 就绪后更新全局状态。
pub async fn wait_for_healthy(app_handle: tauri::AppHandle, timeout_secs: u64) {
    let client = reqwest::Client::new();
    let url = health_url();
    let max_attempts = timeout_secs * 2; // 每 500ms 检查一次

    for _ in 0..max_attempts {
        match client.get(&url).timeout(Duration::from_secs(2)).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("hexclaw sidecar 就绪: {}", url);
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    *state.ready.lock().unwrap() = true;
                }
                // 通知前端 sidecar 已就绪
                let _ = app_handle.emit("sidecar-ready", true);
                return;
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    log::error!("hexclaw sidecar 启动超时 ({}s)", timeout_secs);
    let _ = app_handle.emit("sidecar-error", "启动超时");
}

/// 检查 sidecar 是否就绪
pub fn is_ready(app_handle: &tauri::AppHandle) -> bool {
    app_handle
        .try_state::<SidecarState>()
        .map(|s| *s.ready.lock().unwrap())
        .unwrap_or(false)
}
