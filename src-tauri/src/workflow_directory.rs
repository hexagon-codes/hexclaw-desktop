//! 工作流本机目录只保存不透明引用；服务端与渲染层不持有绝对目录路径。

use crate::{backend_connection, sidecar_client::SidecarClient};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct WorkflowDirectoryError {
    pub code: &'static str,
    pub message: String,
}

impl WorkflowDirectoryError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(message: &str, error: impl std::fmt::Display) -> Self {
        Self::new(
            "workflow_directory_save_failed",
            format!("{message}: {error}"),
        )
    }
}

#[derive(Clone, Serialize)]
pub struct WorkflowDirectoryRef {
    pub client_id: String,
    pub directory_ref: String,
    pub label: String,
}

#[derive(Serialize)]
pub struct WorkflowDirectoryCatalog {
    pub client_id: String,
    pub directories: Vec<WorkflowDirectoryRef>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DirectoryRecord {
    directory_ref: String,
    label: String,
    path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
struct DirectoryFile {
    schema_version: u32,
    client_id: String,
    directories: Vec<DirectoryRecord>,
}

#[derive(Default)]
pub struct WorkflowDirectoryRegistry {
    data: Mutex<Option<DirectoryFile>>,
    saves: tokio::sync::Mutex<()>,
}

#[derive(Clone, Deserialize)]
pub struct WorkflowDirectoryFile {
    pub artifact_id: String,
    pub name: String,
    pub digest: String,
    pub download_url: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkflowDirectoryFileReceipt {
    pub artifact_id: String,
    pub name: String,
    pub digest: String,
    pub path: String,
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, WorkflowDirectoryError> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("workflow-directories.json"))
        .map_err(|error| WorkflowDirectoryError::io("Resolve workflow directory settings", error))
}

fn persist_registry(path: &Path, data: &DirectoryFile) -> Result<(), WorkflowDirectoryError> {
    let parent = path.parent().ok_or_else(|| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow directory settings have no parent",
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| WorkflowDirectoryError::io("Create workflow settings directory", error))?;
    let temp = parent.join(format!(".workflow-directories-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(data)
            .map_err(|error| WorkflowDirectoryError::io("Encode workflow directories", error))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| {
                WorkflowDirectoryError::io("Create workflow directory settings", error)
            })?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|error| {
                WorkflowDirectoryError::io("Write workflow directory settings", error)
            })?;
        fs::rename(&temp, path).map_err(|error| {
            WorkflowDirectoryError::io("Commit workflow directory settings", error)
        })?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn read_registry(path: &Path) -> Result<DirectoryFile, WorkflowDirectoryError> {
    match fs::read(path) {
        Ok(bytes) => {
            let data: DirectoryFile = serde_json::from_slice(&bytes).map_err(|error| {
                WorkflowDirectoryError::io("Read workflow directory settings", error)
            })?;
            if data.schema_version != 1
                || data.client_id.is_empty()
                || data
                    .directories
                    .iter()
                    .any(|value| value.directory_ref.is_empty() || !value.path.is_absolute())
            {
                return Err(WorkflowDirectoryError::new(
                    "workflow_directory_save_failed",
                    "Invalid workflow directory settings",
                ));
            }
            Ok(data)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let data = DirectoryFile {
                schema_version: 1,
                client_id: format!("desktop-{}", Uuid::new_v4()),
                directories: Vec::new(),
            };
            persist_registry(path, &data)?;
            Ok(data)
        }
        Err(error) => Err(WorkflowDirectoryError::io(
            "Read workflow directory settings",
            error,
        )),
    }
}

fn snapshot(
    app: &AppHandle,
    registry: &WorkflowDirectoryRegistry,
) -> Result<DirectoryFile, WorkflowDirectoryError> {
    let mut data = registry.data.lock().map_err(|_| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow directory settings lock is unavailable",
        )
    })?;
    if data.is_none() {
        *data = Some(read_registry(&registry_path(app)?)?);
    }
    data.as_ref().cloned().ok_or_else(|| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow directory settings are unavailable",
        )
    })
}

#[tauri::command]
pub fn workflow_directory_list(
    app: AppHandle,
    registry: State<'_, WorkflowDirectoryRegistry>,
) -> Result<WorkflowDirectoryCatalog, WorkflowDirectoryError> {
    let data = snapshot(&app, &registry)?;
    Ok(WorkflowDirectoryCatalog {
        directories: data
            .directories
            .into_iter()
            .map(|value| WorkflowDirectoryRef {
                client_id: data.client_id.clone(),
                directory_ref: value.directory_ref,
                label: value.label,
            })
            .collect(),
        client_id: data.client_id,
    })
}

#[tauri::command]
pub async fn workflow_directory_pick(
    app: AppHandle,
    registry: State<'_, WorkflowDirectoryRegistry>,
) -> Result<Option<WorkflowDirectoryRef>, WorkflowDirectoryError> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| WorkflowDirectoryError::io("Open workflow directory picker", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|error| WorkflowDirectoryError::io("Read selected workflow directory", error))?;
    let path = fs::canonicalize(selected).map_err(|error| {
        WorkflowDirectoryError::io("Resolve selected workflow directory", error)
    })?;
    if !path.is_dir() {
        return Err(WorkflowDirectoryError::new(
            "workflow_directory_unavailable",
            "Selected workflow directory is unavailable",
        ));
    }
    snapshot(&app, &registry)?;
    let mut locked = registry.data.lock().map_err(|_| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow directory settings lock is unavailable",
        )
    })?;
    let mut data = locked.as_ref().cloned().ok_or_else(|| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow directory settings are unavailable",
        )
    })?;
    let record = if let Some(record) = data.directories.iter().find(|record| record.path == path) {
        record.clone()
    } else {
        let record = DirectoryRecord {
            directory_ref: format!("directory-{}", Uuid::new_v4()),
            label: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Selected folder".into()),
            path,
        };
        data.directories.push(record.clone());
        persist_registry(&registry_path(&app)?, &data)?;
        *locked = Some(data.clone());
        record
    };
    Ok(Some(WorkflowDirectoryRef {
        client_id: data.client_id,
        directory_ref: record.directory_ref,
        label: record.label,
    }))
}

fn require_scope(scope: &str) -> Result<(), WorkflowDirectoryError> {
    if scope.is_empty() {
        return Err(WorkflowDirectoryError::new(
            "workflow_backend_changed",
            "Backend connection scope is required",
        ));
    }
    backend_connection::current()
        .and_then(|connection| connection.validate_scope(Some(scope)))
        .map_err(|_| {
            WorkflowDirectoryError::new("workflow_backend_changed", "Backend connection changed")
        })
}

async fn scoped_wait<T>(
    scope: &str,
    future: impl Future<Output = T>,
) -> Result<T, WorkflowDirectoryError> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            value = &mut future => { require_scope(scope)?; return Ok(value); }
            _ = tokio::time::sleep(Duration::from_millis(200)) => { require_scope(scope)?; }
        }
    }
}

fn relative_download(client: &SidecarClient, raw: &str) -> Result<String, WorkflowDirectoryError> {
    let invalid = || {
        WorkflowDirectoryError::new(
            "workflow_file_unavailable",
            "Workflow file URL does not belong to the active backend",
        )
    };
    let relative = if raw.starts_with('/') && !raw.starts_with("//") {
        raw.to_owned()
    } else {
        let url = url::Url::parse(raw).map_err(|_| invalid())?;
        let base = url::Url::parse(&client.connection().context.api_base).map_err(|_| invalid())?;
        let prefix = base.path().trim_end_matches('/');
        if url.origin() != base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || (!prefix.is_empty() && !url.path().starts_with(&format!("{prefix}/")))
        {
            return Err(invalid());
        }
        format!(
            "{}{}",
            url.path().strip_prefix(prefix).ok_or_else(invalid)?,
            url.query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        )
    };
    crate::sidecar_client::validate_relative_path(&relative).map_err(|_| invalid())?;
    Ok(relative)
}

fn expected_digest(raw: &str) -> Result<String, WorkflowDirectoryError> {
    let digest = raw.strip_prefix("sha256:").unwrap_or(raw);
    if digest.len() != 64 || !digest.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(WorkflowDirectoryError::new(
            "workflow_digest_mismatch",
            "Workflow file digest is invalid",
        ));
    }
    Ok(digest.to_ascii_lowercase())
}

fn file_leaf(name: &str) -> Result<&str, WorkflowDirectoryError> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(WorkflowDirectoryError::new(
            "workflow_file_unavailable",
            "Workflow file name must be a leaf name",
        ));
    }
    Ok(name)
}

async fn digest_file(path: &Path) -> Result<String, WorkflowDirectoryError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| WorkflowDirectoryError::io("Read saved workflow file", error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| WorkflowDirectoryError::io("Read saved workflow file", error))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sync_directory(directory: &Path) -> Result<(), WorkflowDirectoryError> {
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| WorkflowDirectoryError::io("Sync workflow directory", error))?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

async fn commit_file(
    temp: &Path,
    destination: &Path,
    digest: &str,
) -> Result<(), WorkflowDirectoryError> {
    // 原子发布完整文件，禁止替换同名文件；macOS 目录不依赖硬链接能力。
    match publish_without_overwrite(temp, destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if digest_file(destination).await? != digest {
                return Err(WorkflowDirectoryError::new(
                    "workflow_file_conflict",
                    "A different file already exists with the workflow output name",
                ));
            }
        }
        Err(error) => return Err(WorkflowDirectoryError::io("Commit workflow file", error)),
    }
    sync_directory(destination.parent().ok_or_else(|| {
        WorkflowDirectoryError::new(
            "workflow_directory_save_failed",
            "Workflow output directory is unavailable",
        )
    })?)?;
    Ok(())
}

fn publish_without_overwrite(temp: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let temp = CString::new(temp.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        // 两个路径均来自已选目录；RENAME_EXCL 保证并发同名文件不能被覆盖。
        let result =
            unsafe { libc::renamex_np(temp.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::hard_link(temp, destination)
    }
}

async fn save_file(
    client: &SidecarClient,
    directory: &Path,
    file: &WorkflowDirectoryFile,
    scope: &str,
) -> Result<WorkflowDirectoryFileReceipt, WorkflowDirectoryError> {
    let leaf = file_leaf(&file.name)?;
    let expected = expected_digest(&file.digest)?;
    if file.artifact_id.trim().is_empty() {
        return Err(WorkflowDirectoryError::new(
            "workflow_file_unavailable",
            "Workflow artifact identity is required",
        ));
    }
    let destination = directory.join(leaf);
    require_scope(scope)?;
    if tokio::fs::try_exists(&destination)
        .await
        .map_err(|error| WorkflowDirectoryError::io("Inspect workflow output", error))?
    {
        if digest_file(&destination).await? != expected {
            return Err(WorkflowDirectoryError::new(
                "workflow_file_conflict",
                "A different file already exists with the workflow output name",
            ));
        }
        sync_directory(directory)?;
        require_scope(scope)?;
        return Ok(WorkflowDirectoryFileReceipt {
            artifact_id: file.artifact_id.clone(),
            name: file.name.clone(),
            digest: file.digest.clone(),
            path: leaf.into(),
        });
    }
    let relative = relative_download(client, &file.download_url)?;
    let response = scoped_wait(scope, client.get(&relative))
        .await?
        .map_err(|_| {
            WorkflowDirectoryError::new(
                "workflow_network_unavailable",
                "Workflow file download is unavailable",
            )
        })?;
    SidecarClient::require_non_redirect(&response)
        .map_err(|error| WorkflowDirectoryError::new("workflow_file_unavailable", error))?;
    if !response.status().is_success() {
        let code = if response.status().is_server_error() {
            "workflow_network_unavailable"
        } else {
            "workflow_file_unavailable"
        };
        return Err(WorkflowDirectoryError::new(
            code,
            format!(
                "Workflow file download returned HTTP {}",
                response.status().as_u16()
            ),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size != file.size)
    {
        return Err(WorkflowDirectoryError::new(
            "workflow_digest_mismatch",
            "Workflow file size does not match the artifact receipt",
        ));
    }
    let temp = directory.join(format!(".workflow-output-{}.tmp", Uuid::new_v4()));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|error| WorkflowDirectoryError::io("Create workflow output", error))?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut size = 0_u64;
        while let Some(chunk) = scoped_wait(scope, stream.next()).await? {
            let chunk = chunk.map_err(|_| {
                WorkflowDirectoryError::new(
                    "workflow_network_unavailable",
                    "Workflow file download was interrupted",
                )
            })?;
            size = size.checked_add(chunk.len() as u64).ok_or_else(|| {
                WorkflowDirectoryError::new(
                    "workflow_digest_mismatch",
                    "Workflow file size does not match the artifact receipt",
                )
            })?;
            if size > file.size {
                return Err(WorkflowDirectoryError::new(
                    "workflow_digest_mismatch",
                    "Workflow file size does not match the artifact receipt",
                ));
            }
            digest.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|error| WorkflowDirectoryError::io("Write workflow output", error))?;
        }
        if size != file.size || format!("{:x}", digest.finalize()) != expected {
            return Err(WorkflowDirectoryError::new(
                "workflow_digest_mismatch",
                "Workflow file bytes do not match the artifact receipt",
            ));
        }
        output
            .sync_all()
            .await
            .map_err(|error| WorkflowDirectoryError::io("Sync workflow output", error))?;
        drop(output);
        require_scope(scope)?;
        commit_file(&temp, &destination, &expected).await?;
        require_scope(scope)?;
        Ok(WorkflowDirectoryFileReceipt {
            artifact_id: file.artifact_id.clone(),
            name: file.name.clone(),
            digest: file.digest.clone(),
            path: leaf.into(),
        })
    }
    .await;
    let _ = tokio::fs::remove_file(&temp).await;
    result
}

#[tauri::command]
pub async fn workflow_directory_save(
    app: AppHandle,
    registry: State<'_, WorkflowDirectoryRegistry>,
    client_id: String,
    directory_ref: String,
    files: Vec<WorkflowDirectoryFile>,
    scope: String,
) -> Result<Vec<WorkflowDirectoryFileReceipt>, WorkflowDirectoryError> {
    require_scope(&scope)?;
    let _save = registry.saves.lock().await;
    require_scope(&scope)?;
    let data = snapshot(&app, &registry)?;
    if data.client_id != client_id {
        return Err(WorkflowDirectoryError::new(
            "workflow_directory_unavailable",
            "Workflow directory belongs to a different desktop client",
        ));
    }
    let directory = data
        .directories
        .iter()
        .find(|value| value.directory_ref == directory_ref)
        .ok_or_else(|| {
            WorkflowDirectoryError::new(
                "workflow_directory_unavailable",
                "Workflow directory is not registered on this desktop",
            )
        })?;
    if !directory.path.is_dir() {
        return Err(WorkflowDirectoryError::new(
            "workflow_directory_unavailable",
            "Selected workflow directory is unavailable",
        ));
    }
    if files.is_empty() {
        return Err(WorkflowDirectoryError::new(
            "workflow_file_unavailable",
            "Workflow delivery has no generated files",
        ));
    }
    let client = SidecarClient::new(Duration::from_secs(300)).map_err(|_| {
        WorkflowDirectoryError::new(
            "workflow_network_unavailable",
            "Workflow file service is unavailable",
        )
    })?;
    client
        .connection()
        .validate_scope(Some(&scope))
        .map_err(|_| {
            WorkflowDirectoryError::new("workflow_backend_changed", "Backend connection changed")
        })?;
    let mut receipts = Vec::with_capacity(files.len());
    for file in files {
        receipts.push(save_file(&client, &directory.path, &file, &scope).await?);
    }
    Ok(receipts)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("hexclaw-workflow-directory-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn workflow_directory_commit_is_idempotent_and_never_overwrites_different_bytes() {
        let directory = TestDirectory::new();
        let source = directory.0.join(".source.tmp");
        let destination = directory.0.join("report.md");
        fs::write(&source, b"hello").expect("write test artifact");
        let digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        commit_file(&source, &destination, digest)
            .await
            .expect("publish artifact");
        assert_eq!(fs::read(&destination).unwrap(), b"hello");
        assert_eq!(digest_file(&destination).await.unwrap(), digest);
        fs::write(&source, b"hello").expect("stage identical artifact again");
        commit_file(&source, &destination, digest)
            .await
            .expect("replay identical artifact");
        fs::remove_file(&source).expect("release published staging link");
        fs::write(&source, b"different").expect("write competing artifact");
        let other = "9d6f965ac832e40a5df6c06afe983e3b449c07b843ff51ce76204de05c690d11";
        let error = commit_file(&source, &destination, other)
            .await
            .expect_err("reject conflicting artifact");
        assert_eq!(error.code, "workflow_file_conflict");
        assert_eq!(fs::read(&destination).unwrap(), b"hello");
    }

    #[test]
    fn workflow_directory_identity_and_refs_survive_real_settings_reload() {
        let directory = TestDirectory::new();
        let path = directory.0.join("workflow-directories.json");
        let mut data = read_registry(&path).expect("initialize registry");
        let client_id = data.client_id.clone();
        data.directories.push(DirectoryRecord {
            directory_ref: "directory-test".into(),
            label: "Reports".into(),
            path: directory.0.clone(),
        });
        persist_registry(&path, &data).expect("persist directory");
        let reloaded = read_registry(&path).expect("reload registry");
        assert_eq!(reloaded.client_id, client_id);
        assert_eq!(reloaded.directories[0].directory_ref, "directory-test");
        assert_eq!(reloaded.directories[0].path, directory.0);
        let wire = WorkflowDirectoryRef {
            client_id,
            directory_ref: "directory-test".into(),
            label: "Reports".into(),
        };
        assert!(!serde_json::to_string(&wire)
            .unwrap()
            .contains(directory.0.to_str().unwrap()));
        assert!(file_leaf("report.md").is_ok());
        assert!(file_leaf("../report.md").is_err());
        assert!(expected_digest("sha256:not-a-digest").is_err());
    }
}
