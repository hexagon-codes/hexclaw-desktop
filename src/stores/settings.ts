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
  syncProviderApiKeys,
  backendToProviders,
  providersToBackend,
  appendLocalProvidersMissingFromRuntime,
  mergeProviderRuntimeIdentities,
  resolveLoadedDefaultSelection,
} from './settings-helpers'
import { CONFIG_STORE_FILE, CONFIG_STORE_KEY, defaultConfig } from './settings-defaults'
import { syncProviderModelCatalogs } from './provider-model-sync'
import { resolveOllamaCapabilities } from '@/config/providers'
import { collectAvailableChatModels, isOllamaProvider } from '@/config/model-contract'

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
  /** 保存队列：保证并发 saveConfig 按调用顺序串行提交，避免旧保存覆盖新状态 */
  let saveConfigQueue: Promise<void> = Promise.resolve()

  /**
   * 小目录同步改变的是已启用模型配置，必须写回后端；直接复用同一保存队列，
   * 但不再次触发目录同步，避免 save → sync → save 的递归回路。
   */
  function persistSyncedProviderModels() {
    const persistJob = async () => {
      if (!config.value) return
      const snapshot: AppConfig = JSON.parse(JSON.stringify(config.value))
      snapshot.llm.providers = await materializeProviderApiKeys(snapshot.llm.providers)
      await updateLLMConfig(
        providersToBackend(
          snapshot.llm.providers,
          snapshot.llm.defaultModel,
          snapshot.llm.defaultProviderId ?? '',
          snapshot.llm.routing,
        ),
      )
    }
    const queuedJob = saveConfigQueue.catch(() => undefined).then(persistJob)
    saveConfigQueue = queuedJob
    void queuedJob.catch((e) => {
      logger.warn('自动启用的小目录模型持久化失败，将在下次显式保存时重试', e)
    })
  }

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
          sandbox: { network_enabled: savedConfig.sandbox?.network_enabled ?? true },
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
  }

  /** 从后端加载 LLM 配置，带重试机制 */
  async function loadLLMFromBackend(maxRetries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const backendConfig = await getLLMConfig()
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
          providerIds: providers.map((provider) => provider.providerInstanceId || provider.backendKey || provider.id),
        })
        runtimeProviders.value = cloneProviders(providers)
        config.value!.llm.providers = providers
        config.value!.llm.routing = {
          enabled: backendConfig.routing.enabled,
          strategy: backendConfig.routing.strategy || 'cost-aware',
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
    }
  }

  /** 保存配置 — LLM 配置保存到后端 API，其余保存到 Tauri Store */
  async function saveConfig(newConfig: AppConfig): Promise<{ securitySyncFailed: boolean }> {
    // 深拷贝去掉 Vue 响应式代理，确保序列化正确
    const plainConfig: AppConfig = JSON.parse(JSON.stringify(newConfig))
    const previousProviders = cloneProviders(config.value?.llm.providers ?? [])
    const previousSecurity = cloneSecurity(syncedSecurity.value)
    const previousSandbox = cloneSandbox(syncedSandbox.value)
    let securitySyncFailed = false

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
      // 前一项排队保存可能刚拿到服务端身份；构造本次 payload 前先吸收，避免并发重命名漂移 key。
      plainConfig.llm.providers = mergeProviderRuntimeIdentities(
        plainConfig.llm.providers,
        [
          ...(runtimeProviders.value ?? []),
          ...(config.value?.llm.providers ?? []),
        ],
      )
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
        logger.debug('LLM 配置已保存到后端', {
          providerCount: Object.keys(backendConfig.providers).length,
          defaultProvider: backendConfig.default,
        })
        const backendSnap = await getLLMConfig()
        const liveAfterSave = await restoreProviderApiKeys(
          backendToProviders(backendSnap, plainConfig.llm.providers),
        )
        const mergedAfterSave = appendLocalProvidersMissingFromRuntime(
          liveAfterSave,
          plainConfig.llm.providers,
        )
        plainConfig.llm.providers = mergeProviderRuntimeIdentities(
          plainConfig.llm.providers,
          mergedAfterSave,
        )
        if (config.value) {
          config.value.llm.providers = mergeProviderRuntimeIdentities(
            config.value.llm.providers,
            mergedAfterSave,
          )
        }
        runtimeProviders.value = cloneProviders(mergedAfterSave)
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
        if (config.value) {
          config.value.security = cloneSecurity(previousSecurity)
          config.value.sandbox = cloneSandbox(previousSandbox)
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
    return { securitySyncFailed }
  }

  function syncAllProviderModels(providers: ProviderConfig[]) {
    syncProviderModelCatalogs(providers, {
      getConfiguredProviders: () => config.value?.llm.providers ?? [],
      getRuntimeProviders: () => runtimeProviders.value,
      persistChangedProviders: persistSyncedProviderModels,
    })
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
      const merged = {
        ...config.value.llm.providers[idx]!,
        ...updates,
      } as ProviderConfig
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
    config.value.llm.providers = config.value.llm.providers.filter((p) => p.id !== id)
    reconcileDefaultSelection(config.value.llm)
  }

  /** 从 Ollama 实时拉取已安装模型，更新 ollamaModelsCache（不持久化，不触发 saveConfig）。 */
  async function syncOllamaModels() {
    try {
      const status = await getOllamaStatus()
      if (!status.running) return
      ollamaModelsCache.value = (status.models || []).map(m => ({
        id: m.name,
        name: m.name,
        // 先查 Ollama preset 白名单（按 base ID 去 tag 匹配），未命中走名称正则推断 vision
        capabilities: resolveOllamaCapabilities(m.name),
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
