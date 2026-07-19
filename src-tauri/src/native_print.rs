//! Native print adapter for K12 printable artifacts (DD-023A).
//!
//! The frontend supplies ephemeral, already-sanitized printable HTML. On macOS we load it into
//! an isolated hidden WKWebView and run `NSPrintOperation` with the system print panel enabled.
//! `runOperation` is deliberately synchronous on the UI thread: its boolean is the native receipt
//! that distinguishes Print from Cancel/failure. No HTML/PDF file is persisted by this adapter.

const MAX_PRINT_HTML_BYTES: usize = 4 * 1024 * 1024;

fn validate_print_html(html: &str) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("打印内容不能为空".into());
    }
    if html.len() > MAX_PRINT_HTML_BYTES {
        return Err(format!(
            "打印内容过大 {} > {} 字节",
            html.len(),
            MAX_PRINT_HTML_BYTES
        ));
    }
    Ok(())
}

fn initialization_script(html: &str) -> Result<String, String> {
    let source = serde_json::to_string(html).map_err(|e| format!("打印内容编码失败: {e}"))?;
    Ok(format!(
        r#"(() => {{
  const source = {source};
  document.addEventListener('DOMContentLoaded', () => {{
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    document.title = parsed.title || 'HexClaw Print';
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    window.__HEXCLAW_PRINT_READY__ = true;
  }}, {{ once: true }});
}})();"#
    ))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{initialization_script, validate_print_html};
    use objc2_app_kit::NSPrintInfo;
    use objc2_web_kit::WKWebView;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    };
    use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};
    use tokio::sync::oneshot;

    type PrintResult = Result<bool, String>;
    type ResultSender = Arc<Mutex<Option<oneshot::Sender<PrintResult>>>>;

    static PRINT_WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn send_once(sender: &ResultSender, result: PrintResult) {
        if let Ok(mut guard) = sender.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    }

    fn run_operation(webview: tauri::webview::PlatformWebview) -> PrintResult {
        let ptr = webview.inner().cast::<WKWebView>();
        if ptr.is_null() {
            return Err("无法取得系统打印视图".into());
        }

        // SAFETY: Tauri guarantees this closure runs on the main thread and `inner()` is the
        // retained WKWebView for the lifetime of the callback. AppKit printing is main-thread-only.
        let operation = unsafe {
            let webview = &*ptr;
            let print_info = NSPrintInfo::sharedPrintInfo();
            webview.printOperationWithPrintInfo(&print_info)
        };
        operation.setShowsPrintPanel(true);
        operation.setShowsProgressPanel(true);
        // If AppKit spawns the operation separately, runOperation may return before the user has
        // accepted/cancelled. Keep it synchronous so the boolean is an actual native receipt.
        operation.setCanSpawnSeparateThread(false);
        Ok(operation.runOperation())
    }

    pub async fn print_html(app: tauri::AppHandle, html: String) -> PrintResult {
        validate_print_html(&html)?;
        let script = initialization_script(&html)?;
        let sequence = PRINT_WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let label = format!("native-print-{sequence}");
        let url = "about:blank"
            .parse()
            .map_err(|e| format!("初始化打印视图失败: {e}"))?;

        let (tx, rx) = oneshot::channel::<PrintResult>();
        let sender: ResultSender = Arc::new(Mutex::new(Some(tx)));
        let callback_sender = Arc::clone(&sender);
        let started = Arc::new(AtomicBool::new(false));
        let callback_started = Arc::clone(&started);

        WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
            .title("HexClaw Print")
            .inner_size(1.0, 1.0)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .initialization_script(script)
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished)
                    || callback_started.swap(true, Ordering::SeqCst)
                {
                    return;
                }

                let operation_sender = Arc::clone(&callback_sender);
                let schedule_error_sender = Arc::clone(&callback_sender);
                let window_to_close = window.clone();
                if let Err(e) = window.with_webview(move |webview| {
                    let result = run_operation(webview);
                    let _ = window_to_close.close();
                    send_once(&operation_sender, result);
                }) {
                    let _ = window.close();
                    send_once(
                        &schedule_error_sender,
                        Err(format!("无法启动系统打印对话框: {e}")),
                    );
                }
            })
            .build()
            .map_err(|e| format!("创建打印视图失败: {e}"))?;

        rx.await
            .map_err(|_| "系统打印对话框未返回结果".to_string())?
    }
}

/// Open the native print dialog for ephemeral HTML and return the OS operation result.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn native_print_html(app: tauri::AppHandle, html: String) -> Result<bool, String> {
    platform::print_html(app, html).await
}

/// DD-023A forbids a save-file fallback on platforms without a verifiable native adapter.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn native_print_html(_app: tauri::AppHandle, html: String) -> Result<bool, String> {
    validate_print_html(&html)?;
    Err("当前平台尚无可验证的原生打印适配器".into())
}

#[cfg(test)]
mod tests {
    use super::{initialization_script, validate_print_html, MAX_PRINT_HTML_BYTES};

    #[test]
    fn rejects_empty_and_oversized_print_payloads() {
        assert!(validate_print_html("  ").is_err());
        assert!(validate_print_html(&"x".repeat(MAX_PRINT_HTML_BYTES + 1)).is_err());
        assert!(validate_print_html("<!doctype html><p>ok</p>").is_ok());
    }

    #[test]
    fn initialization_script_json_encodes_untrusted_document_text() {
        let script = initialization_script("<p>`quote` \"中文\"</p>").unwrap();
        assert!(script.contains("DOMParser"));
        assert!(script.contains("\\\"中文\\\""));
        assert!(script.contains("__HEXCLAW_PRINT_READY__"));
    }
}
