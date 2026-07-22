/**
 * BUG-20260611 回归测试：settings store 的 syncAllProviderModels（配置加载或保存后
 * 异步触发）不得把远程全量模型 push 进 provider.models，绕过"目录/启用"两层架构——
 * 聚合商（OpenRouter 数百模型）每次保存配置都会把启用列表灌满。
 *
 * 期望：
 *   - 大目录（> AUTO_ENABLE_CATALOG_LIMIT）只写入 catalog store，不污染 provider.models
 *   - 小目录（≤ 阈值）维持原有"全量合并进启用列表"行为
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import type { CatalogModel } from '@/types'

const MOCK_BACKEND_CONFIG = {
  default: 'openRouter',
  providers: {
    openRouter: {
      provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
      api_key: '****ceb3',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'moonshotai/kimi-k2.6:free',
      models: ['moonshotai/kimi-k2.6:free'],
      compatible: 'openai',
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
}

const mockGetLLMConfig = vi.fn().mockResolvedValue(MOCK_BACKEND_CONFIG)
const mockUpdateLLMConfig = vi.fn().mockResolvedValue({})
const mockFetchProviderModels = vi.fn<() => Promise<CatalogModel[]>>().mockResolvedValue([])

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown) => mockUpdateLLMConfig(config),
  fetchProviderModels: (...args: unknown[]) => mockFetchProviderModels(...(args as [])),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({ running: false, models: [] }),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return null
    }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

function bigCatalog(n: number): CatalogModel[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `vendor${i % 7}/model-${i}`,
    name: `Model ${i}`,
    contextLength: 131072,
    promptPrice: i % 5 === 0 ? '0' : '0.00001',
    completionPrice: i % 5 === 0 ? '0' : '0.00005',
    supportsTools: true,
  }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('BUG-20260611: saveConfig 后的模型同步不得灌满启用列表', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockGetLLMConfig.mockClear()
    mockUpdateLLMConfig.mockClear()
    mockFetchProviderModels.mockReset()
    MOCK_BACKEND_CONFIG.providers.openRouter.base_url = 'https://openrouter.ai/api/v1'
    MOCK_BACKEND_CONFIG.providers.openRouter.model = 'moonshotai/kimi-k2.6:free'
    MOCK_BACKEND_CONFIG.providers.openRouter.models = ['moonshotai/kimi-k2.6:free'] as never
  })

  it('配置加载后非阻塞刷新小目录并自动持久化完整的四模型集合', async () => {
    const remoteModels: CatalogModel[] = [
      { id: 'moonshotai/kimi-k2.6:free', name: 'moonshotai/kimi-k2.6:free' },
      { id: 'proxy/model-b', name: 'Model B' },
      { id: 'proxy/model-c', name: 'Model C' },
      { id: 'proxy/model-d', name: 'Model D' },
    ]
    mockFetchProviderModels.mockResolvedValue(remoteModels)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()

    await store.loadConfig()

    await flushPromises()
    await flushPromises()
    expect(mockFetchProviderModels).toHaveBeenCalledTimes(1)
    expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(
      remoteModels.map((model) => model.id),
    )
    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(1)
    const persisted = mockUpdateLLMConfig.mock.calls[0]![0] as {
      providers: Record<string, { models?: string[] }>
    }
    expect(persisted.providers.openRouter?.models).toEqual(remoteModels.map((model) => model.id))
  }, 10_000)

  it('配置加载后把十一模型目录写入 catalog，但不自动扩张已启用集合', async () => {
    const remoteModels: CatalogModel[] = [
      { id: 'moonshotai/kimi-k2.6:free', name: 'moonshotai/kimi-k2.6:free' },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `zhipu/model-${index}`,
        name: `Model ${index}`,
      })),
    ]
    mockFetchProviderModels.mockResolvedValue(remoteModels)

    const { useSettingsStore } = await import('../settings')
    const { useModelCatalogStore } = await import('../model-catalog')
    const store = useSettingsStore()
    const catalogStore = useModelCatalogStore()

    await store.loadConfig()

    await vi.waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(catalogStore.getCatalog(store.config!.llm.providers[0]!.id)?.models).toHaveLength(11),
    )
    expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual([
      'moonshotai/kimi-k2.6:free',
    ])
    expect(mockUpdateLLMConfig).not.toHaveBeenCalled()
  })

  it('配置加载后的目录刷新失败时保留既有模型和目录缓存', async () => {
    mockFetchProviderModels.mockRejectedValue(new Error('provider unavailable'))

    const { useSettingsStore } = await import('../settings')
    const { useModelCatalogStore } = await import('../model-catalog')
    const store = useSettingsStore()
    const catalogStore = useModelCatalogStore()
    catalogStore.setCatalog('openRouter', [{ id: 'cached-model', name: 'Cached Model' }])

    await store.loadConfig()

    await vi.waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledTimes(1))
    expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual([
      'moonshotai/kimi-k2.6:free',
    ])
    expect(catalogStore.getCatalog('openRouter')?.models).toEqual([
      { id: 'cached-model', name: 'Cached Model' },
    ])
    expect(mockUpdateLLMConfig).not.toHaveBeenCalled()
  })

  it('远程目录失败时用已持久化的十一模型建立可管理目录快照', async () => {
    const persistedIds = Array.from({ length: 11 }, (_, index) => `zhipu/glm-${index}`)
    MOCK_BACKEND_CONFIG.providers.openRouter.models = persistedIds as never
    MOCK_BACKEND_CONFIG.providers.openRouter.model = persistedIds[0]!
    mockFetchProviderModels.mockRejectedValue(new Error('endpoint policy rejected'))

    const { useSettingsStore } = await import('../settings')
    const { useModelCatalogStore } = await import('../model-catalog')
    const store = useSettingsStore()

    await store.loadConfig()
    await vi.waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledTimes(1))

    const provider = store.config!.llm.providers[0]!
    expect(provider.models.map((model) => model.id)).toEqual(persistedIds)
    expect(useModelCatalogStore().getCatalog(provider.id)).toMatchObject({
      source: 'fallback',
      models: persistedIds.map((id) => ({ id, name: id })),
      newIds: [],
    })
    expect(mockUpdateLLMConfig).not.toHaveBeenCalled()
  })

  it('force reload 开始后立即废止此前的目录响应，并只接受 reload 后的新响应', async () => {
    const firstCatalog = deferred<CatalogModel[]>()
    const secondCatalog = deferred<CatalogModel[]>()
    mockFetchProviderModels
      .mockImplementationOnce(() => firstCatalog.promise)
      .mockImplementationOnce(() => secondCatalog.promise)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    await vi.waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledTimes(1))

    const reloadBackend = deferred<typeof MOCK_BACKEND_CONFIG>()
    mockGetLLMConfig.mockImplementationOnce(() => reloadBackend.promise)
    const reload = store.loadConfig({ force: true })
    await vi.waitFor(() => expect(mockGetLLMConfig).toHaveBeenCalledTimes(2))

    firstCatalog.resolve([
      { id: 'moonshotai/kimi-k2.6:free', name: 'moonshotai/kimi-k2.6:free' },
      { id: 'stale-before-reload', name: 'Stale Before Reload' },
    ])
    await flushPromises()
    expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).not.toContain(
      'stale-before-reload',
    )

    reloadBackend.resolve(MOCK_BACKEND_CONFIG)
    await reload
    await vi.waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledTimes(2))
    secondCatalog.resolve([
      { id: 'moonshotai/kimi-k2.6:free', name: 'moonshotai/kimi-k2.6:free' },
      { id: 'fresh-after-reload', name: 'Fresh After Reload' },
    ])
    await vi.waitFor(() =>
      expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).toContain(
        'fresh-after-reload',
      ),
    )
    expect(store.config!.llm.providers[0]!.models.map((model) => model.id)).not.toContain(
      'stale-before-reload',
    )
  })

  it('大目录（300 个）：provider.models 保持启用子集，全量进 catalog', async () => {
    mockFetchProviderModels.mockResolvedValue(bigCatalog(300))

    const { useSettingsStore } = await import('../settings')
    const { useModelCatalogStore } = await import('../model-catalog')
    const store = useSettingsStore()
    const catalogStore = useModelCatalogStore()

    await store.loadConfig()
    const provider = store.config!.llm.providers[0]!
    expect(provider.models.length).toBeLessThanOrEqual(2)

    await store.saveConfig(store.config!)
    await flushPromises()

    const after = store.config!.llm.providers[0]!
    expect(after.models.length, 'saveConfig 后启用列表被全量目录灌满').toBeLessThanOrEqual(2)

    const catalog = catalogStore.getCatalog(after.id)
    expect(catalog, '全量目录应写入 catalog store').not.toBeNull()
    expect(catalog!.models).toHaveLength(300)
  })

  it('大目录同步严格保留既有启用集合，不用启发式猜测并删除用户选择', async () => {
    const catalog = bigCatalog(300)
    mockFetchProviderModels.mockResolvedValue(catalog)
    // 即使既有集合覆盖整个目录，也无法证明它不是用户在管理器中主动全选。
    MOCK_BACKEND_CONFIG.providers.openRouter.models = [
      ...catalog.map((m) => m.id),
      'my-custom-model',
    ] as never

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()

    await store.loadConfig()
    const provider = store.config!.llm.providers[0]!
    // 标记自定义模型（后端 yaml 不存 isCustom，这里直接构造前端态）
    const custom = provider.models.find((m) => m.id === 'my-custom-model')
    if (custom) custom.isCustom = true
    expect(provider.models.length).toBeGreaterThan(200)

    await store.saveConfig(store.config!)
    await flushPromises()

    const after = store.config!.llm.providers[0]!
    // backend model + 300 catalog rows + one custom row are all retained.
    expect(after.models).toHaveLength(302)
    const ids = after.models.map((m) => m.id)
    expect(ids, '自定义模型必须保留').toContain('my-custom-model')
    expect(ids, '当前选中模型必须保留').toContain(after.selectedModelId)

    const availableIds = store.availableModels.map((model) => model.modelId)
    expect(availableIds).toContain('my-custom-model')
    expect(availableIds).toContain(after.selectedModelId)
    expect(availableIds).toContain(catalog[1]!.id)

    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(2)
    const persisted = mockUpdateLLMConfig.mock.calls[mockUpdateLLMConfig.mock.calls.length - 1]?.[0] as typeof MOCK_BACKEND_CONFIG
    expect(persisted.providers.openRouter.models).toHaveLength(after.models.length)

    mockGetLLMConfig.mockResolvedValueOnce(persisted)
    setActivePinia(createPinia())
    const restarted = useSettingsStore()
    await restarted.loadConfig()
    expect(restarted.config!.llm.providers[0]!.models.map((model) => model.id)).toEqual(ids)

    MOCK_BACKEND_CONFIG.providers.openRouter.models = ['moonshotai/kimi-k2.6:free'] as never
  })

  it('同一 provider 的旧 endpoint 响应后到时不得覆盖新 endpoint 的目录', async () => {
    const first = deferred<CatalogModel[]>()
    const second = deferred<CatalogModel[]>()
    mockFetchProviderModels
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    expect(mockFetchProviderModels).toHaveBeenCalledTimes(1)

    store.config!.llm.providers[0]!.baseUrl = 'https://new-endpoint.example/v1'
    await store.saveConfig(store.config!)
    await flushPromises()
    expect(mockFetchProviderModels).toHaveBeenCalledTimes(2)

    second.resolve([{ id: 'new-endpoint-model', name: 'New Endpoint Model' }])
    await flushPromises()
    first.resolve([{ id: 'old-endpoint-model', name: 'Old Endpoint Model' }])
    await flushPromises()
    await flushPromises()

    const ids = store.config!.llm.providers[0]!.models.map((model) => model.id)
    expect(ids).toContain('new-endpoint-model')
    expect(ids).not.toContain('old-endpoint-model')
  })

  it('小目录（5 个）：维持原有全量合并行为', async () => {
    const small: CatalogModel[] = Array.from({ length: 5 }, (_, i) => ({
      id: `glm-${i}`,
      name: `GLM ${i}`,
    }))
    mockFetchProviderModels.mockResolvedValue(small)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()

    await store.loadConfig()
    await store.saveConfig(store.config!)
    await flushPromises()

    const after = store.config!.llm.providers[0]!
    const ids = after.models.map((m) => m.id)
    for (const m of small) {
      expect(ids).toContain(m.id)
    }
  })

  it.each([
    { count: 10, expectedEnabled: 11, expectedUpdates: 1, expectedPersistedModels: 11 },
    { count: 11, expectedEnabled: 1, expectedUpdates: 0, expectedPersistedModels: 0 },
  ])('启动目录阈值 $count：启用模型数量为 $expectedEnabled 且同步不递归保存', async ({
    count,
    expectedEnabled,
    expectedUpdates,
    expectedPersistedModels,
  }) => {
    const catalog = bigCatalog(count)
    mockFetchProviderModels.mockResolvedValue(catalog)

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()

    await store.loadConfig()
    await flushPromises()
    await flushPromises()

    const after = store.config!.llm.providers[0]!
    expect(after.models).toHaveLength(expectedEnabled)
    expect(mockFetchProviderModels).toHaveBeenCalledTimes(1)
    expect(mockFetchProviderModels).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1',
      '****ceb3',
      expect.objectContaining({
        providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
      }),
    )
    expect(mockUpdateLLMConfig).toHaveBeenCalledTimes(expectedUpdates)
    const persisted = mockUpdateLLMConfig.mock.calls[mockUpdateLLMConfig.mock.calls.length - 1]?.[0] as
      | { providers: Record<string, { models?: string[] }> }
      | undefined
    expect(persisted?.providers.openRouter?.models?.length ?? 0).toBe(expectedPersistedModels)
  })

  it('中等目录（15 个）用户全选不会被同步删除', async () => {
    const midCatalog = bigCatalog(15)
    mockFetchProviderModels.mockResolvedValue(midCatalog)
    // 用户在模型管理器里"全选该组"主动启用全部 15 个
    MOCK_BACKEND_CONFIG.providers.openRouter.models = midCatalog.map((m) => m.id) as never
    MOCK_BACKEND_CONFIG.providers.openRouter.model = midCatalog[0]!.id

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()
    await store.saveConfig(store.config!)
    await flushPromises()

    const after = store.config!.llm.providers[0]!
    expect(after.models.length, '用户主动全选的中等目录不得被收缩').toBe(15)

    MOCK_BACKEND_CONFIG.providers.openRouter.models = ['moonshotai/kimi-k2.6:free'] as never
    MOCK_BACKEND_CONFIG.providers.openRouter.model = 'moonshotai/kimi-k2.6:free'
  })

})
