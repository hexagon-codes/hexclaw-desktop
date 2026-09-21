//! 后端连接记录由原生层持久化；传输持有不可变快照，避免切换时串服务。

use crate::sidecar;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock},
    time::Duration,
};
use tauri::Emitter;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
struct ConnectionRecord {
    connection_id: String,
    kind: String,
    config_revision: u64,
    #[serde(default)]
    backend_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_base: Option<String>,
    api_token: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct AuthFile {
    schema_version: u32,
    active_connection_id: String,
    connections: Vec<ConnectionRecord>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendContext {
    pub connection_id: String,
    pub backend_id: String,
    pub config_revision: u64,
    pub activation_generation: u64,
    pub kind: String,
    pub api_base: String,
    pub ws_base: String,
    pub has_token: bool,
}

#[derive(Clone)]
pub(crate) struct ConnectionSnapshot {
    pub context: BackendContext,
    token: zeroize::Zeroizing<String>,
}

impl ConnectionSnapshot {
    pub(crate) fn validate_scope(&self, scope: Option<&str>) -> Result<(), String> {
        if let Some(scope) = scope.filter(|scope| !scope.is_empty()) {
            let expected = serde_json::json!([self.context.connection_id, self.context.backend_id,
                self.context.config_revision, self.context.activation_generation]).to_string();
            if scope != expected { return Err("Backend connection changed".into()); }
        }
        Ok(())
    }
    pub(crate) fn endpoint(&self, path: &str) -> Result<Url, String> {
        crate::sidecar_client::validate_relative_path(path)?;
        Url::parse(&format!("{}/", self.context.api_base.trim_end_matches('/')))
            .and_then(|base| base.join(path.trim_start_matches('/')))
            .map_err(|_| "Invalid backend endpoint".into())
    }

    pub(crate) fn token(&self) -> &str { self.token.as_str() }
    pub(crate) fn is_local(&self) -> bool { self.context.kind == "local" }
}

struct ConnectionState { file: AuthFile, generation: u64 }
static STATE: OnceLock<Mutex<ConnectionState>> = OnceLock::new();
static INTENT: AtomicU64 = AtomicU64::new(0);

fn auth_path() -> Result<std::path::PathBuf, String> {
    Ok(sidecar::desktop_config_path()?.with_file_name("auth.json"))
}

fn read_file(path: &Path) -> Result<AuthFile, String> {
    let bytes = fs::read(path).map_err(|error| format!("Read backend connections: {error}"))?;
    let file: AuthFile = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid backend connection file".to_string())?;
    if file.schema_version != 1
        || !file.connections.iter().any(|record| record.connection_id == file.active_connection_id)
        || !file.connections.iter().any(|record| record.connection_id == "local" && record.kind == "local") {
        return Err("Unsupported or incomplete backend connection file".into());
    }
    let mut ids = std::collections::HashSet::new();
    for record in &file.connections {
        if !ids.insert(&record.connection_id) || record.api_token.trim().is_empty()
            || record.api_token.chars().any(char::is_control)
            || !matches!(record.kind.as_str(), "local" | "remote") {
            return Err("Invalid backend connection record".into());
        }
        if record.kind == "remote" { normalize_base(record.api_base.as_deref().unwrap_or(""))?; }
    }
    Ok(file)
}

fn persist(path: &Path, file: &AuthFile) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid backend connection directory")?;
    fs::create_dir_all(dir).map_err(|error| format!("Create backend connection directory: {error}"))?;
    let temp = dir.join(format!(".auth-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut handle = options.open(&temp).map_err(|error| format!("Create backend connection file: {error}"))?;
        let bytes = serde_json::to_vec_pretty(file).map_err(|_| "Encode backend connections")?;
        handle.write_all(&bytes).and_then(|_| handle.sync_all())
            .map_err(|error| format!("Write backend connections: {error}"))?;
        fs::rename(&temp, path).map_err(|error| format!("Commit backend connections: {error}"))?;
        #[cfg(unix)] {
            if fs::File::open(dir).and_then(|file| file.sync_all()).is_err() {
                // rename 已完成时按实际文件对账，不能让内存继续指向旧连接。
                let committed = fs::read(path).map_err(|_| "Backend connection commit outcome is unknown")?;
                if committed != bytes { return Err("Backend connection commit outcome is unknown".into()); }
                log::warn!("Backend connections committed; directory durability sync unavailable");
            }
        }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

pub(crate) fn initialize() -> Result<(), String> {
    if STATE.get().is_some() { return Ok(()); }
    let path = auth_path()?;
    let file = match fs::metadata(&path) {
        Ok(_) => read_file(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let file = AuthFile {
                schema_version: 1, active_connection_id: "local".into(),
                connections: vec![ConnectionRecord {
                    connection_id: "local".into(), kind: "local".into(), config_revision: 1,
                    backend_id: String::new(), api_base: None,
                    api_token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                }],
            };
            persist(&path, &file)?;
            file
        }
        Err(error) => return Err(format!("Read backend connection file: {error}")),
    };
    STATE.set(Mutex::new(ConnectionState { file, generation: 1 }))
        .map_err(|_| "Backend connections already initialized".into())
}

fn state() -> Result<&'static Mutex<ConnectionState>, String> {
    STATE.get().ok_or_else(|| "Backend connections unavailable".into())
}

fn snapshot(record: &ConnectionRecord, generation: u64) -> ConnectionSnapshot {
    let base = if record.kind == "local" { sidecar::base_url() } else { record.api_base.clone().unwrap_or_default() };
    ConnectionSnapshot {
        context: BackendContext {
            connection_id: record.connection_id.clone(), backend_id: record.backend_id.clone(),
            config_revision: record.config_revision, activation_generation: generation,
            kind: record.kind.clone(), ws_base: base.replacen("http", "ws", 1),
            api_base: base, has_token: !record.api_token.is_empty(),
        },
        token: zeroize::Zeroizing::new(record.api_token.clone()),
    }
}

pub(crate) fn current() -> Result<ConnectionSnapshot, String> {
    // 单元验证沿既有受管传输夹具执行，不读写用户连接文件。
    #[cfg(test)]
    if STATE.get().is_none() {
        sidecar::initialize_capability_token()?;
        return Ok(snapshot(&ConnectionRecord {
            connection_id: "local".into(), kind: "local".into(), config_revision: 1,
            backend_id: "test-backend".into(), api_base: None,
            api_token: sidecar::capability_token()?.into(),
        }, 1));
    }
    let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
    let record = guard.file.connections.iter().find(|record| record.connection_id == guard.file.active_connection_id)
        .ok_or("Active backend connection missing")?;
    Ok(snapshot(record, guard.generation))
}

pub(crate) fn local_token() -> Result<String, String> {
    let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
    guard.file.connections.iter().find(|record| record.connection_id == "local")
        .map(|record| record.api_token.clone()).ok_or_else(|| "Local backend connection missing".into())
}

fn normalize_base(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "Invalid backend address")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() {
        return Err("Backend address must be an HTTP or HTTPS service root".into());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCandidate {
    kind: String,
    api_base: Option<String>,
    api_token: Option<String>,
}

fn candidate_record(candidate: BackendCandidate) -> Result<ConnectionRecord, String> {
    let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
    if candidate.kind == "local" {
        return guard.file.connections.iter().find(|record| record.connection_id == "local")
            .cloned().ok_or_else(|| "Local backend connection missing".into());
    }
    if candidate.kind != "remote" { return Err("Invalid backend kind".into()); }
    let base = normalize_base(candidate.api_base.as_deref().unwrap_or(""))?;
    let existing = guard.file.connections.iter().find(|record| record.kind == "remote" && record.api_base.as_deref() == Some(&base));
    let token = candidate.api_token.filter(|token| !token.trim().is_empty())
        .or_else(|| existing.map(|record| record.api_token.clone())).ok_or("Access token required")?;
    if token.chars().any(char::is_control) { return Err("Invalid access token".into()); }
    Ok(ConnectionRecord {
        connection_id: existing.map(|record| record.connection_id.clone()).unwrap_or_else(|| format!("remote-{}", Uuid::new_v4().simple())),
        kind: "remote".into(), backend_id: existing.map(|record| record.backend_id.clone()).unwrap_or_default(),
        config_revision: existing.map_or(1, |record| record.config_revision + u64::from(record.api_token != token)),
        api_base: Some(base), api_token: token,
    })
}

async fn inspect(record: &mut ConnectionRecord) -> Result<String, String> {
    let frozen = snapshot(record, 0);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Create backend connection check")?;
    let mut version = String::new();
    for path in ["/health", "/api/v1/version", "/api/v1/config"] {
        let response = client.get(frozen.endpoint(path)?).bearer_auth(frozen.token()).send().await
            .map_err(|_| "Backend connection failed")?;
        let status = response.status();
        if !status.is_success() { return Err(format!("Backend check {path}: HTTP {}", status.as_u16())); }
        let bytes = crate::sidecar_client::read_bounded(response, 2 * 1024 * 1024).await?;
        let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid backend response")?;
        if path == "/api/v1/version" {
            version = body.get("version").and_then(|value| value.as_str()).unwrap_or_default().into();
        }
        if path == "/api/v1/config" {
            record.backend_id = body.get("backend_id").and_then(|value| value.as_str())
                .filter(|value| !value.is_empty()).ok_or("Backend does not support persistent data identity")?.into();
        }
    }
    Ok(version)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendReadiness {
    context: BackendContext,
    version: String,
    default_model: String,
}

// 首配仅投影候选服务的配置事实，不切换连接、不发送模型请求。
#[tauri::command]
pub async fn inspect_backend_readiness(candidate: BackendCandidate) -> Result<BackendReadiness, String> {
    let mut record = candidate_record(candidate)?;
    let version = inspect(&mut record).await?;
    let frozen = snapshot(&record, 0);
    let response = reqwest::Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Create backend model check")?
        .get(frozen.endpoint("/api/v1/config/llm")?).bearer_auth(frozen.token()).send().await
        .map_err(|_| "Backend model configuration check failed")?;
    if !response.status().is_success() { return Err(format!("Backend model check: HTTP {}", response.status().as_u16())); }
    let bytes = crate::sidecar_client::read_bounded(response, 2 * 1024 * 1024).await?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid backend model configuration")?;
    let provider = body.get("default").and_then(|value| value.as_str())
        .and_then(|name| body.get("providers").and_then(|providers| providers.get(name)));
    let default_model = provider.filter(|provider| provider.get("enabled").and_then(|value| value.as_bool()) != Some(false))
        .and_then(|provider| provider.get("model")).and_then(|value| value.as_str()).unwrap_or_default().to_owned();
    Ok(BackendReadiness { context: frozen.context, version, default_model })
}

#[tauri::command]
pub fn get_backend_context() -> Result<BackendContext, String> { Ok(current()?.context) }

#[tauri::command]
pub fn get_backend_connections() -> Result<Vec<BackendContext>, String> {
    let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
    Ok(guard.file.connections.iter().map(|record| snapshot(record, guard.generation).context).collect())
}

/// 连接面板只读查看本机业务令牌，不随当前服务切换读取目标。
#[tauri::command]
pub fn get_local_backend_token() -> Result<String, String> {
    local_token()
}

/// 按已保存的远端连接读取令牌，不改变当前连接或配置文件。
#[tauri::command]
pub fn get_remote_backend_token(connection_id: String) -> Result<String, String> {
    let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
    guard.file.connections.iter()
        .find(|record| record.kind == "remote" && record.connection_id == connection_id)
        .map(|record| record.api_token.clone())
        .ok_or_else(|| "Remote backend connection missing".into())
}

#[tauri::command]
pub async fn test_backend_connection(candidate: BackendCandidate) -> Result<BackendContext, String> {
    let mut record = candidate_record(candidate)?;
    inspect(&mut record).await?;
    Ok(snapshot(&record, 0).context)
}

#[tauri::command]
pub async fn activate_backend_connection(app: tauri::AppHandle, candidate: BackendCandidate) -> Result<BackendContext, String> {
    let intent = INTENT.fetch_add(1, Ordering::SeqCst) + 1;
    let mut record = candidate_record(candidate)?;
    if record.kind == "local" && !sidecar::is_ready(&app) {
        let instance = sidecar::spawn_sidecar(&app)?;
        sidecar::wait_for_healthy(app.clone(), 30, instance).await?;
    }
    inspect(&mut record).await?;
    let context = {
        let mut guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
        if INTENT.load(Ordering::SeqCst) != intent { return Err("Backend connection intent superseded".into()); }
        let path = auth_path()?;
        let mut next = read_file(&path)?;
        next.active_connection_id = record.connection_id.clone();
        match next.connections.iter_mut().find(|value| value.connection_id == record.connection_id) {
            Some(value) => *value = record.clone(),
            None => next.connections.push(record.clone()),
        }
        persist(&path, &next)?;
        guard.file = next;
        guard.generation += 1;
        snapshot(&record, guard.generation).context
    };
    let _ = app.emit("backend-connection-changed", &context);
    Ok(context)
}

// 本机首次健康就绪后补齐数据身份；远端已保存选择不会被本机启动回执覆盖。
pub(crate) async fn refresh_active_identity(app: tauri::AppHandle) -> Result<(), String> {
    let initial = current()?;
    let mut record = {
        let guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
        guard.file.connections.iter().find(|record| record.connection_id == initial.context.connection_id)
            .cloned().ok_or("Active backend connection missing")?
    };
    inspect(&mut record).await?;
    accept_active_identity(app, &initial, &record.backend_id)
}

// 只接纳原连接代次的受保护响应；同地址换库也会切换数据作用域。
pub(crate) fn accept_active_identity(app: tauri::AppHandle, initial: &ConnectionSnapshot, backend_id: &str) -> Result<(), String> {
    if backend_id.is_empty() { return Err("Backend data identity is missing".into()); }
    let context = {
        let mut guard = state()?.lock().map_err(|_| "Backend connection lock unavailable")?;
        if guard.generation != initial.context.activation_generation { return Ok(()); }
        let mut next = read_file(&auth_path()?)?;
        let saved = next.connections.iter_mut().find(|value| value.connection_id == initial.context.connection_id)
            .ok_or("Active backend connection missing")?;
        if saved.backend_id == backend_id { return Ok(()); }
        saved.backend_id = backend_id.into();
        let record = saved.clone();
        persist(&auth_path()?, &next)?;
        guard.file = next;
        guard.generation += 1;
        snapshot(&record, guard.generation).context
    };
    let _ = app.emit("backend-connection-changed", context);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str, base: Option<&str>) -> ConnectionRecord {
        ConnectionRecord { connection_id: kind.into(), kind: kind.into(), config_revision: 1,
            backend_id: format!("{kind}-database"), api_base: base.map(str::to_owned), api_token: format!("{kind}-fixture-secret") }
    }

    #[test]
    fn backend_snapshot_preserves_proxy_prefix_and_original_token() {
        let frozen = snapshot(&record("remote", Some("https://example.invalid/hexclaw")), 1);
        assert_eq!(frozen.endpoint("/api/v1/config?view=1").unwrap().as_str(), "https://example.invalid/hexclaw/api/v1/config?view=1");
        let other = snapshot(&record("remote", Some("http://other.invalid")), 2);
        assert_eq!(other.endpoint("/ws").unwrap().as_str(), "http://other.invalid/ws");
        assert_eq!(frozen.context.ws_base, "wss://example.invalid/hexclaw");
        assert_eq!(frozen.token(), "remote-fixture-secret");
        let projection = serde_json::to_string(&frozen.context).unwrap();
        assert!(!projection.contains("fixture-secret"));
    }

    #[test]
    fn auth_file_retains_both_connections_and_rejects_corruption_without_writing() {
        let dir = std::env::temp_dir().join(format!("hexclaw-auth-{}", Uuid::new_v4()));
        let path = dir.join("auth.json");
        let mut file = AuthFile { schema_version: 1, active_connection_id: "remote".into(),
            connections: vec![record("local", None), record("remote", Some("https://example.invalid/prefix"))] };
        persist(&path, &file).unwrap();
        let first = read_file(&path).unwrap();
        assert_eq!(first.active_connection_id, "remote");
        assert_eq!(first.connections.len(), 2);
        file.active_connection_id = "local".into();
        persist(&path, &file).unwrap();
        let second = read_file(&path).unwrap();
        assert_eq!(second.connections[1].api_token, first.connections[1].api_token);
        assert_eq!(second.connections[1].config_revision, 1);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        fs::write(&path, b"invalid-json").unwrap();
        assert!(read_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid-json");
        fs::remove_dir_all(dir).unwrap();
    }
}
