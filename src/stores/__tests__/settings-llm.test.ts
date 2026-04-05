import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// 模拟后端返回的 LLM 配置
const MOCK_BACKEND_CONFIG = {
  default: 'testprovider',
  providers: {
    testprovider: {
      api_key: '****5OsG',
      base_url: 'https://api.example.com/v1',
      model: 'claude-sonnet-4-6-test',
      compatible: 'openai',
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
}

const mockGetLLMConfig = vi.fn().mockResolvedValue(MOCK_BACKEND_CONFIG)
const mockUpdateLLMConfig = vi.fn().mockResolvedValue({})
let mockPersistedAppConfig: unknown = null

const mockGetOllamaStatus = vi.fn()

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown) => mockUpdateLLMConfig(config),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return mockPersistedAppConfig
    }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

describe('Settings Store — isTauri 检测与 LLM 加载', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockReset()
    mockGetLLMConfig.mockResolvedValue(MOCK_BACKEND_CONFIG)
    mockUpdateLLMConfig.mockReset()
    mockUpdateLLMConfig.mockResolvedValue({})
    mockGetOllamaStatus.mockReset()
    mockPersistedAppConfig = null
  })

  afterEach(() => {
    // 清除所有可能的 Tauri 全局标识
    delete (window as unknown as Record<string, unknown>).__TAURI__
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (globalThis as unknown as Record<string, unknown>).isTauri
  })

  it('Tauri v2 官方 isTauri() 使用 globalThis.isTauri 而非 __TAURI__', async () => {
    // 验证 @tauri-apps/api/core 的 isTauri 实现
    // Tauri v2 运行时设置的是 globalThis.isTauri = true
    const { isTauri: officialIsTauri } = await import('@tauri-apps/api/core')

    // 没有设置任何全局变量时，应该返回 false
    expect(officialIsTauri()).toBe(false)

    // 设置 globalThis.isTauri = true（Tauri v2 运行时实际行为）
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
    expect(officialIsTauri()).toBe(true)

    // 清理
    delete (globalThis as unknown as Record<string, unknown>).isTauri
  })

  it('仅设置 __TAURI__ 不足以通过 Tauri v2 官方检测', async () => {
    const { isTauri: officialIsTauri } = await import('@tauri-apps/api/core')
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    // 官方检测不看 __TAURI__
    expect(officialIsTauri()).toBe(false)
  })

  it('仅设置 __TAURI_INTERNALS__ 不足以通过 Tauri v2 官方检测', async () => {
    const { isTauri: officialIsTauri } = await import('@tauri-apps/api/core')
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { metadata: {} }
    // 官方检测不看 __TAURI_INTERNALS__
    expect(officialIsTauri()).toBe(false)
  })

  it('我们的 isTauri 应该也检测 globalThis.isTauri', async () => {
    // 模拟 Tauri v2 运行时（只设置 globalThis.isTauri）
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    // 应调用 getLLMConfig
    expect(mockGetLLMConfig).toHaveBeenCalled()
    expect(store.config!.llm.providers).toHaveLength(1)
    expect(store.config!.llm.providers[0]!.id).toBe('testprovider')
  })

  it('无任何 Tauri 标识时不应加载后端 LLM 配置', async () => {
    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(mockGetLLMConfig).not.toHaveBeenCalled()
    expect(store.config!.llm.providers).toEqual([])
  })

  it('backendToProviders 正确转换后端数据', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    const provider = store.config!.llm.providers[0]!
    expect(provider.id).toBe('testprovider')
    expect(provider.name).toBe('testprovider')
    expect(provider.enabled).toBe(true)
    expect(provider.baseUrl).toBe('https://api.example.com/v1')
    expect(provider.models).toHaveLength(1)
    expect(provider.models[0]!.id).toBe('claude-sonnet-4-6-test')
    expect(provider.selectedModelId).toBe('claude-sonnet-4-6-test')
  })

  it('defaultModel 正确映射', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.config!.llm.defaultModel).toBe('claude-sonnet-4-6-test')
    expect(store.config!.llm.defaultProviderId).toBe('testprovider')
  })

  it('availableModels 计算属性正确', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('claude-sonnet-4-6-test')
    expect(store.availableModels[0]!.providerKey).toBe('testprovider')
  })

  it('后端加载后本地已启用的 provider（如 Ollama）也出现在 availableModels', async () => {
    mockPersistedAppConfig = {
      llm: {
        providers: [
          {
            id: 'zhipu-local',
            name: '智谱',
            type: 'custom',
            enabled: true,
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'glm-5',
      },
      security: {},
      general: {},
      notification: {},
      mcp: {},
    }
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.config!.llm.providers.some((provider) => provider.name === '智谱')).toBe(true)
    expect(store.availableModels).toHaveLength(2)
    expect(store.availableModels.some((model) => model.providerKey === 'testprovider')).toBe(true)
    expect(store.availableModels.some((model) => model.providerName === '智谱')).toBe(true)
  })

  it('getLLMConfig 失败时应重试 3 次', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetLLMConfig.mockRejectedValue(new Error('connection refused'))
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
    vi.useFakeTimers()

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    const loading = store.loadConfig()
    await vi.runAllTimersAsync()
    await loading

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(3)
    expect(store.config!.llm.providers).toEqual([])
    vi.useRealTimers()
  }, 30000)

  /**
   * 回归：后端 getLLMConfig 全失败时曾把 runtimeProviders 设为 []，[] 不会触发 ?? 回退，
   * 导致 enabledProviders/availableModels 全空（会话页无模型），尽管本地 Store 里仍有 Ollama。
   */
  it('getLLMConfig 全失败但本地已有 Ollama 时仍可用 enabledProviders + syncOllamaModels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetLLMConfig.mockRejectedValue(new Error('sidecar down'))
    mockPersistedAppConfig = {
      llm: {
        providers: [
          {
            id: 'ollama-local',
            name: 'Ollama',
            type: 'ollama',
            enabled: true,
            apiKey: '',
            baseUrl: 'http://127.0.0.1:11434/v1',
            backendKey: 'ollama',
            models: [],
            selectedModelId: '',
          },
        ],
        defaultModel: '',
        defaultProviderId: '',
      },
      security: {},
      general: {},
      notification: {},
      mcp: {},
    }
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
    vi.useFakeTimers()

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    const loading = store.loadConfig()
    await vi.runAllTimersAsync()
    await loading

    expect(mockGetLLMConfig).toHaveBeenCalled()
    expect(store.config!.llm.providers.some((p) => p.type === 'ollama')).toBe(true)
    expect(store.runtimeProviders).toBeNull()
    expect(store.enabledProviders.some((p) => p.type === 'ollama')).toBe(true)

    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3.5:9b', size: 6_600_000_000 }],
    })
    await store.syncOllamaModels()

    expect(store.availableModels.some((m) => m.modelId === 'qwen3.5:9b')).toBe(true)
    vi.useRealTimers()
  }, 30000)

  it('第一次失败第二次成功时应正常加载', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetLLMConfig
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(MOCK_BACKEND_CONFIG)
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
    vi.useFakeTimers()

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    const loading = store.loadConfig()
    await vi.runAllTimersAsync()
    await loading

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(2)
    expect(store.config!.llm.providers).toHaveLength(1)
    vi.useRealTimers()
  }, 15000)

  it('已有加载进行中时，force reload 不应被静默吞掉', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    let resolveFirstLoad!: (value: typeof MOCK_BACKEND_CONFIG) => void
    mockGetLLMConfig
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstLoad = resolve
          }),
      )
      .mockResolvedValueOnce({
        default: 'testprovider',
        providers: {
          testprovider: {
            api_key: '****new',
            base_url: 'https://api.example.com/v1',
            model: 'new-model',
            compatible: 'openai',
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()

    const firstLoad = store.loadConfig()
    await vi.waitFor(() => {
      expect(mockGetLLMConfig).toHaveBeenCalledTimes(1)
    })

    const forceReload = store.loadConfig({ force: true })

    resolveFirstLoad(MOCK_BACKEND_CONFIG)
    await Promise.all([firstLoad, forceReload])

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(2)
    expect(store.availableModels.some((model) => model.modelId === 'new-model')).toBe(true)
  })

  it('保存后会使用后端热生效的 runtime providers 刷新聊天模型列表', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
    mockGetLLMConfig.mockResolvedValueOnce(MOCK_BACKEND_CONFIG).mockResolvedValueOnce({
      default: '智谱',
      providers: {
        智谱: {
          api_key: '****zhipu',
          base_url: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-5',
          compatible: 'openai',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.llm.providers = [
      {
        id: 'zhipu-local',
        name: '智谱',
        type: 'custom',
        enabled: true,
        apiKey: 'sk-zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
      },
    ]
    store.config!.llm.defaultModel = 'glm-5'
    store.config!.llm.defaultProviderId = 'zhipu-local'

    await store.saveConfig(store.config!)

    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(1)
    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.providerKey).toBe('智谱')
    expect(store.config!.llm.defaultProviderId).toBe('zhipu-local')
  })

  it('并发保存时应保留最后一次保存对应的 runtime providers', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    let releaseFirstSave!: () => void
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })

    mockGetLLMConfig
      .mockResolvedValueOnce(MOCK_BACKEND_CONFIG)
      .mockResolvedValueOnce({
        default: 'testprovider',
        providers: {
          testprovider: {
            api_key: '****old',
            base_url: 'https://api.example.com/v1',
            model: 'old-model',
            compatible: 'openai',
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      })
      .mockResolvedValueOnce({
        default: 'testprovider',
        providers: {
          testprovider: {
            api_key: '****new',
            base_url: 'https://api.example.com/v1',
            model: 'new-model',
            compatible: 'openai',
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      })

    mockUpdateLLMConfig
      .mockImplementationOnce(
        async () => {
          await firstSaveGate
          return {}
        },
      )
      .mockResolvedValueOnce({})

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    const oldConfig = JSON.parse(JSON.stringify(store.config!))
    oldConfig.llm.providers[0].models = [{ id: 'old-model', name: 'old-model', capabilities: ['text'] }]
    oldConfig.llm.providers[0].selectedModelId = 'old-model'
    oldConfig.llm.defaultModel = 'old-model'
    oldConfig.llm.defaultProviderId = oldConfig.llm.providers[0].id

    const newConfig = JSON.parse(JSON.stringify(store.config!))
    newConfig.llm.providers[0].models = [{ id: 'new-model', name: 'new-model', capabilities: ['text'] }]
    newConfig.llm.providers[0].selectedModelId = 'new-model'
    newConfig.llm.defaultModel = 'new-model'
    newConfig.llm.defaultProviderId = newConfig.llm.providers[0].id

    const firstSave = store.saveConfig(oldConfig)
    const secondSave = store.saveConfig(newConfig)

    await vi.waitFor(() => {
      expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(1)
    })
    releaseFirstSave()
    await Promise.all([firstSave, secondSave])

    expect(store.config!.llm.defaultModel).toBe('new-model')
    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('new-model')
  })
})

describe('enabledProviders 与 runtime 合并', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockReset()
    mockGetLLMConfig.mockResolvedValue(MOCK_BACKEND_CONFIG)
    mockPersistedAppConfig = null
    delete (globalThis as unknown as Record<string, unknown>).isTauri
  })

  it('runtime 快照缺行时仍保留 config 中的 Ollama（saveConfig/getLLMConfig 去同步场景）', async () => {
    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    store.config!.llm.providers = [
      {
        id: 'p-openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: '',
        baseUrl: '',
        models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      },
      {
        id: 'p-ollama',
        name: 'Ollama',
        type: 'ollama',
        enabled: true,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        backendKey: 'ollama',
        models: [],
      },
    ]
    store.runtimeProviders = [
      {
        id: 'p-openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: '',
        baseUrl: '',
        models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      },
    ]

    expect(store.enabledProviders.some((p) => p.type === 'ollama')).toBe(true)
    expect(store.enabledProviders).toHaveLength(2)
  })
})

describe('syncOllamaModels — Ollama Provider 模型列表同步', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockReset()
    mockUpdateLLMConfig.mockReset()
    mockUpdateLLMConfig.mockResolvedValue({})
    mockGetOllamaStatus.mockReset()
    mockPersistedAppConfig = null
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true
  })

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).isTauri
  })

  async function setupStoreWithOllama(providerOverrides: Record<string, unknown> = {}) {
    const ollamaBackend = {
      default: 'ollama',
      providers: {
        ollama: {
          api_key: '',
          base_url: 'http://localhost:11434/v1',
          model: 'qwen3:8b',
          compatible: '',
          ...providerOverrides,
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    }
    mockGetLLMConfig.mockResolvedValue(ollamaBackend)
    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    return store
  }

  it('通过 backendKey 匹配 Ollama provider 并同步模型列表', async () => {
    const store = await setupStoreWithOllama()

    // 初始：ollamaModelsCache 为空，Ollama provider 在 availableModels 中无模型
    expect(store.availableModels.some(m => m.modelId === 'qwen3:8b')).toBe(false)

    // 第一次同步：填充缓存
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    await store.syncOllamaModels()
    expect(store.availableModels.some(m => m.modelId === 'qwen3:8b')).toBe(true)

    // 模拟 Ollama 返回新模型列表（qwen3:8b 已删，新增 qwen3.5:9b）
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3.5:9b', size: 6_600_000_000 }],
    })

    await store.syncOllamaModels()

    // 验证：qwen3:8b 消失，qwen3.5:9b 出现
    expect(store.availableModels.some(m => m.modelId === 'qwen3:8b')).toBe(false)
    expect(store.availableModels.some(m => m.modelId === 'qwen3.5:9b')).toBe(true)
  })

  it('通过 name 匹配包含 "ollama" 的 Provider', async () => {
    mockGetLLMConfig.mockResolvedValue({
      default: 'my-ollama',
      providers: {
        'my-ollama': {
          api_key: '',
          base_url: 'http://localhost:11434/v1',
          model: 'llama3:8b',
          compatible: '',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    // 手动设 provider name（模拟用户改名为 "My Ollama"）
    store.config!.llm.providers[0]!.name = 'My Ollama Server'

    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3.5:9b', size: 6_600_000_000 }],
    })

    // saveConfig 内部会重新 getLLMConfig()，需返回同步后的模型
    mockGetLLMConfig.mockResolvedValue({
      default: 'my-ollama',
      providers: {
        'my-ollama': {
          api_key: '',
          base_url: 'http://localhost:11434/v1',
          model: 'qwen3.5:9b',
          compatible: '',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    await store.syncOllamaModels()

    expect(store.availableModels.some(m => m.modelId === 'qwen3.5:9b')).toBe(true)
    expect(store.availableModels.some(m => m.modelId === 'llama3:8b')).toBe(false)
  })

  it('syncOllamaModels 更新 ollamaModelsCache，availableModels 反映新模型', async () => {
    const store = await setupStoreWithOllama()

    // syncOllamaModels 不再修改 provider.models 或 selectedModelId
    // 它只更新 ollamaModelsCache，availableModels computed 读取缓存
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 2,
      models: [
        { name: 'qwen3.5:9b', size: 6_600_000_000 },
        { name: 'deepseek-r1:7b', size: 4_700_000_000 },
      ],
    })

    await store.syncOllamaModels()

    // availableModels 应包含新的 Ollama 模型
    const ollamaModels = store.availableModels.filter(m => m.providerKey === 'ollama')
    expect(ollamaModels).toHaveLength(2)
    expect(ollamaModels.map(m => m.modelId)).toEqual(['qwen3.5:9b', 'deepseek-r1:7b'])
  })

  it('Ollama 未运行时 syncOllamaModels 不破坏现有配置', async () => {
    const store = await setupStoreWithOllama()
    const modelsBefore = store.availableModels.length

    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0 })

    await store.syncOllamaModels()

    // 不应改变现有配置
    expect(store.availableModels.length).toBe(modelsBefore)
  })

  it('Ollama API 报错时不影响配置', async () => {
    const store = await setupStoreWithOllama()
    const modelsBefore = store.availableModels.length

    mockGetOllamaStatus.mockRejectedValue(new Error('connection refused'))

    await store.syncOllamaModels()

    expect(store.availableModels.length).toBe(modelsBefore)
  })
})
