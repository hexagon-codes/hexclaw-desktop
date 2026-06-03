//! BUG-20260523 回归测试
//!
//! 症状：前端 Tauri `backend_chat` / `stream_chat` 调 sidecar `/api/v1/chat`
//!      使用硬编码 120 秒 reqwest timeout，对 claude / thinking 模型 / 复杂工具链
//!      不够用 → 前端报 "请求失败: error sending request for url
//!      (http://localhost:16060/api/v1/chat)" + "Assistant reply stalled"。
//!
//! 根因：`src-tauri/src/commands.rs` 内 `.timeout(Duration::from_secs(120))`
//!      硬编码两处。Claude-sonnet-4-6 + 40 个工具 + 复杂任务
//!      推理时间常超 2 分钟。
//!
//! 修复方向：把 chat 类 HTTP 调用 timeout 提升到 600 秒（10 分钟）。
//!
//! 本测试永久保留作回归屏障：扫描 commands.rs 中所有 chat 相关函数
//! 的 `.timeout(Duration::from_secs(N))`，断言 N >= 300。
//! 任何未来回退到短 timeout 都会立即 FAIL。

use std::fs;
use std::path::PathBuf;

/// 提取 `pub async fn <name>(...)` 函数体（从 `{` 到匹配的 `}`）。
/// 返回 (函数名, 函数体)。
fn extract_functions(src: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let needle = "pub async fn ";
    let mut cursor = 0usize;
    while let Some(rel) = src[cursor..].find(needle) {
        let start = cursor + rel + needle.len();
        // 函数名 = 直到 `(`
        let name_end = match src[start..].find('(') {
            Some(p) => start + p,
            None => break,
        };
        let name = src[start..name_end].trim().to_string();
        // 找到第一个 `{`
        let brace_open = match src[name_end..].find('{') {
            Some(p) => name_end + p,
            None => break,
        };
        // 匹配花括号
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
        let body = src[brace_open..i].to_string();
        out.push((name, body));
        cursor = i;
    }
    out
}

/// 提取函数体内所有 `Duration::from_secs(N)` 的 N 值。
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
        let num_str = body[start..end].trim();
        if let Ok(n) = num_str.parse::<u64>() {
            out.push(n);
        }
        cursor = end + 1;
    }
    out
}

#[test]
fn bug_20260523_chat_http_timeout_must_be_at_least_300_seconds() {
    // 定位 commands.rs（测试工作目录是 crate root = src-tauri/）
    let path: PathBuf = PathBuf::from("src/commands.rs");
    assert!(
        path.exists(),
        "BUG-20260523: 找不到 {}（CWD={:?}）",
        path.display(),
        std::env::current_dir().ok()
    );
    let src = fs::read_to_string(&path).expect("读 commands.rs 失败");

    // 凡是函数名含 'chat' 的 pub async fn 都被认为是"聊天类 HTTP 调用入口"
    let chat_fns: Vec<(String, String)> = extract_functions(&src)
        .into_iter()
        .filter(|(name, _)| name.contains("chat"))
        .collect();

    assert!(
        !chat_fns.is_empty(),
        "BUG-20260523: 在 commands.rs 中没找到任何 'chat' 相关 pub async fn——\
         是不是函数被重命名了？必须更新这条测试。"
    );

    // 期望阈值：300 秒（5 分钟）—— 留出 claude / thinking 模型推理的最小余量。
    // 推荐实际取 600 秒（10 分钟），见 commands.rs 注释。
    const MIN_TIMEOUT_SECS: u64 = 300;

    let mut violations: Vec<String> = Vec::new();
    for (name, body) in &chat_fns {
        let timeouts = extract_from_secs_values(body);
        // 必须至少出现一次 timeout（否则不会有 reqwest 超时——这本身可能是隐患，
        // 但本测试只防"短 timeout"回退，不强求一定要有 timeout 调用）。
        for secs in timeouts {
            if secs < MIN_TIMEOUT_SECS {
                violations.push(format!(
                    "BUG-20260523: 函数 `{name}` 含 `Duration::from_secs({secs})`，\
                     小于最小阈值 {MIN_TIMEOUT_SECS}s——claude / thinking / 40 工具链推理常超 2 分钟，\
                     会导致 'error sending request for url' + 'Assistant reply stalled'"
                ));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "BUG-20260523 chat HTTP timeout 不达标：\n{}",
        violations.join("\n")
    );
}
