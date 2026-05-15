// Skill Sandbox — 安全执行 skill 脚本
//
// 职责：
//   - 验证脚本路径（防止路径遍历）
//   - restricted 模式：清理环境变量，仅保留 PATH/HOME
//   - full 模式：继承父进程环境
//   - 强制超时，捕获 stdout/stderr
//   - 输出大小上限 1 MiB，防止内存爆炸
//
// @see src/schemas/skill.schema.json → experimental.scripts

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

// ─── Types ────────────────────────────────────────────

/// 单次脚本输出的字节上限（1 MiB）
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;

/// 沙箱配置（与 skill.json experimental.scripts.*.sandbox 对齐）
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// 沙箱模式: "restricted" | "full"
    pub sandbox_mode: String,
    /// 超时毫秒（默认 30000）
    pub timeout_ms: u64,
    /// 允许的目录列表（skill 目录 + temp 目录）
    pub allowed_dirs: Vec<String>,
    /// 自定义环境变量（JSON 对象格式 {"KEY": "VALUE", ...}）
    pub env_vars: Option<HashMap<String, String>>,
    // NOTE: max_memory_mb 已移除 — Linux cgroup / Windows job object
    // 需要 platform-specific 实现，当前由操作系统 OOM 处理。
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            sandbox_mode: "restricted".into(),
            timeout_ms: 30_000,
            allowed_dirs: Vec::new(),
            env_vars: None,
        }
    }
}

/// 脚本执行结果
#[derive(Debug, Serialize, Clone)]
pub struct SandboxResult {
    /// 进程退出码（None = 被信号终止）
    pub exit_code: Option<i32>,
    /// 标准输出
    pub stdout: String,
    /// 标准错误
    pub stderr: String,
    /// 是否因超时被终止
    pub timed_out: bool,
    /// 执行耗时毫秒
    pub duration_ms: u64,
}

// ─── Path Validation ──────────────────────────────────

/// 验证脚本路径：相对 skill 目录解析，拒绝路径遍历
pub fn validate_script_path(skill_dir: &Path, script_file: &str) -> Result<PathBuf, String> {
    if script_file.contains("..") {
        return Err(format!("path traversal rejected: {}", script_file));
    }

    let p = Path::new(script_file);
    if p.is_absolute() {
        return Err(format!("absolute script path rejected: {}", script_file));
    }

    let resolved = skill_dir.join(script_file);

    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("cannot resolve script path: {}", e))?;

    let skill_dir_canonical = skill_dir
        .canonicalize()
        .map_err(|e| format!("cannot resolve skill dir: {}", e))?;

    if !canonical.starts_with(&skill_dir_canonical) {
        return Err(format!(
            "script escapes skill directory: {}",
            canonical.display()
        ));
    }

    if !canonical.is_file() {
        return Err(format!("script not found: {}", canonical.display()));
    }

    Ok(canonical)
}

// ─── Sandbox Execution ────────────────────────────────

/// 在沙箱中执行脚本
pub async fn execute_in_sandbox(
    config: &SandboxConfig,
    script_path: &Path,
    input: Option<String>,
) -> Result<SandboxResult, String> {
    let interpreter = script_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| match ext {
            "sh" | "bash" => "sh".to_string(),
            "py" => "python3".to_string(),
            "js" => "node".to_string(),
            "ts" => "npx".to_string(),
            _ => read_shebang(script_path).unwrap_or_else(|| {
                script_path.to_str().unwrap_or("./script").to_string()
            }),
        })
        .unwrap_or_else(|| {
            read_shebang(script_path).unwrap_or_else(|| {
                script_path.to_str().unwrap_or("./script").to_string()
            })
        });

    // L4: 验证解释器存在
    if interpreter != "npx" && interpreter != script_path.to_str().unwrap_or("") {
        ensure_interpreter_available(&interpreter)?;
    }

    let mut cmd = if interpreter == "npx" {
        let mut c = Command::new("npx");
        c.arg("tsx").arg(script_path);
        c
    } else if interpreter == script_path.to_str().unwrap_or("") {
        Command::new(script_path)
    } else {
        let mut c = Command::new(&interpreter);
        c.arg(script_path);
        c
    };

    // M2: restricted 模式下限制 PATH（含 Windows）
    if config.sandbox_mode == "restricted" {
        cmd.env_clear();
        #[cfg(not(target_os = "windows"))]
        cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        #[cfg(target_os = "windows")]
        {
            let path = std::env::var("SystemRoot")
                .map(|sr| {
                    format!(
                        "{}\\System32;{}\\System32\\WindowsPowerShell\\v1.0",
                        sr, sr
                    )
                })
                .unwrap_or_default();
            cmd.env("PATH", path);
        }
        // HOME: Unix 用 $HOME，Windows 用 $USERPROFILE（$HOME 通常未设置）
        #[cfg(not(target_os = "windows"))]
        cmd.env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        #[cfg(target_os = "windows")]
        cmd.env(
            "HOME",
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned()),
        );
    }

    // 应用自定义环境变量（覆盖默认值）
    if let Some(ref env_vars) = config.env_vars {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    let start = std::time::Instant::now();
    let duration = Duration::from_millis(config.timeout_ms);

    if let Some(ref data) = input {
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn script: {}", e))?;

        // 写入 stdin
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            stdin
                .write_all(data.as_bytes())
                .await
                .map_err(|e| format!("failed to write stdin: {}", e))?;
            drop(stdin);
        }

        // M4: 在 wait 之前拿走 stdout/stderr ownership，确保超时后仍可读
        let mut child_stdout = child.stdout.take();
        let mut child_stderr = child.stderr.take();

        match timeout(duration, child.wait()).await {
            Ok(Ok(status)) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let stdout = read_limited_output(&mut child_stdout).await;
                let stderr = read_limited_output(&mut child_stderr).await;
                Ok(SandboxResult {
                    exit_code: status.code(),
                    stdout,
                    stderr,
                    timed_out: false,
                    duration_ms,
                })
            }
            Ok(Err(e)) => Err(format!("process wait failed: {}", e)),
            Err(_) => {
                // M4: kill 后仍能读取已缓冲的输出
                let _ = child.kill().await;
                let stdout = read_limited_output(&mut child_stdout).await;
                let stderr = read_limited_output(&mut child_stderr).await;
                let mut combined_stderr = stderr;
                if combined_stderr.is_empty() {
                    combined_stderr = "execution timed out".into();
                } else {
                    combined_stderr.push_str("\nexecution timed out");
                }
                Ok(SandboxResult {
                    exit_code: None,
                    stdout,
                    stderr: combined_stderr,
                    timed_out: true,
                    duration_ms: config.timeout_ms,
                })
            }
        }
    } else {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn script: {}", e))?;

        // M4: 在 wait 之前拿走 stdout/stderr ownership
        let mut child_stdout = child.stdout.take();
        let mut child_stderr = child.stderr.take();

        match timeout(duration, child.wait()).await {
            Ok(Ok(status)) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let stdout = read_limited_output(&mut child_stdout).await;
                let stderr = read_limited_output(&mut child_stderr).await;
                Ok(SandboxResult {
                    exit_code: status.code(),
                    stdout,
                    stderr,
                    timed_out: false,
                    duration_ms,
                })
            }
            Ok(Err(e)) => Err(format!("process wait failed: {}", e)),
            Err(_) => {
                // M4: kill 后仍能读取已缓冲的输出
                let _ = child.kill().await;
                let stdout = read_limited_output(&mut child_stdout).await;
                let stderr = read_limited_output(&mut child_stderr).await;
                let mut combined_stderr = stderr;
                if combined_stderr.is_empty() {
                    combined_stderr = "execution timed out".into();
                } else {
                    combined_stderr.push_str("\nexecution timed out");
                }
                Ok(SandboxResult {
                    exit_code: None,
                    stdout,
                    stderr: combined_stderr,
                    timed_out: true,
                    duration_ms: config.timeout_ms,
                })
            }
        }
    }
}

/// 从 child stdout/stderr 读取字符串，限制最大 1 MiB（M3）
///
/// 使用 `take()` 截断防止恶意脚本输出耗尽内存。
/// 通过 trait object 统一处理 ChildStdout / ChildStderr。
async fn read_limited_output(reader: &mut Option<impl AsyncReadExt + Unpin>) -> String {
    match reader.take() {
        Some(r) => {
            let mut buf = Vec::with_capacity(8192);
            let mut limited = r.take(MAX_OUTPUT_BYTES);
            let _ = limited.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        }
        None => String::new(),
    }
}

/// L4: 验证解释器是否可用，不可用时返回明确错误
fn ensure_interpreter_available(interpreter: &str) -> Result<(), String> {
    // 直接路径检查
    if Path::new(interpreter).exists() {
        return Ok(());
    }

    // 通过 PATH 查找
    let paths = std::env::var("PATH").unwrap_or_default();
    let separator = if cfg!(target_os = "windows") { ';' } else { ':' };

    for dir in paths.split(separator) {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(interpreter);
        if candidate.exists() {
            return Ok(());
        }
        // Windows: 尝试常见扩展名
        #[cfg(target_os = "windows")]
        for ext in &[".exe", ".cmd", ".bat"] {
            if Path::new(dir).join(format!("{}{}", interpreter, ext)).exists() {
                return Ok(());
            }
        }
    }

    Err(format!(
        "interpreter not found: {} — install it or add to PATH",
        interpreter
    ))
}

/// 读取脚本文件的 shebang 行，返回解释器路径
fn read_shebang(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;

    let line = first_line.trim();
    if line.starts_with("#!") {
        let interp = line[2..].trim();
        if let Some(name) = interp.strip_prefix("/usr/bin/env ") {
            return Some(name.split_whitespace().next()?.to_string());
        }
        return Some(interp.split_whitespace().next()?.to_string());
    }
    None
}

// ─── Tests ────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_script_path_rejects_traversal() {
        let skill_dir = PathBuf::from("/tmp/test-skill");
        let result = validate_script_path(&skill_dir, "../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_script_path_rejects_absolute() {
        let skill_dir = PathBuf::from("/tmp/test-skill");
        let result = validate_script_path(&skill_dir, "/etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    #[ignore] // 需要创建临时目录和文件才能通过 canonicalize()
    fn test_validate_script_path_accepts_relative() {
        let skill_dir = PathBuf::from("/tmp/test-skill");
        let script = validate_script_path(&skill_dir, "scripts/run.sh");
        assert!(script.is_ok());
        assert!(!script.unwrap().to_string_lossy().contains("traversal"));
    }
}
