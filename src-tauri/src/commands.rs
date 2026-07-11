// Tauri Commands
//
// 前端可通过 invoke() 调用的系统级操作。
// 业务逻辑不放在这里，业务 API 全部走 hexclaw REST API。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
        // BUG-20260523: 升 120 → 600 秒（10 分钟）。
        // claude / thinking 模型 + 多工具 + 长 prompt 推理常超 2 分钟，
        // 旧 120s 会导致前端报 "error sending request for url"。
        .timeout(std::time::Duration::from_secs(600))
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
    pub request_id: Option<String>,
    pub metadata: Option<HashMap<String, String>>,
    pub attachments: Option<Vec<ChatAttachment>>,
}

/// 通过 hexclaw 后端 Agent 聊天 — **SSE 流式版**（BUG-20260523-v2 架构修复）
///
/// 旧设计（同步阻塞）：HTTP POST 阻塞等 sidecar 把整个 ReAct 循环跑完才返回。
/// 这迫使前端给一个"时长不可预测"的 LLM 操作设固定 HTTP 总超时（曾经 120s / 600s），
/// 触发 "error sending request for url" + "Assistant reply stalled" 假错误。
///
/// 新设计（端到端 SSE）：
///   1. 请求 header 带 `Accept: text/event-stream`，sidecar 走 SSE 分支
///   2. 用 `bytes_stream` 增量消费响应体
///   3. 每 chunk 通过 Tauri event `backend-chat-stream` 推前端
///   4. 卡死判定改用 **chunk 间空闲超时**（idle timeout, 60s）—— 真实卡死才报错
///   5. 总时长 timeout 保留 30 分钟仅作 zombie 兜底
///
/// 返回值：最终累积的 reply 文本（向后兼容，前端不监听 chunk 也能用）。
#[tauri::command]
pub async fn backend_chat(
    app: tauri::AppHandle,
    params: BackendChatParams,
) -> Result<String, String> {
    /// chunk 间空闲超时：sidecar 60s 没新 chunk 即判卡死。
    /// 比"总时长 timeout"更符合 streaming 语义——chunk 持续到来证明系统还活着。
    const CHUNK_IDLE_TIMEOUT_SECS: u64 = 60;
    /// 首 chunk 超时（独立且更长）：多 skill ReAct + 本地大模型（如 qwen3.5:9b 跑 CPU）在**首个内容
    /// chunk 前**有很长的思考/工具阶段（真机实测 tutor 首 chunk ~214s，思考期无任何输出）。若沿用 60s
    /// 空闲超时会把慢但活着的 agent 误判卡死 → 空回复（BUG-20260708 F3）。故首 chunk 前用长超时容忍思考期，
    /// 收到首 chunk 后切回 60s 空闲超时防中途真卡死。
    const FIRST_CHUNK_TIMEOUT_SECS: u64 = 300;
    /// 总时长 timeout：仅作 zombie 连接兜底。
    /// streaming 架构下不应作 LLM SLA 边界（LLM 复杂任务 30 min 也可能正常完成）。
    const ZOMBIE_TIMEOUT_SECS: u64 = 1800;

    let url = format!("{}/api/v1/chat", sidecar::base_url());
    let request_id_for_log = params
        .request_id
        .as_deref()
        .unwrap_or("(unset)")
        .to_string();

    log::info!(
        "[backend_chat] → 准备 SSE 请求 url={} session={:?} model={:?} request_id={}",
        url,
        params.session_id.as_deref().unwrap_or(""),
        params.model.as_deref().unwrap_or(""),
        request_id_for_log,
    );

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
    if let Some(request_id) = params.request_id {
        if !request_id.is_empty() {
            body["request_id"] = serde_json::json!(request_id);
        }
    }
    if let Some(metadata) = params.metadata {
        if !metadata.is_empty() {
            body["metadata"] = serde_json::json!(metadata);
        }
    }
    if let Some(attachments) = params.attachments {
        body["attachments"] = serde_json::to_value(&attachments)
            .map_err(|e| format!("Failed to serialize attachments: {}", e))?;
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream") // ★ 触发 sidecar SSE 分支
        // 仅作 zombie 兜底（30 min）。真实卡死由 CHUNK_IDLE_TIMEOUT_SECS 检测。
        .timeout(std::time::Duration::from_secs(ZOMBIE_TIMEOUT_SECS))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| {
            log::error!("[backend_chat] HTTP 请求失败 request_id={} err={}", request_id_for_log, e);
            format!("请求失败: {}", e)
        })?;

    let status = resp.status().as_u16();
    log::info!(
        "[backend_chat] ← 收到 HTTP 响应 status={} request_id={} ct={:?}",
        status,
        request_id_for_log,
        resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
    );

    if status >= 400 {
        let text = resp.text().await.unwrap_or_default();
        log::error!("[backend_chat] HTTP {} body={} request_id={}", status, text, request_id_for_log);
        return Err(format!("HTTP {}: {}", status, text));
    }

    // 增量消费 SSE 流；每 chunk emit 一次 event；按行解析 `data: ...`
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut accumulated_reply = String::new();
    // 捕获后端 SSE 最后那个 Done=true 的 ReplyChunk（带 metadata.session_id / usage /
    // tool_calls / blocks）；[DONE] 与自然结束返回时用它构造完整响应（契约#1）。
    let mut done_chunk: Option<serde_json::Value> = None;
    let mut chunk_count: u64 = 0;
    let idle = std::time::Duration::from_secs(CHUNK_IDLE_TIMEOUT_SECS);
    let first_chunk = std::time::Duration::from_secs(FIRST_CHUNK_TIMEOUT_SECS);

    loop {
        // 首 chunk 前用长超时（容忍慢本地模型/多步 ReAct 思考期，无输出）；收到首 chunk 后切回 60s
        // 空闲超时（防中途真卡死）。chunk_count==0 = 尚未收到任何内容 chunk（BUG-20260708 F3）。
        let wait = if chunk_count == 0 { first_chunk } else { idle };
        let waited_secs = wait.as_secs();
        match tokio::time::timeout(wait, stream.next()).await {
            Err(_) => {
                log::error!(
                    "[backend_chat] CHUNK_IDLE_TIMEOUT 触发 — sidecar {}s 无新 chunk \
                     已收 {} chunks request_id={}",
                    waited_secs,
                    chunk_count,
                    request_id_for_log,
                );
                let _ = app.emit(
                    "backend-chat-stream",
                    BackendChatStreamEvent {
                        request_id: request_id_for_log.clone(),
                        event_type: "error".into(),
                        data: format!(
                            "上游 {}s 无新数据，判定卡死（已收 {} chunks）",
                            waited_secs, chunk_count
                        ),
                    },
                );
                return Err(format!(
                    "Sidecar {}s 无新 chunk，疑似卡死",
                    waited_secs
                ));
            }
            Ok(None) => break, // 流自然结束
            Ok(Some(Err(e))) => {
                log::error!(
                    "[backend_chat] 读 stream 失败 chunks_so_far={} request_id={} err={}",
                    chunk_count, request_id_for_log, e
                );
                return Err(format!("读取流失败: {}", e));
            }
            Ok(Some(Ok(bytes))) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                // SSE 按 `\n\n` 分事件，但 chunked 边界不对齐——逐行扫 `data: `
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();
                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let payload = &line[6..];

                    if payload == "[DONE]" {
                        log::info!(
                            "[backend_chat] [DONE] 收到 chunks={} reply_len={} request_id={}",
                            chunk_count, accumulated_reply.len(), request_id_for_log
                        );
                        let _ = app.emit(
                            "backend-chat-stream",
                            BackendChatStreamEvent {
                                request_id: request_id_for_log.clone(),
                                event_type: "done".into(),
                                data: String::new(),
                            },
                        );
                        // 返回累积的 reply + done chunk 捕获的 session_id/usage/tool_calls/blocks
                        // （向后兼容：前端不监听 event 也能拿到完整内容与元数据）。
                        return Ok(build_final_chat_response(
                            &accumulated_reply,
                            done_chunk.as_ref(),
                        ));
                    }

                    chunk_count += 1;

                    // 解析 chunk JSON 累积 content（reasoning / metadata 仅 emit 不累积到 reply）
                    if let Ok(j) = serde_json::from_str::<serde_json::Value>(payload) {
                        if let Some(c) = j.get("content").and_then(|v| v.as_str()) {
                            accumulated_reply.push_str(c);
                        }
                        // Done=true 的 chunk 带 metadata.session_id / usage / tool_calls / blocks，
                        // 捕获到局部变量，供 [DONE] / 自然结束返回时透传前端（契约#1）。
                        if j.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                            done_chunk = Some(j.clone());
                        }
                        if let Some(err_msg) = j.get("error").and_then(|v| v.as_str()) {
                            log::error!(
                                "[backend_chat] chunk 含 error chunk={} err={} request_id={}",
                                chunk_count, err_msg, request_id_for_log
                            );
                            let _ = app.emit(
                                "backend-chat-stream",
                                BackendChatStreamEvent {
                                    request_id: request_id_for_log.clone(),
                                    event_type: "error".into(),
                                    data: err_msg.to_string(),
                                },
                            );
                            return Err(err_msg.to_string());
                        }
                    }

                    let _ = app.emit(
                        "backend-chat-stream",
                        BackendChatStreamEvent {
                            request_id: request_id_for_log.clone(),
                            event_type: "chunk".into(),
                            data: payload.to_string(),
                        },
                    );
                }
            }
        }
    }

    log::warn!(
        "[backend_chat] 流自然结束但未见 [DONE] chunks={} reply_len={} request_id={}",
        chunk_count, accumulated_reply.len(), request_id_for_log
    );
    Ok(build_final_chat_response(
        &accumulated_reply,
        done_chunk.as_ref(),
    ))
}

/// 从累积文本 + 可选的 done chunk（后端 SSE 最后那个 `Done=true` 的 ReplyChunk JSON）构造
/// backend_chat 的最终响应 JSON 字符串。
///
/// 契约#1：后端 `adapter.ReplyChunk` 在 `Done=true` 时才填充 `metadata`(含 `session_id`) /
/// `usage` / `tool_calls` / `blocks`。旧实现只回 `{reply, session_id:""}`，把这些字段全丢了，
/// 导致前端 `BackendChatResponse` 的 session_id/usage/tool_calls/blocks 恒空。此处一并透传。
///
/// 抽成纯函数以便脱离 tauri runtime 做单元测试。
fn build_final_chat_response(
    accumulated_reply: &str,
    done_chunk: Option<&serde_json::Value>,
) -> String {
    let mut resp = serde_json::json!({
        "reply": accumulated_reply,
        "session_id": "",
    });

    if let Some(dc) = done_chunk {
        if let Some(meta) = dc.get("metadata").filter(|v| !v.is_null()) {
            if let Some(sid) = meta.get("session_id").and_then(|v| v.as_str()) {
                resp["session_id"] = serde_json::json!(sid);
            }
            resp["metadata"] = meta.clone();
        }
        if let Some(usage) = dc.get("usage").filter(|v| !v.is_null()) {
            resp["usage"] = usage.clone();
        }
        if let Some(tool_calls) = dc.get("tool_calls").filter(|v| !v.is_null()) {
            resp["tool_calls"] = tool_calls.clone();
        }
        if let Some(blocks) = dc.get("blocks").filter(|v| !v.is_null()) {
            resp["blocks"] = blocks.clone();
        }
    }

    resp.to_string()
}

/// backend_chat 的流式事件载荷（向前端推 chunk / done / error）。
#[derive(Clone, Serialize)]
pub struct BackendChatStreamEvent {
    pub request_id: String,
    pub event_type: String, // "chunk" / "done" / "error"
    pub data: String,
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

/// 校验目标路径：必须绝对 + 不含 `..` + 父目录存在
fn validate_save_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    if path.contains("..") {
        return Err("path must not contain '..'".into());
    }
    let parent = p.parent().ok_or("path has no parent")?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {}", parent.display()));
    }
    Ok(p)
}

/// 从 URL 下载并写入用户选择的路径
///
/// 允许 http/https；不允许 cloud metadata。支持 sidecar localhost（要下载 hexclaw
/// 后端 file server 的生成物）。10 MiB 上限避免内存爆炸。
#[tauri::command]
pub async fn save_file_from_url(url: String, path: String) -> Result<u64, String> {
    let p = validate_save_path(&path)?;

    // URL 校验
    let parsed = url.parse::<url::Url>().map_err(|e| format!("invalid URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("unsupported scheme: {}", scheme));
    }
    if let Some(host) = parsed.host_str() {
        if host == "169.254.169.254" || host == "metadata.google.internal" {
            return Err("blocked: cloud metadata endpoint".into());
        }
    }

    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    const MAX_BYTES: usize = 100 * 1024 * 1024;
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("文件过大 {} > {} 字节", bytes.len(), MAX_BYTES));
    }

    std::fs::write(&p, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    Ok(bytes.len() as u64)
}

/// 将前端提供的 base64 字节写入用户选择的路径（用于 data: URL）
#[tauri::command]
pub fn save_bytes_to_path(base64_data: String, path: String) -> Result<u64, String> {
    use base64::Engine as _;
    let p = validate_save_path(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    const MAX_BYTES: usize = 100 * 1024 * 1024;
    if bytes.len() > MAX_BYTES {
        return Err(format!("文件过大 {} > {} 字节", bytes.len(), MAX_BYTES));
    }
    std::fs::write(&p, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    Ok(bytes.len() as u64)
}

/// 读取本地文件为 base64（会话框原生拖拽上传用：Tauri onDragDropEvent 只给路径）。
#[derive(Serialize)]
pub struct ReadFileResult {
    pub base64: String,
    pub name: String,
    pub mime: String,
}

#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<ReadFileResult, String> {
    use base64::Engine as _;
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("读取失败: {}", e))?;
    if !meta.is_file() {
        return Err("不是文件".to_string());
    }
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return Err(format!("文件过大 {} > {} 字节", meta.len(), MAX_BYTES));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取失败: {}", e))?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
    .to_string();
    Ok(ReadFileResult {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        name,
        mime,
    })
}

// ─── 文档渲染（POST /api/v1/render → 流式直写文件）──────────────────
//
// markdown → docx/pdf/epub/odt/rtf/txt/html/md，由 sidecar 渲染层处理。
//
// 关键设计（详见 hexclaw/.claude/doc-generation-architecture.md）：
//   - reqwest 流式下载 sidecar 响应 → tokio::fs::File 直写用户选定路径
//   - **不经过 base64 / 不进 JS string**——避免 100 MB 输出在三处放大内存
//   - 复用 validate_save_path 路径校验
//   - 错误分支按 sidecar 返回的 RenderError JSON 透传

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RenderOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(rename = "AllowRawHTML", skip_serializing_if = "is_false_ref")]
    pub allow_raw_html: bool,
    #[serde(rename = "AllowRawTeX", skip_serializing_if = "is_false_ref")]
    pub allow_raw_tex: bool,
}

fn is_false_ref(b: &bool) -> bool { !*b }

#[derive(Debug, Serialize)]
struct RenderRequest<'a> {
    content: &'a str,
    format: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<&'a RenderOptions>,
}

#[derive(Debug, Deserialize)]
struct RenderErrorResponse {
    error: RenderError,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RenderError {
    pub code: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub detail: String,
}

/// 渲染 markdown artifact 并流式写入用户选定的本地路径。
#[tauri::command]
pub async fn render_artifact_to_path(
    content: String,
    format: String,
    target_path: String,
    title: Option<String>,
    options: Option<RenderOptions>,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;

    let p = validate_save_path(&target_path)?;

    let title_str = title.unwrap_or_default();
    let body = RenderRequest {
        content: &content,
        format: &format,
        title: &title_str,
        options: options.as_ref(),
    };

    let url = format!("{}/api/v1/render", sidecar::base_url());
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("sidecar 不可达: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        if let Ok(err_resp) = serde_json::from_str::<RenderErrorResponse>(&text) {
            return Err(serde_json::to_string(&err_resp.error).unwrap_or(text));
        }
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    let mut file = tokio::fs::File::create(&p)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取响应流失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败: {}", e))?;
        total += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| format!("flush 失败: {}", e))?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 真机 E2E（real fs）：read_file_as_base64 读真实磁盘文件 → 还原字节 + 推断 MIME。
    // 对应会话框拖拽上传链路的「路径→字节」半段（BUG-20260622-CHATINPUT-DROP）。
    #[test]
    fn test_read_file_as_base64_real_image() {
        use base64::Engine as _;

        // 写一个真实 .png 文件到临时目录（PNG magic header + 任意载荷）
        let payload: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG magic
            0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xAB, 0xCD, // 任意字节
        ];
        let path = std::env::temp_dir().join(format!("hexclaw_e2e_drop_{}.png", std::process::id()));
        std::fs::write(&path, &payload).expect("写临时图片失败");

        let res = read_file_as_base64(path.to_string_lossy().to_string()).expect("读取应成功");

        // 文件名 + MIME 推断
        assert_eq!(res.name, path.file_name().unwrap().to_str().unwrap());
        assert_eq!(res.mime, "image/png");
        // base64 还原 == 原始字节（无损）
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(res.base64.as_bytes())
            .expect("base64 解码失败");
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(&path); // 清理
    }

    #[test]
    fn test_read_file_as_base64_rejects_missing_and_dir() {
        // 不存在的路径报错（不 panic）
        assert!(read_file_as_base64("/no/such/hexclaw/file.png".into()).is_err());
        // 目录不是文件
        assert!(read_file_as_base64(std::env::temp_dir().to_string_lossy().to_string()).is_err());
    }

    // ── 契约#1：backend_chat SSE done chunk 透传 ──
    // 后端 SSE 最后发 Done=true 的 ReplyChunk（metadata.session_id / usage / tool_calls / blocks），
    // 旧实现只回 {reply, session_id:""}，把这些字段全丢了。build_final_chat_response 负责透传。

    // RED 基线：无 done chunk（旧行为）——只回 reply + 空 session_id，无 usage/tool_calls/blocks。
    #[test]
    fn test_build_final_chat_response_no_done_chunk_is_old_behavior() {
        let out = build_final_chat_response("hello world", None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["reply"], "hello world");
        assert_eq!(v["session_id"], "");
        // 旧行为：这些字段缺失（不是被丢弃后填空，而是压根没有）
        assert!(v.get("usage").is_none());
        assert!(v.get("tool_calls").is_none());
        assert!(v.get("blocks").is_none());
    }

    // GREEN：解析 done chunk 后返回带 session_id / usage / tool_calls / blocks / metadata 的完整 JSON。
    #[test]
    fn test_build_final_chat_response_extracts_done_chunk_fields() {
        // 模拟后端 adapter.ReplyChunk（Done=true）序列化出的 JSON
        let done = serde_json::json!({
            "content": "",
            "done": true,
            "metadata": { "session_id": "sess-abc-123", "request_id": "req-9" },
            "usage": {
                "input_tokens": 12,
                "output_tokens": 34,
                "total_tokens": 46,
                "provider": "openai",
                "model": "gpt-4o"
            },
            "tool_calls": [ { "name": "search", "arguments": "{}" } ],
            "blocks": [ { "type": "text", "text": "hi" } ]
        });

        let out = build_final_chat_response("final reply", Some(&done));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(v["reply"], "final reply");
        // session_id 从 metadata.session_id 提取（不再恒空）
        assert_eq!(v["session_id"], "sess-abc-123");
        // usage 透传（含后端命名 input_tokens/output_tokens）
        assert_eq!(v["usage"]["input_tokens"], 12);
        assert_eq!(v["usage"]["output_tokens"], 34);
        assert_eq!(v["usage"]["total_tokens"], 46);
        // tool_calls / blocks 透传
        assert_eq!(v["tool_calls"][0]["name"], "search");
        assert_eq!(v["blocks"][0]["type"], "text");
        // metadata 也透传（前端 BackendChatResponse 声明了 metadata）
        assert_eq!(v["metadata"]["session_id"], "sess-abc-123");
    }

    // 边界：done chunk 存在但无 metadata（session_id 缺失）——降级回空串，不 panic。
    #[test]
    fn test_build_final_chat_response_done_chunk_without_metadata() {
        let done = serde_json::json!({ "content": "", "done": true });
        let out = build_final_chat_response("r", Some(&done));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "");
        assert!(v.get("usage").is_none());
    }
}
