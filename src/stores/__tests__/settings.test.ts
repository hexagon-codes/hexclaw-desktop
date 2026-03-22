import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from '../settings'

// Mock API — 当前使用 @/api/config
vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockRejectedValue(new Error('no backend')),
  updateLLMConfig: vi.fn().mockImplementation((config) => Promise.resolve(config)),
}))

describe('useSettingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has null config initially', () => {
    const store = useSettingsStore()
    expect(store.config).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('falls back to default config on load error', async () => {
    const store = useSettingsStore()
    await store.loadConfig()
    expect(store.config).not.toBeNull()
    expect(store.config!.llm.providers).toEqual([])
    expect(store.config!.llm.defaultModel).toBe('')
    expect(store.config!.security.gateway_enabled).toBe(true)
    expect(store.config!.general.language).toBe('zh-CN')
    expect(store.loading).toBe(false)
  })

  it('saves config with an explicit default provider/model pair', async () => {
    const store = useSettingsStore()
    await store.loadConfig()
    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4-turbo', name: 'gpt-4-turbo', capabilities: ['text'] }],
    })

    const config = store.config!
    const provider = config.llm.providers[0]!
    config.llm.defaultProviderId = provider.id
    config.llm.defaultModel = 'gpt-4-turbo'
    await store.saveConfig(config)

    expect(store.config!.llm.defaultProviderId).toBe(provider.id)
    expect(store.config!.llm.defaultModel).toBe('gpt-4-turbo')
  })

  it('addProvider 为默认重名项自动生成唯一名称', async () => {
    const store = useSettingsStore()
    await store.loadConfig()

    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      models: [],
    })
    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      models: [],
    })

    expect(store.config!.llm.providers.map(provider => provider.name)).toEqual(['OpenAI', 'OpenAI 2'])
  })
})
