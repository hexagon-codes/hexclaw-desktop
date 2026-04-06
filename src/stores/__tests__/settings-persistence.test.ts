import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppConfig, BackendLLMConfig, ProviderConfig } from '@/types'

type AppConfigOverrides = Omit<
  Partial<AppConfig>,
  'llm' | 'security' | 'general' | 'notification' | 'mcp'
> & {
  llm?: Partial<AppConfig['llm']>
  security?: Partial<AppConfig['security']>
  general?: Partial<AppConfig['general']>
  notification?: Partial<AppConfig['notification']>
  mcp?: Partial<AppConfig['mcp']>
}

const { state, mockGetLLMConfig, mockUpdateLLMConfig, mockUpdateConfig } = vi.hoisted(() => ({
  state: {
    savedConfig: null as AppConfig | null,
    secureValues: new Map<string, string>(),
  },
  mockGetLLMConfig: vi.fn(),
  mockUpdateLLMConfig: vi.fn().mockResolvedValue({}),
  mockUpdateConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown) => mockUpdateLLMConfig(config),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: (config: unknown) => mockUpdateConfig(config),
}))

vi.mock('@/utils/secure-store', () => ({
  loadSecureValue: vi.fn(async (key: string) => state.secureValues.get(key) ?? null),
  saveSecureValue: vi.fn(async (key: string, value: string) => {
    state.secureValues.set(key, value)
  }),
  removeSecureValue: vi.fn(async (key: string) => {
    state.secureValues.delete(key)
  }),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return state.savedConfig
    }
    async set(_key: string, value: AppConfig) {
      state.savedConfig = value
    }
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

function makeConfig(overrides?: AppConfigOverrides): AppConfig {
  return {
    llm: {
      providers: [],
      defaultModel: '',
      defaultProviderId: '',
      ...overrides?.llm,
    },
    security: {
      gateway_enabled: true,
      injection_detection: true,
      pii_filter: false,
      content_filter: true,
      max_tokens_per_request: 8192,
      rate_limit_rpm: 60,
      ...overrides?.security,
    },
    general: {
      language: 'zh-CN',
      log_level: 'info',
      data_dir: '',
      auto_start: false,
      defaultAgentRole: 'assistant',
      ...overrides?.general,
    },
    notification: {
      system_enabled: true,
      sound_enabled: false,
      agent_complete: true,
      ...overrides?.notification,
    },
    mcp: {
      default_protocol: 'stdio',
      ...overrides?.mcp,
    },
  }
}

function makeBackendConfig(): BackendLLMConfig {
  return {
    default: 'API Mart',
    providers: {
      'API Mart': {
        api_key: '****key',
        base_url: 'https://api.example.com/v1',
        model: 'claude-sonnet-4-6-test',
        compatible: 'openai',
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }
}

function makeLocalProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'custom-1',
    name: 'API Mart',
    type: 'custom',
    enabled: true,
    apiKey: '',
    baseUrl: 'https://api.example.com/v1',
    models: [
      { id: 'claude-sonnet-4-6-test', name: 'Claude Sonnet 4.6', capabilities: ['text'] },
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
    ],
    selectedModelId: 'claude-sonnet-4-6-test',
    ...overrides,
  }
}

describe('Settings Store persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    state.savedConfig = null
    state.secureValues.clear()
    mockGetLLMConfig.mockReset()
    mockUpdateLLMConfig.mockClear()
    mockUpdateConfig.mockClear()
    ;(globalThis as Record<string, unknown>).isTauri = true
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('保留本地自定义 provider 元数据和多模型列表', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider()],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    state.secureValues.set('llm.provider.custom-1.apiKey', 'sk-live-key')
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.config).not.toBeNull()
    expect(store.config!.llm.defaultModel).toBe('gpt-4o')
    expect(store.config!.llm.defaultProviderId).toBe('custom-1')
    expect(store.config!.llm.providers).toHaveLength(1)

    const provider = store.config!.llm.providers[0]!
    expect(provider.id).toBe('custom-1')
    expect(provider.name).toBe('API Mart')
    expect(provider.type).toBe('custom')
    expect(provider.apiKey).toBe('sk-live-key')
    expect(provider.models.map((model) => model.id)).toEqual([
      'claude-sonnet-4-6-test',
      'gpt-4o',
    ])
  })

  it('保存时用安全存储中的真实 API Key，避免把脱敏值写回后端', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider()],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    state.secureValues.set('llm.provider.custom-1.apiKey', 'sk-live-key')
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.llm.providers[0]!.apiKey = '****key'
    await store.saveConfig(store.config!)

    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(1)
    const backendConfig = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(backendConfig.providers['API Mart']!.api_key).toBe('sk-live-key')
    expect(backendConfig.default).toBe('API Mart')
    expect(state.savedConfig!.llm.providers[0]!.apiKey).toBe('')
    expect(state.savedConfig!.llm.defaultProviderId).toBe('custom-1')
  })

  it('多模型 provider 保存时使用 selectedModelId，而不是模型列表第一项', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider({ selectedModelId: 'gpt-4o' })],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    state.secureValues.set('llm.provider.custom-1.apiKey', 'sk-live-key')
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.llm.providers[0]!.selectedModelId = 'gpt-4o'
    store.config!.llm.defaultModel = 'gpt-4o'

    await store.saveConfig(store.config!)

    const backendConfig = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(backendConfig.providers['API Mart']!.model).toBe('gpt-4o')
  })

  it('保存时携带当前路由策略配置', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider()],
        defaultModel: 'claude-sonnet-4-6-test',
        defaultProviderId: 'custom-1',
        routing: {
          enabled: true,
          strategy: 'quality-first',
        },
      },
    })
    state.secureValues.set('llm.provider.custom-1.apiKey', 'sk-live-key')
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.llm.routing = {
      enabled: true,
      strategy: 'quality-first',
    }

    await store.saveConfig(store.config!)

    const backendConfig = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(backendConfig.routing).toEqual({
      enabled: true,
      strategy: 'quality-first',
    })
  })

  it('没有真实 API Key 时拒绝保存脱敏值，避免污染配置', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider({ backendKey: undefined, apiKey: '****key' })],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    mockGetLLMConfig.mockResolvedValue({
      default: '',
      providers: {},
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    await expect(store.saveConfig(store.config!)).rejects.toThrow('只有脱敏值')
    expect(mockUpdateLLMConfig).not.toHaveBeenCalled()
  })

  it('缺少本地明文 API Key 时，仍可保留后端已有 provider 的脱敏值并保存其他变更', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider({ backendKey: 'API Mart', apiKey: '****key' })],
        defaultModel: 'claude-sonnet-4-6-test',
        defaultProviderId: 'custom-1',
      },
      general: {
        language: 'zh-CN',
      },
    })
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.general.language = 'en'

    await expect(store.saveConfig(store.config!)).resolves.toBeUndefined()

    const backendConfig = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(backendConfig.providers['API Mart']!.api_key).toBe('****key')
  })

  it('拒绝保存重名 provider，避免后端按名称落键时互相覆盖', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [
          makeLocalProvider({ id: 'custom-1', name: 'API Mart' }),
          makeLocalProvider({ id: 'custom-2', name: 'API Mart 2' }),
        ],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    mockGetLLMConfig.mockResolvedValue({
      default: '',
      providers: {},
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    store.config!.llm.providers[1]!.name = 'api mart'

    await expect(store.saveConfig(store.config!)).rejects.toThrow('名称重复')
    expect(mockUpdateLLMConfig).not.toHaveBeenCalled()
  })

  it('删除默认 provider 后会清理失效的 defaultProviderId/defaultModel', async () => {
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider()],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.removeProvider('custom-1')

    expect(store.config!.llm.defaultProviderId).toBe('')
    expect(store.config!.llm.defaultModel).toBe('')
  })
})
