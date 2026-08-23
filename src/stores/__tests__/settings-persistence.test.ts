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

const { state, mockGetLLMConfig, mockUpdateLLMConfig, mockUpdateConfig, mockLogger } = vi.hoisted(
  () => ({
    state: {
      savedConfig: null as AppConfig | null,
      secureValues: new Map<string, string>(),
      loadSecureValueHook: null as null | ((key: string) => Promise<string | null>),
    },
    mockGetLLMConfig: vi.fn(),
    mockUpdateLLMConfig: vi.fn().mockResolvedValue({}),
    mockUpdateConfig: vi.fn().mockResolvedValue({}),
    mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
)

vi.mock('@/utils/logger', () => ({ logger: mockLogger }))

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown, replacements: unknown) =>
    mockUpdateLLMConfig(config, replacements),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: (config: unknown) => mockUpdateConfig(config),
}))

vi.mock('@/utils/secure-store', () => ({
  credentialRefFor: (key: { ownerKind: string; ownerId: string; secretKind: string }) =>
    key.ownerKind === 'provider'
      ? `llm_provider/${key.ownerId}/api_key`
      : `sidecar-connection:v1:${key.ownerId}:${key.secretKind}`,
  credentialPresent: vi.fn().mockResolvedValue(true),
  loadSecureValue: vi.fn(async (key: string) => {
    if (state.loadSecureValueHook) return state.loadSecureValueHook(key)
    return state.secureValues.get(key) ?? null
  }),
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
    memory: {
      enabled: true,
      ...overrides?.memory,
    },
    sandbox: {
      network_enabled: true,
      ...overrides?.sandbox,
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

function emptyBackendConfig(): BackendLLMConfig {
  return {
    default: '',
    providers: {},
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
    state.loadSecureValueHook = null
    mockGetLLMConfig.mockReset()
    mockUpdateLLMConfig.mockClear()
    mockUpdateConfig.mockClear()
    for (const method of Object.values(mockLogger)) method.mockClear()
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
    expect(provider.apiKey).toBe('****key')
    expect(provider.models.map((model) => model.id)).toEqual(['claude-sonnet-4-6-test', 'gpt-4o'])
  })

  it('保存脱敏 provider 时只提交 preserve mutation，不把明文或掩码写入配置', async () => {
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
    expect(backendConfig.providers['API Mart']).not.toHaveProperty('api_key')
    expect(backendConfig.providers['API Mart']!.api_key_mutation).toEqual({ mode: 'preserve' })
    expect(mockUpdateLLMConfig.mock.calls[0]![1]).toEqual([])
    expect(backendConfig.default).toBe('API Mart')
    expect(state.savedConfig!.llm.providers[0]!.apiKey).toBe('')
    expect(state.savedConfig!.llm.defaultProviderId).toBe('custom-1')
  })

  it('does not persist the server-owned provider probe receipt into the Tauri store', async () => {
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
    store.config!.llm.providers[0]!.probeReceipt = {
      providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
      outcome: 'passed',
      testedAt: Date.UTC(2026, 6, 28, 6, 20),
      latencyMs: 321,
      locality: 'cloud',
    }

    await store.saveConfig(store.config!)

    expect(state.savedConfig!.llm.providers[0]!.probeReceipt).toBeUndefined()
  })

  it('never includes restored or submitted API keys in logger arguments', async () => {
    const secret = 'sk-secret-must-never-enter-logs'
    state.savedConfig = makeConfig({
      llm: {
        providers: [makeLocalProvider()],
        defaultModel: 'gpt-4o',
        defaultProviderId: 'custom-1',
      },
    })
    state.secureValues.set('llm.provider.custom-1.apiKey', secret)
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    store.config!.llm.providers[0]!.apiKey = secret
    await store.saveConfig(store.config!)

    const logText = JSON.stringify(Object.values(mockLogger).flatMap((method) => method.mock.calls))
    expect(logText).not.toContain(secret)
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

  it('新 provider 首次保存后回灌服务端身份，重命名再次保存不漂移 backend key', async () => {
    const canonicalBackendKey = 'OpenRouter Primary'
    const serverProviderId = 'pvd_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const backendAfterCreate: BackendLLMConfig = {
      default: canonicalBackendKey,
      providers: {
        [canonicalBackendKey]: {
          provider_instance_id: serverProviderId,
          api_key: '****key',
          base_url: 'https://openrouter.ai/api/v1',
          model: 'chat-model',
          models: ['chat-model'],
          model_specs_mode: 'explicit',
          model_specs: [{ id: 'chat-model', display_name: 'Chat Model', capabilities: ['text'] }],
          compatible: 'openai',
          locality: 'cloud',
          enabled: true,
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    }
    mockGetLLMConfig
      .mockResolvedValueOnce(emptyBackendConfig())
      .mockResolvedValueOnce(backendAfterCreate)
      .mockResolvedValueOnce(backendAfterCreate)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    const created = store.addProvider({
      name: canonicalBackendKey,
      type: 'custom',
      enabled: true,
      apiKey: 'sk-live-new-provider',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'chat-model', name: 'Chat Model', capabilities: ['text'] }],
      selectedModelId: 'chat-model',
    })!
    store.config!.llm.defaultProviderId = created.id
    store.config!.llm.defaultModel = 'chat-model'

    await store.saveConfig(store.config!)

    const afterCreate = store.config!.llm.providers.find((provider) => provider.id === created.id)!
    expect(afterCreate.id).toBe(created.id)
    expect(afterCreate.providerInstanceId).toBe(serverProviderId)
    expect(afterCreate.backendKey).toBe(canonicalBackendKey)
    expect(afterCreate.apiKey).toBe('sk-live-new-provider')
    expect(state.savedConfig!.llm.providers[0]).toMatchObject({
      id: created.id,
      providerInstanceId: serverProviderId,
      backendKey: canonicalBackendKey,
      apiKey: '',
    })

    afterCreate.name = 'Renamed for display'
    await store.saveConfig(store.config!)

    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(2)
    const firstPayload = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    const secondPayload = mockUpdateLLMConfig.mock.calls[1]![0] as BackendLLMConfig
    expect(Object.keys(firstPayload.providers)).toEqual([canonicalBackendKey])
    expect(firstPayload.providers[canonicalBackendKey]!.provider_instance_id).toBeUndefined()
    expect(Object.keys(secondPayload.providers)).toEqual([canonicalBackendKey])
    expect(secondPayload.providers[canonicalBackendKey]!.provider_instance_id).toBe(
      serverProviderId,
    )
    expect(secondPayload.providers).not.toHaveProperty('Renamed for display')
    const afterRename = store.config!.llm.providers.find((provider) => provider.id === created.id)!
    expect(afterRename).toMatchObject({
      id: created.id,
      name: 'Renamed for display',
      providerInstanceId: serverProviderId,
      backendKey: canonicalBackendKey,
      apiKey: 'sk-live-new-provider',
    })
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

    await store.saveConfig(store.config!)

    const backendConfig = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(backendConfig.providers['API Mart']).not.toHaveProperty('api_key')
    expect(backendConfig.providers['API Mart']!.api_key_mutation).toEqual({ mode: 'preserve' })
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

  it('保存等待原生配置协调器期间产生的新编辑不会被旧快照覆盖', async () => {
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

    let releaseCoordinator!: () => void
    let markCoordinatorStarted!: () => void
    const coordinatorGate = new Promise<void>((resolve) => {
      releaseCoordinator = resolve
    })
    const coordinatorStarted = new Promise<void>((resolve) => {
      markCoordinatorStarted = resolve
    })
    mockUpdateLLMConfig.mockImplementationOnce(async () => {
      markCoordinatorStarted()
      await coordinatorGate
    })

    const save = store.saveConfig(store.config!)
    await coordinatorStarted
    store.config!.llm.providers[0]!.name = 'Edited while saving'
    releaseCoordinator()
    await save

    expect(store.config!.llm.providers[0]!.name).toBe('Edited while saving')
    const payload = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(payload.providers).toHaveProperty('API Mart')
    expect(payload.providers).not.toHaveProperty('Edited while saving')
  })

  it('provider 删除通过同一次原生配置提交完成，不调用 renderer vault API', async () => {
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
    store.removeProvider('custom-1')

    await store.saveConfig(store.config!)

    const payload = mockUpdateLLMConfig.mock.calls[0]![0] as BackendLLMConfig
    expect(payload.providers).toEqual({})
    expect(mockUpdateLLMConfig.mock.calls[0]![1]).toEqual([])
  })

  it('provider 原子删除失败时不覆盖上次成功的本地快照', async () => {
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
    store.removeProvider('custom-1')
    mockUpdateLLMConfig.mockRejectedValueOnce(new Error('backend unavailable'))

    await expect(store.saveConfig(store.config!)).rejects.toThrow('backend unavailable')

    expect(state.savedConfig!.llm.providers).toHaveLength(1)
    expect(state.savedConfig!.llm.providers[0]!.id).toBe('custom-1')
  })

  it('安全和 sandbox 同步失败时应同时回滚内存状态和本地持久化', async () => {
    state.savedConfig = makeConfig({
      security: {
        content_filter: true,
      },
      sandbox: {
        network_enabled: true,
      },
    })
    mockGetLLMConfig.mockResolvedValue(makeBackendConfig())
    mockUpdateConfig.mockRejectedValueOnce(new Error('sandbox update failed'))

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.config!.sandbox!.network_enabled).toBe(true)
    expect(store.config!.security.content_filter).toBe(true)

    store.config!.security.content_filter = false
    store.config!.sandbox!.network_enabled = false
    const result = await store.saveConfig(store.config!)
    expect(result.securitySyncFailed).toBe(true)

    expect(store.config!.sandbox!.network_enabled).toBe(true)
    expect(store.config!.security.content_filter).toBe(true)
    expect(state.savedConfig!.sandbox!.network_enabled).toBe(true)
    expect(state.savedConfig!.security.content_filter).toBe(true)
  })
})
