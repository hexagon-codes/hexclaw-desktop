import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { logger } from '@/utils/logger'
import { getLLMConfig, updateLLMConfig, fetchProviderModels } from '@/api/config'
import { getOllamaStatus } from '@/api/ollama'
import { updateConfig } from '@/api/settings'
import { isTauri } from '@/utils/platform'
import type {
  AppConfig,
  ProviderConfig,
  ApiError,
  ModelCapability,
  ModelOption,
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
  syncProviderApiKeys,
  backendToProviders,
  providersToBackend,
  appendLocalProvidersMissingFromRuntime,
  providerMatchesBackendKey,
} from './settings-helpers'
import { CONFIG_STORE_FILE, CONFIG_STORE_KEY, defaultConfig } from './settings-defaults'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)
  const runtimeProviders = ref<ProviderConfig[] | null>(null)

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

  const isOllamaProvider = (p: ProviderConfig) =>
    p.type === 'ollama' ||
    p.backendKey?.toLowerCase().includes('ollama') ||
    p.name?.toLowerCase().includes('ollama')

  /** 所有可用模型（来自已启用的 Provider + Ollama 实时缓存） */
  const availableModels = computed(() => {
    const models: {
      providerId: string
      providerKey: string
      providerName: string
      modelId: string
      modelName: string
      capabilities: ModelCapability[]
    }[] = []
    for (const p of enabledProviders.value) {
      // Ollama Provider 用独立缓存，不依赖 Provider.models
      const modelList = isOllamaProvider(p) ? ollamaModelsCache.value : p.models
      for (const m of modelList) {
        models.push({
          providerId: p.id,
          providerKey: p.backendKey || p.name || p.id,
          providerName: p.name,
          modelId: m.id,
          modelName: m.name,
          capabilities: m.capabilities ?? ['text'],
        })
      }
    }
    return models
  })

  /** 并发锁：防止 loadConfig 被多次并发调用 */
  let loadConfigPromise: Promise<void> | null = null
  /** 当前加载进行中时，force reload 会挂到这里，避免被静默吞掉 */
  let forceReloadPromise: Promise<void> | null = null
  /** 保存队列：保证并发 saveConfig 按调用顺序串行提交，避免旧保存覆盖新状态 */
  let saveConfigQueue: Promise<void> = Promise.resolve()

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
          logger.debug('Tauri Store 读取配置:', savedConfig)
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
      const persistedLlm = savedConfig?.llm
        ? {
            providers: cloneProviders(savedConfig.llm.providers ?? []),
            defaultModel: savedConfig.llm.defaultModel ?? '',
            defaultProviderId: savedConfig.llm.defaultProviderId ?? '',
            routing: {
              enabled: savedConfig.llm.routing?.enabled ?? defaultRouting.enabled,
              strategy: savedConfig.llm.routing?.strategy || defaultRouting.strategy,
            },
          }
        : {
            providers: cloneProviders(existingLlm.providers),
            defaultModel: existingLlm.defaultModel,
            defaultProviderId: existingLlm.defaultProviderId ?? '',
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
        }
      } else {
        config.value = { ...defaults, llm: persistedLlm }
      }

      config.value!.llm.providers = await restoreProviderApiKeys(config.value!.llm.providers)
      config.value!.llm.defaultProviderId = resolveDefaultModelProviderId(
        config.value!.llm.providers,
        config.value!.llm.defaultModel,
        config.value!.llm.defaultProviderId ?? '',
      )
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
    }

    loading.value = false
  }

  /** 从后端加载 LLM 配置，带重试机制 */
  async function loadLLMFromBackend(maxRetries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const backendConfig = await getLLMConfig()
        logger.debug('后端 LLM 配置原始数据', backendConfig)
        const localProviders = config.value?.llm.providers ?? []
        const liveProviders = await restoreProviderApiKeys(
          backendToProviders(backendConfig, localProviders),
        )
        const providers = appendLocalProvidersMissingFromRuntime(liveProviders, localProviders)

        logger.debug('转换后的 providers', providers)
        runtimeProviders.value = cloneProviders(providers)
        config.value!.llm.providers = providers
        config.value!.llm.routing = {
          enabled: backendConfig.routing.enabled,
          strategy: backendConfig.routing.strategy || 'cost-aware',
        }
        const persistedDefaultModel = config.value!.llm.defaultModel
        const persistedDefaultProviderId = config.value!.llm.defaultProviderId ?? ''
        const backendDefaultModel = backendConfig.default
          ? backendConfig.providers[backendConfig.default]?.model || ''
          : ''
        const backendDefaultProviderId = backendConfig.default
          ? providers.find((provider) => providerMatchesBackendKey(provider, backendConfig.default))
              ?.id || ''
          : ''
        const hasPersistedDefaultModel = providers.some(
          (provider) =>
            provider.id === persistedDefaultProviderId &&
            provider.models.some((model) => model.id === persistedDefaultModel),
        )
        const hasBackendDefaultModel = providers.some(
          (provider) =>
            provider.id === backendDefaultProviderId &&
            provider.models.some((model) => model.id === backendDefaultModel),
        )
        config.value!.llm.defaultModel = hasPersistedDefaultModel
          ? persistedDefaultModel
          : hasBackendDefaultModel
            ? backendDefaultModel
            : ''
        config.value!.llm.defaultProviderId = hasPersistedDefaultModel
          ? persistedDefaultProviderId
          : hasBackendDefaultModel
            ? backendDefaultProviderId
            : ''
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
    }
  }

  /** 保存配置 — LLM 配置保存到后端 API，其余保存到 Tauri Store */
  async function saveConfig(newConfig: AppConfig) {
    // 深拷贝去掉 Vue 响应式代理，确保序列化正确
    const plainConfig: AppConfig = JSON.parse(JSON.stringify(newConfig))
    const previousProviders = cloneProviders(config.value?.llm.providers ?? [])

    assertUniqueProviderNames(plainConfig.llm.providers)
    plainConfig.llm.providers = await materializeProviderApiKeys(plainConfig.llm.providers)
    plainConfig.llm.defaultProviderId = resolveDefaultModelProviderId(
      plainConfig.llm.providers,
      plainConfig.llm.defaultModel,
      plainConfig.llm.defaultProviderId ?? '',
    )
    plainConfig.llm.routing = {
      enabled: plainConfig.llm.routing?.enabled ?? false,
      strategy: plainConfig.llm.routing?.strategy || 'cost-aware',
    }
    reconcileDefaultSelection(plainConfig.llm)

    // 先更新本地状态，确保 UI 不会因为异步操作延迟而丢失响应性
    config.value = plainConfig

    const persistJob = async () => {
      await syncProviderApiKeys(plainConfig.llm.providers, previousProviders)

      // LLM 配置保存到后端 API
      try {
        const backendConfig = providersToBackend(
          plainConfig.llm.providers,
          plainConfig.llm.defaultModel,
          plainConfig.llm.defaultProviderId ?? '',
          plainConfig.llm.routing,
        )
        await updateLLMConfig(backendConfig)
        logger.debug('LLM 配置已保存到后端', backendConfig)
        const backendSnap = await getLLMConfig()
        const liveAfterSave = await restoreProviderApiKeys(
          backendToProviders(backendSnap, plainConfig.llm.providers),
        )
        const mergedAfterSave = appendLocalProvidersMissingFromRuntime(
          liveAfterSave,
          plainConfig.llm.providers,
        )
        runtimeProviders.value = cloneProviders(mergedAfterSave)
      } catch (e) {
        logger.error('LLM 配置保存到后端失败', e)
        if (isTauri()) {
          throw e
        }
      }

      // 安全配置同步到后端
      try {
        await updateConfig({ security: plainConfig.security })
        logger.debug('安全配置已同步到后端', plainConfig.security)
      } catch (e) {
        logger.warn('安全配置同步到后端失败（非致命）', e)
      }

      // 非 LLM 配置保存到 Tauri Store
      // API Key 统一走 secure-store，配置副本里不落明文
      const configToSave: AppConfig = {
        ...plainConfig,
        llm: {
          providers: plainConfig.llm.providers.map((p) => ({
            ...p,
            apiKey: '',
          })),
          defaultModel: plainConfig.llm.defaultModel,
          defaultProviderId: plainConfig.llm.defaultProviderId ?? '',
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
      syncAllProviderModels(plainConfig.llm.providers)
    }

    const queuedJob = saveConfigQueue.catch(() => undefined).then(persistJob)
    saveConfigQueue = queuedJob
    await queuedJob
  }

  /** 保存后异步拉取每个云端 Provider 的模型列表（fire-and-forget） */
  function syncAllProviderModels(providers: ProviderConfig[]) {
    for (const p of providers) {
      if (!p.enabled || !p.apiKey?.trim() || p.type === 'ollama') continue
      const baseUrl = p.baseUrl?.trim()
      if (!baseUrl) continue
      fetchProviderModels(baseUrl, p.apiKey).then((remoteModels) => {
        if (!remoteModels.length || !config.value) return
        const target = config.value.llm.providers.find((cp) => cp.id === p.id)
        if (!target) return
        const existingMap = new Map(target.models.map((m) => [m.id, m]))
        for (const rm of remoteModels) {
          if (!existingMap.has(rm.id)) {
            target.models.push({ id: rm.id, name: rm.name || rm.id, capabilities: ['text'] })
          }
        }
        logger.debug('自动拉取模型列表完成', p.name, remoteModels.length)
      }).catch(() => {
        // 静默失败，兜底模型已可用
      })
    }
  }

  /** 添加 Provider */
  function addProvider(provider: Omit<ProviderConfig, 'id'>) {
    if (!config.value) return null
    const newProvider: ProviderConfig = {
      ...provider,
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
      config.value.llm.providers[idx] = {
        ...config.value.llm.providers[idx]!,
        ...updates,
      } as ProviderConfig
      reconcileDefaultSelection(config.value.llm)
    }
  }

  /** 删除 Provider */
  function removeProvider(id: string) {
    if (!config.value) return
    config.value.llm.providers = config.value.llm.providers.filter((p) => p.id !== id)
    reconcileDefaultSelection(config.value.llm)
  }

  /**
   * 同步 Ollama Provider 的模型列表与 Ollama 实际已下载模型
   * 下载/删除模型后调用，确保 Provider 模型列表与 Ollama 一致
   */
  /**
   * 从 Ollama 实际已安装模型同步到 Provider 模型列表（仅内存更新，不持久化）
   *
   * 不调 saveConfig — 避免 save→reload→reset 循环。
   * 模型列表来自 Ollama 实时状态，每次 detect()/refreshModels() 都会刷新，无需持久化。
   */
  /**
   * 从 Ollama 实时拉取已安装模型，更新独立缓存 ollamaModelsCache。
   * availableModels computed 直接读取此缓存，完全绕开 Provider.models 的配置链。
   * 每次调用都是一次 ref 赋值 → Vue 响应式 100% 可靠。
   */
  async function syncOllamaModels() {
    try {
      const status = await getOllamaStatus()
      if (!status.running) return
      ollamaModelsCache.value = (status.models || []).map(m => ({
        id: m.name,
        name: m.name,
        capabilities: ['text'] as ModelCapability[],
      }))
    } catch { /* Ollama 可能未运行 */ }
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
