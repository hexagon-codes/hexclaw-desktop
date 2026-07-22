import { fetchProviderModels } from '@/api/config'
import { PROVIDER_PRESETS } from '@/config/providers'
import type { ProviderConfig } from '@/types'
import { logger } from '@/utils/logger'
import { cloneProviders } from './settings-helpers'
import {
  beginProviderCatalogSync,
  reconcileProviderCatalog,
  useModelCatalogStore,
} from './model-catalog'

interface ProviderModelSyncContext {
  getConfiguredProviders: () => ProviderConfig[]
  getRuntimeProviders: () => ProviderConfig[] | null
  persistChangedProviders: () => void
}

/**
 * Refresh remote model catalogs without blocking configuration saves.
 * The lease prevents a response from an older provider identity/endpoint overwriting newer state.
 */
export function syncProviderModelCatalogs(
  providers: ProviderConfig[],
  context: ProviderModelSyncContext,
) {
  const catalogStore = useModelCatalogStore()
  for (const provider of providers) {
    if (
      !provider.enabled ||
      (!provider.apiKey?.trim() && !provider.providerInstanceId) ||
      provider.type === 'ollama'
    ) continue
    const baseUrl = provider.baseUrl?.trim()
    if (!baseUrl && !provider.providerInstanceId) continue

    const syncLease = beginProviderCatalogSync(provider, baseUrl)
    void fetchProviderModels(baseUrl, provider.apiKey, {
      providerType: provider.type,
      providerInstanceId: provider.providerInstanceId,
      locality: provider.locality,
      privateNetworkAccess: provider.privateNetworkAccess,
    }).then((remoteModels) => {
      if (!remoteModels.length) return
      const target = context.getConfiguredProviders().find((candidate) => candidate.id === provider.id)
      if (!target) return
      if (!syncLease.isCurrent(target, target.baseUrl?.trim() ?? '')) {
        logger.debug('忽略已过期的模型目录同步响应', provider.name)
        return
      }

      catalogStore.setCatalog(target.id, remoteModels)
      const result = reconcileProviderCatalog(
        target,
        remoteModels,
        PROVIDER_PRESETS[provider.type]?.defaultModels ?? [],
      )
      if (result.changed) {
        const runtimeTarget = context.getRuntimeProviders()?.find(
          (candidate) =>
            candidate.id === target.id ||
            Boolean(
              target.providerInstanceId &&
              candidate.providerInstanceId === target.providerInstanceId,
            ),
        )
        if (runtimeTarget) {
          runtimeTarget.models = cloneProviders([target])[0]!.models
          runtimeTarget.selectedModelId = target.selectedModelId
        }
        context.persistChangedProviders()
      }
      logger.debug(
        result.managed ? '目录已同步（大目录，不自动启用）' : '自动拉取模型列表完成',
        provider.name,
        remoteModels.length,
      )
    }).catch(() => {
      // Background refresh failure leaves the last known model configuration intact.
    })
  }
}
