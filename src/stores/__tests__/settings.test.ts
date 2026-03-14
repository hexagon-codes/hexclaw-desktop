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

  it('saves config via API', async () => {
    const store = useSettingsStore()
    await store.loadConfig()
    const config = store.config!
    config.llm.defaultModel = 'gpt-4-turbo'
    await store.saveConfig(config)
    expect(store.config!.llm.defaultModel).toBe('gpt-4-turbo')
  })
})
