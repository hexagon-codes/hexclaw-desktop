import type { ProviderConfig } from '@/types'

function normalizedIdentity(value: string | undefined | null): string {
  return (value ?? '').trim().toLocaleLowerCase()
}

export function resolveProviderDisplayName(
  providerIdentity: string | undefined | null,
  providers: ProviderConfig[],
  frozenDisplayName?: string | null,
): string {
  const identity = normalizedIdentity(providerIdentity)
  if (identity) {
    const configured = providers.find((provider) =>
      [provider.providerInstanceId, provider.id, provider.backendKey, provider.name].some(
        (candidate) => normalizedIdentity(candidate) === identity,
      ),
    )
    if (configured?.name?.trim()) return configured.name
  }
  if (frozenDisplayName?.trim()) return frozenDisplayName
  return providerIdentity ?? ''
}
