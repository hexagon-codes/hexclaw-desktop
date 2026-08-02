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
    OLLAMA_MANAGED.lock().map(|g| *g).unwrap_or(false)
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
        let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let req = "GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n";
        if stream.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = [0u8; 32];
        let Ok(n) = stream.read(&mut buf) else {
            return false;
        };
        let response = String::from_utf8_lossy(&buf[..n]);
        if !(response.starts_with("HTTP/1") && response.contains("200")) {
            return false;
        }
    }

    // 2. 可执行文件存在性检查 — 防止僵尸进程（进程在内存中但二进制已删除）
    #[cfg(unix)]
    {
        let output = Command::new("lsof")
            .args([
                "-nP",
                &format!("-iTCP:{}", OLLAMA_PORT),
                "-sTCP:LISTEN",
                "-t",
            ])
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
                        let exe_path = cmd.split_whitespace().next().unwrap_or("");
                        if !exe_path.is_empty() && !Path::new(exe_path).exists() {
                            log::warn!(
                                "Ollama 进程 PID {} 的可执行文件已不存在: {}",
                                pid,
                                exe_path
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

/// 探测系统安装的 ollama 二进制（macOS/Linux 常见安装路径 → which 兜底）
///
/// 系统 ollama（如 Homebrew / 官方安装包）自带完整 runtime，能真正推理；
/// 而 app 内置 bundle 可能缺 llama-server 导致推理 500。因此优先系统运行时。
fn find_system_ollama() -> Option<std::path::PathBuf> {
    #[cfg(not(target_os = "windows"))]
    {
        // 1. 常见安装路径，按序探测
        for candidate in [
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
            "/usr/bin/ollama",
        ] {
            let p = std::path::PathBuf::from(candidate);
            if p.exists() {
                return Some(p);
            }
        }
        // 2. which ollama 兜底
        if let Ok(out) = Command::new("which").arg("ollama").output() {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = stdout.lines().next() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        let p = std::path::PathBuf::from(trimmed);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        // 本 bug 仅 macOS；Windows 暂不探测系统运行时，走内置回退
        None
    }
}

/// 发起一个简单的 HTTP/1.0 请求（原生 TcpStream，不引第三方），返回 (status_code, body)。
///
/// 与 is_ollama_healthy 同风格，用于功能性健康探针，避免为同步路径引入 async runtime。
fn http_request(
    method: &str,
    path: &str,
    json_body: Option<&str>,
    read_timeout: Duration,
) -> Option<(u16, String)> {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], OLLAMA_PORT));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(read_timeout));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let req = match json_body {
        Some(body) => format!(
            "{method} {path} HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
        None => format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    };
    stream.write_all(req.as_bytes()).ok()?;

    let mut raw = Vec::new();
    // 读到 EOF 或超时（超时会返回已读到的部分）
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();

    // 解析状态码
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())?;

    // 分离 body
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();

    Some((status, body))
}

/// 取第一个可用模型名（GET /api/tags → models[0].name）；无模型或失败返回 None。
fn first_available_model() -> Option<String> {
    let (status, body) = http_request("GET", "/api/tags", None, Duration::from_secs(3))?;
    if status != 200 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    parsed
        .get("models")?
        .as_array()?
        .first()?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}

/// 功能性健康检查（best practice）：健康 = 能真正推理，而非仅 API 200。
///
/// 坏的内置 bundle（缺 llama-server）能响应 /api/tags 200 却在推理时 500。
/// 因此先 tags 200 过一遍，再发一个最小推理探针识破坏实例。
fn is_ollama_functional() -> bool {
    // 1. 基础 API + 僵尸进程检查
    if !is_ollama_healthy() {
        return false;
    }

    // 2. 取一个模型名做最小推理探针；取不到（tags 空）则退回 tags 200 的旧判定
    let Some(model) = first_available_model() else {
        log::info!("Ollama tags 为空，无法做推理探针，退回 API 健康判定");
        return true;
    };

    // 3. 最小推理探针 POST /api/generate，短超时
    let probe_body = format!(
        r#"{{"model":{},"prompt":"hi","stream":false,"options":{{"num_predict":1}}}}"#,
        serde_json::Value::String(model.clone())
    );
    match http_request(
        "POST",
        "/api/generate",
        Some(&probe_body),
        Duration::from_secs(10),
    ) {
        Some((200, _)) => true,
        Some((status, body)) => {
            let lower = body.to_lowercase();
            if status >= 500 || lower.contains("llama-server") || lower.contains("binary not found")
            {
                log::warn!(
                    "Ollama 推理探针失败（模型 {}，HTTP {}），判定坏实例（可能内置 bundle 缺 llama-server）",
                    model, status
                );
                false
            } else {
                // 其它非 500 错误（如模型未就绪等）不武断判死，视为可用
                log::info!("Ollama 推理探针返回 HTTP {}，非致命，视为可用", status);
                true
            }
        }
        // 无响应/超时：可能是好实例正在冷加载模型，避免误杀
        None => {
            log::info!("Ollama 推理探针超时，视为正在加载的真实例（保守放行）");
            true
        }
    }
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

    // 0. 优先探测系统安装的 ollama 运行时（自带完整 runtime，能真推理）
    let system = find_system_ollama();
    if let Some(ref p) = system {
        log::info!("检测到系统 Ollama 运行时: {:?}（优先于内置 bundle）", p);
    }

    // 1. 检测端口是否被占用 — 用功能性健康检查识破坏 bundle（能列模型但推理 500）
    if is_port_in_use(OLLAMA_PORT) {
        if is_ollama_functional() {
            log::info!(
                "检测到外部 Ollama 已运行于端口 {} 且可正常推理，直接复用",
                OLLAMA_PORT
            );
            set_ready(app, true);
            *OLLAMA_MANAGED.lock().unwrap_or_else(|e| e.into_inner()) = false;
            let _ = app.emit("ollama-ready", true);
            return Ok(());
        }
        // 端口被占用但推理起不来 — 可能是内置 bundle 缺 llama-server 的坏实例，清理后重启
        log::warn!(
            "端口 {} 被占用但 Ollama 无法正常推理（可能内置 bundle 缺 llama-server），清理后用优选运行时重启",
            OLLAMA_PORT
        );
        kill_stale_ollama(OLLAMA_PORT);
        // 等待端口释放
        std::thread::sleep(Duration::from_secs(1));
    }

    // 2. 选型：系统运行时优先，否则回退内置 bundle
    let (final_path, is_system) = match system {
        Some(p) => (p, true),
        None => {
            // 查找内嵌二进制（resources/ollama/ 目录，包含 binary + 动态库）
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

            if binary_path.exists() {
                (binary_path, false)
            } else {
                // 开发模式回退: src-tauri/binaries/ollama-bundle/
                let fallback_dir = resource_path.join("binaries").join("ollama-bundle");
                let fallback = fallback_dir.join(binary_name);
                if !fallback.exists() {
                    log::warn!(
                        "未找到系统 Ollama，也未找到内嵌二进制: {:?} / {:?}，跳过自动启动",
                        ollama_dir.join(binary_name),
                        fallback
                    );
                    return Ok(());
                }
                (fallback, false)
            }
        }
    };

    // 3. 启动进程（系统运行时不覆盖 DYLD，用自己的 runtime）
    spawn_ollama_child(&final_path, is_system)?;
    *OLLAMA_MANAGED.lock().unwrap_or_else(|e| e.into_inner()) = true;
    Ok(())
}

/// 启动 Ollama 子进程
///
/// `is_system` = true 表示系统安装的 ollama（自带 runtime，不覆盖动态库搜索路径）；
/// false 表示内置 bundle（binary 同目录带 libggml/libmlx 等，需覆盖 DYLD/LD 路径）。
fn spawn_ollama_child(path: &std::path::Path, is_system: bool) -> Result<(), String> {
    let enriched_path = crate::sidecar::enrich_path(None);
    let lib_dir = path
        .parent()
        .unwrap_or(Path::new("."))
        .to_string_lossy()
        .to_string();

    let mut cmd = Command::new(path);
    cmd.args(["serve"])
        .env("PATH", &enriched_path)
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", OLLAMA_PORT));

    // 仅内置 bundle 才覆盖动态库搜索路径：binary 所在目录（包含 libggml/libmlx 等）。
    // 系统 ollama 用自己的 runtime，覆盖 DYLD 反而可能污染其查找。
    if !is_system {
        if cfg!(target_os = "macos") {
            cmd.env("DYLD_LIBRARY_PATH", &lib_dir);
        } else if cfg!(target_os = "linux") {
            cmd.env("LD_LIBRARY_PATH", &lib_dir);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// find_system_ollama 的核心不变量：要么返回 None，要么返回一个真实存在的文件。
    /// 环境无关（无论测试机是否装了 ollama 都成立）。
    #[test]
    fn find_system_ollama_returns_existing_or_none() {
        if let Some(p) = find_system_ollama() {
            assert!(p.exists(), "返回的系统 ollama 路径必须真实存在: {:?}", p);
        }
        // 未装系统 ollama 时返回 None，属于合法降级。
    }

    /// first_available_model 返回 Some 时必须非空模型名。
    #[test]
    fn first_available_model_is_nonempty_when_present() {
        if let Some(name) = first_available_model() {
            assert!(!name.is_empty(), "模型名不应为空");
        }
    }
}
