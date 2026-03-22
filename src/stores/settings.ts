import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { logger } from '@/utils/logger'
import { getLLMConfig, updateLLMConfig } from '@/api/config'
import { updateConfig } from '@/api/settings'
import { loadSecureValue, removeSecureValue, saveSecureValue } from '@/utils/secure-store'
import type {
  AppConfig,
  ProviderConfig,
  ApiError,
  ModelCapability,
  ModelOption,
  BackendLLMConfig,
  BackendLLMProvider,
} from '@/types'

/** Tauri Store 中配置的键名 */
const CONFIG_STORE_KEY = 'app_config'

/** Tauri Store 文件名 */
const CONFIG_STORE_FILE = 'config.dat'

/** 默认配置 */
function defaultConfig(): AppConfig {
  return {
    llm: {
      providers: [],
      defaultModel: '',
      defaultProviderId: '',
      routing: {
        enabled: false,
        strategy: 'cost-aware',
      },
    },
    security: {
      gateway_enabled: true,
      injection_detection: true,
      pii_filter: false,
      content_filter: true,
      max_tokens_per_request: 8192,
      rate_limit_rpm: 60,
    },
    general: {
      language: 'zh-CN',
      log_level: 'info',
      data_dir: '',
      auto_start: false,
      defaultAgentRole: 'assistant',
    },
    notification: {
      system_enabled: true,
      sound_enabled: false,
      agent_complete: true,
    },
    mcp: {
      default_protocol: 'stdio',
    },
  }
}

/** 检测是否运行在 Tauri 桌面环境中（与 @tauri-apps/api/core 保持一致） */
function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).isTauri
}

const KNOWN_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'deepseek',
  'qwen',
  'gemini',
  'ark',
  'ollama',
] as const
type KnownProviderType = (typeof KNOWN_PROVIDER_TYPES)[number]

function cloneModels(models: ModelOption[] = []): ModelOption[] {
  return models.map((model) => ({
    ...model,
    capabilities: model.capabilities ?? ['text'],
  }))
}

function cloneProviders(providers: ProviderConfig[] = []): ProviderConfig[] {
  return providers.map((provider) => ({
    ...provider,
    models: cloneModels(provider.models),
  }))
}

function resolveProviderSelectedModelId(
  provider: Pick<ProviderConfig, 'models' | 'selectedModelId'>,
  preferredModelId = '',
): string {
  const trimmedPreferredModelId = preferredModelId.trim()
  if (
    trimmedPreferredModelId &&
    provider.models.some((model) => model.id === trimmedPreferredModelId)
  ) {
    return trimmedPreferredModelId
  }

  const currentSelectedModelId = provider.selectedModelId?.trim() ?? ''
  if (currentSelectedModelId && provider.models.some((model) => model.id === currentSelectedModelId)) {
    return currentSelectedModelId
  }

  return provider.models[0]?.id ?? ''
}

function secureApiKeyKey(providerId: string): string {
  return `llm.provider.${providerId}.apiKey`
}

function normalizeProviderName(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase()
}

function ensureUniqueProviderName(baseName: string, providers: ProviderConfig[]): string {
  const trimmedBaseName = baseName.trim() || 'Provider'
  const usedNames = new Set(
    providers.map((provider) => normalizeProviderName(provider.name)).filter(Boolean),
  )

  if (!usedNames.has(normalizeProviderName(trimmedBaseName))) {
    return trimmedBaseName
  }

  let index = 2
  while (usedNames.has(normalizeProviderName(`${trimmedBaseName} ${index}`))) {
    index += 1
  }
  return `${trimmedBaseName} ${index}`
}

function assertUniqueProviderNames(providers: ProviderConfig[]) {
  const seen = new Map<string, string>()

  for (const provider of providers) {
    const normalizedName = normalizeProviderName(provider.name)
    if (!normalizedName) continue

    const existingName = seen.get(normalizedName)
    if (existingName) {
      throw new Error(`LLM 服务商名称重复：${provider.name}。请为每个服务商使用唯一名称`)
    }
    seen.set(normalizedName, provider.name)
  }
}

function isMaskedApiKey(value: string | undefined | null): boolean {
  return (value ?? '').includes('*')
}

function providerMatchesBackendKey(provider: ProviderConfig, backendKey: string): boolean {
  const normalizedBackendKey = backendKey.trim().toLowerCase()
  return [provider.id, provider.backendKey, provider.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.trim().toLowerCase() === normalizedBackendKey)
}

function mergeProviderModels(
  localProvider: ProviderConfig | undefined,
  backendModelId: string,
): ModelOption[] {
  const localModels = cloneModels(localProvider?.models ?? [])
  const trimmedBackendModelId = backendModelId.trim()

  if (!trimmedBackendModelId) return localModels
  if (localModels.some((model) => model.id === trimmedBackendModelId)) return localModels

  return [
    {
      id: trimmedBackendModelId,
      name: trimmedBackendModelId,
      capabilities: ['text'],
    },
    ...localModels,
  ]
}

function resolveDefaultModelProviderId(
  providers: ProviderConfig[],
  modelId: string,
  preferredProviderId = '',
): string {
  if (!modelId) return ''
  if (preferredProviderId) {
    const exact = providers.find(
      (provider) =>
        provider.id === preferredProviderId &&
        provider.models.some((model) => model.id === modelId),
    )
    if (exact) return exact.id
  }
  return (
    providers.find((provider) => provider.models.some((model) => model.id === modelId))?.id ?? ''
  )
}

function reconcileDefaultSelection(llmConfig: AppConfig['llm']) {
  llmConfig.routing = {
    enabled: llmConfig.routing?.enabled ?? false,
    strategy: llmConfig.routing?.strategy || 'cost-aware',
  }

  for (const provider of llmConfig.providers) {
    provider.selectedModelId = resolveProviderSelectedModelId(
      provider,
      provider.id === llmConfig.defaultProviderId ? llmConfig.defaultModel : '',
    )
  }

  const resolvedProviderId = resolveDefaultModelProviderId(
    llmConfig.providers,
    llmConfig.defaultModel,
    llmConfig.defaultProviderId ?? '',
  )
  llmConfig.defaultProviderId = resolvedProviderId
  if (!resolvedProviderId) {
    llmConfig.defaultModel = ''
    return
  }

  const defaultProvider = llmConfig.providers.find((provider) => provider.id === resolvedProviderId)
  if (!defaultProvider) {
    llmConfig.defaultModel = ''
    llmConfig.defaultProviderId = ''
    return
  }

  defaultProvider.selectedModelId = resolveProviderSelectedModelId(defaultProvider, llmConfig.defaultModel)
  if (!defaultProvider.models.some((model) => model.id === llmConfig.defaultModel)) {
    llmConfig.defaultModel = defaultProvider.selectedModelId
  }
}

async function restoreProviderApiKeys(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const restoredProviders = cloneProviders(providers)

  for (const provider of restoredProviders) {
    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (secureApiKey) {
      provider.apiKey = secureApiKey
    }
  }

  return restoredProviders
}

async function materializeProviderApiKeys(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const normalizedProviders = cloneProviders(providers)

  for (const provider of normalizedProviders) {
    const currentApiKey = provider.apiKey.trim()
    if (!currentApiKey) continue
    if (!isMaskedApiKey(currentApiKey)) continue

    const secureApiKey = await loadSecureValue(secureApiKeyKey(provider.id))
    if (!secureApiKey) {
      if (provider.backendKey?.trim()) {
        // 已存在于后端的 provider 可以继续回传脱敏值，让后端保留旧 Key。
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

async function syncProviderApiKeys(
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

/** 后端格式 -> 桌面格式 */
function backendToProviders(
  backend: BackendLLMConfig,
  localProviders: ProviderConfig[] = [],
): ProviderConfig[] {
  return Object.entries(backend.providers).map(([name, p]) => {
    const localProvider = localProviders.find((provider) =>
      providerMatchesBackendKey(provider, name),
    )
    const lowerName = name.toLowerCase()
    const matchedType = KNOWN_PROVIDER_TYPES.find((t) => lowerName === t || lowerName.startsWith(t))
    const nextProvider: ProviderConfig = {
      id: localProvider?.id ?? name,
      backendKey: name,
      name: localProvider?.name ?? name,
      type: (localProvider?.type ?? matchedType ?? 'custom') as ProviderConfig['type'],
      enabled: true,
      baseUrl: p.base_url || localProvider?.baseUrl || '',
      apiKey: p.api_key || localProvider?.apiKey || '',
      models: mergeProviderModels(localProvider, p.model),
      selectedModelId: '',
    }
    nextProvider.selectedModelId = resolveProviderSelectedModelId(nextProvider, p.model)
    return nextProvider
  })
}

/** 桌面格式 -> 后端格式 */
function providersToBackend(
  providers: ProviderConfig[],
  defaultModel: string,
  defaultProviderId = '',
  routing = { enabled: false, strategy: 'cost-aware' },
): BackendLLMConfig {
  const backendProviders: Record<string, BackendLLMProvider> = {}
  for (const p of providers) {
    if (!p.enabled) continue
    const key = p.backendKey || p.name || p.id
    const selectedModelId = resolveProviderSelectedModelId(
      p,
      p.id === defaultProviderId ? defaultModel : '',
    )
    backendProviders[key] = {
      api_key: p.apiKey || '',
      base_url: p.baseUrl || '',
      model: selectedModelId,
      compatible:
        p.type === 'custom' || !KNOWN_PROVIDER_TYPES.includes(p.type as KnownProviderType)
          ? 'openai'
          : '',
    }
  }
  // Find which provider the default model belongs to
  let defaultProvider = Object.keys(backendProviders)[0] || ''
  const exactDefaultProvider = providers.find(
    (provider) =>
      provider.id === defaultProviderId &&
      provider.enabled &&
      provider.models.some((model) => model.id === defaultModel),
  )
  if (exactDefaultProvider) {
    defaultProvider = exactDefaultProvider.name || exactDefaultProvider.id
  } else {
    for (const [key, val] of Object.entries(backendProviders)) {
      if (val.model === defaultModel) {
        defaultProvider = key
        break
      }
    }
  }
  return {
    default: defaultProvider,
    providers: backendProviders,
    routing: {
      enabled: routing.enabled,
      strategy: routing.strategy || 'cost-aware',
    },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)
  const runtimeProviders = ref<ProviderConfig[] | null>(null)

  /** 所有已启用的 Provider */
  const enabledProviders = computed(() =>
    (runtimeProviders.value ?? config.value?.llm.providers ?? []).filter((p) => p.enabled),
  )

  /** 所有可用模型（来自已启用的 Provider） */
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
      for (const m of p.models) {
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

  /** 加载配置 — 非 LLM 配置从 Tauri Store 读取，LLM 配置从后端 API 读取 */
  async function loadConfig({ force = false } = {}) {
    // 已有 providers 且非强制重载，说明完整配置已就绪，无需重新加载
    if (!force && config.value?.llm.providers.length) {
      return
    }
    // 如果已在加载中，复用已有 Promise
    if (loadConfigPromise) {
      return loadConfigPromise
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

      // 从后端 API 加载 LLM 配置（带重试，等待 sidecar 就绪）
      if (isTauri()) {
        await loadLLMFromBackend()
      }
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
        runtimeProviders.value = cloneProviders(liveProviders)
        const providers = cloneProviders(liveProviders)

        for (const lp of localProviders) {
          if (!providers.some((p) => p.id === lp.id || providerMatchesBackendKey(lp, p.name))) {
            providers.push({
              ...lp,
              models: cloneModels(lp.models),
            })
          }
        }

        logger.debug('转换后的 providers', providers)
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
    runtimeProviders.value = []
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

    await syncProviderApiKeys(plainConfig.llm.providers, previousProviders)

    // LLM 配置保存到后端 API
    if (isTauri()) {
      try {
        const backendConfig = providersToBackend(
          plainConfig.llm.providers,
          plainConfig.llm.defaultModel,
          plainConfig.llm.defaultProviderId ?? '',
          plainConfig.llm.routing,
        )
        await updateLLMConfig(backendConfig)
        logger.debug('LLM 配置已保存到后端', backendConfig)
        runtimeProviders.value = await restoreProviderApiKeys(
          backendToProviders(await getLLMConfig(), plainConfig.llm.providers),
        )
      } catch (e) {
        logger.error('LLM 配置保存到后端失败', e)
        throw e
      }

      // 安全配置同步到后端
      try {
        await updateConfig({ security: plainConfig.security })
        logger.debug('安全配置已同步到后端', plainConfig.security)
      } catch (e) {
        logger.warn('安全配置同步到后端失败（非致命）', e)
      }
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
  }
})
