import { credentialRefFor, type CredentialKey } from '@/utils/secure-store'
import type { ProviderConfig, ProviderCredentialReplacement } from '@/types'
import { cloneProviders } from './settings-provider-copy'

function providerCredentialKey(provider: ProviderConfig): CredentialKey {
  if (!provider.providerInstanceId) {
    throw new Error('provider credential requires a stable provider identity')
  }
  return {
    ownerKind: 'provider',
    ownerId: provider.providerInstanceId,
    secretKind: 'api_key',
  }
}

function providerWireKey(provider: ProviderConfig): string {
  return provider.backendKey || provider.name || provider.id
}

export function isMaskedApiKey(value: string | undefined | null): boolean {
  return (value ?? '').includes('*')
}

export async function restoreProviderApiKeys(
  providers: ProviderConfig[],
): Promise<ProviderConfig[]> {
  const restoredProviders = cloneProviders(providers)
  for (const provider of restoredProviders) {
    if (provider.credentialRef) {
      const key = providerCredentialKey(provider)
      const expectedRef = credentialRefFor(key)
      if (provider.credentialRef !== expectedRef) {
        throw new Error('provider credential reference conflicts with stable identity')
      }
      if (provider.credentialPresent === true) {
        // The Sidecar reports a usable owner-YAML key. Keep the returned value if
        // present, otherwise keep legacy masked presentation.
        if (!provider.apiKey || isMaskedApiKey(provider.apiKey)) {
          provider.apiKey = '********'
        }
        provider.apiKeyMutation = 'preserve'
      } else {
        // The Sidecar reports no usable YAML key. Do not probe Keychain or
        // invent another persistence source for the opaque reference.
        provider.credentialRef = undefined
        provider.credentialPresent = false
        provider.apiKey = ''
        provider.apiKeyMutation = 'delete'
      }
      continue
    }
    if (isMaskedApiKey(provider.apiKey)) {
      // Legacy inline Sidecar secret: preserve without ever mapping mask -> empty.
      provider.apiKeyMutation = 'preserve'
    }
  }
  return restoredProviders
}

export async function materializeProviderApiKeys(
  providers: ProviderConfig[],
): Promise<ProviderConfig[]> {
  const normalizedProviders = cloneProviders(providers)
  for (const provider of normalizedProviders) {
    const apiKey = provider.apiKey.trim()
    if (isMaskedApiKey(apiKey)) {
      if (provider.credentialRef) {
        const expectedRef = credentialRefFor(providerCredentialKey(provider))
        if (provider.credentialRef !== expectedRef || provider.credentialPresent === false) {
          throw new Error(
            `服务商 ${provider.name || provider.id} 的 API Key 只有脱敏值，请重新输入完整 Key 后再保存`,
          )
        }
      } else if (!provider.backendKey?.trim()) {
        throw new Error(
          `服务商 ${provider.name || provider.id} 的 API Key 只有脱敏值，请重新输入完整 Key 后再保存`,
        )
      }
      provider.apiKeyMutation = 'preserve'
      continue
    }

    if (apiKey) {
      provider.credentialRef = provider.providerInstanceId
        ? credentialRefFor(providerCredentialKey(provider))
        : undefined
      provider.credentialPresent = undefined
      provider.apiKeyMutation = 'replace'
      continue
    }

    provider.apiKeyMutation = 'delete'
  }
  return normalizedProviders
}

export function providerCredentialReplacements(
  providers: ProviderConfig[],
): ProviderCredentialReplacement[] {
  return providers
    .filter((provider) => provider.apiKeyMutation === 'replace')
    .map((provider) => {
      const secret = provider.apiKey.trim()
      if (!secret || isMaskedApiKey(secret)) {
        throw new Error('replace mutation requires one plaintext native secret')
      }
      return { providerKey: providerWireKey(provider), secret }
    })
}

/**
 * Removed production boundary. Provider mutations must be committed together
 * with the Sidecar config by the native coordinator; standalone vault sync is
 * deliberately fail-closed to prevent split-brain state.
 */
export async function syncProviderApiKeys(): Promise<never> {
  throw new Error('standalone provider credential sync is forbidden')
}
