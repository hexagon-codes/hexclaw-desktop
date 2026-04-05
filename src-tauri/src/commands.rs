// Tauri Commands
//
// 前端可通过 invoke() 调用的系统级操作。
// 业务逻辑不放在这里，业务 API 全部走 hexclaw REST API。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::ollama;
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

/// 重启 sidecar 进程
#[tauri::command]
pub async fn restart_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    sidecar::stop_sidecar();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    sidecar::spawn_sidecar(&app)?;
    // 等待健康检查
    sidecar::wait_for_healthy(app, 15).await;
    Ok("sidecar restarted".to_string())
}

/// 健康检查（Rust 端发请求，绕过 WebView CORS 限制）
#[tauri::command]
pub async fn check_engine_health() -> bool {
    let url = sidecar::health_url();
    match reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// 代理 API 请求到 hexclaw（绕过 CORS）
#[tauri::command]
pub async fn proxy_api_request(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err(format!("Invalid API path: {}", path));
    }
    let url = format!("{}{}", sidecar::base_url(), path);
    let client = reqwest::Client::new();

    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => {
            let mut r = client.post(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "PUT" => {
            let mut r = client.put(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "PATCH" => {
            let mut r = client.patch(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        "DELETE" => {
            let mut r = client.delete(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        _ => return Err(format!("不支持的 HTTP 方法: {}", method)),
    };

    let resp = req
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status >= 400 {
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(text)
}

/// 流式聊天请求参数
#[derive(Deserialize)]
pub struct StreamChatParams {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMsg>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// 唯一请求 ID，用于前端匹配事件
    pub request_id: String,
}

#[derive(Deserialize, Serialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// SSE 流式事件 payload
#[derive(Clone, Serialize)]
pub struct StreamEvent {
    pub request_id: String,
    /// "chunk" | "done" | "error"
    pub event_type: String,
    pub data: String,
}

/// 流式聊天 — 通过 Rust 代理到 LLM Provider（绕过 CORS）
///
/// 通过 Tauri event 系统将 SSE chunks 推送到前端：
///   - `chat-stream` { request_id, event_type: "chunk", data: "SSE data line" }
///   - `chat-stream` { request_id, event_type: "done", data: "" }
///   - `chat-stream` { request_id, event_type: "error", data: "error message" }
#[tauri::command]
pub async fn stream_chat(app: tauri::AppHandle, params: StreamChatParams) -> Result<(), String> {
    let trimmed = params.base_url.trim_end_matches('/');
    if let Ok(parsed) = trimmed.parse::<url::Url>() {
        let scheme = parsed.scheme();
        if scheme != "https" && scheme != "http" {
            return Err(format!("Unsupported scheme: {}", scheme));
        }
        if let Some(host) = parsed.host_str() {
            // Block cloud metadata endpoints
            if host == "169.254.169.254" || host == "metadata.google.internal" {
                return Err("Blocked: cloud metadata endpoint".to_string());
            }
            // Block private/loopback IPs (SSRF protection)
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                let is_private = match ip {
                    std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified(),
                    std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
                };
                if is_private {
                    return Err(format!("Blocked: private/loopback address {}", host));
                }
            }
        }
    }
    let url = format!("{}/chat/completions", trimmed);

    let body = serde_json::json!({
        "model": params.model,
        "messages": params.messages,
        "stream": true,
        "temperature": params.temperature.unwrap_or(0.7),
        "max_tokens": params.max_tokens.unwrap_or(4096),
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", params.api_key))
        .timeout(std::time::Duration::from_secs(120))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            "chat-stream",
            StreamEvent {
                request_id: params.request_id,
                event_type: "error".into(),
                data: format!("HTTP {}: {}", status, text),
            },
        );
        return Ok(());
    }

    // 逐块读取 SSE 流
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                buffer.push_str(&text);

                // 按行分割处理 SSE
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if line.starts_with("data: ") {
                        let data = &line[6..];
                        if data == "[DONE]" {
                            let _ = app.emit(
                                "chat-stream",
                                StreamEvent {
                                    request_id: params.request_id.clone(),
                                    event_type: "done".into(),
                                    data: String::new(),
                                },
                            );
                            return Ok(());
                        }
                        let _ = app.emit(
                            "chat-stream",
                            StreamEvent {
                                request_id: params.request_id.clone(),
                                event_type: "chunk".into(),
                                data: data.to_string(),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "chat-stream",
                    StreamEvent {
                        request_id: params.request_id.clone(),
                        event_type: "error".into(),
                        data: format!("流读取错误: {}", e),
                    },
                );
                return Ok(());
            }
        }
    }

    // 流正常结束
    let _ = app.emit(
        "chat-stream",
        StreamEvent {
            request_id: params.request_id,
            event_type: "done".into(),
            data: String::new(),
        },
    );

    Ok(())
}

/// 聊天附件
#[derive(Deserialize, Serialize, Clone)]
pub struct ChatAttachment {
    pub r#type: String,
    pub name: String,
    pub mime: String,
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub url: String,
}

/// 后端聊天请求参数
#[derive(Deserialize)]
pub struct BackendChatParams {
    pub message: String,
    pub session_id: Option<String>,
    pub role: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub user_id: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub attachments: Option<Vec<ChatAttachment>>,
}

/// 通过 hexclaw 后端 Agent 聊天
///
/// 后端处理完整 ReAct Agent 循环（含工具调用、RAG、搜索等）。
/// 超时 120 秒，匹配后端 2 分钟处理上限。
#[tauri::command]
pub async fn backend_chat(params: BackendChatParams) -> Result<String, String> {
    let url = format!("{}/api/v1/chat", sidecar::base_url());

    let mut body = serde_json::json!({
        "message": params.message,
        "session_id": params.session_id.unwrap_or_default(),
        "user_id": params.user_id.unwrap_or_else(|| "desktop-user".into()),
        "role": params.role.unwrap_or_default(),
        "provider": params.provider.unwrap_or_default(),
        "model": params.model.unwrap_or_default(),
    });
    if let Some(t) = params.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = params.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }
    if let Some(attachments) = params.attachments {
        body["attachments"] = serde_json::to_value(attachments).unwrap_or_default();
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status >= 400 {
        return Err(format!("HTTP {}: {}", status, text));
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
