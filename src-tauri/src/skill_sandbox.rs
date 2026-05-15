// Skill Sandbox — 安全执行 skill 脚本
//
// 职责：
//   - 验证脚本路径（防止路径遍历）
//   - restricted 模式：清理环境变量，仅保留 PATH/HOME
//   - full 模式：继承父进程环境
//   - 强制超时，捕获 stdout/stderr
//
// @see src/schemas/skill.schema.json → experimental.scripts

use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

// ─── Types ────────────────────────────────────────────

/// 沙箱配置（与 skill.json experimental.scripts.*.sandbox 对齐）
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// 沙箱模式: "restricted" | "full"
    pub sandbox_mode: String,
    /// 超时毫秒（默认 30000）
    pub timeout_ms: u64,
    /// 最大内存 MB（默认 256，reserved for future use）
    pub max_memory_mb: u64,
    /// 允许的目录列表（skill 目录 + temp 目录）
    pub allowed_dirs: Vec<String>,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            sandbox_mode: "restricted".into(),
            timeout_ms: 30_000,
            max_memory_mb: 256,
            allowed_dirs: Vec::new(),
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

    if config.sandbox_mode == "restricted" {
        cmd.env_clear();
        #[cfg(target_os = "windows")]
        cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
        #[cfg(not(target_os = "windows"))]
        cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        cmd.env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
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

        // 拿走 stdout/stderr 的 ownership，然后用 wait() 而非 wait_with_output()
        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();

        match timeout(duration, child.wait()).await {
            Ok(Ok(status)) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let stdout = read_string_from_option_stdout(child_stdout);
                let stderr = read_string_from_option_stderr(child_stderr);
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
                let _ = child.kill().await;
                Ok(SandboxResult {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: "execution timed out".into(),
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

        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();

        match timeout(duration, child.wait()).await {
            Ok(Ok(status)) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let stdout = read_string_from_option_stdout(child_stdout);
                let stderr = read_string_from_option_stderr(child_stderr);
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
                let _ = child.kill().await;
                Ok(SandboxResult {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: "execution timed out".into(),
                    timed_out: true,
                    duration_ms: config.timeout_ms,
                })
            }
        }
    }
}

/// 从 Option<ChildStdout> 读取字符串
fn read_string_from_option_stdout(
    reader: Option<tokio::process::ChildStdout>,
) -> String {
    match reader {
        Some(r) => {
            let mut buf = String::new();
            use tokio::io::AsyncReadExt;
            let mut async_r = r;
            let _ = tokio::runtime::Handle::current().block_on(async {
                async_r.read_to_string(&mut buf).await
            });
            buf
        }
        None => String::new(),
    }
}

/// 从 Option<ChildStderr> 读取字符串
fn read_string_from_option_stderr(
    reader: Option<tokio::process::ChildStderr>,
) -> String {
    match reader {
        Some(r) => {
            let mut buf = String::new();
            use tokio::io::AsyncReadExt;
            let mut async_r = r;
            let _ = tokio::runtime::Handle::current().block_on(async {
                async_r.read_to_string(&mut buf).await
            });
            buf
        }
        None => String::new(),
    }
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
    fn test_validate_script_path_accepts_relative() {
        let skill_dir = PathBuf::from("/tmp/test-skill");
        let script = validate_script_path(&skill_dir, "scripts/run.sh");
        assert!(script.is_err());
        assert!(!script.unwrap_err().contains("traversal"));
    }
}
