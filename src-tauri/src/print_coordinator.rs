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

fn should_replay_dialog_open(record: &CoordinatorRecord, job: &PrintJobProjection) -> bool {
    record.receipt.is_none()
        && record.state == CoordinatorState::DialogOpen
        && job.status == "preparing"
}

fn step_status_matches(actual_status: &str, expected_status: &str) -> bool {
    actual_status == expected_status
        || (expected_status == "dialog_open" && actual_status == "submitted")
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
        } else if !step_status_matches(&job.status, expected_status) {
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
        } else if !step_status_matches(&job.status, expected_status) {
            return Err("PrintJob conflict did not prove the expected state".into());
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

    let recovered = if let Some(record) = load(&app, &print_job_id, job.attempt_count).await? {
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
        if should_replay_dialog_open(&record, &job) {
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
            let (pdf, pdf_digest) = fetch_print_pdf(&client, &agent, &job).await?;
            if pdf_digest != record.pdf_digest {
                return Err("recovered print artifact digest changed".into());
            }
            Some((record, pdf))
        } else if matches!(
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
        } else {
            None
        }
    } else {
        None
    };

    let (pdf, mut record) = if let Some((record, pdf)) = recovered {
        (pdf, record)
    } else {
        if job.status != "preparing" {
            return Err(format!(
                "PrintJob is not eligible for native execution: {}",
                job.status
            ));
        }
        let (pdf, pdf_digest) = fetch_print_pdf(&client, &agent, &job).await?;
        let record = CoordinatorRecord {
            operation_id: print_job_id.clone(),
            attempt_count: job.attempt_count,
            owner_digest,
            source_digest: job.source_digest.clone(),
            pdf_digest,
            state: CoordinatorState::Prepared,
            receipt: None,
        };
        persist(&app, &record).await?;
        (pdf, record)
    };

    if record.state != CoordinatorState::DialogOpen {
        // 先持久化本地栅栏，再通知 Sidecar 或打开系统对话框，避免发生第二次物理打印。
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
    }

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
    use std::{
        env, fs,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        path::PathBuf,
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    struct TestSidecarEnv {
        home: PathBuf,
        previous: Vec<(&'static str, Option<String>)>,
    }

    impl TestSidecarEnv {
        fn new(port: u16) -> Self {
            let home = env::temp_dir().join(format!("hexclaw-print-test-{}", Uuid::new_v4()));
            fs::create_dir_all(home.join(".hexclaw")).expect("create test home");
            let names = [
                crate::test_runtime::TEST_MODE_ENV,
                crate::test_runtime::TEST_HOME_ENV,
                crate::test_runtime::TEST_SIDECAR_PORT_ENV,
            ];
            let previous = names
                .into_iter()
                .map(|name| (name, env::var(name).ok()))
                .collect();
            env::set_var(crate::test_runtime::TEST_MODE_ENV, "1");
            env::set_var(crate::test_runtime::TEST_HOME_ENV, &home);
            env::set_var(crate::test_runtime::TEST_SIDECAR_PORT_ENV, port.to_string());
            crate::sidecar::initialize_capability_token().expect("initialize test capability");
            Self { home, previous }
        }
    }

    impl Drop for TestSidecarEnv {
        fn drop(&mut self) {
            for (name, value) in &self.previous {
                if let Some(value) = value {
                    env::set_var(name, value);
                } else {
                    env::remove_var(name);
                }
            }
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        path: String,
        body: Vec<u8>,
    }

    fn read_request(stream: &mut TcpStream) -> CapturedRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set request timeout");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let read = stream.read(&mut buffer).expect("read request");
            assert!(read > 0, "request ended before headers");
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let header = String::from_utf8_lossy(&bytes[..header_end]);
        let request_line = header.lines().next().expect("request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .expect("request path")
            .to_string();
        let content_length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while bytes.len() - header_end < content_length {
            let read = stream.read(&mut buffer).expect("read request body");
            assert!(read > 0, "request ended before body");
            bytes.extend_from_slice(&buffer[..read]);
        }
        CapturedRequest {
            path,
            body: bytes[header_end..header_end + content_length].to_vec(),
        }
    }

    fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write fixture response");
    }

    fn print_job_json(status: &str) -> String {
        json!({
            "print_job": {
                "print_job_id": "job-1",
                "status": status,
                "artifact_id": "artifact-1",
                "source_digest": "source-1",
                "attempt_count": 0
            }
        })
        .to_string()
    }

    fn spawn_one_response_server(
        status: &'static str,
        body: String,
    ) -> (
        u16,
        Arc<Mutex<Option<CapturedRequest>>>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        let port = listener.local_addr().expect("fixture address").port();
        let captured = Arc::new(Mutex::new(None));
        let captured_for_thread = Arc::clone(&captured);
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept fixture request");
            let request = read_request(&mut stream);
            *captured_for_thread.lock().expect("lock request") = Some(request);
            write_response(&mut stream, status, &body);
        });
        (port, captured, thread)
    }

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

    #[tokio::test]
    async fn post_step_does_not_accept_submitted_for_terminal_states() {
        for expected_status in ["cancelled", "failed", "outcome_unknown"] {
            let (port, captured, server) =
                spawn_one_response_server("200 OK", print_job_json("submitted"));
            let environment = TestSidecarEnv::new(port);
            let client = SidecarClient::new(Duration::from_secs(2)).expect("client");

            let result = post_step(
                &client,
                "agent-1",
                "job-1",
                "events",
                &json!({ "agent": "agent-1", "status": expected_status }),
                expected_status,
                "source-1",
                None,
            )
            .await;

            server.join().expect("join fixture server");
            assert!(
                result.is_err(),
                "submitted must not satisfy a {expected_status} post_step"
            );
            let request = captured
                .lock()
                .expect("lock request")
                .take()
                .expect("captured request");
            assert_eq!(request.path, "/api/k12/print-jobs/job-1/events");
            let body: Value = serde_json::from_slice(&request.body).expect("event body");
            assert_eq!(
                body.get("status").and_then(Value::as_str),
                Some(expected_status)
            );
            drop(environment);
        }
    }

    #[test]
    fn dialog_open_record_replays_when_sidecar_is_still_preparing() {
        let record = CoordinatorRecord {
            operation_id: "job-1".into(),
            attempt_count: 0,
            owner_digest: sha256_hex(b"agent-1"),
            source_digest: "source-1".into(),
            pdf_digest: "pdf-1".into(),
            state: CoordinatorState::DialogOpen,
            receipt: None,
        };
        let preparing_job = PrintJobProjection {
            print_job_id: "job-1".into(),
            status: "preparing".into(),
            artifact_id: "artifact-1".into(),
            source_digest: "source-1".into(),
            attempt_count: 0,
            native_job_id: None,
            native_receipt_id: None,
            printer_snapshot: None,
        };
        assert!(should_replay_dialog_open(&record, &preparing_job));

        let mut dialog_open_job = preparing_job.clone();
        dialog_open_job.status = "dialog_open".into();
        assert!(!should_replay_dialog_open(&record, &dialog_open_job));
    }
}
