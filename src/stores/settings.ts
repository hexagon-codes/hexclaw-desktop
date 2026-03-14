import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { logger } from '@/utils/logger'
import { getLLMConfig, updateLLMConfig } from '@/api/config'
import type { AppConfig, ProviderConfig, ApiError, ModelCapability, BackendLLMConfig, BackendLLMProvider } from '@/types'

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

/** 检测是否运行在 Tauri 桌面环境中 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

/** 后端格式 -> 桌面格式 */
function backendToProviders(backend: BackendLLMConfig): ProviderConfig[] {
  return Object.entries(backend.providers).map(([name, p]) => ({
    id: name,
    name: name,
    type: (p.compatible === 'openai' ? 'custom' : name) as ProviderConfig['type'],
    enabled: true,
    baseUrl: p.base_url || '',
    apiKey: p.api_key || '',
    models: [{ id: p.model, name: p.model, capabilities: ['text'] as ModelCapability[] }],
  }))
}

/** 桌面格式 -> 后端格式 */
function providersToBackend(providers: ProviderConfig[], defaultModel: string): BackendLLMConfig {
  const backendProviders: Record<string, BackendLLMProvider> = {}
  for (const p of providers) {
    if (!p.enabled) continue
    const key = p.id || p.name
    backendProviders[key] = {
      api_key: p.apiKey || '',
      base_url: p.baseUrl || '',
      model: p.models?.[0]?.id || '',
      compatible: p.type === 'custom' || !['openai', 'anthropic', 'deepseek', 'qwen', 'gemini', 'ollama'].includes(p.type)
        ? 'openai'
        : '',
    }
  }
  // Find which provider the default model belongs to
  let defaultProvider = Object.keys(backendProviders)[0] || ''
  for (const [key, val] of Object.entries(backendProviders)) {
    if (val.model === defaultModel) {
      defaultProvider = key
      break
    }
  }
  return {
    default: defaultProvider,
    providers: backendProviders,
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppConfig | null>(null)
  const loading = ref(false)
  const error = ref<ApiError | null>(null)

  /** 所有已启用的 Provider */
  const enabledProviders = computed(() =>
    config.value?.llm.providers.filter((p) => p.enabled) ?? [],
  )

  /** 所有可用模型（来自已启用的 Provider） */
  const availableModels = computed(() => {
    const models: { providerId: string; providerName: string; modelId: string; modelName: string; capabilities: ModelCapability[] }[] = []
    for (const p of enabledProviders.value) {
      for (const m of p.models) {
        models.push({
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          modelName: m.name,
          capabilities: m.capabilities ?? ['text'],
        })
      }
    }
    return models
  })

  /** 加载配置 — 非 LLM 配置从 Tauri Store 读取，LLM 配置从后端 API 读取 */
  async function loadConfig() {
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

      // 合并默认值（非 LLM 部分）
      const defaults = defaultConfig()
      if (savedConfig) {
        config.value = {
          llm: {
            providers: defaults.llm.providers,
            defaultModel: defaults.llm.defaultModel,
          },
          security: { ...defaults.security, ...savedConfig.security },
          general: { ...defaults.general, ...savedConfig.general },
          notification: { ...defaults.notification, ...savedConfig.notification },
          mcp: { ...defaults.mcp, ...savedConfig.mcp },
        }
      } else {
        config.value = defaults
      }

      // 从后端 API 加载 LLM 配置
      if (isTauri()) {
        try {
          const backendConfig = await getLLMConfig()
          logger.debug('后端 LLM 配置:', backendConfig)
          const providers = backendToProviders(backendConfig)
          config.value.llm.providers = providers
          config.value.llm.defaultModel = backendConfig.default
            ? (backendConfig.providers[backendConfig.default]?.model || '')
            : ''
        } catch (e) {
          logger.warn('后端 LLM 配置加载失败，使用空 providers', e)
          config.value.llm.providers = []
          config.value.llm.defaultModel = ''
        }
      }
    } catch (e) {
      logger.error('加载配置失败', e)
      config.value = defaultConfig()
    }

    loading.value = false
  }

  /** 保存配置 — LLM 配置保存到后端 API，其余保存到 Tauri Store */
  async function saveConfig(newConfig: AppConfig) {
    // 深拷贝去掉 Vue 响应式代理，确保序列化正确
    const plainConfig: AppConfig = JSON.parse(JSON.stringify(newConfig))

    // LLM 配置保存到后端 API
    if (isTauri()) {
      try {
        const backendConfig = providersToBackend(plainConfig.llm.providers, plainConfig.llm.defaultModel)
        await updateLLMConfig(backendConfig)
        logger.debug('LLM 配置已保存到后端', backendConfig)
      } catch (e) {
        logger.error('LLM 配置保存到后端失败', e)
        throw e
      }
    }

    // 非 LLM 配置保存到 Tauri Store（不含 LLM providers/apiKey）
    const configToSave: AppConfig = {
      ...plainConfig,
      llm: {
        providers: [],
        defaultModel: '',
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

    config.value = plainConfig
  }

  /** 添加 Provider */
  function addProvider(provider: Omit<ProviderConfig, 'id'>) {
    if (!config.value) return
    const newProvider: ProviderConfig = {
      ...provider,
      id: nanoid(10),
    }
    config.value.llm.providers.push(newProvider)
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
    }
  }

  /** 删除 Provider */
  function removeProvider(id: string) {
    if (!config.value) return
    config.value.llm.providers = config.value.llm.providers.filter((p) => p.id !== id)
  }

  return {
    config,
    loading,
    error,
    enabledProviders,
    availableModels,
    loadConfig,
    saveConfig,
    addProvider,
    updateProvider,
    removeProvider,
  }
})
