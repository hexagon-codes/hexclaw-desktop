//! Capability-based native file I/O.
//!
//! A filesystem path is accepted only from a native picker or native drop
//! event. It is exchanged immediately for a short-lived, window/operation/
//! purpose-bound opaque grant. Consumers remove the grant before I/O, making
//! every capability single-use even when an operation fails.

use crate::sidecar_client::{read_bounded, SidecarClient};
use futures_util::StreamExt;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Cursor},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
const MAX_ACTIVE_IMAGE_PREVIEW_LEASES: usize = MAX_ACTIVE_FILE_GRANTS;
const MAX_IMAGE_PREVIEW_EDGE: u32 = 1024;
const MAX_IMAGE_PREVIEW_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PREVIEW_DECODE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_ENCODED_BYTES: usize = 8 * 1024 * 1024;
const MAX_ACTIVE_IMAGE_PREVIEW_BYTES: usize = 64 * 1024 * 1024;

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
    image_previews: Arc<Mutex<NativeImagePreviewLeaseState>>,
}

struct NativeImagePreviewLease {
    upload_grant_id: String,
    window_label: String,
    operation_id: String,
    scope: Option<NativeImagePreviewScope>,
    source_identity: FileIdentity,
    source_sha256: String,
    created_at: SystemTime,
    expires_at: Instant,
    expires_at_system: SystemTime,
    revoked_at: Option<SystemTime>,
    png: Arc<[u8]>,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeImagePreviewScope {
    owner_id: String,
    session_id: String,
    attachment_id: String,
}

#[derive(Default)]
struct NativeImagePreviewWindowScope {
    owner_id: String,
    session_id: String,
    attachment_ids: HashSet<String>,
}

#[derive(Default)]
struct NativeImagePreviewLeaseState {
    leases: HashMap<String, NativeImagePreviewLease>,
    window_scopes: HashMap<String, NativeImagePreviewWindowScope>,
    total_bytes: usize,
}

struct DerivedNativeImagePreview {
    png: Vec<u8>,
    width: u32,
    height: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_lease: Option<NativeImagePreviewLeaseDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImagePreviewLeaseDescriptor {
    lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    mime: String,
    width: u32,
    height: u32,
    created_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_id: Option<String>,
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
    fn purge_expired_image_previews_locked(state: &mut NativeImagePreviewLeaseState) {
        let now = Instant::now();
        let expired = state
            .leases
            .iter()
            .filter(|(_, lease)| lease.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            Self::remove_image_preview_locked(state, &id, SystemTime::now());
        }
    }

    fn remove_image_preview_locked(
        state: &mut NativeImagePreviewLeaseState,
        id: &str,
        revoked_at: SystemTime,
    ) -> bool {
        let Some(mut lease) = state.leases.remove(id) else {
            return false;
        };
        lease.revoked_at = Some(revoked_at);
        state.total_bytes = state.total_bytes.saturating_sub(lease.png.len());
        if let Some(scope) = lease.scope.as_ref() {
            if let Some(active) = state.window_scopes.get_mut(&lease.window_label) {
                if active.owner_id == scope.owner_id && active.session_id == scope.session_id {
                    active.attachment_ids.remove(&scope.attachment_id);
                }
            }
        }
        true
    }

    fn image_preview_descriptor(
        lease_id: &str,
        lease: &NativeImagePreviewLease,
    ) -> NativeImagePreviewLeaseDescriptor {
        let scope = lease.scope.as_ref();
        NativeImagePreviewLeaseDescriptor {
            lease_id: lease_id.to_owned(),
            url: scope.map(|_| native_image_preview_url(lease_id)),
            mime: "image/png".into(),
            width: lease.width,
            height: lease.height,
            created_at_unix_ms: unix_millis(lease.created_at),
            expires_at_unix_ms: unix_millis(lease.expires_at_system),
            owner_id: scope.map(|value| value.owner_id.clone()),
            session_id: scope.map(|value| value.session_id.clone()),
            attachment_id: scope.map(|value| value.attachment_id.clone()),
        }
    }

    fn insert_image_preview(
        &self,
        upload_grant_id: &str,
        grant: &FileGrant,
        preview: DerivedNativeImagePreview,
    ) -> Result<NativeImagePreviewLeaseDescriptor, String> {
        let source_identity = grant
            .identity
            .clone()
            .ok_or("native image preview source identity is missing")?;
        let source_sha256 = grant
            .source_sha256
            .as_deref()
            .ok_or("native image preview source digest is missing")?;
        if grant.purpose != GrantPurpose::AttachmentUpload
            || source_sha256.len() != 64
            || !source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || preview.png.is_empty()
            || preview.png.len() > MAX_IMAGE_PREVIEW_ENCODED_BYTES
            || preview.width == 0
            || preview.height == 0
            || preview.width > MAX_IMAGE_PREVIEW_EDGE
            || preview.height > MAX_IMAGE_PREVIEW_EDGE
        {
            return Err("native image preview contract is invalid".into());
        }
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        if state.leases.len() >= MAX_ACTIVE_IMAGE_PREVIEW_LEASES
            || state.total_bytes.saturating_add(preview.png.len()) > MAX_ACTIVE_IMAGE_PREVIEW_BYTES
        {
            return Err("Too many active native image previews".into());
        }

        let lease_id = Uuid::new_v4().to_string();
        let created_at = SystemTime::now();
        let expires_at_system = created_at + GRANT_TTL;
        state.total_bytes = state.total_bytes.saturating_add(preview.png.len());
        state.leases.insert(
            lease_id.clone(),
            NativeImagePreviewLease {
                upload_grant_id: upload_grant_id.to_owned(),
                window_label: grant.window_label.clone(),
                operation_id: grant.operation_id.clone(),
                scope: None,
                source_identity,
                source_sha256: source_sha256.to_owned(),
                created_at,
                expires_at: Instant::now() + GRANT_TTL,
                expires_at_system,
                revoked_at: None,
                png: Arc::from(preview.png),
                width: preview.width,
                height: preview.height,
            },
        );
        let descriptor = Self::image_preview_descriptor(
            &lease_id,
            state
                .leases
                .get(&lease_id)
                .expect("new native image preview lease"),
        );
        drop(state);

        // TTL 到点主动释放派生预览；读取路径仍会同步清理，避免调度延迟扩大能力窗口。
        let image_previews = Arc::clone(&self.image_previews);
        let expiring_lease_id = descriptor.lease_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(GRANT_TTL).await;
            if let Ok(mut state) = image_previews.lock() {
                if state
                    .leases
                    .get(&expiring_lease_id)
                    .is_some_and(|lease| lease.expires_at <= Instant::now())
                {
                    NativeFileGrantRegistry::remove_image_preview_locked(
                        &mut state,
                        &expiring_lease_id,
                        SystemTime::now(),
                    );
                }
            }
        });
        Ok(descriptor)
    }

    fn sync_image_preview_scope(
        &self,
        window_label: &str,
        owner_id: Option<&str>,
        session_id: Option<&str>,
        attachment_ids: &[String],
    ) -> Result<(), String> {
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        match (owner_id, session_id) {
            (None, None) if attachment_ids.is_empty() => {
                state.window_scopes.remove(window_label);
                Ok(())
            }
            (Some(owner_id), Some(session_id)) => {
                let owner_id = validate_preview_identity(owner_id, "owner")?;
                let session_id = validate_preview_identity(session_id, "session")?;
                if attachment_ids.len() > MAX_ACTIVE_IMAGE_PREVIEW_LEASES {
                    return Err("native image preview attachment scope is invalid".into());
                }
                let mut active_attachments = HashSet::with_capacity(attachment_ids.len());
                for attachment_id in attachment_ids {
                    active_attachments
                        .insert(validate_preview_identity(attachment_id, "attachment")?);
                }
                state.window_scopes.insert(
                    window_label.to_owned(),
                    NativeImagePreviewWindowScope {
                        owner_id,
                        session_id,
                        attachment_ids: active_attachments,
                    },
                );
                Ok(())
            }
            _ => Err("native image preview window scope is invalid".into()),
        }
    }

    fn bind_image_preview(
        &self,
        lease_id: &str,
        window_label: &str,
        operation_id: &str,
        upload_grant_id: &str,
        scope: &NativeImagePreviewScope,
    ) -> Result<NativeImagePreviewLeaseDescriptor, String> {
        Uuid::parse_str(lease_id).map_err(|_| "native image preview lease id is invalid")?;
        Uuid::parse_str(upload_grant_id)
            .map_err(|_| "native image preview upload grant id is invalid")?;
        let operation_id = validate_operation_id(operation_id)?;
        let scope = NativeImagePreviewScope {
            owner_id: validate_preview_identity(&scope.owner_id, "owner")?,
            session_id: validate_preview_identity(&scope.session_id, "session")?,
            attachment_id: validate_preview_identity(&scope.attachment_id, "attachment")?,
        };
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        let active = state
            .window_scopes
            .get(window_label)
            .ok_or("native image preview window scope is missing")?;
        if active.owner_id != scope.owner_id || active.session_id != scope.session_id {
            return Err("native image preview window scope mismatch".into());
        }
        let lease = state
            .leases
            .get(lease_id)
            .ok_or("native image preview lease expired or unknown")?;
        if lease.window_label != window_label
            || lease.operation_id != operation_id
            || lease.upload_grant_id != upload_grant_id
        {
            return Err("native image preview lease scope mismatch".into());
        }
        if lease
            .scope
            .as_ref()
            .is_some_and(|bound_scope| bound_scope != &scope)
        {
            return Err("native image preview lease scope mismatch".into());
        }
        state
            .leases
            .get_mut(lease_id)
            .expect("validated native image preview lease")
            .scope = Some(scope.clone());
        state
            .window_scopes
            .get_mut(window_label)
            .expect("validated native image preview window scope")
            .attachment_ids
            .insert(scope.attachment_id);
        Ok(Self::image_preview_descriptor(
            lease_id,
            state
                .leases
                .get(lease_id)
                .expect("bound native image preview lease"),
        ))
    }

    fn inspect_image_preview(
        &self,
        lease_id: &str,
        window_label: &str,
    ) -> Result<(Arc<[u8]>, u32, u32), String> {
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        let window_or_integrity_mismatch = state.leases.get(lease_id).is_some_and(|lease| {
            lease.window_label != window_label
                || lease.revoked_at.is_some()
                || lease.source_identity.size == 0
                || !lease.source_identity.canonical_path.is_absolute()
                || lease.source_sha256.len() != 64
                || !lease
                    .source_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || lease
                    .expires_at_system
                    .duration_since(lease.created_at)
                    .ok()
                    != Some(GRANT_TTL)
        });
        if window_or_integrity_mismatch {
            Self::remove_image_preview_locked(&mut state, lease_id, SystemTime::now());
            return Err("native image preview lease scope mismatch".into());
        }
        let lease = state
            .leases
            .get(lease_id)
            .ok_or("native image preview lease expired or unknown")?;
        let scope = lease
            .scope
            .as_ref()
            .ok_or("native image preview lease is not bound")?;
        let active = state
            .window_scopes
            .get(window_label)
            .ok_or("native image preview window scope is missing")?;
        if active.owner_id != scope.owner_id
            || active.session_id != scope.session_id
            || !active.attachment_ids.contains(&scope.attachment_id)
        {
            return Err("native image preview lease business scope mismatch".into());
        }
        Ok((lease.png.clone(), lease.width, lease.height))
    }

    fn revoke_image_preview(
        &self,
        lease_id: &str,
        window_label: &str,
        operation_id: &str,
        upload_grant_id: &str,
        scope: &NativeImagePreviewScope,
    ) -> Result<(), String> {
        Uuid::parse_str(lease_id).map_err(|_| "native image preview lease id is invalid")?;
        Uuid::parse_str(upload_grant_id)
            .map_err(|_| "native image preview upload grant id is invalid")?;
        let operation_id = validate_operation_id(operation_id)?;
        let scope = NativeImagePreviewScope {
            owner_id: validate_preview_identity(&scope.owner_id, "owner")?,
            session_id: validate_preview_identity(&scope.session_id, "session")?,
            attachment_id: validate_preview_identity(&scope.attachment_id, "attachment")?,
        };
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        let Some(lease) = state.leases.get(lease_id) else {
            return Ok(());
        };
        if lease.scope.as_ref() != Some(&scope) {
            return Err("native image preview lease business scope mismatch".into());
        }
        let native_scope_matches = lease.window_label == window_label
            && lease.operation_id == operation_id
            && lease.upload_grant_id == upload_grant_id;
        Self::remove_image_preview_locked(&mut state, lease_id, SystemTime::now());
        if native_scope_matches {
            Ok(())
        } else {
            Err("native image preview lease scope mismatch".into())
        }
    }

    fn revoke_image_previews_for_upload_grant(&self, upload_grant_id: &str) -> Result<(), String> {
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        let ids = state
            .leases
            .iter()
            .filter(|(_, lease)| lease.upload_grant_id == upload_grant_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            Self::remove_image_preview_locked(&mut state, &id, SystemTime::now());
        }
        Ok(())
    }

    fn revoke_image_previews_for_window(&self, window_label: &str) -> Result<(), String> {
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        let ids = state
            .leases
            .iter()
            .filter(|(_, lease)| lease.window_label == window_label)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            Self::remove_image_preview_locked(&mut state, &id, SystemTime::now());
        }
        Ok(())
    }

    #[cfg(test)]
    fn active_image_preview_count(&self) -> Result<usize, String> {
        let mut state = self
            .image_previews
            .lock()
            .map_err(|_| "native image preview registry poisoned")?;
        Self::purge_expired_image_previews_locked(&mut state);
        Ok(state.leases.len())
    }

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
        let _ = self.revoke_image_previews_for_upload_grant(id);
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

fn validate_preview_identity(value: &str, kind: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("native image preview {kind} identity is invalid"));
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

fn unix_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn native_image_preview_url(lease_id: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("http://hexclaw-preview.localhost/{lease_id}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("hexclaw-preview://localhost/{lease_id}")
    }
}

fn native_image_preview_origin_is_valid(uri: &tauri::http::Uri) -> bool {
    #[cfg(target_os = "windows")]
    {
        uri.scheme_str() == Some("http")
            && uri.authority().map(|value| value.as_str()) == Some("hexclaw-preview.localhost")
    }
    #[cfg(not(target_os = "windows"))]
    {
        uri.scheme_str() == Some("hexclaw-preview")
            && uri.authority().map(|value| value.as_str()) == Some("localhost")
    }
}

fn native_image_preview_format(mime: &str) -> Option<ImageFormat> {
    match mime {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" => Some(ImageFormat::Jpeg),
        _ => None,
    }
}

fn derive_bounded_native_image_preview(
    file: std::fs::File,
    format: ImageFormat,
) -> Result<DerivedNativeImagePreview, String> {
    let mut reader = ImageReader::with_format(BufReader::new(file), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_PREVIEW_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_PREVIEW_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_PREVIEW_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("decode native image preview: {error}"))?;
    if decoder.total_bytes() > MAX_IMAGE_PREVIEW_DECODE_BYTES {
        return Err("native image preview exceeds decode limit".into());
    }
    let orientation = decoder
        .orientation()
        .map_err(|error| format!("read native image preview orientation: {error}"))?;
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("decode native image preview: {error}"))?;
    image.apply_orientation(orientation);
    let image = image.thumbnail(MAX_IMAGE_PREVIEW_EDGE, MAX_IMAGE_PREVIEW_EDGE);
    let width = image.width();
    let height = image.height();
    let mut encoded = Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| format!("encode native image preview: {error}"))?;
    let png = encoded.into_inner();
    if png.is_empty() || png.len() > MAX_IMAGE_PREVIEW_ENCODED_BYTES {
        return Err("native image preview exceeds encoded limit".into());
    }
    Ok(DerivedNativeImagePreview { png, width, height })
}

async fn derive_native_image_preview(
    grant: &FileGrant,
) -> Result<Option<DerivedNativeImagePreview>, String> {
    let Some(format) = native_image_preview_format(&grant.mime) else {
        return Ok(None);
    };
    let file = open_verified_read_grant(grant).await?;
    let file = file.into_std().await;
    tokio::task::spawn_blocking(move || derive_bounded_native_image_preview(file, format))
        .await
        .map_err(|_| "native image preview worker failed".to_string())?
        .map(Some)
}

fn native_image_preview_error_response(
    status: tauri::http::StatusCode,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CACHE_CONTROL, "no-store")
        .header(tauri::http::header::CONTENT_LENGTH, "0")
        .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Vec::new())
        .expect("constant native image preview error response")
}

pub fn native_image_preview_response(
    registry: &NativeFileGrantRegistry,
    window_label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET || !request.body().is_empty() {
        return native_image_preview_error_response(tauri::http::StatusCode::METHOD_NOT_ALLOWED);
    }
    if !native_image_preview_origin_is_valid(request.uri()) || request.uri().query().is_some() {
        return native_image_preview_error_response(tauri::http::StatusCode::NOT_FOUND);
    }
    let lease_id = request.uri().path().trim_matches('/');
    if lease_id.contains('/') || Uuid::parse_str(lease_id).is_err() {
        return native_image_preview_error_response(tauri::http::StatusCode::NOT_FOUND);
    }
    let Ok((png, _, _)) = registry.inspect_image_preview(lease_id, window_label) else {
        return native_image_preview_error_response(tauri::http::StatusCode::NOT_FOUND);
    };
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(tauri::http::header::CONTENT_TYPE, "image/png")
        .header(tauri::http::header::CACHE_CONTROL, "no-store, max-age=0")
        .header(tauri::http::header::PRAGMA, "no-cache")
        .header(tauri::http::header::CONTENT_LENGTH, png.len().to_string())
        .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(tauri::http::header::CONTENT_DISPOSITION, "inline")
        .header("Referrer-Policy", "no-referrer")
        .body(png.as_ref().to_vec())
        .expect("constant native image preview response")
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
    let grant = FileGrant {
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
    };
    // 预览从同一文件身份与摘要已验证的句柄派生；失败只关闭预览能力，
    // 不放宽或替换原有一次性上传授权。
    let preview = if purpose == GrantPurpose::AttachmentUpload {
        derive_native_image_preview(&grant).await.ok().flatten()
    } else {
        None
    };
    let grant_id = registry.insert(grant.clone())?;
    let preview_lease = preview.and_then(|preview| {
        registry
            .insert_image_preview(&grant_id, &grant, preview)
            .ok()
    });
    Ok(FileGrantDescriptor {
        grant_id,
        operation_id,
        purpose,
        name,
        mime,
        size,
        source_sha256: Some(source_sha256),
        preview_lease,
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
        preview_lease: None,
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
        preview_lease: None,
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
        preview_lease: None,
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
pub fn sync_native_image_preview_scope(
    window: WebviewWindow,
    owner_id: Option<String>,
    session_id: Option<String>,
    attachment_ids: Vec<String>,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<(), String> {
    registry.sync_image_preview_scope(
        window.label(),
        owner_id.as_deref(),
        session_id.as_deref(),
        &attachment_ids,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn bind_native_image_preview_lease(
    window: WebviewWindow,
    lease_id: String,
    operation_id: String,
    upload_grant_id: String,
    owner_id: String,
    session_id: String,
    attachment_id: String,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<NativeImagePreviewLeaseDescriptor, String> {
    registry.bind_image_preview(
        &lease_id,
        window.label(),
        &operation_id,
        &upload_grant_id,
        &NativeImagePreviewScope {
            owner_id,
            session_id,
            attachment_id,
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn revoke_native_image_preview_lease(
    window: WebviewWindow,
    lease_id: String,
    operation_id: String,
    upload_grant_id: String,
    owner_id: String,
    session_id: String,
    attachment_id: String,
    registry: State<'_, NativeFileGrantRegistry>,
) -> Result<(), String> {
    registry.revoke_image_preview(
        &lease_id,
        window.label(),
        &operation_id,
        &upload_grant_id,
        &NativeImagePreviewScope {
            owner_id,
            session_id,
            attachment_id,
        },
    )
}

pub fn revoke_native_image_preview_leases_for_window(
    registry: &NativeFileGrantRegistry,
    window_label: &str,
) -> Result<(), String> {
    registry.revoke_image_previews_for_window(window_label)
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

    fn preview_request(
        method: tauri::http::Method,
        preview_url: &str,
    ) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .method(method)
            .uri(preview_url)
            .body(Vec::new())
            .expect("build native image preview request")
    }

    fn preview_scope(session_id: &str, attachment_id: &str) -> NativeImagePreviewScope {
        NativeImagePreviewScope {
            owner_id: "desktop-user".into(),
            session_id: session_id.into(),
            attachment_id: attachment_id.into(),
        }
    }

    fn bind_preview(
        registry: &NativeFileGrantRegistry,
        descriptor: &FileGrantDescriptor,
        window_label: &str,
        scope: &NativeImagePreviewScope,
    ) -> NativeImagePreviewLeaseDescriptor {
        let preview = descriptor
            .preview_lease
            .as_ref()
            .expect("native image preview descriptor");
        registry
            .sync_image_preview_scope(
                window_label,
                Some(&scope.owner_id),
                Some(&scope.session_id),
                std::slice::from_ref(&scope.attachment_id),
            )
            .expect("synchronize active native preview scope");
        registry
            .bind_image_preview(
                &preview.lease_id,
                window_label,
                &descriptor.operation_id,
                &descriptor.grant_id,
                scope,
            )
            .expect("bind native image preview")
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
        assert_eq!(
            GrantPurpose::AttachmentUpload.max_bytes(),
            200 * 1024 * 1024
        );
        assert!(
            GrantPurpose::AttachmentUpload.max_bytes() < GrantPurpose::KnowledgeUpload.max_bytes()
        );
        assert!(validate_mime("paper.pdf", "application/pdf").is_ok());
        assert!(validate_mime("paper.pdf", "image/png").is_err());
        assert!(!GrantPurpose::SaveDownload.is_read());
        assert!(!GrantPurpose::KnowledgeUpload.is_save());
    }

    #[tokio::test]
    async fn attachment_grant_accepts_exact_200_mib_and_rejects_one_byte_over_before_hashing() {
        let root =
            std::env::temp_dir().join(format!("hexclaw-attachment-limit-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create attachment-limit fixture root");
        let exact = root.join("exact-limit.png");
        let over = root.join("over-limit.png");
        std::fs::File::create(&exact)
            .expect("create exact attachment fixture")
            .set_len(MAX_ATTACHMENT_BYTES)
            .expect("size exact attachment fixture");
        std::fs::File::create(&over)
            .expect("create over-limit attachment fixture")
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .expect("size over-limit attachment fixture");

        let registry = NativeFileGrantRegistry::default();
        let descriptor = issue_read_grant(
            &registry,
            "main",
            "attachment-exact-limit",
            exact,
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("exact 200 MiB attachment must receive a grant");
        assert_eq!(descriptor.size, MAX_ATTACHMENT_BYTES);
        assert!(
            descriptor.preview_lease.is_none(),
            "invalid image bytes must not weaken the unchanged upload grant"
        );

        let error = issue_read_grant(
            &registry,
            "main",
            "attachment-over-limit",
            over,
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect_err("200 MiB + 1 byte attachment must be rejected before hashing");
        assert_eq!(error, "selected file exceeds operation limit");

        std::fs::remove_dir_all(root).expect("clean attachment-limit fixture root");
    }

    #[tokio::test]
    async fn legal_native_image_grant_issues_independent_preview_lease_without_consuming_upload_grant(
    ) {
        let path = std::env::temp_dir().join(format!(
            "hexclaw-native-image-preview-{}.png",
            Uuid::new_v4()
        ));
        tokio::fs::write(&path, include_bytes!("../icons/32x32.png"))
            .await
            .expect("write image fixture");
        let registry = NativeFileGrantRegistry::default();

        let descriptor = issue_read_grant(
            &registry,
            "main",
            "native-preview-session",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue native image grant");
        let serialized = serde_json::to_value(&descriptor).expect("serialize grant descriptor");
        let preview = serialized
            .get("previewLease")
            .and_then(serde_json::Value::as_object)
            .expect("legal native image must include an opaque preview lease");
        assert_eq!(
            preview.get("mime").and_then(serde_json::Value::as_str),
            Some("image/png")
        );
        for required in [
            "leaseId",
            "mime",
            "width",
            "height",
            "createdAtUnixMs",
            "expiresAtUnixMs",
        ] {
            assert!(preview.contains_key(required));
        }
        assert_eq!(preview.len(), 6);
        for forbidden in [
            "url",
            "ownerId",
            "sessionId",
            "attachmentId",
            "path",
            "bytes",
            "base64",
            "data",
        ] {
            assert!(!preview.contains_key(forbidden));
        }
        let unbound_preview = descriptor
            .preview_lease
            .clone()
            .expect("native image preview descriptor");
        assert!(unbound_preview.expires_at_unix_ms > unbound_preview.created_at_unix_ms);
        assert!(unbound_preview.url.is_none());
        assert!(unbound_preview.owner_id.is_none());
        assert!(unbound_preview.session_id.is_none());
        assert!(unbound_preview.attachment_id.is_none());
        {
            let state = registry
                .image_previews
                .lock()
                .expect("lock image preview registry");
            let lease = state
                .leases
                .get(&unbound_preview.lease_id)
                .expect("stored image preview lease");
            assert_eq!(lease.upload_grant_id, descriptor.grant_id);
            assert_eq!(lease.window_label, "main");
            assert_eq!(lease.operation_id, "native-preview-session");
            assert_eq!(lease.source_identity.size, descriptor.size);
            assert_eq!(
                Some(lease.source_sha256.as_str()),
                descriptor.source_sha256.as_deref()
            );
            assert!(lease.scope.is_none());
        }
        assert!(
            registry
                .consume(
                    &unbound_preview.lease_id,
                    "main",
                    "native-preview-session",
                    GrantPurpose::AttachmentUpload,
                )
                .is_err(),
            "preview lease must not be redeemable as an upload grant"
        );

        let scope = preview_scope("chat-session-a", "attachment-a");
        let preview_lease = bind_preview(&registry, &descriptor, "main", &scope);
        let serialized = serde_json::to_value(&preview_lease).expect("serialize bound lease");
        let preview = serialized
            .as_object()
            .expect("serialize bound native image preview lease as object");
        for required in [
            "leaseId",
            "url",
            "mime",
            "width",
            "height",
            "createdAtUnixMs",
            "expiresAtUnixMs",
            "ownerId",
            "sessionId",
            "attachmentId",
        ] {
            assert!(preview.contains_key(required));
        }
        assert_eq!(preview.len(), 10);
        let preview_url = preview_lease.url.as_deref().expect("bound preview URL");
        assert_eq!(
            preview_url,
            native_image_preview_url(&preview_lease.lease_id)
        );
        assert!(!preview_url.contains(&scope.owner_id));
        assert!(!preview_url.contains(&scope.session_id));
        assert!(!preview_url.contains(&scope.attachment_id));

        let grant = registry
            .consume(
                &descriptor.grant_id,
                "main",
                "native-preview-session",
                GrantPurpose::AttachmentUpload,
            )
            .expect("preview issuance must not consume upload grant");
        open_verified_read_grant(&grant)
            .await
            .expect("upload grant remains bound to the original image");
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("count image previews"),
            1,
            "consuming the upload grant must not consume its independent preview lease"
        );
        registry
            .revoke_image_preview(
                &preview_lease.lease_id,
                "main",
                "native-preview-session",
                &descriptor.grant_id,
                &scope,
            )
            .expect("explicitly revoke preview lease");
        registry
            .revoke_image_preview(
                &preview_lease.lease_id,
                "main",
                "native-preview-session",
                &descriptor.grant_id,
                &scope,
            )
            .expect("duplicate preview revoke is idempotent");
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("count image previews after revoke"),
            0
        );

        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn native_image_preview_protocol_returns_only_bounded_derived_png_without_cors() {
        let path = std::env::temp_dir().join(format!(
            "hexclaw-native-image-preview-{}.jpg",
            Uuid::new_v4()
        ));
        let source = DynamicImage::new_rgb8(2048, 1024);
        let mut encoded = Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, ImageFormat::Jpeg)
            .expect("encode JPEG fixture");
        let original = encoded.into_inner();
        tokio::fs::write(&path, &original)
            .await
            .expect("write JPEG fixture");
        let registry = NativeFileGrantRegistry::default();
        let descriptor = issue_read_grant(
            &registry,
            "main",
            "native-preview-protocol",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue JPEG upload grant");
        let scope = preview_scope("chat-session-protocol", "attachment-protocol");
        let preview = bind_preview(&registry, &descriptor, "main", &scope);
        assert_eq!((preview.width, preview.height), (1024, 512));
        let preview_url = preview.url.as_deref().expect("bound preview URL");

        let wrong_host = tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(format!("hexclaw-preview://other/{}", preview.lease_id))
            .body(Vec::new())
            .expect("build wrong-host preview request");
        assert_eq!(
            native_image_preview_response(&registry, "main", wrong_host).status(),
            tauri::http::StatusCode::NOT_FOUND
        );
        let query = tauri::http::Request::builder()
            .method(tauri::http::Method::GET)
            .uri(format!("{preview_url}?download=1"))
            .body(Vec::new())
            .expect("build query preview request");
        assert_eq!(
            native_image_preview_response(&registry, "main", query).status(),
            tauri::http::StatusCode::NOT_FOUND
        );

        let response = native_image_preview_response(
            &registry,
            "main",
            preview_request(tauri::http::Method::GET, preview_url),
        );
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(tauri::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("image/png")
        );
        assert!(response
            .headers()
            .get(tauri::http::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("no-store")));
        assert!(response
            .headers()
            .get(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
        assert!(response.body().starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_ne!(response.body().as_slice(), original.as_slice());

        let second_get = native_image_preview_response(
            &registry,
            "main",
            preview_request(tauri::http::Method::GET, preview_url),
        );
        assert_eq!(
            second_get.status(),
            tauri::http::StatusCode::OK,
            "render reads do not consume the lease"
        );
        let rejected_post = native_image_preview_response(
            &registry,
            "main",
            preview_request(tauri::http::Method::POST, preview_url),
        );
        assert_eq!(
            rejected_post.status(),
            tauri::http::StatusCode::METHOD_NOT_ALLOWED
        );
        assert!(rejected_post.body().is_empty());
        assert!(rejected_post
            .headers()
            .get(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());

        let wrong_window = native_image_preview_response(
            &registry,
            "other",
            preview_request(tauri::http::Method::GET, preview_url),
        );
        assert_eq!(wrong_window.status(), tauri::http::StatusCode::NOT_FOUND);
        let revoked_after_scope_failure = native_image_preview_response(
            &registry,
            "main",
            preview_request(tauri::http::Method::GET, preview_url),
        );
        assert_eq!(
            revoked_after_scope_failure.status(),
            tauri::http::StatusCode::NOT_FOUND
        );

        let grant = registry
            .consume(
                &descriptor.grant_id,
                "main",
                "native-preview-protocol",
                GrantPurpose::AttachmentUpload,
            )
            .expect("preview scope rejection must not consume upload grant");
        open_verified_read_grant(&grant)
            .await
            .expect("upload grant remains usable");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn native_image_preview_scope_mismatch_does_not_consume_the_legal_lease_or_upload_grant()
    {
        let path = std::env::temp_dir().join(format!(
            "hexclaw-native-image-preview-scope-{}.png",
            Uuid::new_v4()
        ));
        tokio::fs::write(&path, include_bytes!("../icons/32x32.png"))
            .await
            .expect("write image fixture");
        let registry = NativeFileGrantRegistry::default();
        let descriptor = issue_read_grant(
            &registry,
            "main",
            "native-preview-scope",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue scoped native image preview");
        let unbound = descriptor
            .preview_lease
            .as_ref()
            .expect("native image preview descriptor");
        assert!(unbound.url.is_none(), "bind 前不得暴露可读 lease URL");
        let unbound_url = native_image_preview_url(&unbound.lease_id);
        assert_eq!(
            native_image_preview_response(
                &registry,
                "main",
                preview_request(tauri::http::Method::GET, &unbound_url),
            )
            .status(),
            tauri::http::StatusCode::NOT_FOUND,
            "未绑定真实业务身份的 lease 不可读取"
        );

        let legal_scope = preview_scope("chat-session-a", "attachment-a");
        let preview = bind_preview(&registry, &descriptor, "main", &legal_scope);
        let preview_url = preview.url.as_deref().expect("bound preview URL");

        for wrong_scope in [
            NativeImagePreviewScope {
                owner_id: "other-owner".into(),
                ..legal_scope.clone()
            },
            NativeImagePreviewScope {
                session_id: "chat-session-b".into(),
                ..legal_scope.clone()
            },
            NativeImagePreviewScope {
                attachment_id: "attachment-b".into(),
                ..legal_scope.clone()
            },
        ] {
            assert!(registry
                .bind_image_preview(
                    &preview.lease_id,
                    "main",
                    &descriptor.operation_id,
                    &descriptor.grant_id,
                    &wrong_scope,
                )
                .is_err());
            assert_eq!(
                registry
                    .active_image_preview_count()
                    .expect("count immutable scoped preview lease"),
                1,
                "conflicting rebind must not consume the legal lease"
            );
        }

        // Tauri scheme 请求只携带 opaque URL 与 window；同 window 的业务所有权由
        // ChatInput 同步的当前 owner/session/attachment active exact-set 提供。
        // 原 attachment 不再 active 时，即使复制同一个 bearer URL 到错误 attachment 也必须拒绝。
        for (owner, session, attachments, label) in [
            (
                "other-owner",
                legal_scope.session_id.as_str(),
                vec![legal_scope.attachment_id.clone()],
                "wrong owner",
            ),
            (
                legal_scope.owner_id.as_str(),
                "chat-session-b",
                vec![legal_scope.attachment_id.clone()],
                "wrong session",
            ),
            (
                legal_scope.owner_id.as_str(),
                legal_scope.session_id.as_str(),
                vec!["attachment-b".into()],
                "wrong attachment",
            ),
        ] {
            registry
                .sync_image_preview_scope("main", Some(owner), Some(session), &attachments)
                .expect("synchronize wrong active scope");
            assert_eq!(
                native_image_preview_response(
                    &registry,
                    "main",
                    preview_request(tauri::http::Method::GET, preview_url),
                )
                .status(),
                tauri::http::StatusCode::NOT_FOUND,
                "{label} must fail closed"
            );
            assert_eq!(
                registry
                    .active_image_preview_count()
                    .expect("count native preview leases"),
                1,
                "{label} must not consume the legal lease"
            );
            registry
                .sync_image_preview_scope(
                    "main",
                    Some(&legal_scope.owner_id),
                    Some(&legal_scope.session_id),
                    std::slice::from_ref(&legal_scope.attachment_id),
                )
                .expect("restore legal active scope");
            assert_eq!(
                native_image_preview_response(
                    &registry,
                    "main",
                    preview_request(tauri::http::Method::GET, preview_url),
                )
                .status(),
                tauri::http::StatusCode::OK,
                "legal lease must remain readable after {label}"
            );
        }

        for wrong_scope in [
            NativeImagePreviewScope {
                owner_id: "other-owner".into(),
                ..legal_scope.clone()
            },
            NativeImagePreviewScope {
                session_id: "chat-session-b".into(),
                ..legal_scope.clone()
            },
            NativeImagePreviewScope {
                attachment_id: "attachment-b".into(),
                ..legal_scope.clone()
            },
        ] {
            assert!(registry
                .revoke_image_preview(
                    &preview.lease_id,
                    "main",
                    &descriptor.operation_id,
                    &descriptor.grant_id,
                    &wrong_scope,
                )
                .is_err());
            assert_eq!(
                native_image_preview_response(
                    &registry,
                    "main",
                    preview_request(tauri::http::Method::GET, preview_url),
                )
                .status(),
                tauri::http::StatusCode::OK,
                "cross-scope revoke must not consume the legal lease"
            );
        }

        registry
            .revoke_image_preview(
                &preview.lease_id,
                "main",
                &descriptor.operation_id,
                &descriptor.grant_id,
                &legal_scope,
            )
            .expect("revoke legal scoped preview lease");
        assert_eq!(
            native_image_preview_response(
                &registry,
                "main",
                preview_request(tauri::http::Method::GET, preview_url),
            )
            .status(),
            tauri::http::StatusCode::NOT_FOUND
        );
        registry
            .consume(
                &descriptor.grant_id,
                "main",
                &descriptor.operation_id,
                GrantPurpose::AttachmentUpload,
            )
            .expect("preview scope checks must not consume the one-use upload grant");

        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn native_image_preview_lifecycle_revokes_on_expiry_discard_and_window_destroy() {
        let path = std::env::temp_dir().join(format!(
            "hexclaw-native-image-lifecycle-{}.png",
            Uuid::new_v4()
        ));
        tokio::fs::write(&path, include_bytes!("../icons/32x32.png"))
            .await
            .expect("write image fixture");
        let registry = NativeFileGrantRegistry::default();

        let wrong_operation = issue_read_grant(
            &registry,
            "main",
            "native-preview-operation-scope",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue operation-scoped preview");
        let wrong_upload_grant = issue_read_grant(
            &registry,
            "main",
            "native-preview-upload-grant-scope",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue upload-grant-scoped preview");
        let wrong_operation_scope = preview_scope("operation-session", "operation-attachment");
        let wrong_upload_grant_scope =
            preview_scope("upload-grant-session", "upload-grant-attachment");
        let wrong_operation_preview =
            bind_preview(&registry, &wrong_operation, "main", &wrong_operation_scope);
        let wrong_upload_grant_preview = bind_preview(
            &registry,
            &wrong_upload_grant,
            "main",
            &wrong_upload_grant_scope,
        );
        assert!(registry
            .revoke_image_preview(
                &wrong_operation_preview.lease_id,
                "main",
                "wrong-operation",
                &wrong_operation.grant_id,
                &wrong_operation_scope,
            )
            .is_err());
        assert!(registry
            .revoke_image_preview(
                &wrong_upload_grant_preview.lease_id,
                "main",
                "native-preview-upload-grant-scope",
                &wrong_operation.grant_id,
                &wrong_upload_grant_scope,
            )
            .is_err());
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("operation/upload-grant failures consume only preview leases"),
            0
        );
        registry
            .consume(
                &wrong_operation.grant_id,
                "main",
                "native-preview-operation-scope",
                GrantPurpose::AttachmentUpload,
            )
            .expect("wrong operation revoke must not consume upload grant");
        registry
            .consume(
                &wrong_upload_grant.grant_id,
                "main",
                "native-preview-upload-grant-scope",
                GrantPurpose::AttachmentUpload,
            )
            .expect("wrong upload grant revoke must not consume upload grant");

        let expired = issue_read_grant(
            &registry,
            "main",
            "native-preview-expiry",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue expiring preview");
        let expired_lease_id = expired
            .preview_lease
            .as_ref()
            .expect("expiring preview lease")
            .lease_id
            .clone();
        {
            let mut state = registry
                .image_previews
                .lock()
                .expect("lock image preview registry");
            state
                .leases
                .get_mut(&expired_lease_id)
                .expect("stored preview lease")
                .expires_at = Instant::now() - Duration::from_millis(1);
        }
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("purge expired preview"),
            0
        );
        registry
            .consume(
                &expired.grant_id,
                "main",
                "native-preview-expiry",
                GrantPurpose::AttachmentUpload,
            )
            .expect("preview expiry must not consume upload grant");

        let discarded = issue_read_grant(
            &registry,
            "main",
            "native-preview-discard",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue discard preview");
        registry
            .discard(
                &discarded.grant_id,
                "main",
                "native-preview-discard",
                GrantPurpose::AttachmentUpload,
            )
            .expect("discard upload grant");
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("discard revokes preview"),
            0
        );

        let main = issue_read_grant(
            &registry,
            "main",
            "native-preview-main-window",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue main-window preview");
        let auxiliary = issue_read_grant(
            &registry,
            "auxiliary",
            "native-preview-other-window",
            path.clone(),
            GrantPurpose::AttachmentUpload,
        )
        .await
        .expect("issue auxiliary-window preview");
        let main_scope = preview_scope("main-window-session", "main-window-attachment");
        let auxiliary_scope =
            preview_scope("auxiliary-window-session", "auxiliary-window-attachment");
        let main_preview = bind_preview(&registry, &main, "main", &main_scope);
        let auxiliary_preview = bind_preview(&registry, &auxiliary, "auxiliary", &auxiliary_scope);
        registry
            .revoke_image_previews_for_window("main")
            .expect("revoke destroyed window previews");
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("only auxiliary preview remains"),
            1
        );
        assert_eq!(
            native_image_preview_response(
                &registry,
                "main",
                preview_request(
                    tauri::http::Method::GET,
                    main_preview.url.as_deref().expect("main preview URL"),
                ),
            )
            .status(),
            tauri::http::StatusCode::NOT_FOUND
        );
        assert_eq!(
            native_image_preview_response(
                &registry,
                "auxiliary",
                preview_request(
                    tauri::http::Method::GET,
                    auxiliary_preview
                        .url
                        .as_deref()
                        .expect("auxiliary preview URL"),
                ),
            )
            .status(),
            tauri::http::StatusCode::OK
        );
        registry
            .revoke_image_previews_for_window("auxiliary")
            .expect("revoke auxiliary previews");
        assert_eq!(
            registry
                .active_image_preview_count()
                .expect("all previews revoked"),
            0
        );

        let _ = tokio::fs::remove_file(path).await;
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
