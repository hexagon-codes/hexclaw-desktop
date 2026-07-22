//! Native print adapter for K12 printable artifacts (DD-023A).
//!
//! Durable K12 PrintJobs supply the exact PDF bytes already shown in preview. On macOS PDFKit
//! creates `NSPrintOperation` directly from those bytes, so no WebView can reflow final pages.
//! `runOperation` is deliberately synchronous on the UI thread. Its result is wrapped in a typed,
//! operation-scoped receipt that distinguishes Print from Cancel/failure and can be committed to
//! the durable backend PrintJob. No HTML/PDF file is persisted by this adapter.

use base64::Engine;

const MAX_PRINT_PDF_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
struct NativePrinterSnapshot {
    adapter: &'static str,
    platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    printer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paper: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NativePrintReceipt {
    status: &'static str,
    native_job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_receipt_id: Option<String>,
    printer_snapshot: NativePrinterSnapshot,
}

fn receipt_from_result(
    sequence: u64,
    printed: bool,
    printer: Option<String>,
    paper: Option<String>,
) -> NativePrintReceipt {
    let native_job_id = format!("native-print-{sequence}");
    let native_receipt_id = printed.then(|| {
        let observed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("appkit-receipt-{sequence}-{observed_at}")
    });
    NativePrintReceipt {
        status: if printed { "printed" } else { "cancelled" },
        native_job_id,
        native_receipt_id,
        printer_snapshot: NativePrinterSnapshot {
            adapter: "appkit",
            platform: if cfg!(target_os = "macos") {
                "macos"
            } else {
                "unsupported"
            },
            printer,
            paper,
        },
    }
}

fn decode_print_pdf(pdf_base64: &str) -> Result<Vec<u8>, String> {
    let encoded = pdf_base64.trim();
    if encoded.is_empty() {
        return Err("打印 PDF 不能为空".into());
    }
    let max_encoded_len = MAX_PRINT_PDF_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_encoded_len {
        return Err(format!(
            "打印 PDF 编码过大 {} > {} 字节",
            encoded.len(),
            max_encoded_len
        ));
    }
    let pdf = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("打印 PDF 编码无效: {e}"))?;
    if pdf.is_empty() {
        return Err("打印 PDF 不能为空".into());
    }
    if pdf.len() > MAX_PRINT_PDF_BYTES {
        return Err(format!(
            "打印 PDF 过大 {} > {} 字节",
            pdf.len(),
            MAX_PRINT_PDF_BYTES
        ));
    }
    if !pdf.starts_with(b"%PDF-") {
        return Err("打印内容不是有效的 PDF 文档".into());
    }
    Ok(pdf)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{decode_print_pdf, receipt_from_result, NativePrintReceipt};
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::NSPrintInfo;
    use objc2_foundation::NSData;
    use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };
    use tokio::sync::oneshot;

    type PrintResult = Result<NativePrintReceipt, String>;
    type ResultSender = Arc<Mutex<Option<oneshot::Sender<PrintResult>>>>;

    static PRINT_WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn send_once(sender: &ResultSender, result: PrintResult) {
        if let Ok(mut guard) = sender.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    }

    fn run_pdf_operation(pdf: &[u8], sequence: u64) -> Result<NativePrintReceipt, String> {
        let mtm =
            MainThreadMarker::new().ok_or_else(|| "系统 PDF 打印必须在主线程启动".to_string())?;
        // SAFETY: `pdf` remains alive for the duration of this call and NSData copies the bytes.
        let data = unsafe { NSData::dataWithBytes_length(pdf.as_ptr().cast(), pdf.len()) };
        // SAFETY: PDFKit parsing and print-operation construction execute on AppKit's main thread.
        let document = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
            .ok_or_else(|| "系统无法解析打印 PDF".to_string())?;
        if unsafe { document.pageCount() } == 0 {
            return Err("打印 PDF 不包含可打印页面".into());
        }

        let print_info = NSPrintInfo::sharedPrintInfo();
        // `PageScaleDownToFit` preserves the canonical PDF page geometry and only prevents a
        // printer's non-printable margins from clipping it; PDFKit does not reflow content.
        let operation = unsafe {
            document.printOperationForPrintInfo_scalingMode_autoRotate(
                Some(&print_info),
                PDFPrintScalingMode::PageScaleDownToFit,
                true,
                mtm,
            )
        }
        .ok_or_else(|| "系统无法创建 PDF 打印任务".to_string())?;
        operation.setShowsPrintPanel(true);
        operation.setShowsProgressPanel(true);
        operation.setCanSpawnSeparateThread(false);
        let printed = operation.runOperation();
        let printer = Some(print_info.printer().name().to_string());
        let paper = print_info.paperName().map(|name| name.to_string());
        Ok(receipt_from_result(sequence, printed, printer, paper))
    }

    pub async fn print_pdf(app: tauri::AppHandle, pdf_base64: String) -> PrintResult {
        let pdf = decode_print_pdf(&pdf_base64)?;
        let sequence = PRINT_WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<PrintResult>();
        let sender: ResultSender = Arc::new(Mutex::new(Some(tx)));
        let main_sender = Arc::clone(&sender);

        if let Err(error) = app.run_on_main_thread(move || {
            send_once(&main_sender, run_pdf_operation(&pdf, sequence));
        }) {
            send_once(
                &sender,
                Err(format!("无法在主线程启动系统 PDF 打印对话框: {error}")),
            );
        }

        rx.await
            .map_err(|_| "系统 PDF 打印对话框未返回结果".to_string())?
    }
}

/// Print an in-memory canonical PDF with PDFKit/AppKit. PDFKit consumes the exact bytes already
/// shown in the preview, so the native print operation cannot reflow the document.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn native_print_pdf(
    app: tauri::AppHandle,
    pdf_base64: String,
) -> Result<NativePrintReceipt, String> {
    platform::print_pdf(app, pdf_base64).await
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn native_print_pdf(
    _app: tauri::AppHandle,
    pdf_base64: String,
) -> Result<NativePrintReceipt, String> {
    decode_print_pdf(&pdf_base64)?;
    Err("当前平台尚无可验证的原生 PDF 打印适配器".into())
}

#[cfg(test)]
mod tests {
    use super::{decode_print_pdf, receipt_from_result, MAX_PRINT_PDF_BYTES};

    #[test]
    fn native_result_has_a_typed_operation_and_success_only_receipt() {
        let printed =
            receipt_from_result(42, true, Some("EPSON L3250".into()), Some("iso-a4".into()));
        assert_eq!(printed.status, "printed");
        assert_eq!(printed.native_job_id, "native-print-42");
        assert!(printed.native_receipt_id.is_some());
        assert_eq!(printed.printer_snapshot.adapter, "appkit");
        assert_eq!(
            printed.printer_snapshot.printer.as_deref(),
            Some("EPSON L3250")
        );
        assert_eq!(printed.printer_snapshot.paper.as_deref(), Some("iso-a4"));

        let cancelled = receipt_from_result(43, false, None, None);
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.native_job_id, "native-print-43");
        assert!(cancelled.native_receipt_id.is_none());
    }

    #[test]
    fn pdf_payload_requires_exact_pdf_magic_and_enforces_the_decoded_size_limit() {
        let decoded = decode_print_pdf("JVBERi0xLjc=").expect("valid PDF payload");
        assert_eq!(decoded, b"%PDF-1.7");

        assert!(decode_print_pdf("").is_err());
        assert!(decode_print_pdf("PGh0bWw+").is_err());
        assert!(decode_print_pdf("not base64").is_err());

        // Reject before decoding an attacker-controlled payload large enough to exceed the cap.
        let encoded_over_limit = "A".repeat(((MAX_PRINT_PDF_BYTES + 2) / 3) * 4 + 4);
        assert!(decode_print_pdf(&encoded_over_limit).is_err());
    }
}
