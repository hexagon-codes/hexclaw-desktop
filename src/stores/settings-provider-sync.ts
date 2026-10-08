import { getLLMConfig, updateLLMConfig } from '@/api/config'
import { backendScopeKey } from '@/services/backend-context'
import { messageFromUnknownError } from '@/utils/errors'
import type { AppConfig, BackendLLMConfig, ProviderConfig, ProviderCredentialReplacement } from '@/types'
import { logger } from '@/utils/logger'
import { invalidateProviderCatalogSync } from './model-catalog'
import { syncProviderModelCatalogs } from './provider-model-sync'
import {
  invalidateChangedProviderProbeReceipt,
  materializeProviderApiKeys,
  mergeLLMConfigChanges,
  providerCredentialReplacements,
  providersToBackend,
  withLLMConfigConditions,
} from './settings-helpers'

interface SettingsProviderSyncContext {
  canPersistSyncedModels?: () => boolean
  getConfig: () => AppConfig | null
  getRuntimeProviders: () => ProviderConfig[] | null
  getLLMConfigConditions: () => Pick<BackendLLMConfig, 'config_revision' | 'config_digest'> | null
  getLLMConfigBaseline: () => BackendLLMConfig | null
  recordLLMConfigConditions: (
    receipt: Pick<BackendLLMConfig, 'config_revision' | 'config_digest'> & Partial<BackendLLMConfig>,
  ) => void
  beginModelPersistence?: () => number
  recordPersistedModels?: (commit: {
    scope: string
    sequence: number
    providers: ProviderConfig[]
    submitted: BackendLLMConfig
    persisted: BackendLLMConfig
  }) => void
}

/**
 * 统一协调显式配置保存与后台目录持久化，保证二者共用同一串行队列；
 * 同时集中管理目录 lease 的废止边界，避免 store 主文件承载并发协议细节。
 */
export function createSettingsProviderSync(context: SettingsProviderSyncContext) {
  let persistenceQueue: Promise<void> = Promise.resolve()

  function captureOrigin() {
    const baseline = context.getLLMConfigBaseline()
    return {
      scope: backendScopeKey(),
      baseline: baseline ? JSON.parse(JSON.stringify(baseline)) as BackendLLMConfig : null,
    }
  }

  function isConfigStale(error: unknown) {
    const message = messageFromUnknownError(error)
    if (message === 'LLM configuration is stale') return true
    try {
      const body = JSON.parse(message)
      return body.code === 'LLM_CONFIG_STALE' && body.message === 'LLM configuration is stale'
    } catch { return false }
  }

  async function persistLLMConfig(
    draft: BackendLLMConfig,
    replacements: ProviderCredentialReplacement[],
    origin = captureOrigin(),
    onPersisted?: (payload: BackendLLMConfig) => void,
  ) {
    const assertScope = () => {
      if (backendScopeKey() !== origin.scope) throw new Error('Backend connection changed during configuration save')
    }
    assertScope()
    const latest = context.getLLMConfigBaseline()
    // 设置页不编辑缓存及推理路由，完整写入须保留来源快照中的这些字段。
    let payload = origin.baseline ? { ...origin.baseline, ...draft, cache: origin.baseline.cache } : draft
    if (origin.baseline && latest && origin.baseline.config_digest !== latest.config_digest) {
      if (replacements.length) throw new Error('LLM configuration is stale')
      payload = mergeLLMConfigChanges(origin.baseline, draft, latest)
    }
    const submit = async (value: BackendLLMConfig) => {
      assertScope()
      const receipt = await updateLLMConfig(
        withLLMConfigConditions(value, context.getLLMConfigConditions()), replacements,
      )
      assertScope()
      context.recordLLMConfigConditions({ ...value, ...receipt })
      onPersisted?.(value)
      return receipt
    }
    try {
      return await submit(payload)
    } catch (error) {
      // 只有明确未提交的条件冲突允许读回后提交一次；网络未知不重放。
      if (!isConfigStale(error) || !origin.baseline || replacements.length) throw error
      assertScope()
      const current = await getLLMConfig()
      assertScope()
      context.recordLLMConfigConditions(current)
      payload = mergeLLMConfigChanges(origin.baseline, draft, current)
      return submit(payload)
    }
  }

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
      if (context.canPersistSyncedModels?.() === false) return
      const current = context.getConfig()
      if (!current) return
      const snapshot: AppConfig = JSON.parse(JSON.stringify(current))
      const origin = captureOrigin()
      const sequence = context.beginModelPersistence?.() ?? 0
      snapshot.llm.providers = await materializeProviderApiKeys(snapshot.llm.providers)
      const backendConfig = providersToBackend(
          snapshot.llm.providers,
          snapshot.llm.defaultModel,
          snapshot.llm.defaultProviderId ?? '',
          snapshot.llm.routing,
          snapshot.llm.defaultReasoningPolicy,
      )
      await persistLLMConfig(
        backendConfig,
        providerCredentialReplacements(snapshot.llm.providers),
        origin,
        // 只在真实提交成功后传递本次实际 payload，不以完成时的可变配置代替。
        (persisted) => context.recordPersistedModels?.({
          scope: origin.scope,
          sequence,
          providers: snapshot.llm.providers,
          submitted: backendConfig,
          persisted,
        }),
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
    captureOrigin,
    persistLLMConfig,
    invalidate: invalidateProviderCatalogSync,
    invalidateAll,
    invalidateTransitions,
    sync,
  }
}
