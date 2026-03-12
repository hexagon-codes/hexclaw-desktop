// hexclaw sidecar 进程管理
//
// 负责 hexclaw serve 进程的完整生命周期：
//   - 应用启动时自动启动 hexclaw serve --desktop --port 16060
//   - 周期性健康检查 (GET /health)
//   - 应用退出时优雅关闭进程
//
// 架构对标: Docker Desktop 管理 Docker Engine

use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Sidecar 进程句柄，用于生命周期管理
static SIDECAR_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

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

/// 启动 hexclaw sidecar 进程
///
/// Tauri externalBin 会将 sidecar 放在与主程序同目录 (Contents/MacOS/)。
/// 进程句柄存储在全局静态变量中，供 stop_sidecar 使用。
pub fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let binary_name = if cfg!(target_os = "windows") {
        "hexclaw.exe"
    } else {
        "hexclaw"
    };

    // externalBin 的 sidecar 与主程序在同一目录 (Contents/MacOS/)
    let binary_path = std::env::current_exe()
        .map_err(|e| format!("获取当前程序路径失败: {}", e))?
        .parent()
        .ok_or("无法获取程序所在目录")?
        .join(binary_name);

    if !binary_path.exists() {
        // 开发模式回退：从 resource_dir/binaries 查找
        let resource_path = app
            .path()
            .resource_dir()
            .map_err(|e| format!("获取资源路径失败: {}", e))?;
        let fallback_path = resource_path.join("binaries").join(binary_name);
        if !fallback_path.exists() {
            return Err(format!("sidecar 二进制不存在: {:?} 和 {:?}", binary_path, fallback_path));
        }
        return spawn_child(&fallback_path);
    }

    spawn_child(&binary_path)
}

/// 启动子进程并记录 PID
fn spawn_child(path: &std::path::Path) -> Result<(), String> {
    let child = Command::new(path)
        .args(["serve", "--desktop", "--port", &HEXCLAW_PORT.to_string()])
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {}", e))?;

    log::info!("sidecar 已启动, PID: {}, 路径: {:?}", child.id(), path);

    if let Ok(mut guard) = SIDECAR_PROCESS.lock() {
        *guard = Some(child);
    }

    Ok(())
}

/// 停止 sidecar 进程
///
/// 向 sidecar 进程发送 kill 信号并等待退出。
/// 应在应用退出时调用，确保子进程不会变成孤儿进程。
pub fn stop_sidecar() {
    if let Ok(mut guard) = SIDECAR_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            log::info!("正在停止 sidecar...");
            let _ = child.kill();
            let _ = child.wait();
            log::info!("sidecar 已停止");
        }
    }
}
