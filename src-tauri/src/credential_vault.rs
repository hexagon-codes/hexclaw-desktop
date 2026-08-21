//! Typed OS credential-vault boundary.
//!
//! Renderer commands are intentionally write/delete/present only. Accounts are
//! derived from a stable provider/connection identity plus an enum secret kind;
//! renderer code cannot choose a keyring service or arbitrary account string.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "net.hexclaw.desktop";
const MAX_OWNER_ID_BYTES: usize = 160;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const CREDENTIAL_REF_PREFIX: &str = "hexclaw-vault:v1";
const PROVIDER_ID_PREFIX: &str = "pvd_v1_";
const LEGACY_PROVIDER_ID_PREFIX: &str = "pvd_legacy_v1_";
const PROVIDER_VAULT_ERROR: &str =
    "provider credentials require the native config coordinator";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialOwnerKind {
    Provider,
    Connection,
}

#[cfg(all(test, target_os = "macos"))]
mod macos_keychain_boundary_tests {
    use super::{
        entry, read_secret, remove_secret, write_secret, CredentialKey, CredentialOwnerKind,
        CredentialSecretKind,
    };
    use uuid::Uuid;

    struct Cleanup<'a>(&'a CredentialKey);

    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = remove_secret(self.0);
        }
    }

    #[test]
    fn credential_entries_use_native_macos_backend() -> Result<(), String> {
        let key = CredentialKey {
            owner_kind: CredentialOwnerKind::Connection,
            owner_id: "keychain-backend-contract".to_string(),
            secret_kind: CredentialSecretKind::Token,
        };
        let (_, entry) = entry(&key)?;
        if !entry.get_credential().is::<keyring::macos::MacCredential>() {
            return Err("credential entry is not backed by macOS Keychain".to_string());
        }
        Ok(())
    }

    #[test]
    #[ignore = "mutates the macOS login Keychain; run explicitly"]
    fn real_macos_keychain_round_trip() -> Result<(), String> {
        let nonce = Uuid::new_v4().simple().to_string();
        let key = CredentialKey {
            owner_kind: CredentialOwnerKind::Connection,
            owner_id: format!("keychain-boundary-{nonce}"),
            secret_kind: CredentialSecretKind::Token,
        };
        let secret = format!("hexclaw-keychain-boundary-{nonce}");
        let _cleanup = Cleanup(&key);

        let _ = remove_secret(&key)?;
        let credential_ref = write_secret(&key, &secret)?;
        if credential_ref.is_empty() || credential_ref == secret {
            return Err("credential reference must be opaque and non-empty".to_string());
        }

        let stored = read_secret(&key)?;
        if stored
            .as_deref()
            .is_none_or(|value| value != secret.as_str())
        {
            return Err("Keychain returned a different secret".to_string());
        }

        if !remove_secret(&key)? {
            return Err("Keychain entry was not removed".to_string());
        }
        if read_secret(&key)?.is_some() {
            return Err("Keychain entry remained readable after removal".to_string());
        }

        Ok(())
    }
}

impl CredentialOwnerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Connection => "connection",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSecretKind {
    ApiKey,
    Password,
    Token,
    Secret,
    AppSecret,
    AesKey,
    AccessKey,
    SecretKey,
}

impl CredentialSecretKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Password => "password",
            Self::Token => "token",
            Self::Secret => "secret",
            Self::AppSecret => "app_secret",
            Self::AesKey => "aes_key",
            Self::AccessKey => "access_key",
            Self::SecretKey => "secret_key",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialKey {
    owner_kind: CredentialOwnerKind,
    owner_id: String,
    secret_kind: CredentialSecretKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMutationReceipt {
    credential_ref: String,
    updated: bool,
}

fn validate_owner_id(owner_id: &str) -> Result<(), String> {
    if owner_id.is_empty()
        || owner_id.len() > MAX_OWNER_ID_BYTES
        || !owner_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("credential owner identity is invalid".into());
    }
    Ok(())
}

impl CredentialKey {
    pub(crate) fn credential_ref(&self) -> Result<String, String> {
        validate_owner_id(&self.owner_id)?;
        if self.owner_kind == CredentialOwnerKind::Provider {
            if self.secret_kind != CredentialSecretKind::ApiKey {
                return Err("provider credential kind is invalid".into());
            }
            validate_provider_instance_id(&self.owner_id)?;
            return Ok(format!("llm_provider/{}/api_key", self.owner_id));
        }
        Ok(format!(
            "{CREDENTIAL_REF_PREFIX}:{}:{}:{}",
            self.owner_kind.as_str(),
            self.owner_id,
            self.secret_kind.as_str()
        ))
    }
}

fn ensure_os_vault_access_allowed(key: &CredentialKey) -> Result<(), String> {
    if key.owner_kind == CredentialOwnerKind::Provider {
        return Err(PROVIDER_VAULT_ERROR.into());
    }
    Ok(())
}

fn validate_provider_instance_id(provider_instance_id: &str) -> Result<(), String> {
    let hex = provider_instance_id
        .strip_prefix(PROVIDER_ID_PREFIX)
        .filter(|value| value.len() == 32)
        .or_else(|| {
            provider_instance_id
                .strip_prefix(LEGACY_PROVIDER_ID_PREFIX)
                .filter(|value| value.len() == 64)
        })
        .ok_or_else(|| "provider identity is not canonical".to_string())?;
    if !hex
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("provider identity is not canonical".into());
    }
    Ok(())
}

fn entry(key: &CredentialKey) -> Result<(String, Entry), String> {
    ensure_os_vault_access_allowed(key)?;
    let credential_ref = key.credential_ref()?;
    let entry = Entry::new(SERVICE, &credential_ref)
        .map_err(|error| format!("open OS credential vault: {error}"))?;
    Ok((credential_ref, entry))
}

#[cfg(test)]
pub(crate) fn read_secret(key: &CredentialKey) -> Result<Option<Zeroizing<String>>, String> {
    match entry(key)?.1.get_password() {
        Ok(secret) => Ok(Some(Zeroizing::new(secret))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("read OS credential vault: {error}")),
    }
}

pub(crate) fn write_secret(key: &CredentialKey, secret: &str) -> Result<String, String> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err("credential secret is invalid".into());
    }
    let (credential_ref, entry) = entry(key)?;
    entry
        .set_password(secret)
        .map_err(|error| format!("write OS credential vault: {error}"))?;
    Ok(credential_ref)
}

pub(crate) fn remove_secret(key: &CredentialKey) -> Result<bool, String> {
    let (_, entry) = entry(key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("delete OS credential: {error}")),
    }
}

#[tauri::command]
pub async fn put_credential(
    key: CredentialKey,
    secret: String,
) -> Result<CredentialMutationReceipt, String> {
    ensure_os_vault_access_allowed(&key)?;
    let secret = Zeroizing::new(secret);
    tauri::async_runtime::spawn_blocking(move || {
        let credential_ref = write_secret(&key, secret.as_str())?;
        Ok(CredentialMutationReceipt {
            credential_ref,
            updated: true,
        })
    })
    .await
    .map_err(|error| format!("credential vault worker failed: {error}"))?
}

#[tauri::command]
pub async fn delete_credential(key: CredentialKey) -> Result<CredentialMutationReceipt, String> {
    ensure_os_vault_access_allowed(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let credential_ref = key.credential_ref()?;
        let updated = remove_secret(&key)?;
        Ok(CredentialMutationReceipt {
            credential_ref,
            updated,
        })
    })
    .await
    .map_err(|error| format!("credential vault worker failed: {error}"))?
}

#[tauri::command]
pub async fn credential_present(key: CredentialKey) -> Result<bool, String> {
    let (_, entry) = entry(&key)?;
    tauri::async_runtime::spawn_blocking(move || match entry.get_password() {
        Ok(secret) => {
            drop(Zeroizing::new(secret));
            Ok(true)
        }
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("read OS credential vault: {error}")),
    })
    .await
    .map_err(|error| format!("credential vault worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(owner_id: &str) -> CredentialKey {
        CredentialKey {
            owner_kind: CredentialOwnerKind::Provider,
            owner_id: owner_id.into(),
            secret_kind: CredentialSecretKind::ApiKey,
        }
    }

    fn assert_provider_vault_denied<T>(result: Result<T, String>) {
        match result {
            Ok(_) => panic!("provider credential unexpectedly reached the OS vault"),
            Err(error) => assert_eq!(error, PROVIDER_VAULT_ERROR),
        }
    }

    #[test]
    fn provider_vault_read_fails_closed_before_keyring_access() {
        assert_provider_vault_denied(read_secret(&key(
            "pvd_v1_00112233445566778899aabbccddeeff",
        )));
    }

    #[test]
    fn provider_vault_delete_fails_closed_before_keyring_access() {
        assert_provider_vault_denied(remove_secret(&key(
            "pvd_v1_00112233445566778899aabbccddeeff",
        )));
    }

    #[tokio::test]
    async fn provider_vault_presence_fails_closed_before_keyring_access() {
        assert_provider_vault_denied(
            credential_present(key("pvd_v1_00112233445566778899aabbccddeeff")).await,
        );
    }

    #[test]
    fn credential_reference_is_stable_and_scope_typed() {
        let provider_id = "pvd_v1_00112233445566778899aabbccddeeff";
        assert_eq!(
            key(provider_id).credential_ref().expect("ref"),
            format!("llm_provider/{provider_id}/api_key")
        );
        assert!(key("provider-01").credential_ref().is_err());
        assert!(key("../escape").credential_ref().is_err());
        assert!(key("provider:other").credential_ref().is_err());
        assert!(key("").credential_ref().is_err());
    }

    #[test]
    fn distinct_owner_and_secret_kinds_cannot_alias() {
        let owner_id = "pvd_v1_00112233445566778899aabbccddeeff";
        let provider = key(owner_id);
        let connection = CredentialKey {
            owner_kind: CredentialOwnerKind::Connection,
            owner_id: owner_id.into(),
            secret_kind: CredentialSecretKind::Password,
        };
        assert_ne!(
            provider.credential_ref().expect("provider"),
            connection.credential_ref().expect("connection")
        );
    }
}
