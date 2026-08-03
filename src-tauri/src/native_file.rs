//! Capability-based native file I/O.
//!
//! A filesystem path is accepted only from a native picker or native drop
//! event. It is exchanged immediately for a short-lived, window/operation/
//! purpose-bound opaque grant. Consumers remove the grant before I/O, making
//! every capability single-use even when an operation fails.

use crate::sidecar_client::{read_bounded, SidecarClient};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use uuid::Uuid;

const GRANT_TTL: Duration = Duration::from_secs(60);
const MAX_IPC_CHUNK_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_KNOWLEDGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SAVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ACTIVE_FILE_GRANTS: usize = 64;
const MAX_ACTIVE_FILE_TRANSFERS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantPurpose {
    AttachmentUpload,
    KnowledgeUpload,
    SaveDownload,
    SaveCopy,
    RenderArtifact,
}

impl GrantPurpose {
    fn max_bytes(self) -> u64 {
        match self {
            Self::AttachmentUpload => MAX_ATTACHMENT_BYTES,
            Self::KnowledgeUpload => MAX_KNOWLEDGE_BYTES,
            Self::SaveDownload | Self::SaveCopy | Self::RenderArtifact => MAX_SAVE_BYTES,
        }
    }

    fn is_read(self) -> bool {
        matches!(self, Self::AttachmentUpload | Self::KnowledgeUpload)
    }

    fn is_save(self) -> bool {
        matches!(
            self,
            Self::SaveDownload | Self::SaveCopy | Self::RenderArtifact
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    canonical_path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Debug, Clone)]
struct FileGrant {
    path: PathBuf,
    name: String,
    mime: String,
    expected_size: u64,
    purpose: GrantPurpose,
    window_label: String,
    operation_id: String,
    sealed: bool,
    cleanup_source: bool,
    identity: Option<FileIdentity>,
    source_sha256: Option<String>,
    expires_at: Instant,
    io_lock: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
pub struct NativeFileGrantRegistry {
    grants: Mutex<HashMap<String, FileGrant>>,
}

#[derive(Default, Clone)]
pub struct NativeFileTransferRegistry {
    transfers: Arc<Mutex<HashMap<String, ActiveFileTransfer>>>,
}

struct ActiveFileTransfer {
    generation: Uuid,
    cancellation: CancellationToken,
}

struct FileTransferRegistration {
    operation_id: String,
    generation: Uuid,
    cancellation: CancellationToken,
    registry: NativeFileTransferRegistry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGrantDescriptor {
    grant_id: String,
    operation_id: String,
    purpose: GrantPurpose,
    name: String,
    mime: String,
    size: u64,
    source_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransferReceipt {
    status: u16,
    bytes_transferred: u64,
    body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransferProgress {
    bytes_transferred: u64,
    total_bytes: u64,
}

impl NativeFileTransferRegistry {
    fn register(&self, operation_id: String) -> Result<FileTransferRegistration, String> {
        let operation_id = validate_operation_id(&operation_id)?;
        let mut transfers = self
            .transfers
            .lock()
            .map_err(|_| "file transfer registry poisoned")?;
        if transfers.contains_key(&operation_id) {
            return Err("file transfer operation is already active".into());
        }
        if transfers.len() >= MAX_ACTIVE_FILE_TRANSFERS {
            return Err("Too many active native file transfers".into());
        }
        let generation = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        transfers.insert(
            operation_id.clone(),
            ActiveFileTransfer {
                generation,
                cancellation: cancellation.clone(),
            },
        );
        Ok(FileTransferRegistration {
            operation_id,
            generation,
            cancellation,
            registry: self.clone(),
        })
    }

    fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let operation_id = validate_operation_id(operation_id)?;
        let cancellation = self
            .transfers
            .lock()
            .map_err(|_| "file transfer registry poisoned")?
            .get(&operation_id)
            .map(|active| active.cancellation.clone());
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
        Ok(())
    }

    fn release(&self, operation_id: &str, generation: Uuid) -> Result<(), String> {
        let mut transfers = self
            .transfers
            .lock()
            .map_err(|_| "file transfer registry poisoned")?;
        if transfers
            .get(operation_id)
            .is_some_and(|active| active.generation == generation)
        {
            transfers.remove(operation_id);
        }
        Ok(())
    }

    #[cfg(test)]
    fn active_count(&self) -> Result<usize, String> {
        self.transfers
            .lock()
            .map(|transfers| transfers.len())
            .map_err(|_| "file transfer registry poisoned".into())
    }
}

impl FileTransferRegistration {
    fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    #[cfg(test)]
    fn generation(&self) -> Uuid {
        self.generation
    }
}

impl Drop for FileTransferRegistration {
    fn drop(&mut self) {
        let _ = self.registry.release(&self.operation_id, self.generation);
    }
}

fn register_acknowledged_transfer(
    registry: &NativeFileTransferRegistry,
    operation_id: String,
    on_registered: &Channel<()>,
) -> Result<FileTransferRegistration, String> {
    let registration = registry.register(operation_id)?;
    on_registered
        .send(())
        .map_err(|_| "file transfer registration acknowledgement failed".to_string())?;
    Ok(registration)
}

async fn await_file_transfer_or_cancel<T, F>(
    cancellation: CancellationToken,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("file transfer cancelled".into()),
        result = future => result,
    }
}

impl NativeFileGrantRegistry {
    fn purge_expired(&self) -> Result<(), String> {
        let expired = {
            let mut grants = self
                .grants
                .lock()
                .map_err(|_| "file grant registry poisoned")?;
            let expired_ids = grants
                .iter()
                .filter(|(_, grant)| grant.expires_at <= Instant::now())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            expired_ids
                .into_iter()
                .filter_map(|id| grants.remove(&id))
                .collect::<Vec<_>>()
        };
        let mut failures = Vec::new();
        for grant in expired.into_iter().filter(|grant| grant.cleanup_source) {
            if let Err(error) = std::fs::remove_file(&grant.path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("remove expired staging file: {error}"));
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn insert(&self, grant: FileGrant) -> Result<String, String> {
        if let Err(error) = self.purge_expired() {
            if grant.cleanup_source {
                let _ = std::fs::remove_file(&grant.path);
            }
            return Err(error);
        }
        let id = Uuid::new_v4().to_string();
        let cleanup_path = grant.cleanup_source.then(|| grant.path.clone());
        match self.insert_with_id(id.clone(), grant) {
            Ok(()) => Ok(id),
            Err(error) => {
                if let Some(path) = cleanup_path {
                    let _ = std::fs::remove_file(path);
                }
                Err(error)
            }
        }
    }

    fn insert_with_id(&self, id: String, grant: FileGrant) -> Result<(), String> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "file grant registry poisoned")?;
        if grants.len() >= MAX_ACTIVE_FILE_GRANTS {
            return Err("Too many active native file grants".into());
        }
        if grants.contains_key(&id) {
            return Err("file grant identity is already active".into());
        }
        grants.insert(id, grant);
        Ok(())
    }

    fn inspect(
        &self,
        id: &str,
        window_label: &str,
        operation_id: &str,
        purpose: GrantPurpose,
    ) -> Result<FileGrant, String> {
        self.purge_expired()?;
        let grants = self
            .grants
            .lock()
            .map_err(|_| "file grant registry poisoned")?;
        let grant = grants
            .get(id)
            .cloned()
            .ok_or("file grant expired or unknown")?;
        validate_scope(&grant, window_label, operation_id, purpose)?;
        Ok(grant)
    }

    fn mutate<T>(
        &self,
        id: &str,
        window_label: &str,
        operation_id: &str,
        purpose: GrantPurpose,
        mutate: impl FnOnce(&mut FileGrant) -> Result<T, String>,
    ) -> Result<T, String> {
        self.purge_expired()?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "file grant registry poisoned")?;
        let grant = grants.get_mut(id).ok_or("file grant expired or unknown")?;
        validate_scope(grant, window_label, operation_id, purpose)?;
        mutate(grant)
    }

    fn consume(
        &self,
        id: &str,
        window_label: &str,
        operation_id: &str,
        purpose: GrantPurpose,
    ) -> Result<FileGrant, String> {
        self.purge_expired()?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "file grant registry poisoned")?;
        // Remove before validation/I/O. A stolen or malformed attempt cannot
        // probe and then replay the same capability.
        let grant = grants.remove(id).ok_or("file grant expired or unknown")?;
        if let Err(error) = validate_scope(&grant, window_label, operation_id, purpose) {
            if grant.cleanup_source {
                let _ = std::fs::remove_file(&grant.path);
            }
            return Err(error);
        }
        Ok(grant)
    }

    fn discard(
        &self,
        id: &str,
        window_label: &str,
        operation_id: &str,
        purpose: GrantPurpose,
    ) -> Result<(), String> {
        let grant = self.consume(id, window_label, operation_id, purpose)?;
        if grant.cleanup_source {
            match std::fs::remove_file(&grant.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("remove private staging file: {error}")),
            }
        }
        Ok(())
    }
}

fn staging_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("resolve app cache: {error}"))?
        .join("native-file-grants"))
}

fn prune_staging_directory(dir: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read private staging directory: {error}")),
    };
    let mut failures = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failures.push(format!("read private staging entry: {error}"));
                continue;
            }
        };
        let path = entry.path();
        let is_private_part = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".part"))
            .is_some_and(|stem| Uuid::parse_str(stem).is_ok());
        let is_regular_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if is_private_part && is_regular_file {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("remove orphan private staging file: {error}"));
                }
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub fn prune_stale_staging_files(app: &AppHandle) -> Result<(), String> {
    prune_staging_directory(&staging_directory(app)?)
}

fn validate_scope(
    grant: &FileGrant,
    window_label: &str,
    operation_id: &str,
    purpose: GrantPurpose,
) -> Result<(), String> {
    if grant.expires_at <= Instant::now() {
        return Err("file grant expired or unknown".into());
    }
    if grant.window_label != window_label
        || grant.operation_id != operation_id
        || grant.purpose != purpose
    {
        return Err("file grant scope mismatch".into());
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("file operation id is invalid".into());
    }
    Ok(value.to_owned())
}

fn validate_upload_contract(
    purpose: GrantPurpose,
    relative_path: &str,
    idempotency_key: &str,
    field_name: Option<&str>,
) -> Result<(), String> {
    if idempotency_key.is_empty()
        || idempotency_key.len() > 512
        || idempotency_key.chars().any(char::is_control)
        || field_name.unwrap_or("file") != "file"
    {
        return Err("native upload contract is invalid".into());
    }
    let endpoint = SidecarClient::endpoint(relative_path)?;
    let path = endpoint.path();
    let query = endpoint
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let allowed = match purpose {
        GrantPurpose::KnowledgeUpload => {
            path == "/api/v1/knowledge/documents"
                && query.len() == 1
                && query[0].0 == "user_id"
                && !query[0].1.is_empty()
        }
        GrantPurpose::AttachmentUpload => {
            (path == "/api/v1/attachments" && query.is_empty())
                || (path == "/api/v1/documents/extract" && query.is_empty())
                || (path == "/api/k12/assets"
                    && query.len() == 1
                    && query[0].0 == "agent"
                    && !query[0].1.is_empty())
        }
        _ => false,
    };
    if !allowed {
        return Err("native upload target does not match grant purpose".into());
    }
    Ok(())
}

fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| "file name is invalid".into())
}

fn mime_for_name(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "html" | "htm" => "text/html",
        "epub" => "application/epub+zip",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        _ => "application/octet-stream",
    }
}

fn validate_mime(name: &str, declared: &str) -> Result<String, String> {
    let inferred = mime_for_name(name);
    let declared = declared.trim().to_ascii_lowercase();
    if declared.is_empty() || declared == "application/octet-stream" {
        return Ok(inferred.to_owned());
    }
    if declared.len() > 128
        || declared.chars().any(char::is_control)
        || (inferred != "application/octet-stream" && declared != inferred)
    {
        return Err("file MIME does not match its approved extension".into());
    }
    Ok(declared)
}

async fn identity(path: &Path) -> Result<FileIdentity, String> {
    let canonical_path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("canonicalize selected file: {error}"))?;
    let metadata = tokio::fs::symlink_metadata(&canonical_path)
        .await
        .map_err(|error| format!("inspect selected file: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("selected path is not a regular file".into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity {
        canonical_path,
        size: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}

async fn open_verified_read_grant(grant: &FileGrant) -> Result<tokio::fs::File, String> {
    let expected = grant
        .identity
        .as_ref()
        .ok_or("file grant has no source identity")?;
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&grant.path)
        .await
        .map_err(|error| format!("open granted source file: {error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("inspect opened source file: {error}"))?;
    let canonical_path = tokio::fs::canonicalize(&grant.path)
        .await
        .map_err(|error| format!("canonicalize opened source file: {error}"))?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let identity_matches = canonical_path == expected.canonical_path
        && metadata.is_file()
        && metadata.len() == expected.size
        && metadata.modified().ok() == expected.modified
        && {
            #[cfg(unix)]
            {
                metadata.dev() == expected.device && metadata.ino() == expected.inode
            }
            #[cfg(not(unix))]
            {
                true
            }
        };
    let actual_sha256 = sha256_open_file(&mut file).await?;
    if !identity_matches
        || metadata.len() != grant.expected_size
        || validate_mime(&grant.name, &grant.mime)? != grant.mime
        || grant.source_sha256.as_deref() != Some(actual_sha256.as_str())
    {
        return Err("source file changed after native authorization".into());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(|error| format!("rewind granted source file: {error}"))?;
    Ok(file)
}

async fn sha256_open_file(file: &mut tokio::fs::File) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("hash file: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("open file: {error}"))?;
    sha256_open_file(&mut file).await
}

async fn issue_read_grant(
    registry: &NativeFileGrantRegistry,
    window_label: &str,
    operation_id: &str,
    path: PathBuf,
    purpose: GrantPurpose,
) -> Result<FileGrantDescriptor, String> {
    if !purpose.is_read() {
        return Err("native open/drop grant purpose is invalid".into());
    }
    let operation_id = validate_operation_id(operation_id)?;
    let source_identity = identity(&path).await?;
    if source_identity.size > purpose.max_bytes() {
        return Err("selected file exceeds operation limit".into());
    }
    let name = file_name(&source_identity.canonical_path)?;
    let mime = validate_mime(&name, mime_for_name(&name))?;
    let size = source_identity.size;
    let source_sha256 = sha256_file(&source_identity.canonical_path).await?;
    let grant_id = registry.insert(FileGrant {
        path: source_identity.canonical_path.clone(),
        name: name.clone(),
        mime: mime.clone(),
        expected_size: size,
        purpose,
        window_label: window_label.to_owned(),
        operation_id: operation_id.clone(),
        sealed: true,
        cleanup_source: false,
        identity: Some(source_identity),
        source_sha256: Some(source_sha256.clone()),
        expires_at: Instant::now() + GRANT_TTL,
        io_lock: Arc::new(tokio::sync::Mutex::new(())),
    })?;
    Ok(FileGrantDescriptor {
        grant_id,
        operation_id,
        purpose,
        name,
        mime,
        size,
        source_sha256: Some(source_sha256),
    })
}

async fn issue_save_grant(
    registry: &NativeFileGrantRegistry,
    window_label: &str,
    operation_id: &str,
    path: PathBuf,
    purpose: GrantPurpose,
) -> Result<FileGrantDescriptor, String> {
    if !purpose.is_save() {
        return Err("native save grant purpose is invalid".into());
    }
    let operation_id = validate_operation_id(operation_id)?;
    let name = file_name(&path)?;
    let parent = path.parent().ok_or("save destination has no parent")?;
    let parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|error| format!("open save directory: {error}"))?;
    if !tokio::fs::metadata(&parent)
        .await
        .map_err(|error| format!("inspect save directory: {error}"))?
        .is_dir()
    {
        return Err("save destination parent is not a directory".into());
    }
    let target = parent.join(&name);
    if tokio::fs::symlink_metadata(&target)
        .await
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("save destination cannot be a symbolic link".into());
    }
    let mime = validate_mime(&name, mime_for_name(&name))?;
    let grant_id = registry.insert(FileGrant {
        path: target,
        name: name.clone(),
        mime: mime.clone(),
        expected_size: purpose.max_bytes(),
        purpose,
        window_label: window_label.to_owned(),
        operation_id: operation_id.clone(),
        sealed: true,
        cleanup_source: false,
        identity: None,
        source_sha256: None,
        expires_at: Instant::now() + GRANT_TTL,
        io_lock: Arc::new(tokio::sync::Mutex::new(())),
    })?;
    Ok(FileGrantDescriptor {
        grant_id,
        operation_id,
        purpose,
        name,
        mime,
        size: 0,
        source_sha256: None,
    })
}

#[tauri::command]
pub async fn pick_open_file_grant(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
    purpose: GrantPurpose,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<Option<FileGrantDescriptor>, String> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
            .await
            .map_err(|error| format!("native open dialog worker failed: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("native open dialog returned an invalid path: {error}"))?;
    issue_read_grant(&registry, window.label(), &operation_id, path, purpose)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn pick_save_file_grant(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
    purpose: GrantPurpose,
    default_name: String,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<Option<FileGrantDescriptor>, String> {
    let default_name = file_name(Path::new(&default_name))?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("native save dialog worker failed: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("native save dialog returned an invalid path: {error}"))?;
    issue_save_grant(&registry, window.label(), &operation_id, path, purpose)
        .await
        .map(Some)
}

/// Called only from Tauri's native drag/drop callback. The WebView receives
/// descriptors, never a command capable of redeeming an arbitrary path.
pub async fn issue_native_drop_grants(
    app: AppHandle,
    window_label: String,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    let registry = app.state::<NativeFileGrantRegistry>();
    let batch_id = format!("native-drop:{}", Uuid::new_v4());
    let mut descriptors = Vec::with_capacity(paths.len());
    for path in paths {
        descriptors.push(
            issue_read_grant(
                &registry,
                &window_label,
                &batch_id,
                path,
                GrantPurpose::AttachmentUpload,
            )
            .await?,
        );
    }
    let window = app
        .get_webview_window(&window_label)
        .ok_or("native drop window no longer exists")?;
    window
        .emit("native-file-drop-grants", descriptors)
        .map_err(|error| format!("emit native drop grants: {error}"))
}

#[tauri::command]
// Tauri derives this invoke ABI from the individual command parameters. A
// request-object refactor would change the renderer contract.
#[allow(clippy::too_many_arguments)]
pub async fn create_staging_file_grant(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
    purpose: GrantPurpose,
    name: String,
    mime: String,
    size: u64,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<FileGrantDescriptor, String> {
    if !matches!(
        purpose,
        GrantPurpose::AttachmentUpload | GrantPurpose::KnowledgeUpload | GrantPurpose::SaveCopy
    ) {
        return Err("renderer staging purpose is forbidden".into());
    }
    if size == 0 || size > purpose.max_bytes() {
        return Err("staging file size is invalid".into());
    }
    let operation_id = validate_operation_id(&operation_id)?;
    let name = file_name(Path::new(&name))?;
    let mime = validate_mime(&name, &mime)?;
    let dir = staging_directory(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("create staging directory: {error}"))?;
    let path = dir.join(format!("{}.part", Uuid::new_v4()));
    tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .await
        .map_err(|error| format!("create staging file: {error}"))?;
    let grant_id = registry.insert(FileGrant {
        path,
        name: name.clone(),
        mime: mime.clone(),
        expected_size: size,
        purpose,
        window_label: window.label().to_owned(),
        operation_id: operation_id.clone(),
        sealed: false,
        cleanup_source: true,
        identity: None,
        source_sha256: None,
        expires_at: Instant::now() + GRANT_TTL,
        io_lock: Arc::new(tokio::sync::Mutex::new(())),
    })?;
    Ok(FileGrantDescriptor {
        grant_id,
        operation_id,
        purpose,
        name,
        mime,
        size,
        source_sha256: None,
    })
}

#[tauri::command]
pub async fn append_file_grant_chunk(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    purpose: GrantPurpose,
    offset: u64,
    chunk: Vec<u8>,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<u64, String> {
    if chunk.is_empty() || chunk.len() > MAX_IPC_CHUNK_BYTES {
        return Err("staging chunk size is invalid".into());
    }
    let initial = registry.inspect(&grant_id, window.label(), &operation_id, purpose)?;
    let _io_guard = initial.io_lock.lock().await;
    let grant = registry.inspect(&grant_id, window.label(), &operation_id, purpose)?;
    if grant.sealed {
        return Err("staging grant is already sealed".into());
    }
    if offset.saturating_add(chunk.len() as u64) > grant.expected_size {
        return Err("staging chunk exceeds declared size".into());
    }
    let metadata = tokio::fs::metadata(&grant.path)
        .await
        .map_err(|error| format!("inspect staging file: {error}"))?;
    // Sequential writes are mandatory. This prevents sparse files and races
    // between two renderer calls using the same grant.
    if metadata.len() != offset {
        return Err("staging chunk offset is not contiguous".into());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&grant.path)
        .await
        .map_err(|error| format!("open staging file: {error}"))?;
    file.write_all(&chunk)
        .await
        .map_err(|error| format!("write staging chunk: {error}"))?;
    file.flush()
        .await
        .map_err(|error| format!("flush staging chunk: {error}"))?;
    let next_offset = offset + chunk.len() as u64;
    registry.mutate(&grant_id, window.label(), &operation_id, purpose, |value| {
        value.expires_at = Instant::now() + GRANT_TTL;
        Ok(())
    })?;
    Ok(next_offset)
}

#[tauri::command]
pub async fn seal_file_grant(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    purpose: GrantPurpose,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<FileGrantDescriptor, String> {
    let initial = registry.inspect(&grant_id, window.label(), &operation_id, purpose)?;
    let _io_guard = initial.io_lock.lock().await;
    let grant = registry.inspect(&grant_id, window.label(), &operation_id, purpose)?;
    let metadata = tokio::fs::metadata(&grant.path)
        .await
        .map_err(|error| format!("inspect staging file: {error}"))?;
    if metadata.len() != grant.expected_size {
        return Err("staging file size mismatch".into());
    }
    let source_sha256 = sha256_file(&grant.path).await?;
    let source_identity = identity(&grant.path).await?;
    registry.mutate(&grant_id, window.label(), &operation_id, purpose, |value| {
        value.sealed = true;
        value.identity = Some(source_identity);
        value.source_sha256 = Some(source_sha256.clone());
        value.expires_at = Instant::now() + GRANT_TTL;
        Ok(())
    })?;
    Ok(FileGrantDescriptor {
        grant_id,
        operation_id,
        purpose,
        name: grant.name,
        mime: grant.mime,
        size: metadata.len(),
        source_sha256: Some(source_sha256),
    })
}

#[tauri::command]
pub fn discard_file_grant(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    purpose: GrantPurpose,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<(), String> {
    registry.discard(&grant_id, window.label(), &operation_id, purpose)
}

#[tauri::command]
// Keep the audited Tauri upload ABI explicit at the process boundary.
#[allow(clippy::too_many_arguments)]
pub async fn upload_file_grant(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    purpose: GrantPurpose,
    relative_path: String,
    idempotency_key: String,
    field_name: Option<String>,
    on_progress: Channel<NativeTransferProgress>,
    on_registered: Channel<()>,
    registry: State<'_, NativeFileGrantRegistry>,
    transfers: State<'_, NativeFileTransferRegistry>,
) -> Result<NativeTransferReceipt, String> {
    if !purpose.is_read() {
        return Err("upload grant purpose is invalid".into());
    }
    validate_upload_contract(
        purpose,
        &relative_path,
        &idempotency_key,
        field_name.as_deref(),
    )?;
    let registration =
        register_acknowledged_transfer(&transfers, operation_id.clone(), &on_registered)?;
    let cancellation = registration.token();
    let grant = registry.consume(&grant_id, window.label(), &operation_id, purpose)?;
    let result = async {
        if !grant.sealed {
            return Err("file grant is not sealed".into());
        }
        let file = open_verified_read_grant(&grant).await?;
        let total_bytes = grant.expected_size;
        let mut bytes_transferred = 0u64;
        let _ = on_progress.send(NativeTransferProgress {
            bytes_transferred: 0,
            total_bytes,
        });
        let progress_channel = on_progress.clone();
        let stream = ReaderStream::new(file).map(move |chunk| {
            if let Ok(bytes) = chunk.as_ref() {
                bytes_transferred = bytes_transferred.saturating_add(bytes.len() as u64);
                let _ = progress_channel.send(NativeTransferProgress {
                    bytes_transferred,
                    total_bytes,
                });
            }
            chunk
        });
        let body = reqwest::Body::wrap_stream(stream);
        let part = reqwest::multipart::Part::stream_with_length(body, grant.expected_size)
            .file_name(grant.name.clone())
            .mime_str(&grant.mime)
            .map_err(|error| format!("build upload part: {error}"))?;
        let form =
            reqwest::multipart::Form::new().part(field_name.unwrap_or_else(|| "file".into()), part);
        let client = SidecarClient::new(Duration::from_secs(300))?;
        let request = client
            .request(reqwest::Method::POST, &relative_path)?
            .header("Idempotency-Key", idempotency_key)
            .multipart(form);
        let response = await_file_transfer_or_cancel(cancellation.clone(), async {
            request
                .send()
                .await
                .map_err(|error| format!("stream upload: {error}"))
        })
        .await?;
        SidecarClient::require_non_redirect(&response)?;
        let status = response.status();
        let bytes =
            await_file_transfer_or_cancel(cancellation, read_bounded(response, MAX_RESPONSE_BYTES))
                .await?;
        if !status.is_success() {
            return Err(format!("upload failed with HTTP {}", status.as_u16()));
        }
        Ok(NativeTransferReceipt {
            status: status.as_u16(),
            bytes_transferred: grant.expected_size,
            body: serde_json::from_slice(&bytes).ok(),
        })
    }
    .await;
    if grant.cleanup_source {
        let _ = tokio::fs::remove_file(&grant.path).await;
    }
    result
}

#[tauri::command]
pub fn cancel_file_transfer(
    operation_id: String,
    transfers: State<'_, NativeFileTransferRegistry>,
) -> Result<(), String> {
    transfers.cancel(&operation_id)
}

#[tauri::command]
pub async fn download_file_grant(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    relative_path: String,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<NativeTransferReceipt, String> {
    let grant = registry.consume(
        &grant_id,
        window.label(),
        &operation_id,
        GrantPurpose::SaveDownload,
    )?;
    let client = SidecarClient::new(Duration::from_secs(300))?;
    let response = client.get(&relative_path).await?;
    SidecarClient::require_non_redirect(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed with HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > grant.expected_size)
    {
        return Err("download exceeds destination grant limit".into());
    }
    let temp = grant
        .path
        .with_file_name(format!(".{}.{}.tmp", grant.name, Uuid::new_v4()));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|error| format!("create download temp file: {error}"))?;
        let mut transferred = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("read download stream: {error}"))?;
            transferred = transferred.saturating_add(chunk.len() as u64);
            if transferred > grant.expected_size {
                return Err("download exceeds destination grant limit".into());
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("write download stream: {error}"))?;
        }
        output
            .flush()
            .await
            .map_err(|error| format!("flush download: {error}"))?;
        output
            .sync_all()
            .await
            .map_err(|error| format!("sync download: {error}"))?;
        drop(output);
        tokio::fs::rename(&temp, &grant.path)
            .await
            .map_err(|error| format!("commit download: {error}"))?;
        Ok(NativeTransferReceipt {
            status: 200,
            bytes_transferred: transferred,
            body: None,
        })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

#[tauri::command]
pub async fn copy_file_grant(
    window: WebviewWindow,
    source_grant_id: String,
    destination_grant_id: String,
    operation_id: String,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<u64, String> {
    let source = registry.consume(
        &source_grant_id,
        window.label(),
        &operation_id,
        GrantPurpose::SaveCopy,
    )?;
    let destination = registry.consume(
        &destination_grant_id,
        window.label(),
        &operation_id,
        GrantPurpose::SaveCopy,
    )?;
    let temp =
        destination
            .path
            .with_file_name(format!(".{}.{}.tmp", destination.name, Uuid::new_v4()));
    let result = async {
        if !source.sealed {
            return Err("source grant is not sealed".into());
        }
        let mut source_file = open_verified_read_grant(&source).await?;
        if source.expected_size > destination.expected_size {
            return Err("source exceeds destination grant limit".into());
        }
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|error| format!("create copy temp file: {error}"))?;
        let bytes = tokio::io::copy(&mut source_file, &mut output)
            .await
            .map_err(|error| format!("copy granted file: {error}"))?;
        output
            .sync_all()
            .await
            .map_err(|error| format!("sync copied file: {error}"))?;
        drop(output);
        tokio::fs::rename(&temp, &destination.path)
            .await
            .map_err(|error| format!("commit copied file: {error}"))?;
        Ok(bytes)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    if source.cleanup_source {
        let _ = tokio::fs::remove_file(&source.path).await;
    }
    result
}

#[tauri::command]
// Keep the audited Tauri render ABI explicit at the process boundary.
#[allow(clippy::too_many_arguments)]
pub async fn render_artifact_to_grant(
    window: WebviewWindow,
    grant_id: String,
    operation_id: String,
    content: String,
    format: String,
    title: Option<String>,
    options: Option<serde_json::Value>,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<u64, String> {
    if !matches!(
        format.as_str(),
        "pdf" | "docx" | "html" | "epub" | "odt" | "rtf" | "txt" | "md"
    ) || content.is_empty()
        || content.len() > 16 * 1024 * 1024
    {
        return Err("render artifact request is invalid".into());
    }
    let grant = registry.consume(
        &grant_id,
        window.label(),
        &operation_id,
        GrantPurpose::RenderArtifact,
    )?;
    let client = SidecarClient::new(Duration::from_secs(120))?;
    let response = client
        .post_json(
            "/api/v1/render",
            &serde_json::json!({
                "content": content,
                "format": format,
                "title": title.unwrap_or_default(),
                "options": options,
            }),
            None,
        )
        .await?;
    SidecarClient::require_non_redirect(&response)?;
    if !response.status().is_success() {
        return Err(format!(
            "render failed with HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > grant.expected_size)
    {
        return Err("rendered artifact exceeds destination grant limit".into());
    }
    let temp = grant
        .path
        .with_file_name(format!(".{}.{}.tmp", grant.name, Uuid::new_v4()));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|error| format!("create render temp file: {error}"))?;
        let mut stream = response.bytes_stream();
        let mut total = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("read render stream: {error}"))?;
            total = total.saturating_add(chunk.len() as u64);
            if total > grant.expected_size {
                return Err("rendered artifact exceeds destination grant limit".into());
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("write render stream: {error}"))?;
        }
        output
            .flush()
            .await
            .map_err(|error| format!("flush rendered artifact: {error}"))?;
        output
            .sync_all()
            .await
            .map_err(|error| format!("sync rendered artifact: {error}"))?;
        drop(output);
        tokio::fs::rename(&temp, &grant.path)
            .await
            .map_err(|error| format!("commit rendered artifact: {error}"))?;
        Ok(total)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_grant(operation_id: &str, purpose: GrantPurpose) -> FileGrant {
        FileGrant {
            path: PathBuf::from("/tmp/opaque-test"),
            name: "test.pdf".into(),
            mime: "application/pdf".into(),
            expected_size: 12,
            purpose,
            window_label: "main".into(),
            operation_id: operation_id.into(),
            sealed: true,
            cleanup_source: false,
            identity: None,
            source_sha256: None,
            expires_at: Instant::now() + GRANT_TTL,
            io_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[test]
    fn capability_is_single_use_and_scope_bound() {
        let registry = NativeFileGrantRegistry::default();
        let id = registry
            .insert(test_grant("op-1", GrantPurpose::AttachmentUpload))
            .expect("insert");
        assert!(registry
            .consume(&id, "other", "op-1", GrantPurpose::AttachmentUpload)
            .is_err());
        assert!(
            registry
                .consume(&id, "main", "op-1", GrantPurpose::AttachmentUpload)
                .is_err(),
            "failed scope attempt must consume the token"
        );

        let id = registry
            .insert(test_grant("op-2", GrantPurpose::AttachmentUpload))
            .expect("insert");
        registry
            .consume(&id, "main", "op-2", GrantPurpose::AttachmentUpload)
            .expect("first consume");
        assert!(registry
            .consume(&id, "main", "op-2", GrantPurpose::AttachmentUpload)
            .is_err());
    }

    #[test]
    fn purpose_limits_and_mime_are_fail_closed() {
        assert_eq!(GRANT_TTL, Duration::from_secs(60));
        assert_eq!(GrantPurpose::AttachmentUpload.max_bytes(), 200 * 1024 * 1024);
        assert!(
            GrantPurpose::AttachmentUpload.max_bytes() < GrantPurpose::KnowledgeUpload.max_bytes()
        );
        assert!(validate_mime("paper.pdf", "application/pdf").is_ok());
        assert!(validate_mime("paper.pdf", "image/png").is_err());
        assert!(!GrantPurpose::SaveDownload.is_read());
        assert!(!GrantPurpose::KnowledgeUpload.is_save());
    }

    #[test]
    fn upload_target_is_bound_to_the_grant_purpose() {
        crate::sidecar::initialize_capability_token().expect("capability");
        assert!(validate_upload_contract(
            GrantPurpose::AttachmentUpload,
            "/api/v1/attachments",
            "attachment:abc",
            Some("file")
        )
        .is_ok());
        assert!(validate_upload_contract(
            GrantPurpose::AttachmentUpload,
            "/api/v1/documents/extract",
            "document:abc",
            Some("file")
        )
        .is_ok());
        assert!(validate_upload_contract(
            GrantPurpose::AttachmentUpload,
            "/api/k12/assets?agent=child",
            "asset:abc",
            None
        )
        .is_ok());
        assert!(validate_upload_contract(
            GrantPurpose::AttachmentUpload,
            "/api/v1/knowledge/documents?user_id=desktop",
            "cross-purpose",
            None
        )
        .is_err());
        assert!(validate_upload_contract(
            GrantPurpose::KnowledgeUpload,
            "/api/v1/knowledge/documents?user_id=desktop",
            "knowledge:abc",
            Some("other")
        )
        .is_err());
    }

    #[test]
    fn expired_staging_grants_remove_their_private_files() {
        let registry = NativeFileGrantRegistry::default();
        let path =
            std::env::temp_dir().join(format!("hexclaw-expired-native-grant-{}", Uuid::new_v4()));
        std::fs::write(&path, b"private staged bytes").expect("write staged fixture");
        let mut grant = test_grant("expired-op", GrantPurpose::SaveCopy);
        grant.path = path.clone();
        grant.cleanup_source = true;
        grant.expires_at = Instant::now() - Duration::from_secs(1);
        registry
            .grants
            .lock()
            .expect("registry")
            .insert("expired".into(), grant);

        registry.purge_expired().expect("purge expired grants");

        assert!(
            !path.exists(),
            "expired private staging file must be deleted"
        );
    }

    #[test]
    fn grant_registry_capacity_fails_closed_and_rolls_back_private_staging_files() {
        let registry = NativeFileGrantRegistry::default();
        let mut ids = Vec::new();
        for index in 0..MAX_ACTIVE_FILE_GRANTS {
            ids.push(
                registry
                    .insert(test_grant(
                        &format!("grant-{index}"),
                        GrantPurpose::AttachmentUpload,
                    ))
                    .expect("fill grant capacity"),
            );
        }

        let overflow_path =
            std::env::temp_dir().join(format!("hexclaw-overflow-grant-{}.part", Uuid::new_v4()));
        std::fs::write(&overflow_path, b"private overflow bytes").expect("write overflow fixture");
        let mut overflow = test_grant("overflow", GrantPurpose::SaveCopy);
        overflow.path = overflow_path.clone();
        overflow.cleanup_source = true;
        let error = registry
            .insert(overflow)
            .expect_err("grant capacity must fail closed");
        assert_eq!(error, "Too many active native file grants");
        assert!(
            !overflow_path.exists(),
            "capacity rejection must remove the private staging file"
        );

        registry
            .consume(&ids[0], "main", "grant-0", GrantPurpose::AttachmentUpload)
            .expect("consume one grant");
        registry
            .insert(test_grant("replacement", GrantPurpose::AttachmentUpload))
            .expect("consumed slot is reusable");
    }

    #[test]
    fn explicit_discard_and_startup_prune_remove_only_private_part_files() {
        let root =
            std::env::temp_dir().join(format!("hexclaw-native-staging-prune-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create staging fixture");
        let orphan = root.join(format!("{}.part", Uuid::new_v4()));
        let unrelated = root.join("keep.txt");
        std::fs::write(&orphan, b"orphan private bytes").expect("write orphan");
        std::fs::write(&unrelated, b"unrelated").expect("write unrelated");

        prune_staging_directory(&root).expect("prune startup staging");
        assert!(!orphan.exists(), "startup must remove orphan .part files");
        assert!(unrelated.exists(), "startup must preserve unrelated files");

        let discarded = root.join(format!("{}.part", Uuid::new_v4()));
        std::fs::write(&discarded, b"cancelled private bytes").expect("write discard fixture");
        let registry = NativeFileGrantRegistry::default();
        let mut grant = test_grant("discard-op", GrantPurpose::SaveCopy);
        grant.path = discarded.clone();
        grant.cleanup_source = true;
        registry
            .insert_with_id("discard-grant".into(), grant)
            .expect("insert grant");
        registry
            .discard(
                "discard-grant",
                "main",
                "discard-op",
                GrantPurpose::SaveCopy,
            )
            .expect("discard grant");
        assert!(
            !discarded.exists(),
            "discard must remove the private .part file"
        );

        std::fs::remove_dir_all(root).expect("cleanup staging fixture");
    }

    #[test]
    fn transfer_registry_is_bounded_generation_safe_and_raii_releases_slots() {
        let registry = NativeFileTransferRegistry::default();
        let mut active = Vec::new();
        for index in 0..MAX_ACTIVE_FILE_TRANSFERS {
            active.push(
                registry
                    .register(format!("transfer-{index}"))
                    .expect("fill transfer capacity"),
            );
        }
        let error = registry
            .register("overflow".into())
            .err()
            .expect("capacity exhaustion must fail closed");
        assert_eq!(error, "Too many active native file transfers");
        active.pop();
        let replacement = registry
            .register("replacement".into())
            .expect("released slot is reusable");
        assert_eq!(
            registry.active_count().expect("replacement active"),
            MAX_ACTIVE_FILE_TRANSFERS
        );
        drop(replacement);
        drop(active);
        assert_eq!(registry.active_count().expect("all released"), 0);

        let cancelled = registry
            .register("reused-operation".into())
            .expect("register cancellable transfer");
        let stale_generation = cancelled.generation();
        registry
            .cancel("reused-operation")
            .expect("cancel active transfer");
        assert!(cancelled.token().is_cancelled());
        assert_eq!(
            registry.active_count().expect("cancel retains ownership"),
            1,
            "cancel must not open an ABA reuse window before the task exits"
        );
        drop(cancelled);

        let current = registry
            .register("reused-operation".into())
            .expect("reuse operation after prior task exits");
        registry
            .release("reused-operation", stale_generation)
            .expect("stale cleanup is harmless");
        assert_eq!(
            registry.active_count().expect("new generation retained"),
            1,
            "old generation must not delete the current transfer"
        );
        drop(current);
        assert_eq!(registry.active_count().expect("current released"), 0);
    }

    #[tokio::test]
    async fn transfer_cancellation_interrupts_a_pending_response_body_and_releases_its_slot() {
        let registry = NativeFileTransferRegistry::default();
        let registration = registry
            .register("response-body".into())
            .expect("register response reader");
        let cancellation = registration.token();
        let pending = tokio::spawn(async move {
            let _registration = registration;
            await_file_transfer_or_cancel(
                cancellation,
                std::future::pending::<Result<Vec<u8>, String>>(),
            )
            .await
        });

        registry
            .cancel("response-body")
            .expect("cancel response reader");
        let error = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("response reader must stop promptly")
            .expect("join response reader")
            .expect_err("cancelled response reader");
        assert_eq!(error, "file transfer cancelled");
        assert_eq!(registry.active_count().expect("slot released"), 0);
    }

    #[test]
    fn failed_registration_ack_releases_the_transfer_slot() {
        let registry = NativeFileTransferRegistry::default();
        let closed_channel = Channel::new(|_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "renderer registration channel closed",
            )
            .into())
        });

        let error =
            register_acknowledged_transfer(&registry, "ack-failure".into(), &closed_channel)
                .err()
                .expect("registration acknowledgement must fail");
        assert_eq!(error, "file transfer registration acknowledgement failed");
        assert_eq!(registry.active_count().expect("failed ACK released"), 0);
    }

    #[tokio::test]
    async fn opened_source_handle_must_match_the_authorized_identity_and_digest() {
        let path =
            std::env::temp_dir().join(format!("hexclaw-native-grant-identity-{}", Uuid::new_v4()));
        tokio::fs::write(&path, b"authorized bytes")
            .await
            .expect("write authorized source");
        let source_identity = identity(&path).await.expect("source identity");
        let source_sha256 = sha256_file(&path).await.expect("source digest");
        let grant = FileGrant {
            path: source_identity.canonical_path.clone(),
            name: "source.txt".into(),
            mime: "text/plain".into(),
            expected_size: source_identity.size,
            purpose: GrantPurpose::KnowledgeUpload,
            window_label: "main".into(),
            operation_id: "identity-test".into(),
            sealed: true,
            cleanup_source: false,
            identity: Some(source_identity),
            source_sha256: Some(source_sha256),
            expires_at: Instant::now() + GRANT_TTL,
            io_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        open_verified_read_grant(&grant)
            .await
            .expect("authorized handle");

        tokio::fs::write(&path, b"substitute bytes")
            .await
            .expect("replace source content");
        assert!(open_verified_read_grant(&grant).await.is_err());
        let _ = tokio::fs::remove_file(path).await;
    }
}
