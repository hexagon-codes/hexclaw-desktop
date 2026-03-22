// hexclaw sidecar 进程管理
//
// 负责 hexclaw serve 进程的完整生命周期：
//   - 应用启动时自动启动 hexclaw serve --desktop (默认端口 16060)
//   - 周期性健康检查 (GET /health)
//   - 应用退出时优雅关闭进程
//
// 架构对标: Docker Desktop 管理 Docker Engine

use std::path::Path;
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

fn set_ready(app_handle: &tauri::AppHandle, ready: bool) {
    if let Some(state) = app_handle.try_state::<SidecarState>() {
        *state.ready.lock().unwrap_or_else(|e| e.into_inner()) = ready;
    }
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
        match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                log::info!("hexclaw sidecar 就绪: {}", url);
                set_ready(&app_handle, true);
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
    set_ready(&app_handle, false);
    let _ = app_handle.emit("sidecar-error", "启动超时");
}

/// 检查 sidecar 是否就绪
pub fn is_ready(app_handle: &tauri::AppHandle) -> bool {
    app_handle
        .try_state::<SidecarState>()
        .map(|s| *s.ready.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or(false)
}

/// 启动 hexclaw sidecar 进程
///
/// Tauri externalBin 会将 sidecar 放在与主程序同目录 (Contents/MacOS/)。
/// 进程句柄存储在全局静态变量中，供 stop_sidecar 使用。
pub fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    set_ready(app, false);

    if let Err(err) = ensure_desktop_knowledge_enabled() {
        log::warn!("准备桌面知识库配置失败: {}", err);
    }

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
            return Err(format!(
                "sidecar 二进制不存在: {:?} 和 {:?}",
                binary_path, fallback_path
            ));
        }
        ensure_port_available(HEXCLAW_PORT)?;
        return spawn_child(&fallback_path);
    }

    ensure_port_available(HEXCLAW_PORT)?;
    spawn_child(&binary_path)
}

/// 启动子进程并记录 PID
fn spawn_child(path: &std::path::Path) -> Result<(), String> {
    let mut child = Command::new(path)
        .args(["serve", "--desktop"])
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {}", e))?;

    std::thread::sleep(Duration::from_millis(300));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("检查 sidecar 进程状态失败: {}", e))?
    {
        return Err(format!("sidecar 启动后立即退出: {}", status));
    }

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

fn ensure_port_available(port: u16) -> Result<(), String> {
    let current_pid = std::process::id();

    for pid in listener_pids(port)? {
        if pid == current_pid {
            continue;
        }

        let command = process_command(pid)?.unwrap_or_default();
        if !is_hexclaw_sidecar_command(&command) {
            return Err(format_port_conflict_error(port, pid, &command));
        }

        log::warn!(
            "检测到残留 hexclaw sidecar 占用端口 {}，准备清理。PID: {}, Command: {}",
            port,
            pid,
            command
        );
        terminate_process(pid)?;
    }

    Ok(())
}

fn format_port_conflict_error(port: u16, pid: u32, command: &str) -> String {
    let details = if command.trim().is_empty() {
        "unknown".to_string()
    } else {
        command.trim().to_string()
    };
    format!(
        "端口 {} 已被其他进程占用，无法启动 HexClaw sidecar。PID: {}，Command: {}",
        port, pid, details
    )
}

fn is_hexclaw_sidecar_command(command: &str) -> bool {
    let executable = command.split_whitespace().next().unwrap_or_default();
    executable_basename(executable) == "hexclaw"
}

fn executable_basename(executable: &str) -> String {
    Path::new(executable)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn ensure_desktop_knowledge_enabled() -> Result<(), String> {
    let config_path = desktop_config_path()?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败 ({}): {}", parent.display(), e))?;
    }

    let existing = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => {
            return Err(format!(
                "读取配置文件失败 ({}): {}",
                config_path.display(),
                err
            ))
        }
    };

    let (next, changed) = ensure_knowledge_enabled_yaml(&existing);
    if !changed {
        return Ok(());
    }

    std::fs::write(&config_path, next)
        .map_err(|e| format!("写入配置文件失败 ({}): {}", config_path.display(), e))?;
    log::info!("桌面模式已确保知识库默认启用: {}", config_path.display());
    Ok(())
}

fn desktop_config_path() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("无法确定用户主目录")?;

    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME").ok_or("无法确定用户主目录")?;

    Ok(std::path::PathBuf::from(home)
        .join(".hexclaw")
        .join("hexclaw.yaml"))
}

fn ensure_knowledge_enabled_yaml(content: &str) -> (String, bool) {
    if content.trim().is_empty() {
        return ("knowledge:\n  enabled: true\n".to_string(), true);
    }

    let normalized = content.replace("\r\n", "\n");
    let mut lines = normalized
        .lines()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>();

    let knowledge_idx = lines
        .iter()
        .position(|line| is_top_level_key(line, "knowledge"));
    let Some(start_idx) = knowledge_idx else {
        let mut next = normalized.trim_end_matches('\n').to_string();
        next.push_str("\n\nknowledge:\n  enabled: true\n");
        return (next, true);
    };

    let mut block_end = lines.len();
    for (idx, line) in lines.iter().enumerate().skip(start_idx + 1) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            block_end = idx;
            break;
        }
    }

    for line in lines.iter_mut().take(block_end).skip(start_idx + 1) {
        if let Some(next) = rewrite_enabled_line(line) {
            let changed = next != *line;
            if changed {
                *line = next;
            }
            return (join_yaml_lines(&lines), changed);
        }
    }

    lines.insert(start_idx + 1, "  enabled: true".to_string());
    (join_yaml_lines(&lines), true)
}

fn is_top_level_key(line: &str, key: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let body = line
        .split_once('#')
        .map_or(line, |(head, _)| head)
        .trim_end();
    body == format!("{key}:")
}

fn rewrite_enabled_line(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || !trimmed.starts_with("enabled:") {
        return None;
    }

    let indent_len = line.len() - trimmed.len();
    let indent = &line[..indent_len];
    let (body, comment) = match line.find('#') {
        Some(idx) => (&line[..idx], Some(&line[idx..])),
        None => (line, None),
    };
    let value = body
        .trim_start()
        .strip_prefix("enabled:")
        .unwrap_or_default()
        .trim();

    if value == "true" {
        return Some(line.to_string());
    }

    let mut next = format!("{indent}enabled: true");
    if let Some(comment) = comment {
        next.push(' ');
        next.push_str(comment.trim_start());
    }
    Some(next)
}

fn join_yaml_lines(lines: &[String]) -> String {
    let mut joined = lines.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

fn parse_pid_list(stdout: &str) -> Vec<u32> {
    stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(unix)]
fn listener_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|e| format!("执行 lsof 失败: {}", e))?;

    if output.status.success() {
        return Ok(parse_pid_list(&String::from_utf8_lossy(&output.stdout)));
    }

    if output.status.code() == Some(1) {
        return Ok(Vec::new());
    }

    Err(format!(
        "查询端口监听进程失败: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(target_os = "windows")]
fn listener_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|e| format!("执行 netstat 失败: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "查询端口监听进程失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let needle = format!(":{}", port);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();

    for line in stdout.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }
        if columns[1].ends_with(&needle) && columns[3].eq_ignore_ascii_case("LISTENING") {
            if let Ok(pid) = columns[4].parse::<u32>() {
                pids.push(pid);
            }
        }
    }

    Ok(pids)
}

#[cfg(unix)]
fn process_command(pid: u32) -> Result<Option<String>, String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|e| format!("读取进程信息失败: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }

    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if command.is_empty() {
        Ok(None)
    } else {
        Ok(Some(command))
    }
}

#[cfg(target_os = "windows")]
fn process_command(pid: u32) -> Result<Option<String>, String> {
    let output = Command::new("wmic")
        .args([
            "process",
            "where",
            &format!("processid={}", pid),
            "get",
            "CommandLine",
            "/value",
        ])
        .output()
        .map_err(|e| format!("读取进程信息失败: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let command = stdout
        .lines()
        .find_map(|line| line.strip_prefix("CommandLine="))
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if command.is_empty() {
        Ok(None)
    } else {
        Ok(Some(command))
    }
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> Result<(), String> {
    send_unix_signal(pid, "-TERM")?;
    if wait_for_process_exit(pid, Duration::from_secs(3))? {
        return Ok(());
    }

    log::warn!(
        "hexclaw sidecar PID {} 未在 TERM 后退出，升级为 KILL。",
        pid
    );
    send_unix_signal(pid, "-KILL")?;
    if wait_for_process_exit(pid, Duration::from_secs(2))? {
        return Ok(());
    }

    Err(format!("无法结束占用端口的残留 sidecar 进程 PID {}", pid))
}

#[cfg(unix)]
fn send_unix_signal(pid: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()
        .map_err(|e| format!("发送 {} 失败: {}", signal, e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("发送 {} 失败，PID {}", signal, pid))
    }
}

#[cfg(target_os = "windows")]
fn terminate_process(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("结束残留 sidecar 失败: {}", e))?;

    if !status.success() {
        return Err(format!("结束残留 sidecar 失败，PID {}", pid));
    }

    Ok(())
}

#[cfg(unix)]
fn wait_for_process_exit(pid: u32, timeout: Duration) -> Result<bool, String> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_exists(pid)? {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Ok(!process_exists(pid)?)
}

#[cfg(unix)]
fn process_exists(pid: u32) -> Result<bool, String> {
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map_err(|e| format!("检查进程状态失败: {}", e))?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_knowledge_enabled_yaml, executable_basename, format_port_conflict_error,
        is_hexclaw_sidecar_command, parse_pid_list,
    };

    #[test]
    fn parse_pid_list_ignores_invalid_lines() {
        let pids = parse_pid_list("1450\n\nabc\n2048\n");
        assert_eq!(pids, vec![1450, 2048]);
    }

    #[test]
    fn detect_hexclaw_sidecar_command_from_full_path() {
        assert!(is_hexclaw_sidecar_command(
            "/Applications/HexClaw.app/Contents/MacOS/hexclaw serve --desktop"
        ));
        assert!(!is_hexclaw_sidecar_command(
            "/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop"
        ));
    }

    #[test]
    fn executable_basename_is_case_insensitive() {
        assert_eq!(
            executable_basename("/Applications/HexClaw.app/Contents/MacOS/HexClaw"),
            "hexclaw"
        );
    }

    #[test]
    fn port_conflict_error_includes_pid_and_command() {
        let message = format_port_conflict_error(16060, 1450, "/usr/bin/python3 server.py");
        assert!(message.contains("16060"));
        assert!(message.contains("1450"));
        assert!(message.contains("/usr/bin/python3 server.py"));
    }

    #[test]
    fn ensure_knowledge_enabled_yaml_creates_minimal_config_when_empty() {
        let (next, changed) = ensure_knowledge_enabled_yaml("");
        assert!(changed);
        assert_eq!(next, "knowledge:\n  enabled: true\n");
    }

    #[test]
    fn ensure_knowledge_enabled_yaml_appends_block_when_missing() {
        let (next, changed) = ensure_knowledge_enabled_yaml("server:\n  port: 16060\n");
        assert!(changed);
        assert!(next.contains("server:\n  port: 16060\n\nknowledge:\n  enabled: true\n"));
    }

    #[test]
    fn ensure_knowledge_enabled_yaml_flips_false_to_true_without_rewriting_all() {
        let input = "server:\n  port: 16060\nknowledge:\n  enabled: false\n  top_k: 3\n";
        let (next, changed) = ensure_knowledge_enabled_yaml(input);
        assert!(changed);
        assert!(next.contains("knowledge:\n  enabled: true\n  top_k: 3\n"));
    }

    #[test]
    fn ensure_knowledge_enabled_yaml_keeps_existing_true_value() {
        let input = "knowledge:\n  enabled: true\n";
        let (next, changed) = ensure_knowledge_enabled_yaml(input);
        assert!(!changed);
        assert_eq!(next, input);
    }
}
