/**
 * BUG-20260611 回归测试：settings store 的 syncAllProviderModels（saveConfig 后
 * 异步触发）把远程全量模型 push 进 provider.models，绕过"目录/启用"两层架构——
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
    async get() { return null }
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

describe('BUG-20260611: saveConfig 后的模型同步不得灌满启用列表', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockGetLLMConfig.mockClear()
    mockUpdateLLMConfig.mockClear()
    mockFetchProviderModels.mockReset()
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

  it('存量灌入污染：启用列表 ≈ 全量目录时自动收缩为策展子集', async () => {
    const catalog = bigCatalog(300)
    mockFetchProviderModels.mockResolvedValue(catalog)
    // 模拟旧版已把全量目录灌进配置：models 含 300 个目录模型 + 1 个自定义
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
    expect(after.models.length, '灌入污染应被收缩').toBeLessThanOrEqual(5)
    const ids = after.models.map((m) => m.id)
    expect(ids, '自定义模型必须保留').toContain('my-custom-model')
    expect(ids, '当前选中模型必须保留').toContain(after.selectedModelId)

    MOCK_BACKEND_CONFIG.providers.openRouter.models = ['moonshotai/kimi-k2.6:free'] as never
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

  it('中等目录（15 个）用户全选不应被识别为灌入而误杀', async () => {
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
