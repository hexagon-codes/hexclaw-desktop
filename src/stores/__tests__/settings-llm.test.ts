import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// 模拟后端返回的 LLM 配置
const MOCK_BACKEND_CONFIG = {
  default: 'apimart',
  providers: {
    apimart: {
      api_key: '****5OsG',
      base_url: 'https://apimart.asia/v1',
      model: 'claude-sonnet-4-6-apimart',
      compatible: 'openai',
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
}

const mockGetLLMConfig = vi.fn().mockResolvedValue(MOCK_BACKEND_CONFIG)
const mockUpdateLLMConfig = vi.fn().mockResolvedValue({})

vi.mock('@/api/config', () => ({
  getLLMConfig: (...args: unknown[]) => mockGetLLMConfig(...args),
  updateLLMConfig: (...args: unknown[]) => mockUpdateLLMConfig(...args),
}))

describe('Settings Store — isTauri 检测与 LLM 加载', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockClear()
    mockGetLLMConfig.mockResolvedValue(MOCK_BACKEND_CONFIG)
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
    expect(store.config!.llm.providers[0]!.id).toBe('apimart')
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
    expect(provider.id).toBe('apimart')
    expect(provider.name).toBe('apimart')
    expect(provider.enabled).toBe(true)
    expect(provider.baseUrl).toBe('https://apimart.asia/v1')
    expect(provider.models).toHaveLength(1)
    expect(provider.models[0]!.id).toBe('claude-sonnet-4-6-apimart')
  })

  it('defaultModel 正确映射', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.config!.llm.defaultModel).toBe('claude-sonnet-4-6-apimart')
  })

  it('availableModels 计算属性正确', async () => {
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('claude-sonnet-4-6-apimart')
  })

  it('getLLMConfig 失败时应重试 3 次', async () => {
    mockGetLLMConfig.mockRejectedValue(new Error('connection refused'))
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(3)
    expect(store.config!.llm.providers).toEqual([])
  }, 30000)

  it('第一次失败第二次成功时应正常加载', async () => {
    mockGetLLMConfig
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(MOCK_BACKEND_CONFIG)
    ;(globalThis as unknown as Record<string, unknown>).isTauri = true

    const { useSettingsStore } = await import('../settings')
    const store = useSettingsStore()
    await store.loadConfig()

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(2)
    expect(store.config!.llm.providers).toHaveLength(1)
  }, 15000)
})
