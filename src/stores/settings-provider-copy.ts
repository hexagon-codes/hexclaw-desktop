import { cloneModels } from '@/config/model-contract'
import type { ProviderConfig } from '@/types'

export function cloneProviders(providers: ProviderConfig[] = []): ProviderConfig[] {
  return providers.map((provider) => ({
    ...provider,
    models: cloneModels(provider.models),
  }))
}
