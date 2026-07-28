import { updateLLMConfig } from '@/api/config'
import type { AppConfig, ProviderConfig } from '@/types'
import { logger } from '@/utils/logger'
import { invalidateProviderCatalogSync } from './model-catalog'
import { syncProviderModelCatalogs } from './provider-model-sync'
import {
  invalidateChangedProviderProbeReceipt,
  materializeProviderApiKeys,
  providersToBackend,
} from './settings-helpers'

interface SettingsProviderSyncContext {
  getConfig: () => AppConfig | null
  getRuntimeProviders: () => ProviderConfig[] | null
}

/**
 * 统一协调显式配置保存与后台目录持久化，保证二者共用同一串行队列；
 * 同时集中管理目录 lease 的废止边界，避免 store 主文件承载并发协议细节。
 */
export function createSettingsProviderSync(context: SettingsProviderSyncContext) {
  let persistenceQueue: Promise<void> = Promise.resolve()

  function enqueue(persist: () => Promise<void>): Promise<void> {
    const queued = persistenceQueue.catch(() => undefined).then(persist)
    persistenceQueue = queued
    return queued
  }

  function invalidateTransitions(
    previousProviders: ProviderConfig[],
    nextProviders: ProviderConfig[],
  ) {
    const previousById = new Map(previousProviders.map((provider) => [provider.id, provider]))
    const nextById = new Map(nextProviders.map((provider) => [provider.id, provider]))
    const providerIds = new Set([...previousById.keys(), ...nextById.keys()])
    for (const providerId of providerIds) {
      const previous = previousById.get(providerId)
      const next = nextById.get(providerId)
      invalidateChangedProviderProbeReceipt(previous, next)
      if (previous?.enabled !== next?.enabled) {
        invalidateProviderCatalogSync(providerId)
      }
    }
  }

  function invalidateAll(providers: ProviderConfig[]) {
    for (const provider of providers) invalidateProviderCatalogSync(provider.id)
  }

  function persistSyncedModels() {
    const queued = enqueue(async () => {
      const current = context.getConfig()
      if (!current) return
      const snapshot: AppConfig = JSON.parse(JSON.stringify(current))
      snapshot.llm.providers = await materializeProviderApiKeys(snapshot.llm.providers)
      await updateLLMConfig(
        providersToBackend(
          snapshot.llm.providers,
          snapshot.llm.defaultModel,
          snapshot.llm.defaultProviderId ?? '',
          snapshot.llm.routing,
        ),
      )
    })
    void queued.catch((error) => {
      logger.warn('自动启用的小目录模型持久化失败，将在下次显式保存时重试', error)
    })
  }

  function sync(providers: ProviderConfig[]) {
    syncProviderModelCatalogs(providers, {
      getConfiguredProviders: () => context.getConfig()?.llm.providers ?? [],
      getRuntimeProviders: context.getRuntimeProviders,
      persistChangedProviders: persistSyncedModels,
    })
  }

  return {
    enqueue,
    invalidate: invalidateProviderCatalogSync,
    invalidateAll,
    invalidateTransitions,
    sync,
  }
}
