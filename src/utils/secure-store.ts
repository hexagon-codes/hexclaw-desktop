import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'

export type CredentialOwnerKind = 'provider' | 'connection'
export type CredentialSecretKind =
  | 'api_key'
  | 'password'
  | 'token'
  | 'secret'
  | 'app_secret'
  | 'aes_key'
  | 'access_key'
  | 'secret_key'

export interface CredentialKey {
  ownerKind: CredentialOwnerKind
  ownerId: string
  secretKind: CredentialSecretKind
}

export interface CredentialMutationReceipt {
  credentialRef: string
  updated: boolean
}

const OWNER_ID = /^[A-Za-z0-9._-]{1,160}$/
const PROVIDER_INSTANCE_ID = /^(?:pvd_v1_[0-9a-f]{32}|pvd_legacy_v1_[0-9a-f]{64})$/

export function credentialRefFor(key: CredentialKey): string {
  if (!OWNER_ID.test(key.ownerId)) throw new Error('credential owner identity is invalid')
  if (key.ownerKind === 'provider') {
    if (key.secretKind !== 'api_key' || !PROVIDER_INSTANCE_ID.test(key.ownerId)) {
      throw new Error('provider credential identity is not canonical')
    }
    return `llm_provider/${key.ownerId}/api_key`
  }
  return `hexclaw-vault:v1:${key.ownerKind}:${key.ownerId}:${key.secretKind}`
}

// Browser development is process-memory only and deliberately has no read API.
const browserSessionVault = new Map<string, string>()

function assertStandaloneMutationAllowed(key: CredentialKey): void {
  if (key.ownerKind === 'provider') {
    throw new Error('provider credentials require the native config coordinator')
  }
}

export async function putCredential(
  key: CredentialKey,
  secret: string,
): Promise<CredentialMutationReceipt> {
  assertStandaloneMutationAllowed(key)
  const credentialRef = credentialRefFor(key)
  if (!secret) throw new Error('credential secret is invalid')
  if (isTauri()) {
    return await invoke<CredentialMutationReceipt>('put_credential', { key, secret })
  }
  browserSessionVault.set(credentialRef, secret)
  return { credentialRef, updated: true }
}

export async function deleteCredential(key: CredentialKey): Promise<CredentialMutationReceipt> {
  assertStandaloneMutationAllowed(key)
  const credentialRef = credentialRefFor(key)
  if (isTauri()) {
    return await invoke<CredentialMutationReceipt>('delete_credential', { key })
  }
  const updated = browserSessionVault.delete(credentialRef)
  return { credentialRef, updated }
}

export async function credentialPresent(key: CredentialKey): Promise<boolean> {
  const credentialRef = credentialRefFor(key)
  if (isTauri()) return await invoke<boolean>('credential_present', { key })
  return browserSessionVault.has(credentialRef)
}
