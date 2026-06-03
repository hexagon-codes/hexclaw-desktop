//! BUG-20260523-v2 架构契约回归测试
//!
//! 背景：v1 测试（bug_20260523_chat_timeout_regression.rs）已把 timeout 从 120s 提到 600s
//!      作为应急止血。但根因是**架构错位**：sidecar 内部跑 ProcessStream 流式消费，
//!      HTTP 层却把全部 chunk 攒成完整 JSON 才返回；前端被迫给一个"流式操作"
//!      设固定 HTTP 总时长上限。
//!
//! 修法：把端到端改为 SSE 流式 ——
//!   1. sidecar `/api/v1/chat` 检测 `Accept: text/event-stream` 切到 SSE 模式
//!   2. Tauri `backend_chat` 加 `Accept: text/event-stream` + 用 `bytes_stream` 消费
//!   3. 每个 chunk 通过 Tauri event 推前端，前端 listener 累积
//!
//! 本测试以**架构契约**为粒度断言 backend_chat 改造完整：
//!   - 必须显式声明接受 SSE (`text/event-stream`)
//!   - 必须使用流式 body 消费 (`bytes_stream`)
//!   - 必须 emit 增量 chunk 事件
//!   - 总时长 timeout 仅保留为 zombie 兜底（>= 1800s），不再作为 LLM SLA 边界
//!
//! 任一项缺失会立即 FAIL，强制未来重构不退回"同步阻塞 + 短 timeout"反模式。

use std::fs;
use std::path::PathBuf;

fn extract_fn_body(src: &str, fn_name: &str) -> Option<String> {
    let needle = format!("pub async fn {}", fn_name);
    let start = src.find(&needle)?;
    let brace_open = src[start..].find('{')? + start;
    let bytes = src.as_bytes();
    let mut depth = 1i32;
    let mut i = brace_open + 1;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    Some(src[brace_open..i].to_string())
}

fn extract_from_secs_values(body: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let needle = "from_secs(";
    let mut cursor = 0usize;
    while let Some(rel) = body[cursor..].find(needle) {
        let start = cursor + rel + needle.len();
        let end = match body[start..].find(')') {
            Some(p) => start + p,
            None => break,
        };
        if let Ok(n) = body[start..end].trim().parse::<u64>() {
            out.push(n);
        }
        cursor = end + 1;
    }
    out
}

#[test]
fn bug_20260523_v2_backend_chat_must_be_streaming() {
    let path = PathBuf::from("src/commands.rs");
    let src = fs::read_to_string(&path).expect("读 commands.rs 失败");

    let body = extract_fn_body(&src, "backend_chat")
        .expect("找不到 pub async fn backend_chat — 是不是被重命名了？");

    let mut violations: Vec<String> = Vec::new();

    // 契约 1：必须显式声明接受 SSE（向 sidecar 表达"请流式回我"）
    if !body.contains("text/event-stream") {
        violations.push(
            "缺少 `text/event-stream` —— backend_chat 必须 \
             在请求 header 中声明 Accept: text/event-stream，否则 sidecar 会走同步路径"
                .into(),
        );
    }

    // 契约 2：必须使用流式 body 消费（reqwest::Response::bytes_stream）
    if !body.contains("bytes_stream") {
        violations.push(
            "缺少 `bytes_stream` —— backend_chat 必须用 reqwest \
             bytes_stream 消费 SSE 增量，不能 .text().await 一次拿全部"
                .into(),
        );
    }

    // 契约 3：必须 emit 增量 chunk 事件给前端
    //   事件名约定 `backend-chat-stream`（与 stream_chat 的 chat-stream 区分）
    if !body.contains("backend-chat-stream") {
        violations.push(
            "缺少 `backend-chat-stream` 事件 emit —— backend_chat 必须把每个 \
             SSE chunk 通过 Tauri event 推给前端，前端用 listen() 累积"
                .into(),
        );
    }

    // 契约 4：HTTP 总时长 timeout 仅作 zombie 兜底，必须 >= 1800s（30 分钟）
    // 真正的"卡死"判定应该由 idle-between-chunks 检测兜底（chunk 间空闲 > 60s）。
    // 旧的"120s/600s 总时长"是错误抽象——LLM 推理时长本质不可预测，
    // 用 idle timeout 才符合 streaming 语义。
    let timeouts = extract_from_secs_values(&body);
    for secs in &timeouts {
        if *secs < 1800 {
            violations.push(format!(
                "总时长 timeout = {secs}s < 1800s —— streaming 架构下 \
                 HTTP 总时长 timeout 只应作 zombie 连接兜底（建议 >= 1800s）。\
                 真实卡死请用 chunk-间 idle timeout 检测"
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "BUG-20260523-v2 backend_chat 架构契约违反：\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn bug_20260523_v2_idle_timeout_must_exist_in_backend_chat() {
    // chunk 间空闲超时是 streaming 架构下"卡死检测"的正确抽象。
    // 没有 idle 检测会让 zombie 连接吞流量；有它就不需要短的总时长 timeout。
    let path = PathBuf::from("src/commands.rs");
    let src = fs::read_to_string(&path).expect("读 commands.rs 失败");

    let body = extract_fn_body(&src, "backend_chat")
        .expect("找不到 pub async fn backend_chat");

    // 标记字符串：建议使用 tokio::time::timeout 包住单次 stream.next()，
    // 或者明确出现 "idle" 字面量以便审计。
    let has_idle_marker = body.contains("idle")
        || body.contains("CHUNK_IDLE")
        || (body.contains("tokio::time::timeout") && body.contains("stream.next"));

    assert!(
        has_idle_marker,
        "BUG-20260523-v2: backend_chat 必须含 chunk 间 idle timeout 检测（\
         tokio::time::timeout 包 stream.next() 或显式标记 `idle` / `CHUNK_IDLE`），\
         否则上游卡死时前端无人感知"
    );
}
