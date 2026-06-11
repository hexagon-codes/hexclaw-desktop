/**
 * BUG-20260611 回归测试：在设置页点击默认 Provider 的其他模型 chip 选不中。
 *
 * 链路：chip 点击 → updateProvider({selectedModelId}) → reconcileDefaultSelection
 * 用仍然有效的全局 defaultModel 把 selectedModelId 强制改回去，选择立刻被回退。
 *
 * 期望：通过 updateProvider 更新默认 Provider 的 selectedModelId 时，
 * 全局 defaultModel 同步跟随（chip 点击的语义就是"切换当前/默认模型"）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const MOCK_BACKEND_CONFIG = {
  default: 'openRouter',
  providers: {
    openRouter: {
      api_key: '****ceb3',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3-coder:free',
      models: [
        'qwen/qwen3-coder:free',
        'openrouter/owl-alpha',
        'nvidia/nemotron-3-ultra:free',
      ],
      compatible: 'openai',
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
}

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue(MOCK_BACKEND_CONFIG),
  updateLLMConfig: vi.fn().mockResolvedValue({}),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
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

describe('BUG-20260611: 默认 Provider 切换模型不得被 reconcile 回退', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('updateProvider 更新 selectedModelId 后选择生效且 defaultModel 同步', async () => {
    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    const provider = store.config!.llm.providers[0]!
    expect(provider.selectedModelId).toBe('qwen/qwen3-coder:free')
    expect(store.config!.llm.defaultModel).toBe('qwen/qwen3-coder:free')

    // 模拟 chip 点击：handleProviderModelChange → updateProvider
    store.updateProvider(provider.id, { selectedModelId: 'openrouter/owl-alpha' })

    const after = store.config!.llm.providers[0]!
    expect(after.selectedModelId, '点击选择被 reconcile 回退').toBe('openrouter/owl-alpha')
    expect(store.config!.llm.defaultModel, '默认 Provider 的选择应同步全局默认模型').toBe(
      'openrouter/owl-alpha',
    )
  })

  it('非默认 Provider 切换模型不影响全局 defaultModel', async () => {
    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    const second = store.addProvider({
      name: '智谱',
      type: 'zhipu',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [
        { id: 'glm-4-plus', name: 'GLM-4 Plus' },
        { id: 'glm-4-flash', name: 'GLM-4 Flash' },
      ],
    })!

    const defaultBefore = store.config!.llm.defaultModel
    store.updateProvider(second.id, { selectedModelId: 'glm-4-flash' })

    const after = store.config!.llm.providers.find((p) => p.id === second.id)!
    expect(after.selectedModelId).toBe('glm-4-flash')
    expect(store.config!.llm.defaultModel, '非默认 Provider 不应改全局默认').toBe(defaultBefore)
  })
})
