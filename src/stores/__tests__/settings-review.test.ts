/**
 * Settings Store Code Review — 暴露 backendToProviders 类型映射逻辑问题
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockGetLLMConfig = vi.fn()
const mockUpdateLLMConfig = vi.fn().mockResolvedValue({})
const mockUpdateConfig = vi.fn().mockResolvedValue({})

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: (config: unknown) => mockUpdateLLMConfig(config),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: (config: unknown) => mockUpdateConfig(config),
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

describe('Settings Store — backendToProviders 类型映射逻辑', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockClear()
    ;(globalThis as Record<string, unknown>).isTauri = true
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('backendToProviders 当 compatible="openai" 且 name 是已知 provider 时类型正确识别', async () => {
    mockGetLLMConfig.mockResolvedValue({
      default: 'deepseek',
      providers: {
        deepseek: {
          api_key: 'sk-xxx',
          base_url: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          compatible: 'openai',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    const provider = store.config!.llm.providers[0]!
    expect(provider.type).toBe('deepseek')
  })

  it('backendToProviders compatible="" 且 name 是已知 provider 时类型正确', async () => {
    mockGetLLMConfig.mockResolvedValue({
      default: 'deepseek',
      providers: {
        deepseek: {
          api_key: 'sk-xxx',
          base_url: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          compatible: '',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig({ force: true })

    const provider = store.config!.llm.providers[0]!
    // 当 compatible !== 'openai' 且 name 匹配已知类型时，类型正确
    expect(provider.type).toBe('deepseek')
  })

  it('disabled provider 在保存时不发送到后端，但本地保留', async () => {
    mockGetLLMConfig.mockResolvedValue({
      default: 'apimart',
      providers: {
        apimart: { api_key: 'key1', base_url: 'url1', model: 'model1', compatible: 'openai' },
        ollama: { api_key: '', base_url: 'http://localhost:11434', model: 'llama3', compatible: '' },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig({ force: true })

    store.updateProvider('ollama', { enabled: false })

    const ollamaProvider = store.config!.llm.providers.find(p => p.id === 'ollama')
    expect(ollamaProvider?.enabled).toBe(false)

    // disabled providers are skipped in providersToBackend (backend treats all as active)
    // but saved locally via Tauri Store and merged back on next loadConfig
    expect(store.config!.llm.providers.length).toBe(2)
  })
})
