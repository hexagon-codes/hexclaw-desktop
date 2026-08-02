//! Native owner for LLM-provider credential/config transactions.
//!
//! The renderer may declare a typed mutation and supply a newly entered secret,
//! but it cannot read Keychain values, choose a vault account, call native-only
//! Sidecar endpoints, or PUT the LLM config through the generic HTTP bridge.

use crate::credential_vault::{self, CredentialKey};
use crate::sidecar_client::{read_bounded, SidecarClient};
use reqwest::{Method, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CONFIG_PATH: &str = "/api/v1/config/llm";
const RESERVE_PATH: &str = "/api/internal/desktop/provider-credentials/reserve";
const HYDRATE_PATH: &str = "/api/internal/desktop/credentials/hydrate";
const DEHYDRATE_PATH: &str = "/api/internal/desktop/credentials/dehydrate";
const MAX_CREDENTIALS: usize = 64;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_PENDING_BYTES: u64 = 2 * 1024 * 1024;
const PENDING_FILE: &str = "pending-llm-config-mutation.json";

#[derive(Default)]
pub struct ProviderCredentialCoordinator {
    operation_lock: Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCredentialReplacement {
    provider_key: String,
    secret: String,
}

impl Drop for ProviderCredentialReplacement {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialApplyReceipt {
    provider_instance_ids: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct ReservedProviderCredential {
    provider_instance_id: String,
    credential_ref: String,
}

#[derive(Debug, Deserialize)]
struct CredentialEndpointReceipt {
    #[serde(default)]
    hydrated_count: Option<usize>,
    #[serde(default)]
    dehydrated_count: Option<usize>,
    credential_refs: Vec<String>,
}

#[derive(Serialize)]
struct HydrateRequest<'a> {
    entries: Vec<HydrateEntry<'a>>,
}

#[derive(Serialize)]
struct HydrateEntry<'a> {
    credential_ref: &'a str,
    secret: &'a str,
}

#[derive(Serialize)]
struct DehydrateRequest<'a> {
    credential_refs: &'a [String],
}

struct PreparedReplacement {
    key: CredentialKey,
    credential_ref: String,
    secret: Zeroizing<String>,
}

struct VaultSnapshot {
    key: CredentialKey,
    credential_ref: String,
    previous: Option<Zeroizing<String>>,
    replacement: bool,
}

struct AppliedVaultTransaction {
    replacements: Vec<PreparedReplacement>,
    snapshots: Vec<VaultSnapshot>,
}

enum ConfigPutFailure {
    Rejected {
        status: u16,
        code: Option<String>,
        message: String,
    },
    Unresolved(String),
}

#[derive(Debug, Deserialize)]
struct ConfigMutationReceipt {
    status: String,
    request_id: String,
    config_revision: u64,
    config_digest: String,
    committed_at: i64,
    replayed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingConfigMutation {
    request_id: String,
    client_config_digest: String,
    config: Value,
    replacement_digests: BTreeMap<String, String>,
    deleted_refs: Vec<String>,
}

fn sha256_digest(raw: &[u8]) -> String {
    let digest = Sha256::digest(raw);
    format!("sha256:{digest:x}")
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn value_digest(value: &Value) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|raw| sha256_digest(&raw))
        .map_err(|error| format!("canonicalize pending config: {error}"))
}

fn is_missing_hydration_rejection(status: u16, code: Option<&str>) -> bool {
    status == 422 && code == Some("credential_ref_not_hydrated")
}

fn pending_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(PENDING_FILE))
        .map_err(|error| format!("resolve pending credential transaction path: {error}"))
}

async fn load_pending(app: &AppHandle) -> Result<Option<PendingConfigMutation>, String> {
    let path = pending_path(app)?;
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect pending credential transaction: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PENDING_BYTES
    {
        return Err("pending credential transaction file is invalid".into());
    }
    let raw = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("read pending credential transaction: {error}"))?;
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|error| format!("decode pending credential transaction: {error}"))
}

async fn write_pending(app: &AppHandle, pending: &PendingConfigMutation) -> Result<(), String> {
    let path = pending_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "pending credential transaction has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("create pending credential transaction directory: {error}"))?;
    if tokio::fs::symlink_metadata(&path)
        .await
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("pending credential transaction cannot be a symlink".into());
    }
    let raw = serde_json::to_vec(pending)
        .map_err(|error| format!("encode pending credential transaction: {error}"))?;
    if raw.len() as u64 > MAX_PENDING_BYTES {
        return Err("pending credential transaction exceeds limit".into());
    }
    let temp = parent.join(format!(".{PENDING_FILE}.{}.tmp", Uuid::new_v4()));
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .await
        .map_err(|error| format!("create pending credential transaction: {error}"))?;
    let result = async {
        file.write_all(&raw)
            .await
            .map_err(|error| format!("write pending credential transaction: {error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("sync pending credential transaction: {error}"))?;
        drop(file);
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(|error| format!("commit pending credential transaction: {error}"))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

async fn remove_pending(app: &AppHandle) -> Result<(), String> {
    let path = pending_path(app)?;
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove pending credential transaction: {error}")),
    }
}

fn providers_object(config: &Value) -> Result<&Map<String, Value>, String> {
    config
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| "LLM config providers must be an object".to_string())
}

fn providers_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "LLM config providers must be an object".to_string())
}

fn provider_key_for_id(provider_instance_id: &str) -> Result<(CredentialKey, String), String> {
    let key = CredentialKey::provider_api_key(provider_instance_id.to_owned());
    let credential_ref = key.credential_ref()?;
    Ok((key, credential_ref))
}

fn provider_key_for_ref(credential_ref: &str) -> Result<CredentialKey, String> {
    let provider_id = credential_ref
        .strip_prefix("llm_provider/")
        .and_then(|value| value.strip_suffix("/api_key"))
        .ok_or_else(|| "provider credential_ref is invalid".to_string())?;
    let (key, expected_ref) = provider_key_for_id(provider_id)?;
    if expected_ref != credential_ref {
        return Err("provider credential_ref is invalid".into());
    }
    Ok(key)
}

fn provider_instance_id(provider: &Map<String, Value>) -> Result<Option<String>, String> {
    match provider.get("provider_instance_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err("provider_instance_id must be a string".into()),
    }
}

fn provider_credential_refs(config: &Value) -> Result<Vec<(String, CredentialKey)>, String> {
    let mut refs = Vec::new();
    let mut seen = BTreeSet::new();
    for provider in providers_object(config)?.values() {
        let provider = provider
            .as_object()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        let Some(raw_ref) = provider.get("credential_ref") else {
            continue;
        };
        let Some(credential_ref) = raw_ref.as_str().filter(|value| !value.trim().is_empty()) else {
            if !raw_ref.is_null() {
                return Err("credential_ref must be a string".into());
            }
            continue;
        };
        let provider_id = provider_instance_id(provider)?
            .ok_or_else(|| "credential_ref requires provider_instance_id".to_string())?;
        let (key, expected_ref) = provider_key_for_id(&provider_id)?;
        if credential_ref != expected_ref {
            return Err("credential_ref is not bound to provider_instance_id".into());
        }
        if !seen.insert(expected_ref.clone()) {
            return Err("duplicate provider credential_ref".into());
        }
        refs.push((expected_ref, key));
    }
    Ok(refs)
}

async fn response_json<T: DeserializeOwned>(
    response: Response,
    operation: &str,
) -> Result<T, String> {
    SidecarClient::require_non_redirect(&response)?;
    let status = response.status();
    let body = read_bounded(response, crate::sidecar_client::MAX_JSON_RESPONSE_BYTES).await?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body);
        return Err(format!(
            "{operation} failed with HTTP {}{}",
            status.as_u16(),
            if detail.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", detail.trim())
            }
        ));
    }
    serde_json::from_slice(&body).map_err(|error| format!("decode {operation} response: {error}"))
}

async fn get_config(client: &SidecarClient) -> Result<Value, String> {
    let response = client.get(CONFIG_PATH).await?;
    response_json(response, "read LLM config").await
}

async fn reserve_provider_credential(
    client: &SidecarClient,
) -> Result<ReservedProviderCredential, String> {
    let response = client
        .request(Method::POST, RESERVE_PATH)?
        .send()
        .await
        .map_err(|error| format!("reserve provider credential failed: {error}"))?;
    let reservation: ReservedProviderCredential =
        response_json(response, "reserve provider credential").await?;
    let (_, expected_ref) = provider_key_for_id(&reservation.provider_instance_id)?;
    if reservation.credential_ref != expected_ref {
        return Err("reserved credential_ref does not match provider identity".into());
    }
    Ok(reservation)
}

async fn post_hydrate(
    client: &SidecarClient,
    entries: Vec<HydrateEntry<'_>>,
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    if entries.len() > MAX_CREDENTIALS {
        return Err("credential hydrate batch exceeds limit".into());
    }
    let expected = entries
        .iter()
        .map(|entry| entry.credential_ref.to_owned())
        .collect::<BTreeSet<_>>();
    let response = client
        .post_json(HYDRATE_PATH, &HydrateRequest { entries }, None)
        .await?;
    let receipt: CredentialEndpointReceipt = response_json(response, "hydrate credentials").await?;
    let actual = receipt.credential_refs.into_iter().collect::<BTreeSet<_>>();
    if receipt.hydrated_count != Some(expected.len()) || actual != expected {
        return Err("credential hydrate receipt mismatch".into());
    }
    Ok(())
}

async fn post_dehydrate(client: &SidecarClient, refs: &[String]) -> Result<(), String> {
    if refs.is_empty() {
        return Ok(());
    }
    if refs.len() > MAX_CREDENTIALS {
        return Err("credential dehydrate batch exceeds limit".into());
    }
    let expected = refs.iter().cloned().collect::<BTreeSet<_>>();
    let response = client
        .post_json(
            DEHYDRATE_PATH,
            &DehydrateRequest {
                credential_refs: refs,
            },
            None,
        )
        .await?;
    let receipt: CredentialEndpointReceipt =
        response_json(response, "dehydrate credentials").await?;
    let actual = receipt.credential_refs.into_iter().collect::<BTreeSet<_>>();
    if receipt.dehydrated_count != Some(expected.len()) || actual != expected {
        return Err("credential dehydrate receipt mismatch".into());
    }
    Ok(())
}

async fn hydrate_saved_credentials(client: &SidecarClient, config: &Value) -> Result<(), String> {
    let refs = provider_credential_refs(config)?;
    if refs.len() > MAX_CREDENTIALS {
        return Err("saved provider credential count exceeds limit".into());
    }
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        refs.into_iter()
            .map(|(credential_ref, key)| {
                credential_vault::read_secret(&key).map(|secret| (credential_ref, secret))
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|error| format!("credential vault worker failed: {error}"))??;

    let mut present = Vec::new();
    let mut missing = Vec::new();
    for (credential_ref, secret) in &resolved {
        if let Some(secret) = secret.as_ref() {
            present.push(HydrateEntry {
                credential_ref,
                secret: secret.as_str(),
            });
        } else {
            missing.push(credential_ref.clone());
        }
    }
    post_hydrate(client, present).await?;
    post_dehydrate(client, &missing).await
}

async fn prepare_config(
    client: &SidecarClient,
    config: &mut Value,
    replacements: Vec<ProviderCredentialReplacement>,
) -> Result<Vec<PreparedReplacement>, String> {
    if replacements.len() > MAX_CREDENTIALS {
        return Err("provider credential replacement count exceeds limit".into());
    }
    let mut secrets = BTreeMap::new();
    for mut replacement in replacements {
        if replacement.provider_key.trim().is_empty()
            || replacement.secret.is_empty()
            || replacement.secret.len() > MAX_SECRET_BYTES
        {
            return Err("provider credential replacement is invalid".into());
        }
        let provider_key = std::mem::take(&mut replacement.provider_key);
        let secret = Zeroizing::new(std::mem::take(&mut replacement.secret));
        if secrets.insert(provider_key, secret).is_some() {
            return Err("duplicate provider credential replacement".into());
        }
    }

    let mut prepared = Vec::new();
    for (provider_key, provider_value) in providers_object_mut(config)? {
        let provider = provider_value
            .as_object_mut()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        if provider
            .get("api_key")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err("plaintext api_key is forbidden in a typed credential transaction".into());
        }
        provider.remove("api_key");
        provider.remove("credential_ref");

        let id = provider_instance_id(provider)?;
        let (mode, supplied_ref) = {
            let mutation = provider
                .get("api_key_mutation")
                .and_then(Value::as_object)
                .ok_or_else(|| "api_key_mutation is required for every provider".to_string())?;
            if mutation
                .keys()
                .any(|key| key != "mode" && key != "credential_ref")
            {
                return Err("api_key_mutation contains an unknown field".into());
            }
            let mode = mutation
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "api_key_mutation.mode is required".to_string())?
                .to_owned();
            let supplied_ref = mutation
                .get("credential_ref")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            (mode, supplied_ref)
        };
        match mode.as_str() {
            "replace" => {
                let secret = secrets
                    .remove(provider_key)
                    .ok_or_else(|| "replace mutation requires one native secret".to_string())?;
                let (key, expected_ref) = if let Some(provider_id) = id.as_deref() {
                    provider_key_for_id(provider_id)?
                } else {
                    let reservation = reserve_provider_credential(client).await?;
                    provider.insert(
                        "provider_instance_id".into(),
                        Value::String(reservation.provider_instance_id.clone()),
                    );
                    (
                        CredentialKey::provider_api_key(reservation.provider_instance_id),
                        reservation.credential_ref,
                    )
                };
                if let Some(supplied_ref) = supplied_ref {
                    if supplied_ref != expected_ref {
                        return Err(
                            "replace credential_ref conflicts with provider identity".into()
                        );
                    }
                }
                provider
                    .get_mut("api_key_mutation")
                    .and_then(Value::as_object_mut)
                    .expect("validated mutation")
                    .insert("credential_ref".into(), Value::String(expected_ref.clone()));
                prepared.push(PreparedReplacement {
                    key,
                    credential_ref: expected_ref,
                    secret,
                });
            }
            "preserve" => {
                if secrets.remove(provider_key).is_some() {
                    return Err("preserve mutation cannot include a native secret".into());
                }
                let provider_id = id
                    .as_deref()
                    .ok_or_else(|| "preserve requires a stable provider identity".to_string())?;
                provider_key_for_id(provider_id)?;
                provider
                    .get_mut("api_key_mutation")
                    .and_then(Value::as_object_mut)
                    .expect("validated mutation")
                    .remove("credential_ref");
            }
            "delete" => {
                if secrets.remove(provider_key).is_some() {
                    return Err("delete mutation cannot include a native secret".into());
                }
                if let Some(provider_id) = id.as_deref() {
                    provider_key_for_id(provider_id)?;
                }
                provider
                    .get_mut("api_key_mutation")
                    .and_then(Value::as_object_mut)
                    .expect("validated mutation")
                    .remove("credential_ref");
            }
            _ => return Err("api_key_mutation.mode is invalid".into()),
        }
    }
    if !secrets.is_empty() {
        return Err("native secret does not match a replace provider".into());
    }
    Ok(prepared)
}

fn deleted_provider_keys(current: &Value, next: &Value) -> Result<Vec<CredentialKey>, String> {
    let mut next_modes = BTreeMap::new();
    for provider in providers_object(next)?.values() {
        let provider = provider
            .as_object()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        let Some(provider_id) = provider_instance_id(provider)? else {
            continue;
        };
        let mode = provider
            .get("api_key_mutation")
            .and_then(Value::as_object)
            .and_then(|mutation| mutation.get("mode"))
            .and_then(Value::as_str)
            .ok_or_else(|| "api_key_mutation.mode is required".to_string())?;
        next_modes.insert(provider_id, mode.to_owned());
    }

    let mut deleted = Vec::new();
    for (_, key) in provider_credential_refs(current)? {
        let provider_id = key
            .credential_ref()?
            .trim_start_matches("llm_provider/")
            .trim_end_matches("/api_key")
            .to_owned();
        if next_modes.get(&provider_id).map(String::as_str) != Some("preserve")
            && next_modes.get(&provider_id).map(String::as_str) != Some("replace")
        {
            deleted.push(key);
        }
    }
    Ok(deleted)
}

fn rollback_vault(snapshots: &[VaultSnapshot]) -> Result<(), String> {
    let mut failures = Vec::new();
    for snapshot in snapshots.iter().rev() {
        let result = match snapshot.previous.as_ref() {
            Some(previous) => {
                credential_vault::write_secret(&snapshot.key, previous.as_str()).map(|_| ())
            }
            None => credential_vault::remove_secret(&snapshot.key).map(|_| ()),
        };
        if let Err(error) = result {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn apply_vault_changes(
    replacements: Vec<PreparedReplacement>,
    deleted_keys: Vec<CredentialKey>,
) -> Result<AppliedVaultTransaction, String> {
    let replacement_refs = replacements
        .iter()
        .map(|replacement| replacement.credential_ref.clone())
        .collect::<BTreeSet<_>>();
    let mut snapshots = Vec::new();

    for replacement in &replacements {
        let previous = match credential_vault::read_secret(&replacement.key) {
            Ok(previous) => previous,
            Err(error) => {
                let rollback = rollback_vault(&snapshots);
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!("{error}; vault rollback failed: {rollback_error}")
                    }
                });
            }
        };
        if let Err(error) =
            credential_vault::write_secret(&replacement.key, replacement.secret.as_str())
        {
            let rollback = rollback_vault(&snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; vault rollback failed: {rollback_error}"),
            });
        }
        snapshots.push(VaultSnapshot {
            key: replacement.key.clone(),
            credential_ref: replacement.credential_ref.clone(),
            previous,
            replacement: true,
        });
    }

    for key in deleted_keys {
        let credential_ref = match key.credential_ref() {
            Ok(credential_ref) => credential_ref,
            Err(error) => {
                let rollback = rollback_vault(&snapshots);
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!("{error}; vault rollback failed: {rollback_error}")
                    }
                });
            }
        };
        if replacement_refs.contains(&credential_ref) {
            continue;
        }
        let previous = match credential_vault::read_secret(&key) {
            Ok(previous) => previous,
            Err(error) => {
                let rollback = rollback_vault(&snapshots);
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!("{error}; vault rollback failed: {rollback_error}")
                    }
                });
            }
        };
        if let Err(error) = credential_vault::remove_secret(&key) {
            let rollback = rollback_vault(&snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}; vault rollback failed: {rollback_error}"),
            });
        }
        snapshots.push(VaultSnapshot {
            key,
            credential_ref,
            previous,
            replacement: false,
        });
    }

    Ok(AppliedVaultTransaction {
        replacements,
        snapshots,
    })
}

async fn rollback_runtime(
    client: &SidecarClient,
    transaction: &AppliedVaultTransaction,
) -> Result<(), String> {
    let mut present = Vec::new();
    let mut missing = Vec::new();
    for snapshot in transaction
        .snapshots
        .iter()
        .filter(|snapshot| snapshot.replacement)
    {
        if let Some(previous) = snapshot.previous.as_ref() {
            present.push(HydrateEntry {
                credential_ref: &snapshot.credential_ref,
                secret: previous.as_str(),
            });
        } else {
            missing.push(snapshot.credential_ref.clone());
        }
    }
    post_hydrate(client, present).await?;
    post_dehydrate(client, &missing).await
}

async fn rollback_uncommitted_transaction(
    client: &SidecarClient,
    transaction: AppliedVaultTransaction,
) -> Vec<String> {
    let mut failures = Vec::new();
    if let Err(error) = rollback_runtime(client, &transaction).await {
        failures.push(format!("runtime rollback failed: {error}"));
    }
    let snapshots = transaction.snapshots;
    match tauri::async_runtime::spawn_blocking(move || rollback_vault(&snapshots)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => failures.push(format!("vault rollback failed: {error}")),
        Err(error) => failures.push(format!("credential vault rollback worker failed: {error}")),
    }
    failures
}

async fn put_config(
    client: &SidecarClient,
    config: &Value,
    request_id: &str,
) -> Result<ConfigMutationReceipt, ConfigPutFailure> {
    let request = client
        .request(Method::PUT, CONFIG_PATH)
        .map_err(|message| ConfigPutFailure::Rejected {
            status: 0,
            code: None,
            message,
        })?;
    let response = request
        .json(config)
        .header("Idempotency-Key", request_id)
        .send()
        .await
        .map_err(|error| {
            ConfigPutFailure::Unresolved(format!("update LLM config outcome is unknown: {error}"))
        })?;
    let status = response.status();
    if status.is_success() {
        let body = read_bounded(response, MAX_ERROR_BYTES)
            .await
            .map_err(ConfigPutFailure::Unresolved)?;
        let receipt: ConfigMutationReceipt = serde_json::from_slice(&body).map_err(|error| {
            ConfigPutFailure::Unresolved(format!("decode config commit receipt: {error}"))
        })?;
        if receipt.status != "ok"
            || receipt.request_id != request_id
            || receipt.config_revision == 0
            || !is_sha256_digest(&receipt.config_digest)
            || receipt.committed_at <= 0
        {
            return Err(ConfigPutFailure::Unresolved(
                "config commit receipt is invalid".into(),
            ));
        }
        return Ok(receipt);
    }
    let error_body = read_bounded(response, MAX_ERROR_BYTES).await.ok();
    let code = error_body.as_deref().and_then(|body| {
        serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|value| value.get("code")?.as_str().map(str::to_owned))
            .filter(|value| value.len() <= 128 && !value.chars().any(char::is_control))
    });
    let detail = error_body
        .as_deref()
        .map(|body| String::from_utf8_lossy(body).trim().to_owned())
        .unwrap_or_default();
    let message = format!(
        "update LLM config failed with HTTP {}{}",
        status.as_u16(),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    );
    if status.is_server_error() || status.as_u16() == 409 {
        Err(ConfigPutFailure::Unresolved(message))
    } else {
        Err(ConfigPutFailure::Rejected {
            status: status.as_u16(),
            code,
            message,
        })
    }
}

async fn put_config_with_retry(
    client: &SidecarClient,
    config: &Value,
    request_id: &str,
) -> Result<ConfigMutationReceipt, ConfigPutFailure> {
    let mut last_unresolved = None;
    for attempt in 0..3 {
        match put_config(client, config, request_id).await {
            Ok(receipt) => return Ok(receipt),
            Err(ConfigPutFailure::Unresolved(message)) => {
                last_unresolved = Some(message);
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(100 * (attempt + 1) as u64)).await;
                }
            }
            Err(rejected) => return Err(rejected),
        }
    }
    Err(ConfigPutFailure::Unresolved(
        last_unresolved.unwrap_or_else(|| "config mutation outcome is unresolved".into()),
    ))
}

fn pending_mutation(
    request_id: String,
    client_config_digest: String,
    config: Value,
    replacements: &[PreparedReplacement],
    deleted_keys: &[CredentialKey],
) -> Result<PendingConfigMutation, String> {
    let replacement_digests = replacements
        .iter()
        .map(|replacement| {
            (
                replacement.credential_ref.clone(),
                sha256_digest(replacement.secret.as_bytes()),
            )
        })
        .collect();
    let deleted_refs = deleted_keys
        .iter()
        .map(CredentialKey::credential_ref)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PendingConfigMutation {
        request_id,
        client_config_digest,
        config,
        replacement_digests,
        deleted_refs,
    })
}

async fn cleanup_deleted_credentials(refs: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut failures = Vec::new();
        for credential_ref in refs {
            match provider_key_for_ref(&credential_ref)
                .and_then(|key| credential_vault::remove_secret(&key).map(|_| ()))
            {
                Ok(()) => {}
                Err(error) => failures.push(error),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    })
    .await
    .map_err(|error| format!("credential cleanup worker failed: {error}"))?
}

async fn hydrate_pending_replacements(
    client: &SidecarClient,
    pending: &PendingConfigMutation,
    replacements: &mut Vec<ProviderCredentialReplacement>,
    may_use_renderer_secrets: bool,
) -> Result<(), String> {
    let mut supplied = BTreeMap::new();
    for replacement in replacements {
        if replacement.provider_key.trim().is_empty()
            || replacement.secret.is_empty()
            || replacement.secret.len() > MAX_SECRET_BYTES
        {
            replacement.secret.zeroize();
            return Err("provider credential replacement is invalid".into());
        }
        let secret = Zeroizing::new(std::mem::take(&mut replacement.secret));
        if supplied
            .insert(replacement.provider_key.clone(), secret)
            .is_some()
        {
            return Err("duplicate provider credential replacement".into());
        }
    }

    let mut expected_by_provider = BTreeMap::new();
    for (provider_key, provider) in providers_object(&pending.config)? {
        let provider = provider
            .as_object()
            .ok_or_else(|| "pending LLM provider must be an object".to_string())?;
        let mutation = provider
            .get("api_key_mutation")
            .and_then(Value::as_object)
            .ok_or_else(|| "pending api_key_mutation is missing".to_string())?;
        if mutation.get("mode").and_then(Value::as_str) != Some("replace") {
            continue;
        }
        let credential_ref = mutation
            .get("credential_ref")
            .and_then(Value::as_str)
            .ok_or_else(|| "pending replace credential_ref is missing".to_string())?;
        let expected_digest = pending
            .replacement_digests
            .get(credential_ref)
            .ok_or_else(|| "pending replacement digest is missing".to_string())?;
        expected_by_provider.insert(
            provider_key.clone(),
            (credential_ref.to_owned(), expected_digest.to_owned()),
        );
    }
    if expected_by_provider.len() != pending.replacement_digests.len() {
        return Err("pending replacement set is inconsistent".into());
    }

    let (resolved, unused_supplied) = tauri::async_runtime::spawn_blocking(move || {
        let mut values = Vec::new();
        for (provider_key, (credential_ref, expected_digest)) in expected_by_provider {
            let key = provider_key_for_ref(&credential_ref)?;
            let mut secret = credential_vault::read_secret(&key)?;
            let supplied_secret = supplied.remove(&provider_key);
            let matches_vault = secret
                .as_ref()
                .is_some_and(|value| sha256_digest(value.as_bytes()) == expected_digest);
            if !matches_vault {
                secret = supplied_secret.filter(|value| {
                    may_use_renderer_secrets && sha256_digest(value.as_bytes()) == expected_digest
                });
                if let Some(value) = secret.as_ref() {
                    credential_vault::write_secret(&key, value.as_str())?;
                }
            }
            let secret = secret.ok_or_else(|| {
                "pending credential generation is unavailable; transaction remains blocked"
                    .to_string()
            })?;
            values.push((credential_ref, secret));
        }
        Ok::<_, String>((values, supplied))
    })
    .await
    .map_err(|error| format!("credential recovery worker failed: {error}"))??;

    if may_use_renderer_secrets && !unused_supplied.is_empty() {
        return Err("native secret does not match the pending credential transaction".into());
    }

    let entries = resolved
        .iter()
        .map(|(credential_ref, secret)| HydrateEntry {
            credential_ref,
            secret: secret.as_str(),
        })
        .collect();
    post_hydrate(client, entries).await
}

async fn reconcile_pending_mutation(
    client: &SidecarClient,
    pending: &PendingConfigMutation,
    replacements: &mut Vec<ProviderCredentialReplacement>,
    current_client_digest: &str,
) -> Result<ConfigMutationReceipt, String> {
    match put_config_with_retry(client, &pending.config, &pending.request_id).await {
        Ok(receipt) => return Ok(receipt),
        Err(ConfigPutFailure::Rejected { status, code, .. })
            if is_missing_hydration_rejection(status, code.as_deref()) => {}
        Err(ConfigPutFailure::Rejected {
            status, message, ..
        }) => {
            return Err(format!(
                "pending config transaction is rejected and remains blocked: {message} (HTTP {status})"
            ));
        }
        Err(ConfigPutFailure::Unresolved(message)) => {
            return Err(format!(
                "pending config transaction is still unresolved: {message}"
            ));
        }
    }

    hydrate_pending_replacements(
        client,
        pending,
        replacements,
        pending.client_config_digest == current_client_digest,
    )
    .await?;
    put_config_with_retry(client, &pending.config, &pending.request_id)
        .await
        .map_err(|failure| match failure {
            ConfigPutFailure::Rejected {
                status, message, ..
            } => format!("pending config transaction remains blocked: {message} (HTTP {status})"),
            ConfigPutFailure::Unresolved(message) => {
                format!("pending config transaction remains unresolved: {message}")
            }
        })
}

fn identity_receipt(config: &Value) -> Result<ProviderCredentialApplyReceipt, String> {
    let mut provider_instance_ids = BTreeMap::new();
    for (provider_key, provider) in providers_object(config)? {
        let provider = provider
            .as_object()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        if let Some(provider_id) = provider_instance_id(provider)? {
            provider_key_for_id(&provider_id)?;
            provider_instance_ids.insert(provider_key.clone(), provider_id);
        }
    }
    Ok(ProviderCredentialApplyReceipt {
        provider_instance_ids,
    })
}

/// Reads the Sidecar config only after all saved Keychain refs have been
/// rehydrated. The response contains masked metadata, never plaintext.
#[tauri::command]
pub async fn get_llm_config_with_credentials(
    app: AppHandle,
    state: State<'_, ProviderCredentialCoordinator>,
) -> Result<Value, String> {
    let _guard = state.operation_lock.lock().await;
    let client = SidecarClient::new(Duration::from_secs(30))?;
    if let Some(pending) = load_pending(&app).await? {
        let mut no_renderer_secrets = Vec::new();
        reconcile_pending_mutation(
            &client,
            &pending,
            &mut no_renderer_secrets,
            &pending.client_config_digest,
        )
        .await?;
        cleanup_deleted_credentials(pending.deleted_refs).await?;
        remove_pending(&app).await?;
    }
    let config = get_config(&client).await?;
    hydrate_saved_credentials(&client, &config).await?;
    get_config(&client).await
}

/// Applies one compensatable native transaction:
/// reserve identity -> Keychain mutations -> process hydration -> one config PUT.
#[tauri::command]
pub async fn apply_llm_config_with_credentials(
    app: AppHandle,
    state: State<'_, ProviderCredentialCoordinator>,
    mut config: Value,
    mut replacements: Vec<ProviderCredentialReplacement>,
) -> Result<ProviderCredentialApplyReceipt, String> {
    let _guard = state.operation_lock.lock().await;
    let client = SidecarClient::new(Duration::from_secs(300))?;
    let client_config_digest = value_digest(&config)?;
    if let Some(pending) = load_pending(&app).await? {
        let receipt =
            reconcile_pending_mutation(&client, &pending, &mut replacements, &client_config_digest)
                .await?;
        let _was_replayed = receipt.replayed;
        cleanup_deleted_credentials(pending.deleted_refs.clone()).await?;
        // A Sidecar restart clears its process-only resolver even though the
        // durable idempotency receipt can still replay successfully.
        let committed = get_config(&client).await?;
        hydrate_saved_credentials(&client, &committed).await?;
        remove_pending(&app).await?;
        if pending.client_config_digest == client_config_digest {
            return identity_receipt(&pending.config);
        }
        for replacement in &mut replacements {
            replacement.secret.zeroize();
        }
        return Err(
            "previous credential transaction was reconciled; retry the newer config mutation"
                .into(),
        );
    }
    let current = get_config(&client).await?;
    hydrate_saved_credentials(&client, &current).await?;
    let prepared = prepare_config(&client, &mut config, replacements).await?;
    let deleted_keys = deleted_provider_keys(&current, &config)?;
    let request_id = format!("llm-config:{}", Uuid::new_v4());
    let pending = pending_mutation(
        request_id.clone(),
        client_config_digest,
        config.clone(),
        &prepared,
        &deleted_keys,
    )?;
    write_pending(&app, &pending).await?;
    let transaction_result =
        tauri::async_runtime::spawn_blocking(move || apply_vault_changes(prepared, Vec::new()))
            .await
            .map_err(|error| format!("credential vault worker failed: {error}"))?;
    let transaction = match transaction_result {
        Ok(transaction) => transaction,
        Err(error) => {
            let cleanup = remove_pending(&app).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => format!("{error}; {cleanup_error}"),
            });
        }
    };

    let hydrate_entries = transaction
        .replacements
        .iter()
        .map(|replacement| HydrateEntry {
            credential_ref: &replacement.credential_ref,
            secret: replacement.secret.as_str(),
        })
        .collect();
    if let Err(error) = post_hydrate(&client, hydrate_entries).await {
        let failures = rollback_uncommitted_transaction(&client, transaction).await;
        if failures.is_empty() {
            return match remove_pending(&app).await {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error}; {cleanup_error}; pending transaction remains fail-closed"
                )),
            };
        }
        return Err(format!(
            "{error}; {}; credential state retained pending transaction reconciliation",
            failures.join("; ")
        ));
    }

    match put_config_with_retry(&client, &config, &request_id).await {
        Ok(receipt) => {
            let _was_replayed = receipt.replayed;
            cleanup_deleted_credentials(pending.deleted_refs.clone()).await?;
            remove_pending(&app).await?;
        }
        Err(ConfigPutFailure::Unresolved(error)) => {
            // A transport error may occur after the Sidecar committed. With a
            // stable credential_ref, GET cannot prove which secret generation
            // won. Retain the new value for receipt-based reconciliation.
            return Err(format!(
                "{error}; credential state retained pending transaction reconciliation"
            ));
        }
        Err(ConfigPutFailure::Rejected {
            status,
            message: error,
            ..
        }) => {
            let failures = rollback_uncommitted_transaction(&client, transaction).await;
            if failures.is_empty() {
                return match remove_pending(&app).await {
                    Ok(()) => Err(format!("{error} (HTTP {status})")),
                    Err(cleanup_error) => Err(format!(
                        "{error}; {cleanup_error}; pending transaction remains fail-closed"
                    )),
                };
            }
            return Err(format!(
                "{error}; {}; pending transaction remains fail-closed",
                failures.join("; ")
            ));
        }
    }

    identity_receipt(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDER_ID: &str = "pvd_v1_00112233445566778899aabbccddeeff";

    #[test]
    fn provider_ref_is_exactly_bound_to_canonical_identity() {
        let (_, credential_ref) = provider_key_for_id(PROVIDER_ID).expect("provider key");
        assert_eq!(
            credential_ref,
            format!("llm_provider/{PROVIDER_ID}/api_key")
        );
        assert!(provider_key_for_id("editable-openai-card").is_err());
    }

    #[test]
    fn deleted_refs_are_derived_by_stable_identity_not_map_key() {
        let current = serde_json::json!({
            "providers": {
                "old-name": {
                    "provider_instance_id": PROVIDER_ID,
                    "credential_ref": format!("llm_provider/{PROVIDER_ID}/api_key")
                }
            }
        });
        let renamed = serde_json::json!({
            "providers": {
                "new-name": {
                    "provider_instance_id": PROVIDER_ID,
                    "api_key_mutation": {"mode": "preserve"}
                }
            }
        });
        assert!(deleted_provider_keys(&current, &renamed)
            .expect("deleted refs")
            .is_empty());

        let deleted = serde_json::json!({"providers": {}});
        assert_eq!(
            deleted_provider_keys(&current, &deleted)
                .expect("deleted refs")
                .len(),
            1
        );
    }

    #[test]
    fn saved_ref_must_match_stable_provider_identity() {
        let invalid = serde_json::json!({
            "providers": {
                "cloud": {
                    "provider_instance_id": PROVIDER_ID,
                    "credential_ref": "llm_provider/pvd_v1_ffeeddccbbaa99887766554433221100/api_key"
                }
            }
        });
        assert!(provider_credential_refs(&invalid).is_err());
    }

    #[test]
    fn only_the_machine_readable_missing_hydration_error_is_recoverable() {
        assert!(is_missing_hydration_rejection(
            422,
            Some("credential_ref_not_hydrated")
        ));
        assert!(!is_missing_hydration_rejection(422, None));
        assert!(!is_missing_hydration_rejection(
            422,
            Some("validation_failed")
        ));
        assert!(!is_missing_hydration_rejection(
            409,
            Some("credential_ref_not_hydrated")
        ));
    }

    #[test]
    fn pending_journal_contains_only_secret_digests() {
        let secret = "native-secret-must-never-be-journaled";
        let (key, credential_ref) = provider_key_for_id(PROVIDER_ID).expect("provider key");
        let replacement = PreparedReplacement {
            key,
            credential_ref: credential_ref.clone(),
            secret: Zeroizing::new(secret.to_owned()),
        };
        let config = serde_json::json!({
            "providers": {
                "cloud": {
                    "provider_instance_id": PROVIDER_ID,
                    "api_key_mutation": {
                        "mode": "replace",
                        "credential_ref": credential_ref
                    }
                }
            }
        });
        let pending = pending_mutation(
            "llm-config:test".into(),
            value_digest(&config).expect("client digest"),
            config,
            &[replacement],
            &[],
        )
        .expect("pending mutation");
        let raw = serde_json::to_string(&pending).expect("journal json");
        assert!(!raw.contains(secret));
        assert_eq!(pending.replacement_digests.len(), 1);
        assert!(pending
            .replacement_digests
            .values()
            .all(|digest| is_sha256_digest(digest)));
        assert!(!is_sha256_digest(&format!("sha256:{}", "z".repeat(64))));
        assert!(!is_sha256_digest(&format!("sha256:{}", "A".repeat(64))));
    }
}
