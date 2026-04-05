// Ollama 本地推理引擎进程管理
//
// 内嵌 Ollama 作为 sidecar，应用启动时自动拉起，用户无需单独安装。
// 如果检测到外部 Ollama 已在运行，则直接复用，不启动内嵌实例。
// 架构对标 LM Studio / Jan.ai 的自包含体验。

use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 内嵌 Ollama 进程句柄
static OLLAMA_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// 是否由我们启动的内嵌实例（false = 外部已运行，跳过管理）
static OLLAMA_MANAGED: Mutex<bool> = Mutex::new(false);

/// Ollama 状态，存储在 Tauri 全局状态中
pub struct OllamaState {
    pub ready: Mutex<bool>,
}

impl Default for OllamaState {
    fn default() -> Self {
        Self {
            ready: Mutex::new(false),
        }
    }
}

/// Ollama 默认端口
pub const OLLAMA_PORT: u16 = 11434;

pub fn base_url() -> String {
    format!("http://localhost:{}", OLLAMA_PORT)
}

fn api_tags_url() -> String {
    format!("{}/api/tags", base_url())
}

fn set_ready(app_handle: &tauri::AppHandle, ready: bool) {
    if let Some(state) = app_handle.try_state::<OllamaState>() {
        *state.ready.lock().unwrap_or_else(|e| e.into_inner()) = ready;
    }
}

/// 检查 Ollama 是否就绪
pub fn is_ready(app_handle: &tauri::AppHandle) -> bool {
    app_handle
        .try_state::<OllamaState>()
        .map(|s| *s.ready.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or(false)
}

/// 是否由本应用管理 Ollama 进程
pub fn is_managed() -> bool {
    OLLAMA_MANAGED
        .lock()
        .map(|g| *g)
        .unwrap_or(false)
}

/// 快速检测端口是否已被占用（同步，用于启动前判断）
fn is_port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// 验证 ollama 是否真正健康（能正常加载模型）
///
/// 僵尸 ollama（二进制被删除）可以响应 /api/tags 但无法 fork/exec runner。
/// 因此不仅检查 API 响应，还验证进程的可执行文件是否仍然存在于磁盘上。
fn is_ollama_healthy() -> bool {
    // 1. API 响应检查
    {
        use std::io::{Read, Write};
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], OLLAMA_PORT));
        let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let req = "GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n";
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = [0u8; 32];
        let Ok(n) = stream.read(&mut buf) else { return false };
        let response = String::from_utf8_lossy(&buf[..n]);
        if !(response.starts_with("HTTP/1") && response.contains("200")) {
            return false;
        }
    }

    // 2. 可执行文件存在性检查 — 防止僵尸进程（进程在内存中但二进制已删除）
    #[cfg(unix)]
    {
        let output = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{}", OLLAMA_PORT), "-sTCP:LISTEN", "-t"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    // 获取进程的可执行文件路径
                    let cmd_output = Command::new("ps")
                        .args(["-p", &pid.to_string(), "-o", "command="])
                        .output();
                    if let Ok(cmd_out) = cmd_output {
                        let cmd = String::from_utf8_lossy(&cmd_out.stdout);
                        let exe_path = cmd.trim().split_whitespace().next().unwrap_or("");
                        if !exe_path.is_empty() && !Path::new(exe_path).exists() {
                            log::warn!(
                                "Ollama 进程 PID {} 的可执行文件已不存在: {}",
                                pid, exe_path
                            );
                            return false;
                        }
                    }
                }
            }
        }
    }

    true
}

/// 清理占用 ollama 端口的僵尸进程
fn kill_stale_ollama(port: u16) {
    #[cfg(unix)]
    {
        let output = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    log::info!("清理僵尸 ollama 进程 PID: {}", pid);
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                }
            }
        }
    }
}

// ─── 启动 ────────────────────────────────────────────

/// 启动 Ollama：检测外部实例 → 找不到则启动内嵌二进制
pub fn spawn_ollama(app: &tauri::AppHandle) -> Result<(), String> {
    set_ready(app, false);

    // 1. 检测端口是否被占用
    if is_port_in_use(OLLAMA_PORT) {
        // 验证 ollama 是否真正健康（防止僵尸进程占端口但无法正常服务）
        if is_ollama_healthy() {
            log::info!("检测到外部 Ollama 已运行于端口 {}，直接复用", OLLAMA_PORT);
            set_ready(app, true);
            *OLLAMA_MANAGED.lock().unwrap_or_else(|e| e.into_inner()) = false;
            let _ = app.emit("ollama-ready", true);
            return Ok(());
        }
        // 端口被占用但不健康 — 可能是僵尸 ollama 进程，尝试清理
        log::warn!("端口 {} 被占用但 Ollama 不健康，尝试清理僵尸进程", OLLAMA_PORT);
        kill_stale_ollama(OLLAMA_PORT);
        // 等待端口释放
        std::thread::sleep(Duration::from_secs(1));
    }

    // 2. 查找内嵌二进制（resources/ollama/ 目录，包含 binary + 动态库）
    let binary_name = if cfg!(target_os = "windows") {
        "ollama.exe"
    } else {
        "ollama"
    };

    // 生产模式: Contents/Resources/ollama/
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("获取资源路径失败: {}", e))?;
    let ollama_dir = resource_path.join("ollama");
    let binary_path = ollama_dir.join(binary_name);

    let final_path = if binary_path.exists() {
        binary_path
    } else {
        // 开发模式回退: src-tauri/binaries/ollama-bundle/
        let fallback_dir = resource_path.join("binaries").join("ollama-bundle");
        let fallback = fallback_dir.join(binary_name);
        if !fallback.exists() {
            log::warn!(
                "未找到内嵌 Ollama 二进制: {:?} / {:?}，跳过自动启动",
                ollama_dir.join(binary_name),
                fallback
            );
            return Ok(());
        }
        fallback
    };

    // 3. 启动进程
    spawn_ollama_child(&final_path)?;
    *OLLAMA_MANAGED.lock().unwrap_or_else(|e| e.into_inner()) = true;
    Ok(())
}

/// 启动 Ollama 子进程
fn spawn_ollama_child(path: &std::path::Path) -> Result<(), String> {
    let enriched_path = crate::sidecar::enrich_path();
    let lib_dir = path.parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();

    let mut cmd = Command::new(path);
    cmd.args(["serve"])
        .env("PATH", &enriched_path)
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT));

    // 动态库搜索路径：binary 所在目录（包含 libggml/libmlx 等）
    if cfg!(target_os = "macos") {
        cmd.env("DYLD_LIBRARY_PATH", &lib_dir);
    } else if cfg!(target_os = "linux") {
        cmd.env("LD_LIBRARY_PATH", &lib_dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Ollama 失败: {}", e))?;

    // 等待 500ms 检查是否立即退出
    std::thread::sleep(Duration::from_millis(500));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("检查 Ollama 进程状态失败: {}", e))?
    {
        return Err(format!("Ollama 启动后立即退出: {}", status));
    }

    log::info!("Ollama 已启动, PID: {}, 路径: {:?}", child.id(), path);

    if let Ok(mut guard) = OLLAMA_PROCESS.lock() {
        *guard = Some(child);
    }

    Ok(())
}

// ─── 健康检查 ────────────────────────────────────────

/// 异步等待 Ollama 就绪
pub async fn wait_for_healthy(app_handle: tauri::AppHandle, timeout_secs: u64) {
    let client = reqwest::Client::new();
    let url = api_tags_url();
    let max_attempts = timeout_secs * 2; // 每 500ms 一次

    for _ in 0..max_attempts {
        match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                log::info!("Ollama 就绪: {}", url);
                set_ready(&app_handle, true);
                let _ = app_handle.emit("ollama-ready", true);
                return;
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    log::error!("Ollama 启动超时 ({}s)", timeout_secs);
    set_ready(&app_handle, false);
    let _ = app_handle.emit("ollama-error", "Ollama 启动超时");
}

// ─── 停止 ────────────────────────────────────────────

/// 停止 Ollama 进程（仅在由本应用启动时才停止）
pub fn stop_ollama() {
    if !is_managed() {
        log::info!("Ollama 由外部管理，跳过停止");
        return;
    }

    if let Ok(mut guard) = OLLAMA_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            log::info!("正在停止 Ollama...");
            let _ = child.kill();
            let _ = child.wait();
            log::info!("Ollama 已停止");
        }
    }

    *OLLAMA_MANAGED.lock().unwrap_or_else(|e| e.into_inner()) = false;
}
