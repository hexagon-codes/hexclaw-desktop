//! Durable native print coordinator.
//!
//! The renderer supplies only the already-created owner-scoped PrintJob
//! identity. Rust resolves the current authenticated Sidecar, verifies the
//! frozen artifact, performs at most one native print operation, and converges
//! the exact receipt. A 409 is never treated as success until the persisted
//! receipt and source digest are queried and proven identical.

use crate::{
    native_print::{print_pdf_bytes, NativePrintReceipt, NativePrinterSnapshot},
    sidecar_client::{read_bounded, SidecarClient},
};
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

const MAX_PRINT_PDF_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutePrintJobRequest {
    agent: String,
    print_job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CoordinatorState {
    Prepared,
    DialogOpen,
    OutcomeUnknown,
    ReceiptRecorded,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoordinatorRecord {
    operation_id: String,
    attempt_count: i32,
    owner_digest: String,
    source_digest: String,
    pdf_digest: String,
    state: CoordinatorState,
    receipt: Option<NativePrintReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutePrintJobResponse {
    state: CoordinatorState,
    receipt: NativePrintReceipt,
}

#[derive(Debug, Clone, Deserialize)]
struct PrintJobEnvelope {
    print_job: PrintJobProjection,
}

#[derive(Debug, Clone, Deserialize)]
struct PrintJobProjection {
    print_job_id: String,
    status: String,
    artifact_id: String,
    source_digest: String,
    attempt_count: i32,
    #[serde(default)]
    native_job_id: Option<String>,
    #[serde(default)]
    native_receipt_id: Option<String>,
    #[serde(default)]
    printer_snapshot: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct PrintPaperProjection {
    print_job_id: String,
    title: String,
    source_digest: String,
    markdown: String,
}

/// A lock is scoped to one durable PrintJob. Weak entries avoid an unbounded
/// registry while still making concurrent renderer invocations share one
/// native critical section.
#[derive(Default)]
pub struct PrintOperationLocks {
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl PrintOperationLocks {
    async fn operation_lock(&self, operation_id: &str) -> Result<OwnedMutexGuard<()>, String> {
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .map_err(|_| "print operation lock registry poisoned")?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(operation_id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(operation_id.to_owned(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        Ok(lock.lock_owned().await)
    }
}

fn validate_identity(label: &str, value: &str, allow_slash: bool) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 512
        || normalized.chars().any(char::is_control)
        || (!allow_slash && (normalized.contains('/') || normalized.contains('\\')))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(normalized.to_owned())
}

fn url_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn record_path(app: &AppHandle, operation_id: &str, attempt_count: i32) -> Result<PathBuf, String> {
    let digest = sha256_hex(format!("{operation_id}:attempt:{attempt_count}").as_bytes());
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data: {error}"))?
        .join("print-coordinator")
        .join(format!("{digest}.json")))
}

async fn persist(app: &AppHandle, record: &CoordinatorRecord) -> Result<(), String> {
    let path = record_path(app, &record.operation_id, record.attempt_count)?;
    let parent = path
        .parent()
        .ok_or("print coordinator path has no parent")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create print coordinator directory: {error}"))?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let bytes =
        serde_json::to_vec(record).map_err(|error| format!("encode print state: {error}"))?;
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("write print state: {error}"))?;
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .open(&temp)
        .await
        .map_err(|error| format!("open print state: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("sync print state: {error}"))?;
    tokio::fs::rename(&temp, path)
        .await
        .map_err(|error| format!("commit print state: {error}"))
}

async fn load(
    app: &AppHandle,
    operation_id: &str,
    attempt_count: i32,
) -> Result<Option<CoordinatorRecord>, String> {
    match tokio::fs::read(record_path(app, operation_id, attempt_count)?).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("decode print state: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read print state: {error}")),
    }
}

async fn query_job(
    client: &SidecarClient,
    agent: &str,
    print_job_id: &str,
) -> Result<PrintJobProjection, String> {
    let path = format!(
        "/api/k12/print-jobs/{}?agent={}",
        url_component(print_job_id),
        url_component(agent)
    );
    let response = client.get(&path).await?;
    SidecarClient::require_non_redirect(&response)?;
    let envelope: PrintJobEnvelope = SidecarClient::read_json(response).await?;
    if envelope.print_job.print_job_id != print_job_id
        || envelope.print_job.artifact_id.trim().is_empty()
        || envelope.print_job.source_digest.trim().is_empty()
        || envelope.print_job.attempt_count < 0
    {
        return Err("Sidecar returned a conflicting PrintJob identity".into());
    }
    Ok(envelope.print_job)
}

async fn fetch_print_pdf(
    client: &SidecarClient,
    agent: &str,
    job: &PrintJobProjection,
) -> Result<(Vec<u8>, String), String> {
    // Generic PrintJobs bind a durable canonical PDF artifact. Practice jobs
    // expose frozen Markdown and are rendered through the same Sidecar render
    // endpoint so Rust, not the renderer, owns the bytes crossing native I/O.
    let artifact_path = format!(
        "/api/k12/print-artifacts/{}/content?agent={}",
        url_component(&job.artifact_id),
        url_component(agent)
    );
    let artifact_response = client.get(&artifact_path).await?;
    SidecarClient::require_non_redirect(&artifact_response)?;
    if artifact_response.status().is_success() {
        let declared_digest = artifact_response
            .headers()
            .get("X-Content-SHA256")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or("print artifact is missing X-Content-SHA256")?;
        let content_type = artifact_response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.starts_with("application/pdf") {
            return Err("print artifact is not a PDF".into());
        }
        let pdf = read_bounded(artifact_response, MAX_PRINT_PDF_BYTES).await?;
        verify_pdf(&pdf)?;
        let digest = sha256_hex(&pdf);
        if digest != declared_digest {
            return Err("print artifact digest mismatch".into());
        }
        return Ok((pdf, digest));
    }
    if artifact_response.status() != StatusCode::NOT_FOUND {
        return Err(format!(
            "print artifact fetch failed with HTTP {}",
            artifact_response.status().as_u16()
        ));
    }

    let paper_path = format!(
        "/api/k12/print-jobs/{}/paper?agent={}",
        url_component(&job.print_job_id),
        url_component(agent)
    );
    let paper_response = client.get(&paper_path).await?;
    SidecarClient::require_non_redirect(&paper_response)?;
    let paper: PrintPaperProjection = SidecarClient::read_json(paper_response).await?;
    if paper.print_job_id != job.print_job_id
        || paper.source_digest != job.source_digest
        || paper.title.trim().is_empty()
        || paper.markdown.trim().is_empty()
    {
        return Err("PrintJob paper conflicts with the frozen source".into());
    }
    let render_response = client
        .post_json(
            "/api/v1/render",
            &json!({
                "content": paper.markdown,
                "format": "pdf",
                "title": paper.title,
            }),
            None,
        )
        .await?;
    SidecarClient::require_non_redirect(&render_response)?;
    if !render_response.status().is_success() {
        return Err(format!(
            "Sidecar PDF render failed with HTTP {}",
            render_response.status().as_u16()
        ));
    }
    let pdf = read_bounded(render_response, MAX_PRINT_PDF_BYTES).await?;
    verify_pdf(&pdf)?;
    let digest = sha256_hex(&pdf);
    Ok((pdf, digest))
}

fn verify_pdf(pdf: &[u8]) -> Result<(), String> {
    if pdf.is_empty() || pdf.len() > MAX_PRINT_PDF_BYTES || !pdf.starts_with(b"%PDF-") {
        return Err("canonical print artifact failed PDF preflight".into());
    }
    Ok(())
}

fn receipt_body(agent: &str, receipt: &NativePrintReceipt, status: &str) -> Value {
    json!({
        "agent": agent,
        "status": status,
        "native_job_id": receipt.native_job_id,
        "native_receipt_id": receipt.native_receipt_id,
        "printer_snapshot": receipt.printer_snapshot,
        "failure_kind": receipt.failure_kind,
        "failure_detail": receipt.failure_detail,
    })
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&object[key]));
            }
            Value::Object(canonical)
        }
        other => other.clone(),
    }
}

fn verify_existing_receipt(
    job: &PrintJobProjection,
    source_digest: &str,
    expected: &NativePrintReceipt,
) -> Result<(), String> {
    if job.source_digest != source_digest
        || job.status != "printed"
        || job.native_job_id.as_deref() != Some(expected.native_job_id.as_str())
        || job.native_receipt_id.as_deref() != expected.native_receipt_id.as_deref()
    {
        return Err("persisted PrintJob receipt identity conflicts with native receipt".into());
    }
    let persisted_snapshot = job
        .printer_snapshot
        .as_ref()
        .ok_or("persisted PrintJob is missing printer snapshot")?;
    let expected_snapshot = serde_json::to_value(&expected.printer_snapshot)
        .map_err(|error| format!("encode native printer snapshot: {error}"))?;
    if canonical_json(persisted_snapshot) != canonical_json(&expected_snapshot) {
        return Err(
            "persisted PrintJob printer snapshot digest conflicts with native receipt".into(),
        );
    }
    Ok(())
}

// Keeping the expected receipt fields explicit makes every print-saga
// transition auditable; grouping them would add an otherwise unused wrapper.
#[allow(clippy::too_many_arguments)]
async fn post_step(
    client: &SidecarClient,
    agent: &str,
    print_job_id: &str,
    suffix: &str,
    body: &Value,
    expected_status: &str,
    source_digest: &str,
    expected_receipt: Option<&NativePrintReceipt>,
) -> Result<PrintJobProjection, String> {
    let path = format!(
        "/api/k12/print-jobs/{}/{}",
        url_component(print_job_id),
        suffix
    );
    let response = client.post_json(&path, body, None).await?;
    SidecarClient::require_non_redirect(&response)?;
    if response.status().is_success() {
        let envelope: PrintJobEnvelope = SidecarClient::read_json(response).await?;
        let job = envelope.print_job;
        if job.print_job_id != print_job_id || job.source_digest != source_digest {
            return Err("Sidecar PrintJob response digest conflict".into());
        }
        if let Some(receipt) = expected_receipt {
            verify_existing_receipt(&job, source_digest, receipt)?;
        } else if job.status != expected_status && job.status != "submitted" {
            return Err("Sidecar PrintJob state did not record the native boundary".into());
        }
        return Ok(job);
    }
    if SidecarClient::is_conflict(&response) {
        // Never convert a bare 409 into success. Query the durable record and
        // prove source + exact receipt (or dialog boundary) before convergence.
        let job = query_job(client, agent, print_job_id).await?;
        if job.source_digest != source_digest {
            return Err("PrintJob source digest changed after conflict".into());
        }
        if let Some(receipt) = expected_receipt {
            verify_existing_receipt(&job, source_digest, receipt)?;
        } else if !matches!(
            job.status.as_str(),
            "dialog_open" | "submitted" | "printed" | "cancelled" | "failed" | "outcome_unknown"
        ) {
            return Err("PrintJob conflict did not prove dialog_open".into());
        }
        return Ok(job);
    }
    Err(format!(
        "print callback failed with HTTP {}",
        response.status().as_u16()
    ))
}

fn unknown_receipt(operation_id: &str, detail: &str) -> NativePrintReceipt {
    NativePrintReceipt {
        status: "outcome_unknown".into(),
        native_job_id: format!("native-print-unknown-{operation_id}"),
        native_receipt_id: None,
        printer_snapshot: NativePrinterSnapshot {
            adapter: "appkit".into(),
            platform: if cfg!(target_os = "macos") {
                "macos".into()
            } else {
                "unsupported".into()
            },
            printer: None,
            paper: None,
        },
        failure_kind: Some("native_outcome_unproven".into()),
        failure_detail: Some(detail.into()),
    }
}

async fn converge(
    app: &AppHandle,
    client: &SidecarClient,
    agent: &str,
    mut record: CoordinatorRecord,
) -> Result<ExecutePrintJobResponse, String> {
    let receipt = record
        .receipt
        .clone()
        .ok_or("print receipt is unavailable")?;
    if receipt.status == "printed" {
        post_step(
            client,
            agent,
            &record.operation_id,
            "commit",
            &receipt_body(agent, &receipt, "printed"),
            "printed",
            &record.source_digest,
            Some(&receipt),
        )
        .await?;
    } else {
        post_step(
            client,
            agent,
            &record.operation_id,
            "events",
            &receipt_body(agent, &receipt, &receipt.status),
            &receipt.status,
            &record.source_digest,
            None,
        )
        .await?;
    }
    record.state = CoordinatorState::ReceiptRecorded;
    persist(app, &record).await?;
    record.state = CoordinatorState::Completed;
    persist(app, &record).await?;
    Ok(ExecutePrintJobResponse {
        state: record.state,
        receipt,
    })
}

#[tauri::command]
pub async fn execute_print_job(
    app: AppHandle,
    request: ExecutePrintJobRequest,
    locks: State<'_, PrintOperationLocks>,
) -> Result<ExecutePrintJobResponse, String> {
    let agent = validate_identity("print agent", &request.agent, true)?;
    let print_job_id = validate_identity("print job id", &request.print_job_id, false)?;
    let _operation_lock = locks.operation_lock(&print_job_id).await?;
    let client = SidecarClient::new(Duration::from_secs(120))?;
    let job = query_job(&client, &agent, &print_job_id).await?;
    let owner_digest = sha256_hex(agent.as_bytes());

    if let Some(record) = load(&app, &print_job_id, job.attempt_count).await? {
        if record.owner_digest != owner_digest || record.source_digest != job.source_digest {
            return Err("local print coordinator record conflicts with Sidecar PrintJob".into());
        }
        if record.state == CoordinatorState::Completed {
            let receipt = record
                .receipt
                .ok_or("completed print record has no receipt")?;
            if receipt.status == "printed" {
                verify_existing_receipt(&job, &record.source_digest, &receipt)?;
            }
            return Ok(ExecutePrintJobResponse {
                state: CoordinatorState::Completed,
                receipt,
            });
        }
        if record.receipt.is_some() {
            return converge(&app, &client, &agent, record).await;
        }
        if matches!(
            record.state,
            CoordinatorState::DialogOpen | CoordinatorState::OutcomeUnknown
        ) {
            let receipt = unknown_receipt(
                &print_job_id,
                "application stopped after the native dialog boundary; automatic reprint is forbidden",
            );
            let record = CoordinatorRecord {
                state: CoordinatorState::OutcomeUnknown,
                receipt: Some(receipt),
                ..record
            };
            persist(&app, &record).await?;
            return converge(&app, &client, &agent, record).await;
        }
    }

    if job.status != "preparing" {
        return Err(format!(
            "PrintJob is not eligible for native execution: {}",
            job.status
        ));
    }
    let (pdf, pdf_digest) = fetch_print_pdf(&client, &agent, &job).await?;
    let mut record = CoordinatorRecord {
        operation_id: print_job_id.clone(),
        attempt_count: job.attempt_count,
        owner_digest,
        source_digest: job.source_digest.clone(),
        pdf_digest,
        state: CoordinatorState::Prepared,
        receipt: None,
    };
    persist(&app, &record).await?;

    // Persist the local fence before telling Sidecar/opening the OS dialog. A
    // crash between these steps may become outcome_unknown, but never a second
    // physical print.
    record.state = CoordinatorState::DialogOpen;
    persist(&app, &record).await?;
    post_step(
        &client,
        &agent,
        &print_job_id,
        "events",
        &json!({ "agent": agent, "status": "dialog_open" }),
        "dialog_open",
        &record.source_digest,
        None,
    )
    .await?;

    let receipt = match print_pdf_bytes(app.clone(), pdf).await {
        Ok(receipt) => receipt,
        Err(error) => unknown_receipt(&print_job_id, &error),
    };
    record.state = if receipt.status == "outcome_unknown" {
        CoordinatorState::OutcomeUnknown
    } else {
        CoordinatorState::ReceiptRecorded
    };
    record.receipt = Some(receipt);
    persist(&app, &record).await?;
    converge(&app, &client, &agent, record).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> NativePrintReceipt {
        NativePrintReceipt {
            status: "printed".into(),
            native_job_id: "native-1".into(),
            native_receipt_id: Some("receipt-1".into()),
            printer_snapshot: NativePrinterSnapshot {
                adapter: "appkit".into(),
                platform: "macos".into(),
                printer: Some("Office".into()),
                paper: Some("A4".into()),
            },
            failure_kind: None,
            failure_detail: None,
        }
    }

    #[tokio::test]
    async fn per_operation_native_lock_serializes_only_the_same_job() {
        let locks = PrintOperationLocks::default();
        let first = locks.operation_lock("job-1").await.expect("first");
        let same = {
            let lock = {
                let mut registry = locks.locks.lock().expect("registry");
                registry
                    .get_mut("job-1")
                    .and_then(|entry| entry.upgrade())
                    .expect("same lock")
            };
            lock.try_lock_owned()
        };
        assert!(same.is_err(), "same PrintJob must not enter twice");
        let other = locks.operation_lock("job-2").await.expect("other");
        drop(other);
        drop(first);
    }

    #[test]
    fn conflict_requires_exact_receipt_and_canonical_snapshot_digest() {
        let expected = receipt();
        let exact = PrintJobProjection {
            print_job_id: "job-1".into(),
            status: "printed".into(),
            artifact_id: "artifact-1".into(),
            source_digest: "source-1".into(),
            attempt_count: 0,
            native_job_id: Some("native-1".into()),
            native_receipt_id: Some("receipt-1".into()),
            printer_snapshot: Some(json!({
                "paper": "A4",
                "platform": "macos",
                "adapter": "appkit",
                "printer": "Office"
            })),
        };
        verify_existing_receipt(&exact, "source-1", &expected).expect("exact receipt");

        let mut conflicting = exact.clone();
        conflicting.printer_snapshot = Some(json!({
            "paper": "Letter",
            "platform": "macos",
            "adapter": "appkit",
            "printer": "Office"
        }));
        assert!(verify_existing_receipt(&conflicting, "source-1", &expected).is_err());
        assert!(verify_existing_receipt(&exact, "other-source", &expected).is_err());
    }

    #[test]
    fn request_contract_rejects_renderer_supplied_callback_or_pdf_fields() {
        let parsed = serde_json::from_value::<ExecutePrintJobRequest>(json!({
            "agent": "mingming",
            "printJobId": "gprint-1"
        }));
        assert!(parsed.is_ok());
        let injected = serde_json::from_value::<ExecutePrintJobRequest>(json!({
            "agent": "mingming",
            "printJobId": "gprint-1",
            "eventUrl": "http://127.0.0.1:1/steal"
        }));
        assert!(injected.is_err());
    }
}
