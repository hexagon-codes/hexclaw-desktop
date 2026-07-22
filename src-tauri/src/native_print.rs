//! Native print adapter for K12 printable artifacts (DD-023A).
//!
//! Durable K12 PrintJobs supply the exact PDF bytes already shown in preview. On macOS PDFKit
//! creates `NSPrintOperation` directly from those bytes, so no WebView can reflow final pages.
//! `runOperation` is deliberately synchronous on the UI thread. Its result is wrapped in a typed,
//! operation-scoped receipt that distinguishes Print from Cancel/failure and can be committed to
//! the durable backend PrintJob. No HTML/PDF file is persisted by this adapter.

use base64::Engine;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_PRINT_PDF_BYTES: usize = 32 * 1024 * 1024;
const MAX_PRINT_PAGES: usize = 500;
const MAX_MEDIA_BOX_POINTS: f64 = 14_400.0;

static PRINT_WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_print_sequence() -> u64 {
    PRINT_WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrintExecution {
    Cancelled,
    Printed,
    OutcomeUnknown,
}

fn classify_print_execution(
    panel_result: isize,
    operation_succeeded: Option<bool>,
) -> Result<PrintExecution, String> {
    match panel_result {
        0 => Ok(PrintExecution::Cancelled),
        1 => match operation_succeeded {
            Some(true) => Ok(PrintExecution::Printed),
            Some(false) => Ok(PrintExecution::OutcomeUnknown),
            None => Err("系统打印面板已确认，但打印任务尚未执行".into()),
        },
        _ => Ok(PrintExecution::OutcomeUnknown),
    }
}

fn validate_pdf_geometry(page_count: usize, media_boxes: &[(f64, f64)]) -> Result<(), String> {
    if page_count == 0 {
        return Err("打印 PDF 不包含可打印页面".into());
    }
    if page_count > MAX_PRINT_PAGES {
        return Err(format!(
            "打印 PDF 页数超过限制 {page_count} > {MAX_PRINT_PAGES}"
        ));
    }
    if media_boxes.len() != page_count {
        return Err("打印 PDF 页面结构不完整".into());
    }
    for (index, (width, height)) in media_boxes.iter().copied().enumerate() {
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width > MAX_MEDIA_BOX_POINTS
            || height > MAX_MEDIA_BOX_POINTS
        {
            return Err(format!(
                "打印 PDF 第 {} 页 MediaBox 无效: {width}×{height}",
                index + 1
            ));
        }
    }
    Ok(())
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_detail: Option<String>,
}

fn receipt_for_status(
    sequence: u64,
    status: &'static str,
    printer: Option<String>,
    paper: Option<String>,
    failure_kind: Option<&'static str>,
    failure_detail: Option<String>,
) -> NativePrintReceipt {
    let native_job_id = format!("native-print-{sequence}");
    let native_receipt_id = (status == "printed").then(|| {
        let observed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("appkit-receipt-{sequence}-{observed_at}")
    });
    NativePrintReceipt {
        status,
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
        failure_kind,
        failure_detail,
    }
}

fn failed_receipt(sequence: u64, failure_kind: &'static str, detail: String) -> NativePrintReceipt {
    receipt_for_status(
        sequence,
        "failed",
        None,
        None,
        Some(failure_kind),
        Some(detail),
    )
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
    use super::{
        classify_print_execution, decode_print_pdf, failed_receipt, next_print_sequence,
        receipt_for_status, validate_pdf_geometry, NativePrintReceipt, PrintExecution,
        MAX_PRINT_PAGES,
    };
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSPrintPanelResult};
    use objc2_foundation::NSData;
    use objc2_pdf_kit::{PDFDisplayBox, PDFDocument, PDFPrintScalingMode};
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    type PrintResult = Result<NativePrintReceipt, String>;
    type ResultSender = Arc<Mutex<Option<oneshot::Sender<PrintResult>>>>;

    fn send_once(sender: &ResultSender, result: PrintResult) {
        if let Ok(mut guard) = sender.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    }

    fn printer_facts(operation: &NSPrintOperation) -> (Option<String>, Option<String>) {
        let final_print_info = operation.printInfo();
        let printer = Some(final_print_info.printer().name().to_string());
        let paper = final_print_info.paperName().map(|name| name.to_string());
        (printer, paper)
    }

    fn run_pdf_operation(pdf: &[u8], sequence: u64) -> NativePrintReceipt {
        let Some(mtm) = MainThreadMarker::new() else {
            return failed_receipt(
                sequence,
                "main_thread_unavailable",
                "系统 PDF 打印必须在主线程启动".into(),
            );
        };
        // SAFETY: `pdf` remains alive for the duration of this call and NSData copies the bytes.
        let data = unsafe { NSData::dataWithBytes_length(pdf.as_ptr().cast(), pdf.len()) };
        // SAFETY: PDFKit parsing and print-operation construction execute on AppKit's main thread.
        let Some(document) = (unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) })
        else {
            return failed_receipt(sequence, "pdf_parse_failed", "系统无法解析打印 PDF".into());
        };
        let page_count = unsafe { document.pageCount() };
        if page_count == 0 || page_count > MAX_PRINT_PAGES {
            let detail = validate_pdf_geometry(page_count, &[]).unwrap_err();
            let kind = if page_count == 0 {
                "pdf_empty"
            } else {
                "pdf_page_limit_exceeded"
            };
            return failed_receipt(sequence, kind, detail);
        }
        let mut media_boxes = Vec::with_capacity(page_count);
        for index in 0..page_count {
            let Some(page) = (unsafe { document.pageAtIndex(index) }) else {
                return failed_receipt(
                    sequence,
                    "pdf_page_unavailable",
                    format!("系统无法读取打印 PDF 第 {} 页", index + 1),
                );
            };
            let bounds = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
            media_boxes.push((bounds.size.width, bounds.size.height));
        }
        if let Err(detail) = validate_pdf_geometry(page_count, &media_boxes) {
            return failed_receipt(sequence, "pdf_media_box_invalid", detail);
        }

        let print_info = NSPrintInfo::sharedPrintInfo();
        // `PageScaleDownToFit` preserves the canonical PDF page geometry and only prevents a
        // printer's non-printable margins from clipping it; PDFKit does not reflow content.
        let Some(operation) = (unsafe {
            document.printOperationForPrintInfo_scalingMode_autoRotate(
                Some(&print_info),
                PDFPrintScalingMode::PageScaleDownToFit,
                true,
                mtm,
            )
        }) else {
            return failed_receipt(
                sequence,
                "print_operation_create_failed",
                "系统无法创建 PDF 打印任务".into(),
            );
        };
        if NSPrintOperation::currentOperation(mtm).is_some() {
            return failed_receipt(
                sequence,
                "print_operation_busy",
                "系统已有打印任务正在运行".into(),
            );
        }

        // Use the operation-owned print info. AppKit copies the shared print info
        // at factory creation, and the panel mutates this operation copy.
        let operation_print_info = operation.printInfo();
        NSPrintOperation::setCurrentOperation(Some(&operation), mtm);
        let panel_result = operation
            .printPanel()
            .runModalWithPrintInfo(&operation_print_info);
        NSPrintOperation::setCurrentOperation(None, mtm);
        let (printer, paper) = printer_facts(&operation);
        if panel_result == NSPrintPanelResult::Cancelled.0 {
            return receipt_for_status(sequence, "cancelled", printer, paper, None, None);
        }
        if panel_result != NSPrintPanelResult::Printed.0 {
            return receipt_for_status(
                sequence,
                "outcome_unknown",
                printer,
                paper,
                Some("print_panel_result_ambiguous"),
                Some(format!("系统打印面板返回未知结果 {panel_result}")),
            );
        }

        // The user decision is already definitive. Suppress both AppKit panels
        // for execution so a false run result is an error/ambiguous spool result,
        // never misreported as a user cancellation.
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        operation.setCanSpawnSeparateThread(false);
        let execution = classify_print_execution(panel_result, Some(operation.runOperation()))
            .unwrap_or(PrintExecution::OutcomeUnknown);
        let (printer, paper) = printer_facts(&operation);
        match execution {
            PrintExecution::Printed => {
                receipt_for_status(sequence, "printed", printer, paper, None, None)
            }
            PrintExecution::Cancelled => {
                receipt_for_status(sequence, "cancelled", printer, paper, None, None)
            }
            PrintExecution::OutcomeUnknown => receipt_for_status(
                sequence,
                "outcome_unknown",
                printer,
                paper,
                Some("print_operation_result_ambiguous"),
                Some("系统已确认打印，但驱动未返回可验证的完成结果".into()),
            ),
        }
    }

    pub async fn print_pdf(app: tauri::AppHandle, pdf_base64: String) -> PrintResult {
        let sequence = next_print_sequence();
        let pdf = match decode_print_pdf(&pdf_base64) {
            Ok(pdf) => pdf,
            Err(error) => return Ok(failed_receipt(sequence, "pdf_preflight_failed", error)),
        };
        let (tx, rx) = oneshot::channel::<PrintResult>();
        let sender: ResultSender = Arc::new(Mutex::new(Some(tx)));
        let main_sender = Arc::clone(&sender);

        if let Err(error) = app.run_on_main_thread(move || {
            send_once(&main_sender, Ok(run_pdf_operation(&pdf, sequence)));
        }) {
            send_once(
                &sender,
                Ok(failed_receipt(
                    sequence,
                    "main_thread_schedule_failed",
                    format!("无法在主线程启动系统 PDF 打印对话框: {error}"),
                )),
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
    let sequence = next_print_sequence();
    if let Err(error) = decode_print_pdf(&pdf_base64) {
        return Ok(failed_receipt(sequence, "pdf_preflight_failed", error));
    }
    Ok(failed_receipt(
        sequence,
        "native_print_unavailable",
        "当前平台尚无可验证的原生 PDF 打印适配器".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_print_execution, decode_print_pdf, receipt_for_status, validate_pdf_geometry,
        PrintExecution, MAX_PRINT_PAGES, MAX_PRINT_PDF_BYTES,
    };

    #[test]
    fn native_result_has_a_typed_operation_and_success_only_receipt() {
        let printed = receipt_for_status(
            42,
            "printed",
            Some("EPSON L3250".into()),
            Some("iso-a4".into()),
            None,
            None,
        );
        assert_eq!(printed.status, "printed");
        assert_eq!(printed.native_job_id, "native-print-42");
        assert!(printed.native_receipt_id.is_some());
        assert_eq!(printed.printer_snapshot.adapter, "appkit");
        assert_eq!(
            printed.printer_snapshot.printer.as_deref(),
            Some("EPSON L3250")
        );
        assert_eq!(printed.printer_snapshot.paper.as_deref(), Some("iso-a4"));

        let cancelled = receipt_for_status(43, "cancelled", None, None, None, None);
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.native_job_id, "native-print-43");
        assert!(cancelled.native_receipt_id.is_none());
    }

    #[test]
    fn print_panel_cancel_is_distinct_from_post_confirmation_operation_failure() {
        assert_eq!(
            classify_print_execution(0, None).expect("cancel result"),
            PrintExecution::Cancelled
        );
        assert_eq!(
            classify_print_execution(1, Some(true)).expect("printed result"),
            PrintExecution::Printed
        );
        assert_eq!(
            classify_print_execution(1, Some(false)).expect("ambiguous driver result"),
            PrintExecution::OutcomeUnknown
        );
        assert_eq!(
            classify_print_execution(9, None).expect("unexpected panel result"),
            PrintExecution::OutcomeUnknown
        );
    }

    #[test]
    fn pdf_geometry_rejects_page_bombs_and_invalid_media_boxes() {
        assert!(validate_pdf_geometry(1, &[(595.0, 842.0)]).is_ok());
        assert!(validate_pdf_geometry(0, &[]).is_err());
        assert!(validate_pdf_geometry(MAX_PRINT_PAGES + 1, &[]).is_err());
        assert!(validate_pdf_geometry(1, &[(0.0, 842.0)]).is_err());
        assert!(validate_pdf_geometry(1, &[(f64::INFINITY, 842.0)]).is_err());
        assert!(validate_pdf_geometry(1, &[(14_401.0, 842.0)]).is_err());
        assert!(validate_pdf_geometry(2, &[(595.0, 842.0)]).is_err());
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
