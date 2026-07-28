import { loadSecureValue, removeSecureValue, saveSecureValue } from '@/utils/secure-store'
import type { ProviderConfig } from '@/types'
import { cloneProviders } from './settings-provider-copy'

function secureApiKeyKey(providerId: string): string {
  return `llm.provider.${providerId}.apiKey`
}

export function isMaskedApiKey(value: string | undefined | null): boolean {
  return (value ?? '').includes('*')
}

export async function restoreProviderApiKeys(
  providers: ProviderConfig[],
): Promise<ProviderConfig[]> {
  const restoredProviders = cloneProviders(providers)

  for (const provider of restoredProviders) {
    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (secureApiKey) {
      provider.apiKey = secureApiKey
    }
  }

  return restoredProviders
}

export async function materializeProviderApiKeys(
  providers: ProviderConfig[],
): Promise<ProviderConfig[]> {
  const normalizedProviders = cloneProviders(providers)

  for (const provider of normalizedProviders) {
    const currentApiKey = provider.apiKey.trim()
    if (!currentApiKey) continue
    if (!isMaskedApiKey(currentApiKey)) continue

    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (!secureApiKey) {
      if (provider.backendKey?.trim()) {
        continue
      }
      throw new Error(
        `服务商 ${provider.name || provider.id} 的 API Key 只有脱敏值，请重新输入完整 Key 后再保存`,
      )
    }
    provider.apiKey = secureApiKey
  }

  return normalizedProviders
}

export async function syncProviderApiKeys(
  providers: ProviderConfig[],
  previousProviders: ProviderConfig[] = [],
): Promise<void> {
  const nextProviderIds = new Set(providers.map((provider) => provider.id))

  for (const previousProvider of previousProviders) {
    if (!nextProviderIds.has(previousProvider.id)) {
      await removeSecureValue(secureApiKeyKey(previousProvider.id))
    }
  }

  for (const provider of providers) {
    const apiKey = provider.apiKey.trim()
    if (!apiKey) {
      await removeSecureValue(secureApiKeyKey(provider.id))
      continue
    }
    if (isMaskedApiKey(apiKey)) continue
    await saveSecureValue(secureApiKeyKey(provider.id), apiKey)
  }
}
