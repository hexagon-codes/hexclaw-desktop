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
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::test_runtime::{self, TestRunContext};

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
const SIDECAR_CAPABILITY_ENV: &str = "HEXCLAW_SIDECAR_CAPABILITY_TOKEN";
static SIDECAR_CAPABILITY_TOKEN: OnceLock<zeroize::Zeroizing<String>> = OnceLock::new();

/// Creates the process-scoped Sidecar capability before the child is spawned.
/// The value is never persisted or returned through a Tauri command.
pub(crate) fn initialize_capability_token() -> Result<(), String> {
    if SIDECAR_CAPABILITY_TOKEN.get().is_some() {
        return Ok(());
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    SIDECAR_CAPABILITY_TOKEN
        .set(zeroize::Zeroizing::new(token))
        .map_err(|_| "Sidecar capability was initialized concurrently".to_string())
}

pub(crate) fn capability_token() -> Result<&'static str, String> {
    SIDECAR_CAPABILITY_TOKEN
        .get()
        .map(|token| token.as_str())
        .ok_or_else(|| "Sidecar capability is not initialized".to_string())
}

fn sidecar_port_for_context(ctx: Option<&TestRunContext>) -> u16 {
    ctx.map_or(HEXCLAW_PORT, |ctx| ctx.sidecar_port)
}

pub fn sidecar_port() -> u16 {
    let ctx = test_runtime::current().ok().flatten();
    sidecar_port_for_context(ctx.as_ref())
}

/// hexclaw API 基础 URL
pub fn base_url() -> String {
    format!("http://localhost:{}", sidecar_port())
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
    let url = health_url();
    let max_attempts = timeout_secs * 2; // 每 500ms 检查一次

    for _ in 0..max_attempts {
        if let Ok(client) = crate::sidecar_client::SidecarClient::new(Duration::from_secs(2)) {
            if let Ok(resp) = client.get("/health").await {
                if resp.status().is_success() {
                    log::info!("hexclaw sidecar 就绪: {}", url);
                    set_ready(&app_handle, true);
                    // 通知前端 sidecar 已就绪
                    let _ = app_handle.emit("sidecar-ready", true);
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
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
    initialize_capability_token()?;
    set_ready(app, false);

    let test_ctx = test_runtime::current()?;
    if let Some(ctx) = test_ctx.as_ref() {
        test_runtime::write_test_config(ctx)?;
        log::info!(
            "sidecar 测试沙箱已启用: home={}, port={}",
            ctx.home.display(),
            ctx.sidecar_port
        );
    } else {
        if let Err(err) = ensure_desktop_knowledge_enabled() {
            log::warn!("准备桌面知识库配置失败: {}", err);
        }

        if let Err(err) = ensure_desktop_voice_enabled() {
            log::warn!("准备桌面语音(TTS)配置失败: {}", err);
        }
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

    // 解析 Tauri 资源目录（reference.docx 资产在此 assets/render/）。
    // 失败不阻塞（开发模式或异常布局下 resource_dir 可能不可达），仅打 warn。
    let resource_dir = app.path().resource_dir().ok();

    if !binary_path.exists() {
        // 开发模式回退：从 resource_dir/binaries 查找
        let resource_path = resource_dir
            .clone()
            .ok_or_else(|| "获取资源路径失败".to_string())?;
        let fallback_path = resource_path.join("binaries").join(binary_name);
        if !fallback_path.exists() {
            return Err(format!(
                "sidecar 二进制不存在: {:?} 和 {:?}",
                binary_path, fallback_path
            ));
        }
        ensure_port_available(sidecar_port_for_context(test_ctx.as_ref()))?;
        return spawn_child(&fallback_path, resource_dir.as_deref(), test_ctx.as_ref());
    }

    ensure_port_available(sidecar_port_for_context(test_ctx.as_ref()))?;
    spawn_child(&binary_path, resource_dir.as_deref(), test_ctx.as_ref())
}

/// 构建包含常用工具路径的 PATH
///
/// macOS GUI 应用不继承用户 shell 的 PATH（不经过 .zshrc/.bashrc），
/// 导致 sidecar 找不到 npx/node/python/docker 等命令。
/// 将常用安装路径追加到当前 PATH。
///
/// `sidecar_dir` 若提供（externalBin 的 pandoc/typst 与 hexclaw sidecar 同处此目录），
/// **前置**到 PATH，sidecar 优先命中签名捆绑版而非系统 pandoc，保证渲染产物跨机器一致。
pub fn enrich_path(sidecar_dir: Option<&Path>) -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let extras: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            // nvm / fnm / volta 默认路径
            &format!(
                "{}/.nvm/versions/node/default/bin",
                std::env::var("HOME").unwrap_or_default()
            ),
            &format!("{}/.local/bin", std::env::var("HOME").unwrap_or_default()),
            // cargo, go
            &format!("{}/go/bin", std::env::var("HOME").unwrap_or_default()),
            &format!("{}/.cargo/bin", std::env::var("HOME").unwrap_or_default()),
        ]
    } else {
        &[
            "/usr/local/bin",
            &format!("{}/.local/bin", std::env::var("HOME").unwrap_or_default()),
            &format!(
                "{}/.nvm/versions/node/default/bin",
                std::env::var("HOME").unwrap_or_default()
            ),
            &format!("{}/go/bin", std::env::var("HOME").unwrap_or_default()),
            &format!("{}/.cargo/bin", std::env::var("HOME").unwrap_or_default()),
        ]
    };
    let mut parts: Vec<String> = Vec::new();
    // 捆绑的 sidecar 目录（pandoc/typst）优先级最高（如果存在）
    if let Some(dir) = sidecar_dir {
        if dir.exists() {
            parts.push(dir.to_string_lossy().into_owned());
        }
    }
    for p in current.split(':') {
        if !p.is_empty() && !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    }
    for extra in extras {
        if !parts.iter().any(|x| x == extra) {
            parts.push((*extra).to_string());
        }
    }
    parts.join(":")
}

/// 启动子进程并记录 PID。
///
/// externalBin 的 pandoc/typst 与 `path`(hexclaw sidecar) 同处 Contents/MacOS/，故把 sidecar
/// 目录前置到 PATH；reference.docx 资产在 `<resource_dir>/assets/render/`，经
/// HEXCLAW_RESOURCE_DIR 传给 sidecar。
fn spawn_child(
    path: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
    test_ctx: Option<&TestRunContext>,
) -> Result<(), String> {
    // macOS GUI app 不继承 shell PATH；把 sidecar 所在目录（与捆绑的 pandoc/typst 同处）前置到
    // PATH，sidecar 的 exec.LookPath("pandoc") / LookPath("typst") 优先命中签名捆绑版。
    let sidecar_dir = path.parent();
    let enriched_path = enrich_path(sidecar_dir);

    let mut cmd = Command::new(path);
    cmd.args(["serve", "--desktop"]);

    if let Some(ctx) = test_ctx {
        test_runtime::configure_child_command(&mut cmd, ctx);
    }
    cmd.env(SIDECAR_CAPABILITY_ENV, capability_token()?);
    cmd.env("PATH", &enriched_path);

    // 把资源根透传给 sidecar，main.go.resolveRenderAssetPaths 第一优先级查这里。
    if let Some(d) = resource_dir {
        cmd.env("HEXCLAW_RESOURCE_DIR", d);
    }

    // 让 sidecar 与宿主机浏览器走同一代理出口：探测系统代理并注入 *_PROXY 环境变量，
    // Go 端 http.ProxyFromEnvironment 自动读取。仅在用户未显式设置该变量时注入，不覆盖
    // 手动配置；系统无手动代理（如 TUN/fake-ip 透明模式）时不注入，靠系统路由直连。
    if test_ctx.is_none() {
        for (k, v) in host_proxy_env() {
            if std::env::var(&k).is_err() {
                log::info!("sidecar 代理注入: {}={}", k, v);
                cmd.env(&k, &v);
            }
        }
    }

    let mut child = cmd
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

/// 探测宿主机系统代理（与浏览器同源），转成 `*_PROXY` 环境变量供 sidecar 使用，
/// 使 Go 端 `http.ProxyFromEnvironment` 走与宿主机浏览器相同的代理出口。
///
/// 仅 macOS 经 `scutil --proxy` 探测系统网络代理；其余平台返回空，沿用进程继承的
/// 环境变量（Go 自会读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY）。
fn host_proxy_env() -> Vec<(String, String)> {
    #[cfg(target_os = "macos")]
    {
        match Command::new("scutil").arg("--proxy").output() {
            Ok(o) if o.status.success() => parse_scutil_proxy(&String::from_utf8_lossy(&o.stdout)),
            _ => Vec::new(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// 解析 `scutil --proxy` 输出为 `*_PROXY` 环境变量键值对。纯函数，便于单测。
///
/// 仅采纳"手动代理"（HTTP/HTTPS/SOCKS 各自 Enable=1）；PAC 自动配置
/// （ProxyAutoConfig）无法被 Go 直接消费，忽略。任一手动代理启用时追加 NO_PROXY，
/// 保证本机/回环直连（sidecar 自身 127.0.0.1:16060、桌面↔sidecar 不应被代理）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil_proxy(output: &str) -> Vec<(String, String)> {
    use std::collections::HashMap;
    let mut kv: HashMap<&str, &str> = HashMap::new();
    for line in output.lines() {
        if let Some((k, v)) = line.split_once(" : ") {
            kv.insert(k.trim(), v.trim());
        }
    }
    let enabled = |k: &str| kv.get(k).map(|v| *v == "1").unwrap_or(false);
    let host_port = |hk: &str, pk: &str| -> Option<(String, String)> {
        match (kv.get(hk), kv.get(pk)) {
            (Some(h), Some(p)) if !h.is_empty() && !p.is_empty() && *p != "0" => {
                Some((h.to_string(), p.to_string()))
            }
            _ => None,
        }
    };

    let mut env: Vec<(String, String)> = Vec::new();
    if enabled("HTTPEnable") {
        if let Some((h, p)) = host_port("HTTPProxy", "HTTPPort") {
            env.push(("HTTP_PROXY".into(), format!("http://{}:{}", h, p)));
        }
    }
    if enabled("HTTPSEnable") {
        // HTTPS 代理走 HTTP CONNECT，URL scheme 仍是 http://。
        if let Some((h, p)) = host_port("HTTPSProxy", "HTTPSPort") {
            env.push(("HTTPS_PROXY".into(), format!("http://{}:{}", h, p)));
        }
    }
    if enabled("SOCKSEnable") {
        if let Some((h, p)) = host_port("SOCKSProxy", "SOCKSPort") {
            env.push(("ALL_PROXY".into(), format!("socks5://{}:{}", h, p)));
        }
    }
    if !env.is_empty() {
        env.push(("NO_PROXY".into(), "localhost,127.0.0.1,::1".into()));
    }
    env
}

/// 停止 sidecar 进程
///
/// 优雅退出（BUG-20260703）：先发 TERM 让后端跑完 graceful shutdown
/// （hexclaw 侧 signal.NotifyContext(SIGTERM) → http.Server.Shutdown →
/// WS StatusGoingAway → 在飞回复落库），3 秒未退再升级 KILL 兜底——
/// 与 ensure_port_available 清理残留进程的 terminate_process 同一语义。
/// 此前直接 child.kill()（Unix 上是不可捕获的 SIGKILL），后端整套
/// 优雅停机在正常退出路径上从未被触发。
/// 应在应用退出时调用，确保子进程不会变成孤儿进程。
pub fn stop_sidecar() {
    if let Ok(mut guard) = SIDECAR_PROCESS.lock() {
        if let Some(child) = guard.take() {
            log::info!("正在停止 sidecar...");
            let graceful = stop_child_gracefully(child, Duration::from_secs(3));
            log::info!(
                "sidecar 已停止（{}）",
                if graceful {
                    "优雅退出"
                } else {
                    "KILL 兜底"
                }
            );
        }
    }
}

/// TERM → 限时等待 → KILL 的子进程停止序列。返回是否在优雅窗口内退出。
///
/// 用 child.try_wait() 轮询而非按 pid 探活：直接收尸（无僵尸残留）且免疫
/// pid 复用竞态。TERM 发送失败（进程已死等）时跳过等待直接走 KILL 收尸。
#[cfg(unix)]
fn stop_child_gracefully(mut child: Child, term_timeout: Duration) -> bool {
    let pid = child.id();
    if send_unix_signal(pid, "-TERM").is_ok() {
        let deadline = std::time::Instant::now() + term_timeout;
        while std::time::Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        log::warn!(
            "sidecar PID {} 未在 TERM 后 {:?} 内退出，升级为 KILL。",
            pid,
            term_timeout
        );
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// Windows 无 SIGTERM 等价物：sidecar 以无控制台方式运行，CTRL_BREAK 不可达，
/// 维持 TerminateProcess 强杀（数据安全由后端 SQLite WAL 兜底，不会损坏库）。
/// 若后续需要 Windows 优雅退出，应走后端本地回环 shutdown 端点，属跨仓变更。
#[cfg(not(unix))]
fn stop_child_gracefully(mut child: Child, _term_timeout: Duration) -> bool {
    let _ = child.kill();
    let _ = child.wait();
    false
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

/// 桌面模式默认启用语音合成（TTS），使用免费、无需 API Key 的 edge-tts。
///
/// 聊天气泡的「朗读」按钮（MessageActions）依赖后端 `/api/v1/voice/synthesize`，
/// 而该路由仅在 `voice.enabled` 且配置了 TTS provider 时注册。`Voice.Enabled`
/// 默认零值 false（DefaultConfig 不含 voice 段），桌面端又无语音设置 UI，导致朗读
/// 按钮开箱即坏（404/503 → toast 失败）。这里仿照知识库的桌面默认，注入 edge-tts。
/// edge-tts 免费、无 Key、仅在用户点击朗读时才请求微软 TTS（不自动外发数据）。
fn ensure_desktop_voice_enabled() -> Result<(), String> {
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

    let (next, changed) = ensure_voice_tts_enabled_yaml(&existing);
    if !changed {
        return Ok(());
    }

    std::fs::write(&config_path, next)
        .map_err(|e| format!("写入配置文件失败 ({}): {}", config_path.display(), e))?;
    log::info!(
        "桌面模式已确保语音 TTS(edge-tts) 默认启用: {}",
        config_path.display()
    );
    Ok(())
}

/// 注入默认 voice/TTS 配置块，确保免费 edge-tts 始终可用。
///
/// - 空文件 / 无顶层 `voice:` → 写入完整 voice 块。
/// - 已有 `voice:` 块但**缺有效 TTS provider** → 注入/补全 `tts.provider: edge-tts`
///   （修"半截 voice 块朗读仍坏"：enabled 但无 provider 时后端 HasTTS=false→503）。
/// - 已有非空 provider 或用户显式 `enabled: false` → **尊重不动**，保证幂等。
fn ensure_voice_tts_enabled_yaml(content: &str) -> (String, bool) {
    const VOICE_BLOCK: &str = "voice:\n  enabled: true\n  tts:\n    provider: edge-tts\n";

    if content.trim().is_empty() {
        return (VOICE_BLOCK.to_string(), true);
    }

    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<String> = normalized
        .lines()
        .map(std::string::ToString::to_string)
        .collect();

    let Some(start) = lines.iter().position(|l| is_top_level_key(l, "voice")) else {
        // 无 voice 块 → 追加完整块
        let mut next = normalized.trim_end_matches('\n').to_string();
        next.push_str("\n\n");
        next.push_str(VOICE_BLOCK);
        return (next, true);
    };

    let mut lines = lines;

    // 定位 voice 块范围（到下一个顶层 key 为止）
    let end = voice_block_end(&lines, start);

    // 已配置**有效**的 tts.provider（去引号后非空真实值，如 azure）→ 用户刻意设好 TTS，
    // 整块尊重不动（含 enabled）。注意：hexclaw 序列化默认写 `provider: ""`，是带引号的
    // 空串，判空前必须先去引号，否则会被误当成"已配 provider"而放过。
    if let Some((_, val)) = voice_subsection_provider(&lines, start, end, "tts:") {
        if !provider_value_is_empty(&val) {
            return (content.to_string(), false);
        }
    }

    // 无有效 tts provider（hexclaw 默认零值块即此形）→ 强制开箱可用：
    //   ① voice.enabled 强制 true：桌面端无 voice 设置 UI，enabled:false 只可能是 hexclaw
    //      默认零值序列化，绝非用户刻意选择 → 语义同知识库(rewrite_enabled_line 强翻)。
    //   ② tts.provider 设为免费 edge-tts：仅作用 tts 子段，**绝不碰 stt.provider**。
    // ① 只翻 voice 块内第一处 enabled:（即 voice.enabled；stt/tts/wake 的 enabled 不动）。
    if let Some(ei) = (start + 1..end).find(|&i| lines[i].trim_start().starts_with("enabled:")) {
        if let Some(rewritten) = rewrite_enabled_line(&lines[ei]) {
            lines[ei] = rewritten;
        }
    } else {
        lines.insert(start + 1, "  enabled: true".to_string());
    }

    // ② tts.provider（基于可能已插入 enabled 行后的最新 lines 重新定位块范围）。
    let end = voice_block_end(&lines, start);
    match voice_subsection_provider(&lines, start, end, "tts:") {
        Some((pi, _)) => {
            // 空 provider → 原地补全（保留原缩进），不重复注入 tts 子段。
            let indent = &lines[pi][..line_indent(&lines[pi])];
            lines[pi] = format!("{indent}provider: edge-tts");
        }
        None => {
            // 无 tts 子段 → 在 voice: 后注入。
            lines.insert(start + 1, "  tts:\n    provider: edge-tts".to_string());
        }
    }

    // 进入强启分支即必有改动（voice.enabled 强制 true + tts.provider 必被补全/注入）。
    (join_yaml_lines(&lines), true)
}

/// 行首缩进字符数。
fn line_indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// voice 顶层块的结束行（exclusive）：start 之后第一处顶层 key，或文件尾。
fn voice_block_end(lines: &[String], start: usize) -> usize {
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        let t = l.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if !l.starts_with(' ') && !l.starts_with('\t') {
            return i;
        }
    }
    lines.len()
}

/// voice 块 [start,end) 内某子段（如 "tts:"）的 provider 行索引与原始值（未去引号）。
/// 子段范围限定在该子段头之后、到缩进 ≤ 子段头缩进的下一行为止——因此 stt 子段的
/// provider 绝不会被误当成 tts 的（修旧实现 `position(starts_with("provider:"))` 命中首个
/// provider=stt 的 bug）。
fn voice_subsection_provider(
    lines: &[String],
    start: usize,
    end: usize,
    sub: &str,
) -> Option<(usize, String)> {
    let sub_idx = (start + 1..end).find(|&i| lines[i].trim() == sub)?;
    let sub_indent = line_indent(&lines[sub_idx]);
    let mut sub_end = end;
    for (i, line) in lines.iter().enumerate().take(end).skip(sub_idx + 1) {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if line_indent(line) <= sub_indent {
            sub_end = i;
            break;
        }
    }
    let pi = (sub_idx + 1..sub_end).find(|&i| lines[i].trim_start().starts_with("provider:"))?;
    let val = lines[pi].trim_start()["provider:".len()..]
        .trim()
        .to_string();
    Some((pi, val))
}

/// provider 值是否"空"——去掉首尾引号与空白后为空（hexclaw 默认序列化为 `""`）。
fn provider_value_is_empty(val: &str) -> bool {
    val.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .is_empty()
}

fn desktop_config_path() -> Result<std::path::PathBuf, String> {
    if let Some(ctx) = test_runtime::current()? {
        return Ok(ctx.config_path());
    }

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
        ensure_knowledge_enabled_yaml, ensure_voice_tts_enabled_yaml, executable_basename,
        format_port_conflict_error, is_hexclaw_sidecar_command, parse_pid_list, parse_scutil_proxy,
        sidecar_port_for_context,
    };
    use crate::test_runtime::TestRunContext;
    use std::path::PathBuf;

    #[test]
    fn sidecar_port_uses_the_test_run_context_only_when_present() {
        assert_eq!(sidecar_port_for_context(None), 16060);
        let ctx = TestRunContext {
            home: PathBuf::from("/tmp/hexclaw-test/run-42"),
            sidecar_port: 16061,
        };
        assert_eq!(sidecar_port_for_context(Some(&ctx)), 16061);
    }

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

    // BUG 复现(2026-06-26): 桌面端有「朗读」按钮但 TTS 从未启用 → 朗读开箱即坏。
    // 桌面默认应注入免费的 edge-tts，使 /api/v1/voice/synthesize 路由注册、按钮可用。
    #[test]
    fn ensure_voice_tts_enabled_yaml_creates_full_block_when_empty() {
        let (next, changed) = ensure_voice_tts_enabled_yaml("");
        assert!(changed);
        assert_eq!(
            next,
            "voice:\n  enabled: true\n  tts:\n    provider: edge-tts\n"
        );
    }

    #[test]
    fn ensure_voice_tts_enabled_yaml_appends_block_when_missing() {
        let (next, changed) = ensure_voice_tts_enabled_yaml("knowledge:\n  enabled: true\n");
        assert!(changed);
        assert!(next.contains(
            "knowledge:\n  enabled: true\n\nvoice:\n  enabled: true\n  tts:\n    provider: edge-tts\n"
        ));
    }

    #[test]
    fn ensure_voice_tts_enabled_yaml_keeps_existing_voice_block() {
        // 幂等 + 尊重用户：已有非空 provider 的完整 voice 块原样不动。
        let input = "voice:\n  enabled: true\n  tts:\n    provider: edge-tts\n";
        let (next, changed) = ensure_voice_tts_enabled_yaml(input);
        assert!(!changed);
        assert_eq!(next, input);
    }

    // bug-20260626-⑤：voice 块存在但缺有效 TTS provider → 朗读仍坏(503)。应补全免费 edge-tts。
    #[test]
    fn ensure_voice_tts_block_without_tts_should_inject_provider() {
        let (next, changed) = ensure_voice_tts_enabled_yaml("voice:\n  enabled: true\n");
        assert!(changed);
        assert!(
            next.contains("provider: edge-tts"),
            "应注入 provider: {next}"
        );
        assert!(next.contains("enabled: true"), "应保留 enabled: {next}");
    }

    #[test]
    fn ensure_voice_tts_empty_provider_should_be_fixed() {
        let (next, changed) =
            ensure_voice_tts_enabled_yaml("voice:\n  enabled: true\n  tts:\n    provider:\n");
        assert!(changed);
        assert!(
            next.contains("provider: edge-tts"),
            "空 provider 应补全: {next}"
        );
        // 不得产生重复 tts 子段
        assert_eq!(next.matches("tts:").count(), 1, "不应重复 tts: {next}");
    }

    #[test]
    fn ensure_voice_tts_bare_disabled_without_provider_is_force_enabled() {
        // 契约修正（bug-20260626-tts-A2）：桌面端无 voice 设置 UI，未配任何 tts.provider 的
        // bare `enabled: false` 与 hexclaw 默认零值序列化无法区分，只可能是默认值，不是用户
        // 刻意选择。旧实现"尊重 enabled:false 不动"会让 🔊 恒坏（路由不注册），故强制启用。
        // 真正想尊重的是"已配非空 provider"那种刻意配置（见
        // ensure_voice_tts_respects_deliberately_configured_provider）。
        let input = "voice:\n  enabled: false\n";
        let (next, changed) = ensure_voice_tts_enabled_yaml(input);
        assert!(changed, "默认 disabled 且无 provider → 应强制启用: {next}");
        assert!(next.contains("enabled: true"), "应翻 enabled: {next}");
        assert!(
            next.contains("provider: edge-tts"),
            "应注入 edge-tts: {next}"
        );
    }

    // bug-20260626-tts-A2：装机现场真实复现。hexclaw 把零值默认 voice 段整段序列化到
    // ~/.hexclaw/hexclaw.yaml（enabled:false + stt/tts/wake 子段、provider 均为带引号空串
    // `""`）。桌面端无 voice 设置 UI → enabled:false 只可能是默认零值，绝非用户刻意选择。
    // 旧实现遇 enabled:false 直接 early-return 不动 → 装好的 app voice 路由不注册(/api/v1/
    // voice/status 404) → 🔊 恒坏。本用例钉死：默认零值块必须被强制启用 edge-tts。
    #[test]
    fn ensure_voice_tts_force_enables_hexclaw_default_serialized_block() {
        let input = concat!(
            "voice:\n",
            "    enabled: false\n",
            "    stt:\n",
            "        provider: \"\"\n",
            "        model: \"\"\n",
            "    tts:\n",
            "        provider: \"\"\n",
            "        voice: \"\"\n",
            "    wake:\n",
            "        enabled: false\n",
        );
        let (next, changed) = ensure_voice_tts_enabled_yaml(input);
        assert!(changed, "默认零值 voice 块必须被强制启用: {next}");
        // voice.enabled 翻 true（仅这一处；wake.enabled 保持 false 不动）
        assert_eq!(
            next.matches("enabled: true").count(),
            1,
            "只应翻 voice.enabled: {next}"
        );
        assert!(
            next.contains("enabled: false"),
            "wake.enabled 应保持不动: {next}"
        );
        // tts.provider 设为免费 edge-tts
        assert!(
            next.contains("provider: edge-tts"),
            "tts.provider 应为 edge-tts: {next}"
        );
        // 绝不能把 edge-tts 注到 stt.provider（stt 段仍不含 edge-tts）
        let stt_seg = &next[next.find("stt:").unwrap()..next.find("tts:").unwrap()];
        assert!(
            !stt_seg.contains("edge-tts"),
            "不得污染 stt.provider: {stt_seg}"
        );
        // 不重复 tts 子段
        assert_eq!(next.matches("tts:").count(), 1, "不应重复 tts 子段: {next}");
    }

    // 真正"刻意配置"才尊重：tts.provider 已是非空真实值（如 azure）→ 即便 enabled:false 也整块不动。
    #[test]
    fn ensure_voice_tts_respects_deliberately_configured_provider() {
        let input = "voice:\n  enabled: false\n  tts:\n    provider: azure\n";
        let (next, changed) = ensure_voice_tts_enabled_yaml(input);
        assert!(!changed, "已配非空 provider 应整块尊重: {next}");
        assert_eq!(next, input);
    }

    #[test]
    fn parse_scutil_proxy_manual_http_https() {
        let out = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 0\n}";
        let env = parse_scutil_proxy(out);
        assert!(env
            .iter()
            .any(|(k, v)| k == "HTTP_PROXY" && v == "http://127.0.0.1:7890"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "HTTPS_PROXY" && v == "http://127.0.0.1:7890"));
        assert!(env.iter().any(|(k, _)| k == "NO_PROXY"));
        assert!(!env.iter().any(|(k, _)| k == "ALL_PROXY"));
    }

    #[test]
    fn parse_scutil_proxy_socks() {
        let out = "  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 192.168.1.2\n";
        let env = parse_scutil_proxy(out);
        assert!(env
            .iter()
            .any(|(k, v)| k == "ALL_PROXY" && v == "socks5://192.168.1.2:1080"));
    }

    #[test]
    fn parse_scutil_proxy_tun_mode_yields_empty() {
        // TUN/fake-ip 透明模式：系统无手动代理 → 不注入任何变量（靠系统路由直连）。
        let out =
            "  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 0\n  ProxyAutoConfigEnable : 0\n";
        assert!(parse_scutil_proxy(out).is_empty());
    }

    #[test]
    fn parse_scutil_proxy_ignores_disabled_with_stale_host() {
        // Enable=0 但仍残留 HTTPProxy/Port（系统常见）→ 不应注入。
        let out = "  HTTPEnable : 0\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n";
        assert!(parse_scutil_proxy(out).is_empty());
    }
}

/// stop_child_gracefully 语义锁（BUG-20260703 优雅退出）：
/// TERM 响应型子进程必须在优雅窗口内退出（不升级 KILL）；
/// 忽略 TERM 的子进程必须被 KILL 兜底且不拖满等待。
/// 旧实现（直接 child.kill() = SIGKILL）在第一条上必然 false，构成 RED 判别。
#[cfg(all(test, unix))]
mod stop_gracefully_tests {
    use super::{process_exists, stop_child_gracefully};
    use std::path::PathBuf;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    /// 启动测试子进程：先装 trap，再落标记文件宣告就绪，最后执行 body。
    /// 若不同步就绪，TERM 可能赶在 trap 生效前送达——子进程按默认处置退出，
    /// 被误判「优雅」（并发全量跑时曾真实复现）。
    fn spawn_trapped_child(name: &str, trap_cmd: &str, body: &str) -> Child {
        let marker: PathBuf =
            std::env::temp_dir().join(format!("hexclaw-stop-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let script = format!("{}; : > '{}'; {}", trap_cmd, marker.display(), body);
        let child = Command::new("sh")
            .args(["-c", &script])
            .spawn()
            .expect("spawn test child");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(Instant::now() < deadline, "测试子进程未在 5s 内就绪");
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&marker);
        child
    }

    #[test]
    fn term_compliant_child_exits_gracefully_without_kill() {
        // 模拟能优雅退出的 sidecar：TERM 中断 wait → trap 触发 → exit 0。
        // （POSIX sh 的 trap 在前台命令结束前不执行，故用 `sleep & wait` 让信号可中断。）
        let child = spawn_trapped_child("compliant", "trap 'exit 0' TERM", "sleep 30 & wait $!");
        let start = Instant::now();
        let graceful = stop_child_gracefully(child, Duration::from_secs(3));
        assert!(
            graceful,
            "TERM 响应型子进程应在优雅窗口内退出，不应升级 KILL"
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "优雅退出不应耗满超时窗口"
        );
    }

    #[test]
    fn term_ignoring_child_is_killed_after_timeout() {
        // 模拟卡死的 sidecar：忽略 TERM → 必须升级 KILL 兜底，且不等 sleep 自然结束。
        let child = spawn_trapped_child("ignoring", "trap '' TERM", "sleep 30");
        let pid = child.id();
        let start = Instant::now();
        let graceful = stop_child_gracefully(child, Duration::from_millis(500));
        assert!(!graceful, "忽略 TERM 的子进程应报告非优雅退出");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "KILL 兜底不应拖到 sleep 自然结束"
        );
        assert!(
            !process_exists(pid).unwrap_or(true),
            "升级 KILL 后进程必须已消失"
        );
    }
}
