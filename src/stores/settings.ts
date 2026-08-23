import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { logger } from '@/utils/logger'
import { getLLMConfig, updateLLMConfig } from '@/api/config'
import { getOllamaStatus } from '@/api/ollama'
import { updateConfig } from '@/api/settings'
import { isTauri } from '@/utils/platform'
import type {
  AppConfig,
  ProviderConfig,
  ApiError,
  BackendLLMConfig,
  ModelCapability,
  ModelOption,
  SecurityConfig,
  SandboxConfig,
} from '@/types'
import {
  cloneProviders,
  mergeConfigProvidersWithRuntime,
  resolveProviderSelectedModelId,
  resolveDefaultModelProviderId,
  ensureUniqueProviderName,
  assertUniqueProviderNames,
  reconcileDefaultSelection,
  restoreProviderApiKeys,
  materializeProviderApiKeys,
  providerCredentialReplacements,
  backendToProviders,
  providersToBackend,
  appendLocalProvidersMissingFromRuntime,
  invalidateChangedProviderProbeReceipt,
  mergeProviderRuntimeIdentities,
  resolveLoadedDefaultSelection,
  withLLMConfigConditions,
} from './settings-helpers'
import { CONFIG_STORE_FILE, CONFIG_STORE_KEY, defaultConfig } from './settings-defaults'
import { createSettingsProviderSync } from './settings-provider-sync'
import { PROVIDER_PRESETS } from '@/config/providers'
import { normalizeDefaultReasoningPolicy } from '@/utils/reasoning-policy'
import {
  collectAvailableChatModels,
  isOllamaProvider,
  reasoningControlFromOllamaCapabilities,
  reasoningSupportFromOllamaCapabilities,
} from '@/config/model-contract'

const OLLAMA_STATUS_CAPABILITY_MAP: Record<string, ModelCapability> = {
  completion: 'text',
  vision: 'vision',
  embedding: 'embedding',
}

function staticOllamaCapabilities(modelName: string): ModelCapability[] {
  const normalizedName = modelName.trim()
  const declared = PROVIDER_PRESETS.ollama.defaultModels.find(
    (model) => normalizedName === model.id || normalizedName.startsWith(`${model.id}:`),
  )?.capabilities
  return declared ? [...declared] : []
}

/** 仅把 Ollama 状态接口显式上报的能力映射为模型能力，缺失或未知值保持未分类。 */
function modelCapabilitiesFromOllamaStatus(
  modelName: string,
  capabilities: readonly string[] | undefined,
): ModelCapability[] {
  // 旧版状态缺字段时，只允许命中静态精确声明，不允许按名称模式推断。
  if (capabilities === undefined) return staticOllamaCapabilities(modelName)

  const resolved = new Set<ModelCapability>()
  for (const capability of capabilities) {
    const mapped = OLLAMA_STATUS_CAPABILITY_MAP[capability.trim().toLowerCase()]
    if (mapped) resolved.add(mapped)
  }
  return [
    ...(resolved.has('text') ? ['text' as const] : []),
    ...[...resolved].filter((capability) => capability !== 'text'),
  ]
}

export const useSettingsStore = defineStore('settings', () => {
  const fallbackSandbox = (): SandboxConfig => ({
    network_enabled: defaultConfig().sandbox?.network_enabled ?? true,
  })
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)
  const runtimeProviders = ref<ProviderConfig[] | null>(null)
  const syncedSecurity = ref<SecurityConfig>({ ...defaultConfig().security })
  const syncedSandbox = ref<SandboxConfig>(fallbackSandbox())

  /**
   * Ollama 模型独立缓存 — 不存入 Provider.models，避免 save/reload/reactivity 链问题。
   * 由 syncOllamaModels() 从 Ollama API 实时填充，availableModels 直接读取。
   */
  const ollamaModelsCache = ref<ModelOption[]>([])

  /**
   * 已启用的 Provider 列表。
   * - runtime 未加载（null）：用 config。
   * - runtime 为空数组：用 config（后端失败等场景曾误写 []）。
   * - runtime 非空：与 config 做并集且以 config 的 id/enabled 为准，避免后端快照少一行时丢掉 Ollama。
   */
  const enabledProviders = computed(() => {
    const rp = runtimeProviders.value
    const fromConfig = config.value?.llm.providers ?? []
    if (rp == null) return fromConfig.filter((p) => p.enabled)
    if (rp.length === 0) return fromConfig.filter((p) => p.enabled)
    return mergeConfigProvidersWithRuntime(fromConfig, rp).filter((p) => p.enabled)
  })

  const cloneSecurity = (security: SecurityConfig): SecurityConfig => ({ ...security })
  const cloneSandbox = (sandbox: SandboxConfig): SandboxConfig => ({ ...sandbox })

  /** 所有可用模型（来自已启用的 Provider + Ollama 实时缓存） */
  const availableModels = computed(() =>
    collectAvailableChatModels(enabledProviders.value, ollamaModelsCache.value),
  )

  /** 并发锁：防止 loadConfig 被多次并发调用 */
  let loadConfigPromise: Promise<void> | null = null
  /** 当前加载进行中时，force reload 会挂到这里，避免被静默吞掉 */
  let forceReloadPromise: Promise<void> | null = null
  /** saveConfig 调用版本；旧保存只能提交自己的不可变快照，不能覆盖更新版本的内存状态。 */
  let latestSaveRevision = 0
  /** 最近一次服务端 GET/提交成功的非敏感条件写入快照。 */
  let llmConfigConditions: Pick<BackendLLMConfig, 'config_revision' | 'config_digest'> | null = null

  function recordLLMConfigConditions(
    snapshot?: Pick<BackendLLMConfig, 'config_revision' | 'config_digest'>,
  ) {
    const revision = snapshot?.config_revision
    const digest = snapshot?.config_digest?.trim()
    llmConfigConditions =
      Number.isSafeInteger(revision) && (revision ?? -1) >= 0 && digest
        ? { config_revision: revision, config_digest: digest }
        : null
  }

  const providerSync = createSettingsProviderSync({
    getConfig: () => config.value,
    getRuntimeProviders: () => runtimeProviders.value,
    getLLMConfigConditions: () => llmConfigConditions,
    recordLLMConfigConditions,
  })

  /** 加载配置 — 非 LLM 配置从 Tauri Store 读取，LLM 配置从后端 API 读取 */
  async function loadConfig({ force = false } = {}) {
    // 已有 providers 且非强制重载，说明完整配置已就绪，无需重新加载
    if (!force && config.value?.llm.providers.length) {
      return
    }
    // 如果已在加载中，复用已有 Promise
    if (loadConfigPromise) {
      if (!force) {
        return loadConfigPromise
      }
      if (!forceReloadPromise) {
        forceReloadPromise = loadConfigPromise
          .then(
            async () => {
              await loadConfig({ force: true })
            },
            async () => {
              await loadConfig({ force: true })
            },
          )
          .finally(() => {
            forceReloadPromise = null
          })
      }
      return forceReloadPromise
    }
    // 每次真正开始加载都先废止旧目录请求；force reload 等待后端期间，旧响应也不得落地。
    providerSync.invalidateAll(config.value?.llm.providers ?? [])
    loadConfigPromise = doLoadConfig()
    try {
      await loadConfigPromise
    } finally {
      loadConfigPromise = null
    }
  }

  async function doLoadConfig() {
    loading.value = true
    error.value = null

    try {
      let savedConfig: AppConfig | null = null

      if (isTauri()) {
        try {
          const { LazyStore } = await import('@tauri-apps/plugin-store')
          const store = new LazyStore(CONFIG_STORE_FILE)
          savedConfig = (await store.get<AppConfig>(CONFIG_STORE_KEY)) ?? null
          logger.debug('Tauri Store 配置已读取', {
            providerCount: savedConfig?.llm?.providers?.length ?? 0,
          })
        } catch (e) {
          logger.warn('Tauri Store 读取配置失败', e)
        }
      } else {
        try {
          const raw = localStorage.getItem(CONFIG_STORE_KEY)
          if (raw) savedConfig = JSON.parse(raw)
        } catch {
          // ignore
        }
      }

      // 合并默认值（非 LLM 部分）——保留已有的 LLM 配置，避免切页时短暂清空 providers
      const defaults = defaultConfig()
      const defaultRouting = defaults.llm.routing ?? {
        enabled: false,
        strategy: 'cost-aware',
      }
      const existingLlm = config.value?.llm ?? defaults.llm
      const previousLoadedProviders = cloneProviders(config.value?.llm.providers ?? [])
      const persistedLlm = savedConfig?.llm
        ? {
            providers: cloneProviders(savedConfig.llm.providers ?? []),
            defaultModel: savedConfig.llm.defaultModel ?? '',
            defaultProviderId: savedConfig.llm.defaultProviderId ?? '',
            defaultReasoningPolicy: normalizeDefaultReasoningPolicy(
              savedConfig.llm.defaultReasoningPolicy,
            ),
            routing: {
              enabled: savedConfig.llm.routing?.enabled ?? defaultRouting.enabled,
              strategy: savedConfig.llm.routing?.strategy || defaultRouting.strategy,
            },
          }
        : {
            providers: cloneProviders(existingLlm.providers),
            defaultModel: existingLlm.defaultModel,
            defaultProviderId: existingLlm.defaultProviderId ?? '',
            defaultReasoningPolicy: normalizeDefaultReasoningPolicy(
              existingLlm.defaultReasoningPolicy,
            ),
            routing: {
              enabled: existingLlm.routing?.enabled ?? defaultRouting.enabled,
              strategy: existingLlm.routing?.strategy || defaultRouting.strategy,
            },
          }
      if (savedConfig) {
        config.value = {
          llm: persistedLlm,
          security: { ...defaults.security, ...savedConfig.security },
          general: { ...defaults.general, ...savedConfig.general },
          notification: { ...defaults.notification, ...savedConfig.notification },
          mcp: { ...defaults.mcp, ...savedConfig.mcp },
          memory: { enabled: savedConfig.memory?.enabled ?? defaults.memory?.enabled ?? true },
          sandbox: { network_enabled: savedConfig.sandbox?.network_enabled ?? true },
        }
      } else {
        config.value = { ...defaults, llm: persistedLlm }
      }
      providerSync.invalidateTransitions(previousLoadedProviders, config.value!.llm.providers)

      config.value!.llm.providers = await restoreProviderApiKeys(config.value!.llm.providers)
      config.value!.llm.defaultProviderId = resolveDefaultModelProviderId(
        config.value!.llm.providers,
        config.value!.llm.defaultModel,
        config.value!.llm.defaultProviderId ?? '',
      )
      syncedSecurity.value = cloneSecurity(config.value!.security)
      syncedSandbox.value = cloneSandbox(config.value!.sandbox ?? fallbackSandbox())
      runtimeProviders.value = isTauri()
        ? null
        : cloneProviders(config.value!.llm.providers.filter((provider) => provider.enabled))

      // 从后端 API 加载 LLM 配置。
      // 桌面端等待 sidecar，就绪前允许短暂重试；
      // Web 开发模式只探测一次，避免首次加载被长时间阻塞。
      await loadLLMFromBackend(isTauri() ? 3 : 1, isTauri() ? 2000 : 0)
    } catch (e) {
      logger.error('加载配置失败', e)
      config.value = defaultConfig()
      syncedSecurity.value = cloneSecurity(config.value.security)
      syncedSandbox.value = cloneSandbox(config.value.sandbox ?? fallbackSandbox())
    }

    loading.value = false
    // 目录是可再生缓存：配置可先使用，远程刷新在后台完成。小目录变更走独立保存队列，
    // 不调用 saveConfig，因此不会形成 save → sync → save 递归。
    providerSync.sync(cloneProviders(config.value?.llm.providers ?? []))
  }

  /** 从后端加载 LLM 配置，带重试机制 */
  async function loadLLMFromBackend(maxRetries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const backendConfig = await getLLMConfig()
        recordLLMConfigConditions(backendConfig)
        logger.debug('后端 LLM 配置已读取', {
          providerCount: Object.keys(backendConfig.providers).length,
          defaultProvider: backendConfig.default,
        })
        const localProviders = config.value?.llm.providers ?? []
        const liveProviders = await restoreProviderApiKeys(
          backendToProviders(backendConfig, localProviders),
        )
        const providers = appendLocalProvidersMissingFromRuntime(liveProviders, localProviders)

        logger.debug('Provider 配置已转换', {
          providerCount: providers.length,
          providerIds: providers.map(
            (provider) => provider.providerInstanceId || provider.backendKey || provider.id,
          ),
        })
        providerSync.invalidateTransitions(config.value!.llm.providers, providers)
        runtimeProviders.value = cloneProviders(providers)
        config.value!.llm.providers = providers
        config.value!.llm.routing = {
          enabled: backendConfig.routing.enabled,
          strategy: backendConfig.routing.strategy || 'cost-aware',
        }
        if (backendConfig.default_reasoning_policy !== undefined) {
          config.value!.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(
            backendConfig.default_reasoning_policy,
          )
        } else {
          config.value!.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(
            config.value!.llm.defaultReasoningPolicy,
          )
        }
        const restoredDefault = resolveLoadedDefaultSelection(
          providers,
          backendConfig,
          config.value!.llm.defaultModel,
          config.value!.llm.defaultProviderId ?? '',
        )
        config.value!.llm.defaultModel = restoredDefault.modelId
        config.value!.llm.defaultProviderId = restoredDefault.providerId
        logger.info('LLM 配置加载成功', { providerCount: providers.length })
        return
      } catch (e) {
        logger.warn(`后端 LLM 配置加载失败 (${attempt}/${maxRetries})`, e)
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }
    logger.error('后端 LLM 配置加载最终失败，保留现有 providers')
    // 用 null 而非 []：与 Tauri 初始态一致，enabledProviders 会回退到本地 config；[] 会阻断 ?? 回退导致全站无模型
    runtimeProviders.value = null
    if ((config.value?.llm.providers.length ?? 0) === 0) {
      config.value!.llm.providers = []
      config.value!.llm.defaultModel = ''
      config.value!.llm.defaultProviderId = ''
      config.value!.llm.routing = {
        enabled: config.value!.llm.routing?.enabled ?? false,
        strategy: config.value!.llm.routing?.strategy || 'cost-aware',
      }
      config.value!.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(
        config.value!.llm.defaultReasoningPolicy,
      )
    }
  }

  /** 保存配置 — LLM 配置保存到后端 API，其余保存到 Tauri Store */
  async function saveConfig(newConfig: AppConfig): Promise<{ securitySyncFailed: boolean }> {
    // 深拷贝去掉 Vue 响应式代理，确保序列化正确
    const requestedConfig: AppConfig = JSON.parse(JSON.stringify(newConfig))
    const previousSecurity = cloneSecurity(syncedSecurity.value)
    const previousSandbox = cloneSandbox(syncedSandbox.value)
    const saveRevision = ++latestSaveRevision
    let securitySyncFailed = false

    assertUniqueProviderNames(requestedConfig.llm.providers)
    requestedConfig.llm.defaultProviderId = resolveDefaultModelProviderId(
      requestedConfig.llm.providers,
      requestedConfig.llm.defaultModel,
      requestedConfig.llm.defaultProviderId ?? '',
    )
    requestedConfig.llm.routing = {
      enabled: requestedConfig.llm.routing?.enabled ?? false,
      strategy: requestedConfig.llm.routing?.strategy || 'cost-aware',
    }
    requestedConfig.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(
      requestedConfig.llm.defaultReasoningPolicy,
    )
    reconcileDefaultSelection(requestedConfig.llm)

    // 首个 await 前同步切换到本次调用的快照；之后旧任务不再整体回写 config。
    providerSync.invalidateTransitions(
      config.value?.llm.providers ?? [],
      requestedConfig.llm.providers,
    )
    config.value = JSON.parse(JSON.stringify(requestedConfig))
    const requestedConfigSignature = JSON.stringify(requestedConfig)

    const persistJob = async () => {
      const plainConfig: AppConfig = JSON.parse(JSON.stringify(requestedConfig))
      // 前一项排队保存可能刚拿到服务端身份；构造本次 payload 前先吸收，避免并发重命名漂移 key。
      plainConfig.llm.providers = mergeProviderRuntimeIdentities(plainConfig.llm.providers, [
        ...(runtimeProviders.value ?? []),
        ...(config.value?.llm.providers ?? []),
      ])
      plainConfig.llm.providers = await materializeProviderApiKeys(plainConfig.llm.providers)

      // LLM 配置保存到后端 API
      try {
        const backendConfig = withLLMConfigConditions(
          providersToBackend(
            plainConfig.llm.providers,
            plainConfig.llm.defaultModel,
            plainConfig.llm.defaultProviderId ?? '',
            plainConfig.llm.routing,
            plainConfig.llm.defaultReasoningPolicy,
          ),
          llmConfigConditions,
        )
        const mutation = await updateLLMConfig(
          backendConfig,
          providerCredentialReplacements(plainConfig.llm.providers),
        )
        recordLLMConfigConditions(mutation)
        logger.debug('LLM 配置已保存到后端', {
          providerCount: Object.keys(backendConfig.providers).length,
          defaultProvider: backendConfig.default,
        })
        const backendSnap = await getLLMConfig()
        recordLLMConfigConditions(backendSnap)
        const liveAfterSave = await restoreProviderApiKeys(
          backendToProviders(backendSnap, plainConfig.llm.providers),
        )
        const mergedAfterSave = appendLocalProvidersMissingFromRuntime(
          liveAfterSave,
          plainConfig.llm.providers,
        )
        if (backendSnap.default_reasoning_policy !== undefined) {
          plainConfig.llm.defaultReasoningPolicy = normalizeDefaultReasoningPolicy(
            backendSnap.default_reasoning_policy,
          )
        }
        plainConfig.llm.providers = mergeProviderRuntimeIdentities(
          plainConfig.llm.providers,
          mergedAfterSave,
        )
        const activeStillMatchesRequest =
          saveRevision === latestSaveRevision &&
          JSON.stringify(config.value) === requestedConfigSignature
        if (config.value) {
          config.value.llm.providers = mergeProviderRuntimeIdentities(
            config.value.llm.providers,
            mergedAfterSave,
          )
        }
        if (activeStillMatchesRequest) {
          runtimeProviders.value = cloneProviders(mergedAfterSave)
        }
      } catch (e) {
        logger.error('LLM 配置保存到后端失败', e)
        if (isTauri()) {
          throw e
        }
      }

      let liveConfigForPersistence = plainConfig

      // 安全配置 + 沙箱配置同步到后端
      try {
        await updateConfig({
          security: plainConfig.security,
          sandbox: plainConfig.sandbox,
        })
        logger.debug('安全/沙箱配置已同步到后端', plainConfig.security, plainConfig.sandbox)
        syncedSecurity.value = cloneSecurity(plainConfig.security)
        syncedSandbox.value = cloneSandbox(plainConfig.sandbox ?? fallbackSandbox())
      } catch (e) {
        securitySyncFailed = true
        logger.warn('安全/沙箱配置同步到后端失败，已回滚本地状态', e)
        liveConfigForPersistence = {
          ...plainConfig,
          security: cloneSecurity(previousSecurity),
          sandbox: cloneSandbox(previousSandbox),
        }
        if (config.value && saveRevision === latestSaveRevision) {
          if (JSON.stringify(config.value.security) === JSON.stringify(requestedConfig.security)) {
            config.value.security = cloneSecurity(previousSecurity)
          }
          if (JSON.stringify(config.value.sandbox) === JSON.stringify(requestedConfig.sandbox)) {
            config.value.sandbox = cloneSandbox(previousSandbox)
          }
        }
      }

      // 非 LLM 配置保存到 Tauri Store
      // API Key 统一走 secure-store，配置副本里不落明文
      const configToSave: AppConfig = {
        ...liveConfigForPersistence,
        llm: {
          providers: plainConfig.llm.providers.map((p) => ({
            ...p,
            apiKey: '',
          })),
          defaultModel: plainConfig.llm.defaultModel,
          defaultProviderId: plainConfig.llm.defaultProviderId ?? '',
          defaultReasoningPolicy: normalizeDefaultReasoningPolicy(
            plainConfig.llm.defaultReasoningPolicy,
          ),
          routing: plainConfig.llm.routing,
        },
      }

      if (isTauri()) {
        try {
          const { LazyStore } = await import('@tauri-apps/plugin-store')
          const store = new LazyStore(CONFIG_STORE_FILE)
          await store.set(CONFIG_STORE_KEY, configToSave)
          await store.save()
          logger.debug('非 LLM 配置已保存到 Tauri Store', configToSave)
        } catch (e) {
          logger.warn('Tauri Store 保存失败，降级到 localStorage', e)
          localStorage.setItem(CONFIG_STORE_KEY, JSON.stringify(configToSave))
        }
      } else {
        localStorage.setItem(CONFIG_STORE_KEY, JSON.stringify(configToSave))
      }

      // 保存后异步拉取远程模型列表（不阻塞保存，失败静默）
      providerSync.sync(plainConfig.llm.providers)
    }

    const queuedJob = providerSync.enqueue(persistJob)
    await queuedJob
    return { securitySyncFailed }
  }

  /** 添加 Provider */
  function addProvider(provider: Omit<ProviderConfig, 'id'>) {
    if (!config.value) return null
    const newProvider: ProviderConfig = {
      ...provider,
      locality: provider.locality ?? (provider.type === 'ollama' ? 'local' : 'auto'),
      localitySource: provider.localitySource ?? 'system',
      name: ensureUniqueProviderName(provider.name, config.value.llm.providers),
      id: nanoid(10),
    }
    newProvider.selectedModelId = resolveProviderSelectedModelId(newProvider)
    config.value.llm.providers.push(newProvider)
    if (!config.value.llm.defaultProviderId && newProvider.selectedModelId) {
      config.value.llm.defaultProviderId = newProvider.id
      config.value.llm.defaultModel = newProvider.selectedModelId
    }
    reconcileDefaultSelection(config.value.llm)
    return newProvider
  }

  /** 更新 Provider */
  function updateProvider(id: string, updates: Partial<ProviderConfig>) {
    if (!config.value) return
    const idx = config.value.llm.providers.findIndex((p) => p.id === id)
    if (idx !== -1) {
      const previous = config.value.llm.providers[idx]!
      const merged = {
        ...previous,
        ...updates,
      } as ProviderConfig
      invalidateChangedProviderProbeReceipt(previous, merged)
      if (previous.enabled !== merged.enabled) {
        providerSync.invalidate(id)
      }
      config.value.llm.providers[idx] = merged
      // 切换默认 Provider 的当前模型 = 切换全局默认模型。
      // 不同步的话 reconcileDefaultSelection 会用旧的 defaultModel 把选择改回去。
      if (
        updates.selectedModelId &&
        id === config.value.llm.defaultProviderId &&
        merged.models.some((m) => m.id === updates.selectedModelId)
      ) {
        config.value.llm.defaultModel = updates.selectedModelId
      }
      reconcileDefaultSelection(config.value.llm)
    }
  }

  /** 删除 Provider */
  function removeProvider(id: string) {
    if (!config.value) return
    providerSync.invalidate(id)
    config.value.llm.providers = config.value.llm.providers.filter((p) => p.id !== id)
    reconcileDefaultSelection(config.value.llm)
  }

  /** 从 Ollama 实时拉取已安装模型，更新 ollamaModelsCache（不持久化，不触发 saveConfig）。 */
  async function syncOllamaModels() {
    try {
      const status = await getOllamaStatus()
      if (!status.running) return
      ollamaModelsCache.value = (status.models || []).map((m) => ({
        id: m.name,
        name: m.name,
        // 只接受 Ollama 状态接口的显式能力，不能从模型名推断视觉或其他模态。
        capabilities: modelCapabilitiesFromOllamaStatus(m.name, m.capabilities),
        reasoningSupport: reasoningSupportFromOllamaCapabilities(m.capabilities),
        reasoningControl: reasoningControlFromOllamaCapabilities(m.capabilities),
      }))
    } catch {
      /* Ollama 可能未运行 */
    }
  }

  // runtimeProviders 变化时（包括 loadConfig force reload），自动刷新 Ollama 模型缓存。
  // 无论用户在哪个页面，缓存始终与 Ollama 实际状态同步。
  watch(runtimeProviders, (providers) => {
    if (providers?.some(isOllamaProvider)) {
      syncOllamaModels()
    }
  })

  return {
    config,
    loading,
    error,
    runtimeProviders,
    enabledProviders,
    availableModels,
    loadConfig,
    saveConfig,
    addProvider,
    updateProvider,
    removeProvider,
    syncOllamaModels,
  }
})
