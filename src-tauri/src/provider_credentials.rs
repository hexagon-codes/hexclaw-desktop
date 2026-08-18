//! Native coordinator for LLM-provider configuration transactions.
//!
//! macOS Homebrew Cask releases are intentionally unsigned. Provider secrets
//! are persisted only by the Go Sidecar into the owner-only
//! `~/.hexclaw/hexclaw.yaml`. This native coordinator may carry a replacement
//! through one request, but must never read, write, or recover it from
//! Keychain or any other persistent store.

use crate::sidecar::desktop_config_path;
use crate::sidecar_client::{read_bounded, SidecarClient};
use reqwest::{Method, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Deserialize)]
struct OwnerProviderEntry {
    provider_instance_id: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OwnerLlmSection {
    #[serde(default)]
    providers: BTreeMap<String, OwnerProviderEntry>,
}

#[derive(Debug, Deserialize)]
struct OwnerConfig {
    #[serde(default)]
    llm: Option<OwnerLlmSection>,
}

const CONFIG_PATH: &str = "/api/v1/config/llm";
const RESERVE_PATH: &str = "/api/internal/desktop/provider-credentials/reserve";
const HYDRATE_PATH: &str = "/api/internal/desktop/credentials/hydrate";
const DEHYDRATE_PATH: &str = "/api/internal/desktop/credentials/dehydrate";
const MAX_CREDENTIALS: usize = 64;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;

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

struct RuntimeReplacement {
    credential_ref: String,
    secret: Zeroizing<String>,
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

fn is_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn credential_ref_for(provider_instance_id: &str) -> Result<String, String> {
    let valid = provider_instance_id
        .strip_prefix("pvd_v1_")
        .is_some_and(|suffix| is_hex(suffix, 32))
        || provider_instance_id
            .strip_prefix("pvd_legacy_v1_")
            .is_some_and(|suffix| is_hex(suffix, 64));
    if !valid {
        return Err("provider identity is not canonical".into());
    }
    Ok(format!("llm_provider/{provider_instance_id}/api_key"))
}

fn provider_instance_id(provider: &Map<String, Value>) -> Result<Option<String>, String> {
    match provider.get("provider_instance_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err("provider_instance_id must be a string".into()),
    }
}

fn provider_credential_refs(config: &Value) -> Result<BTreeSet<String>, String> {
    let mut refs = BTreeSet::new();
    for provider in providers_object(config)?.values() {
        let provider = provider
            .as_object()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        let Some(raw_ref) = provider.get("credential_ref") else {
            continue;
        };
        let Some(credential_ref) = raw_ref.as_str().filter(|value| !value.trim().is_empty()) else {
            if raw_ref.is_null() {
                continue;
            }
            return Err("credential_ref must be a string".into());
        };
        let provider_id = provider_instance_id(provider)?
            .ok_or_else(|| "credential_ref requires provider_instance_id".to_string())?;
        if credential_ref != credential_ref_for(&provider_id)? {
            return Err("credential_ref is not bound to provider_instance_id".into());
        }
        if !refs.insert(credential_ref.to_owned()) {
            return Err("duplicate provider credential_ref".into());
        }
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
    response_json(client.get(CONFIG_PATH).await?, "read LLM config").await
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
    if reservation.credential_ref != credential_ref_for(&reservation.provider_instance_id)? {
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
    if receipt.hydrated_count != Some(expected.len())
        || receipt.credential_refs.into_iter().collect::<BTreeSet<_>>() != expected
    {
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
    if receipt.dehydrated_count != Some(expected.len())
        || receipt.credential_refs.into_iter().collect::<BTreeSet<_>>() != expected
    {
        return Err("credential dehydrate receipt mismatch".into());
    }
    Ok(())
}

async fn prepare_config(
    client: &SidecarClient,
    config: &mut Value,
    replacements: Vec<ProviderCredentialReplacement>,
) -> Result<Vec<RuntimeReplacement>, String> {
    if replacements.len() > MAX_CREDENTIALS {
        return Err("provider credential replacement count exceeds limit".into());
    }
    let mut supplied = BTreeMap::new();
    for mut replacement in replacements {
        if replacement.provider_key.trim().is_empty()
            || replacement.secret.is_empty()
            || replacement.secret.len() > MAX_SECRET_BYTES
        {
            return Err("provider credential replacement is invalid".into());
        }
        let key = std::mem::take(&mut replacement.provider_key);
        let secret = Zeroizing::new(std::mem::take(&mut replacement.secret));
        if supplied.insert(key, secret).is_some() {
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
            return Err(
                "plaintext api_key is forbidden in a runtime credential transaction".into(),
            );
        }
        provider.remove("api_key");
        provider.remove("credential_ref");
        let id = provider_instance_id(provider)?;
        let mode = {
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
            mutation
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "api_key_mutation.mode is required".to_string())?
                .to_owned()
        };
        match mode.as_str() {
            "replace" => {
                let secret = supplied
                    .remove(provider_key)
                    .ok_or_else(|| "replace mutation requires one runtime secret".to_string())?;
                let (provider_id, credential_ref) = match id {
                    Some(provider_id) => (provider_id.clone(), credential_ref_for(&provider_id)?),
                    None => {
                        let reservation = reserve_provider_credential(client).await?;
                        (reservation.provider_instance_id, reservation.credential_ref)
                    }
                };
                if let Some(supplied_ref) = mutation_credential_ref(provider)? {
                    if supplied_ref != credential_ref {
                        return Err(
                            "replace credential_ref conflicts with provider identity".into()
                        );
                    }
                }
                provider.insert("provider_instance_id".into(), Value::String(provider_id));
                provider
                    .get_mut("api_key_mutation")
                    .and_then(Value::as_object_mut)
                    .expect("validated mutation")
                    .insert(
                        "credential_ref".into(),
                        Value::String(credential_ref.clone()),
                    );
                prepared.push(RuntimeReplacement {
                    credential_ref,
                    secret,
                });
            }
            "preserve" => {
                if supplied.remove(provider_key).is_some() {
                    return Err("preserve mutation cannot include a runtime secret".into());
                }
                credential_ref_for(
                    id.as_deref().ok_or_else(|| {
                        "preserve requires a stable provider identity".to_string()
                    })?,
                )?;
                provider
                    .get_mut("api_key_mutation")
                    .and_then(Value::as_object_mut)
                    .expect("validated mutation")
                    .remove("credential_ref");
            }
            "delete" => {
                if supplied.remove(provider_key).is_some() {
                    return Err("delete mutation cannot include a runtime secret".into());
                }
                if let Some(provider_id) = id.as_deref() {
                    credential_ref_for(provider_id)?;
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
    if !supplied.is_empty() {
        return Err("runtime secret does not match a replace provider".into());
    }
    Ok(prepared)
}

fn mutation_credential_ref(provider: &Map<String, Value>) -> Result<Option<&str>, String> {
    let mutation = provider
        .get("api_key_mutation")
        .and_then(Value::as_object)
        .ok_or_else(|| "api_key_mutation is required for every provider".to_string())?;
    match mutation.get("credential_ref") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err("api_key_mutation.credential_ref must be a string".into()),
    }
}

async fn put_config(
    client: &SidecarClient,
    config: &Value,
    request_id: &str,
) -> Result<(), String> {
    let response = client
        .request(Method::PUT, CONFIG_PATH)?
        .json(config)
        .header("Idempotency-Key", request_id)
        .send()
        .await
        .map_err(|error| format!("update LLM config outcome is unknown: {error}"))?;
    SidecarClient::require_non_redirect(&response)?;
    let status = response.status();
    let body = read_bounded(response, MAX_ERROR_BYTES).await?;
    if status.is_success() {
        return Ok(());
    }
    Err(format!(
        "update LLM config failed with HTTP {}{}",
        status.as_u16(),
        if body.is_empty() {
            String::new()
        } else {
            format!(": {}", String::from_utf8_lossy(&body).trim())
        }
    ))
}

fn identity_receipt(config: &Value) -> Result<ProviderCredentialApplyReceipt, String> {
    let mut provider_instance_ids = BTreeMap::new();
    for (provider_key, provider) in providers_object(config)? {
        let provider = provider
            .as_object()
            .ok_or_else(|| "LLM provider must be an object".to_string())?;
        if let Some(provider_id) = provider_instance_id(provider)? {
            credential_ref_for(&provider_id)?;
            provider_instance_ids.insert(provider_key.clone(), provider_id);
        }
    }
    Ok(ProviderCredentialApplyReceipt {
        provider_instance_ids,
    })
}

/// 读取 owner YAML 中单个 Provider 的明文 API Key（方案 B，2026-08-19 批准）：
/// 仅眼睛点击显示时调用，明文只写入前端独立展示层、内存短驻，不写入表单保存值；
/// 不写入任何第二持久化路径，日志与审计保持脱敏。
#[tauri::command]
pub async fn read_provider_api_key(provider_id: String) -> Result<Option<String>, String> {
    read_provider_api_key_from_owner_yaml(&provider_id).await
}

async fn read_provider_api_key_from_owner_yaml(provider_id: &str) -> Result<Option<String>, String> {
    let path = desktop_config_path()?;
    let yaml = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("read owner config failed: {error}"))?;
    let owner_config: OwnerConfig = serde_yaml::from_str(&yaml)
        .map_err(|error| format!("decode owner config failed: {error}"))?;
    Ok(owner_config
        .llm
        .map(|llm| {
            llm.providers
                .into_iter()
                .find_map(|(owner_name, entry)| {
                    let api_key = entry.api_key.filter(|value| !value.trim().is_empty())?;
                    let matches = entry.provider_instance_id.as_deref() == Some(provider_id)
                        || owner_name == provider_id;
                    matches.then_some(api_key)
                })
        })
        .unwrap_or_default())
}

/// Reads Sidecar configuration. Provider API keys stay masked in the response
/// (sidecar masking); the frontend renders them as '********' and reveals
/// plaintext only via read_provider_api_key on demand.
#[tauri::command]
pub async fn get_llm_config_with_credentials(
    state: State<'_, ProviderCredentialCoordinator>,
) -> Result<Value, String> {
    let _guard = state.operation_lock.lock().await;
    let client = SidecarClient::new(Duration::from_secs(30))?;
    get_config(&client).await
}

/// Hydrates only a newly supplied secret into the current Sidecar process,
/// then commits the typed update. The Sidecar atomically persists the accepted
/// Provider key in owner YAML; native code neither journals nor stores it.
#[tauri::command]
pub async fn apply_llm_config_with_credentials(
    state: State<'_, ProviderCredentialCoordinator>,
    mut config: Value,
    replacements: Vec<ProviderCredentialReplacement>,
) -> Result<ProviderCredentialApplyReceipt, String> {
    let _guard = state.operation_lock.lock().await;
    let client = SidecarClient::new(Duration::from_secs(300))?;
    let current = get_config(&client).await?;
    let current_refs = provider_credential_refs(&current)?;
    let prepared = prepare_config(&client, &mut config, replacements).await?;
    let replacement_refs = prepared
        .iter()
        .map(|replacement| replacement.credential_ref.clone())
        .collect::<Vec<_>>();
    let hydrate_entries = prepared
        .iter()
        .map(|replacement| HydrateEntry {
            credential_ref: &replacement.credential_ref,
            secret: replacement.secret.as_str(),
        })
        .collect();
    post_hydrate(&client, hydrate_entries).await?;

    let request_id = format!("llm-config:{}", Uuid::new_v4());
    if let Err(error) = put_config(&client, &config, &request_id).await {
        let _ = post_dehydrate(&client, &replacement_refs).await;
        return Err(error);
    }

    let next_refs = provider_credential_refs(&config)?;
    let stale_refs = current_refs
        .difference(&next_refs)
        .cloned()
        .collect::<Vec<_>>();
    post_dehydrate(&client, &stale_refs).await?;
    identity_receipt(&config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::ffi::OsString;
    use std::fs;

    const PROVIDER_ID: &str = "pvd_v1_00112233445566778899aabbccddeeff";

    #[test]
    fn provider_ref_is_exactly_bound_to_canonical_identity() {
        assert_eq!(
            credential_ref_for(PROVIDER_ID).expect("ref"),
            format!("llm_provider/{PROVIDER_ID}/api_key")
        );
        assert!(credential_ref_for("editable-openai-card").is_err());
    }

    #[test]
    fn persisted_config_refs_remain_opaque_and_validated() {
        let config = serde_json::json!({
            "providers": {"cloud": {
                "provider_instance_id": PROVIDER_ID,
                "credential_ref": format!("llm_provider/{PROVIDER_ID}/api_key")
            }}
        });
        assert_eq!(provider_credential_refs(&config).expect("refs").len(), 1);
    }

    #[test]
    fn replacement_ref_must_be_a_string_when_supplied() {
        let provider = serde_json::json!({
            "api_key_mutation": {"mode": "replace", "credential_ref": 7}
        });
        assert!(mutation_credential_ref(provider.as_object().expect("provider")).is_err());
    }

    #[tokio::test]
    async fn read_provider_api_key_returns_plaintext_only_for_the_requested_provider() {
        let root = env::temp_dir().join(format!(
            "hexclaw-owner-yaml-read-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let home = OsString::from(root.to_string_lossy().to_string());
        let config_dir = root.join(".hexclaw");
        let config_path = config_dir.join("hexclaw.yaml");

        fs::create_dir_all(&config_dir).expect("create .hexclaw");
        fs::write(
            &config_path,
            "llm:\n  providers:\n    openai:\n      provider_instance_id: pvd_v1_00112233445566778899aabbccddeeff\n      api_key: test-key-plain\n    deepseek:\n      api_key: deepseek-key-plain\n",
        )
        .expect("write owner yaml");

        let prior_home = env::var_os("HOME");
        let prior_user_profile = env::var_os("USERPROFILE");
        env::set_var("HOME", &home);
        env::set_var("USERPROFILE", &home);

        // 按 provider_instance_id 匹配
        assert_eq!(
            read_provider_api_key_from_owner_yaml(PROVIDER_ID)
                .await
                .expect("read by instance id"),
            Some("test-key-plain".to_string())
        );
        // 按 owner key 名称匹配（无实例 ID 的 Provider）
        assert_eq!(
            read_provider_api_key_from_owner_yaml("deepseek")
                .await
                .expect("read by name"),
            Some("deepseek-key-plain".to_string())
        );
        // 未匹配 Provider 返回 None，绝不误读其他 Provider 的密钥
        assert_eq!(
            read_provider_api_key_from_owner_yaml("unknown-provider")
                .await
                .expect("read unknown"),
            None
        );

        match prior_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match prior_user_profile {
            Some(value) => env::set_var("USERPROFILE", value),
            None => env::remove_var("USERPROFILE"),
        }
        let _ = fs::remove_dir_all(&root);
    }
}
