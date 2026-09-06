// Tauri Commands
//
// 前端可通过 invoke() 调用的系统级操作。
// 业务逻辑不放在这里，业务 API 全部走 hexclaw REST API。

use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ollama;
use crate::sidecar;
use crate::sidecar_client::{read_bounded, SidecarClient};

const MAX_PROXY_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ACTIVE_SIDECAR_FETCHES: usize = 64;

struct ActiveSidecarFetch {
    generation: Uuid,
    cancellation: CancellationToken,
}

#[derive(Default, Clone)]
pub struct SidecarFetchRegistry {
    requests: Arc<Mutex<HashMap<String, ActiveSidecarFetch>>>,
}

struct SidecarFetchRegistration {
    cancellation_id: String,
    generation: Uuid,
    cancellation: CancellationToken,
    requests: Arc<Mutex<HashMap<String, ActiveSidecarFetch>>>,
}

impl SidecarFetchRegistry {
    fn register(&self, cancellation_id: String) -> Result<SidecarFetchRegistration, String> {
        validate_cancellation_id(&cancellation_id)?;
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Sidecar fetch registry poisoned")?;
        if requests.len() >= MAX_ACTIVE_SIDECAR_FETCHES {
            return Err("Too many active Sidecar requests".into());
        }
        if requests.contains_key(&cancellation_id) {
            return Err("Sidecar cancellation identity is already active".into());
        }
        let generation = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        requests.insert(
            cancellation_id.clone(),
            ActiveSidecarFetch {
                generation,
                cancellation: cancellation.clone(),
            },
        );
        Ok(SidecarFetchRegistration {
            cancellation_id,
            generation,
            cancellation,
            requests: self.requests.clone(),
        })
    }

    fn cancel(&self, cancellation_id: &str) -> Result<(), String> {
        validate_cancellation_id(cancellation_id)?;
        if let Some(active) = self
            .requests
            .lock()
            .map_err(|_| "Sidecar fetch registry poisoned")?
            .remove(cancellation_id)
        {
            active.cancellation.cancel();
        }
        Ok(())
    }

    #[cfg(test)]
    fn active_count(&self) -> Result<usize, String> {
        self.requests
            .lock()
            .map(|requests| requests.len())
            .map_err(|_| "Sidecar fetch registry poisoned".into())
    }
}

impl SidecarFetchRegistration {
    fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl Drop for SidecarFetchRegistration {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            if requests
                .get(&self.cancellation_id)
                .is_some_and(|active| active.generation == self.generation)
            {
                requests.remove(&self.cancellation_id);
            }
        }
    }
}

fn validate_cancellation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err("Sidecar cancellation identity is invalid".into());
    }
    Ok(())
}

async fn await_sidecar_or_cancel<T, F>(
    cancellation: CancellationToken,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("Sidecar request cancelled".into()),
        result = future => result,
    }
}

fn register_legacy_proxy(
    registry: &SidecarFetchRegistry,
) -> Result<SidecarFetchRegistration, String> {
    registry.register(format!("legacy-proxy:{}", Uuid::new_v4()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarFetchResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn registered_cancellation_terminates_an_inflight_native_http_future() {
        let registry = SidecarFetchRegistry::default();
        let registration = registry
            .register("request-1".into())
            .expect("register request");
        let cancellation = registration.token();
        let pending = tokio::spawn(async move {
            await_sidecar_or_cancel(cancellation, std::future::pending::<Result<(), String>>())
                .await
        });

        registry.cancel("request-1").expect("cancel request");
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("cancellation must terminate the pending future")
            .expect("join task");
        assert_eq!(
            result.expect_err("cancelled result"),
            "Sidecar request cancelled"
        );
        assert_eq!(registry.active_count().expect("active count"), 0);
    }

    #[test]
    fn legacy_proxy_shares_the_global_request_budget_and_releases_capacity() {
        let registry = SidecarFetchRegistry::default();
        let mut active = Vec::new();
        for index in 0..MAX_ACTIVE_SIDECAR_FETCHES {
            active.push(
                registry
                    .register(format!("request-{index}"))
                    .expect("fill shared request budget"),
            );
        }

        let error = register_legacy_proxy(&registry)
            .err()
            .expect("legacy proxy must fail closed at shared capacity");
        assert_eq!(error, "Too many active Sidecar requests");

        active.pop();
        let replacement = register_legacy_proxy(&registry).expect("released slot is reusable");
        assert_eq!(
            registry.active_count().expect("replacement active"),
            MAX_ACTIVE_SIDECAR_FETCHES
        );
        drop(replacement);
        assert_eq!(
            registry.active_count().expect("replacement released"),
            MAX_ACTIVE_SIDECAR_FETCHES - 1
        );
        for name in [
            "x-hexclaw-artifact-id",
            "x-hexclaw-source-digest",
            "x-hexclaw-object-counts",
        ] {
            assert!(
                proxy_response_header(&reqwest::header::HeaderName::from_static(name)),
                "archive response metadata must cross the native proxy: {name}"
            );
        }
        assert!(!proxy_response_header(
            &reqwest::header::HeaderName::from_static("set-cookie")
        ));
    }
}

fn proxy_method(method: &str) -> Result<reqwest::Method, String> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        _ => Err("Sidecar HTTP method is not allowed".into()),
    }
}

fn proxy_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "idempotency-key" | "if-match" | "if-none-match" | "range"
    )
}

fn proxy_response_header(name: &reqwest::header::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "content-type"
            | "content-length"
            | "content-disposition"
            | "etag"
            | "last-modified"
            | "x-content-sha256"
            | "x-hexclaw-artifact-id"
            | "x-hexclaw-source-digest"
            | "x-hexclaw-object-counts"
    )
}

async fn execute_sidecar_fetch(
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    cancellation: CancellationToken,
) -> Result<SidecarFetchResponse, String> {
    if body.len() > MAX_PROXY_REQUEST_BYTES {
        return Err("Sidecar request body exceeds IPC limit".into());
    }
    let client = SidecarClient::new(Duration::from_secs(300))?;
    let mut request = client.renderer_request(proxy_method(&method)?, &path)?;
    for (name, value) in headers {
        if !proxy_request_header(&name) || value.len() > 1024 || value.chars().any(char::is_control)
        {
            return Err("Sidecar request header is not allowed".into());
        }
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let response = await_sidecar_or_cancel(cancellation.clone(), async {
        request
            .send()
            .await
            .map_err(|error| format!("Sidecar request failed: {error}"))
    })
    .await?;
    SidecarClient::require_non_redirect(&response)?;
    let status = response.status();
    let response_headers = response
        .headers()
        .iter()
        .filter(|(name, _)| proxy_response_header(name))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    let body = await_sidecar_or_cancel(
        cancellation,
        read_bounded(response, MAX_PROXY_RESPONSE_BYTES),
    )
    .await?;
    Ok(SidecarFetchResponse {
        status: status.as_u16(),
        headers: response_headers,
        body,
    })
}

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

/// 重启 sidecar 进程
#[tauri::command]
pub async fn restart_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    sidecar::stop_sidecar()?;
    let instance = sidecar::spawn_sidecar(&app)?;
    // 等待健康检查
    sidecar::wait_for_healthy(app, 15, instance).await?;
    Ok("sidecar restarted".to_string())
}

/// 健康检查（Rust 端发请求，绕过 WebView CORS 限制）
#[tauri::command]
pub async fn check_engine_health() -> bool {
    let Ok(client) = SidecarClient::new(Duration::from_secs(3)) else {
        return false;
    };
    match client.get("/health").await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Authenticated Sidecar HTTP bridge. The renderer supplies a relative path
/// and an allowlisted HTTP shape; Rust owns the dynamic origin and bearer.
#[tauri::command]
pub async fn sidecar_fetch(
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    cancellation_id: String,
    on_registered: tauri::ipc::Channel<()>,
    registry: tauri::State<'_, SidecarFetchRegistry>,
) -> Result<SidecarFetchResponse, String> {
    let registration = registry.register(cancellation_id)?;
    on_registered
        .send(())
        .map_err(|_| "Sidecar request registration acknowledgement failed".to_string())?;
    execute_sidecar_fetch(method, path, headers, body, registration.token()).await
}

#[tauri::command]
pub fn sidecar_fetch_cancel(
    cancellation_id: String,
    registry: tauri::State<'_, SidecarFetchRegistry>,
) -> Result<(), String> {
    registry.cancel(&cancellation_id)
}

/// Legacy JSON-only adapter retained while call sites converge. It delegates
/// to the exact same authenticated client and cannot choose an origin/header.
#[tauri::command]
pub async fn proxy_api_request(
    method: String,
    path: String,
    body: Option<String>,
    registry: tauri::State<'_, SidecarFetchRegistry>,
) -> Result<String, String> {
    let registration = register_legacy_proxy(&registry)?;
    let mut headers = BTreeMap::new();
    let bytes = body.unwrap_or_default().into_bytes();
    if !bytes.is_empty() {
        headers.insert("content-type".into(), "application/json".into());
    }
    let response =
        execute_sidecar_fetch(method, path, headers, bytes, registration.token()).await?;
    let text = String::from_utf8(response.body)
        .map_err(|_| "Sidecar returned a non-text response".to_string())?;
    if response.status >= 400 {
        return Err(format!("HTTP {}: {}", response.status, text));
    }
    Ok(text)
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

/// 打开「关于」窗口（应用内版本号入口调用，与 macOS 菜单 About 共用同一窗口）。
#[tauri::command]
pub fn open_about(app: tauri::AppHandle) -> Result<(), String> {
    crate::window::open_about(&app).map_err(|e| e.to_string())
}

/// 设置开机自启（U5）。
///
/// 之前前端「开机自启」开关只把布尔值落到 Tauri Store，从不调用 plugin-autostart，
/// 于是开关是个假开关——系统层面永不注册 LaunchAgent。此 command 把开关桥接到
/// `tauri_plugin_autostart` 的 enable()/disable()，让开关真正生效。
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enable {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// 查询开机自启当前是否已在系统层面注册（U5）。
///
/// 前端启动时用它把 UI 开关与真实系统状态对齐（Store 里的布尔值可能与系统实际不一致）。
#[tauri::command]
pub fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 平台信息
#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub version: String,
}

// ─── Ollama Commands ─────────────────────────────────

/// Ollama 状态信息
#[derive(Serialize)]
pub struct OllamaStatus {
    /// 是否就绪
    pub ready: bool,
    /// 是否由本应用管理（false = 外部实例）
    pub managed: bool,
    /// API 基础 URL
    pub base_url: String,
    /// 端口号
    pub port: u16,
}

/// 获取 Ollama 状态
#[tauri::command]
pub fn get_ollama_status(app: tauri::AppHandle) -> OllamaStatus {
    OllamaStatus {
        ready: ollama::is_ready(&app),
        managed: ollama::is_managed(),
        base_url: ollama::base_url(),
        port: ollama::OLLAMA_PORT,
    }
}

/// 重启 Ollama 进程
#[tauri::command]
pub async fn restart_ollama(app: tauri::AppHandle) -> Result<String, String> {
    ollama::stop_ollama();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    ollama::spawn_ollama(&app)?;
    ollama::wait_for_healthy(app, 15).await;
    Ok("ollama restarted".to_string())
}

// ─── 文件保存（Tauri WKWebView 绕过）─────────────────────────────
//
// Web 下载 <a download> 在 Tauri WKWebView 里不可靠；用 dialog.save() 让用户选择
// 路径后，调用下列命令由 Rust 侧写盘，获得系统原生 UX。

// 校验目标路径：必须绝对 + 不含 `..` + 父目录存在
// ─── 文档渲染（POST /api/v1/render → 流式直写文件）──────────────────
//
// markdown → docx/pdf/epub/odt/rtf/txt/html/md，由 sidecar 渲染层处理。
//
// 关键设计（详见 hexclaw/.claude/doc-generation-architecture.md）：
//   - reqwest 流式下载 sidecar 响应 → tokio::fs::File 直写用户选定路径
//   - **不经过 base64 / 不进 JS string**——避免 100 MB 输出在三处放大内存
//   - 复用 validate_save_path 路径校验
//   - 错误分支按 sidecar 返回的 RenderError JSON 透传
