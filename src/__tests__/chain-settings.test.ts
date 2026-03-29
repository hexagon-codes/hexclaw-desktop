/**
 * Chain H: Settings -> LLM Config -> Save
 *
 * Tests the settings store lifecycle: load config, save config,
 * add/remove/update providers, and test LLM connection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ── Hoisted mocks ──────────────────────────────────────────────────

const {
  mockGetLLMConfig,
  mockUpdateLLMConfig,
  mockTestLLMConnection,
  mockUpdateConfig,
  mockSaveSecureValue,
  mockLoadSecureValue,
  mockRemoveSecureValue,
} = vi.hoisted(() => ({
  mockGetLLMConfig: vi.fn().mockResolvedValue({
    default: 'openai',
    providers: { openai: { api_key: 'sk-***', base_url: '', model: 'gpt-4o', compatible: '' } },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  mockUpdateLLMConfig: vi.fn().mockResolvedValue(undefined),
  mockTestLLMConnection: vi.fn().mockResolvedValue({ success: true, message: 'Connected', latency_ms: 120 }),
  mockUpdateConfig: vi.fn().mockResolvedValue({}),
  mockSaveSecureValue: vi.fn().mockResolvedValue(undefined),
  mockLoadSecureValue: vi.fn().mockResolvedValue(null),
  mockRemoveSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/api/config', () => ({
  getLLMConfig: mockGetLLMConfig,
  updateLLMConfig: mockUpdateLLMConfig,
  testLLMConnection: mockTestLLMConnection,
}))

vi.mock('@/api/settings', () => ({
  updateConfig: mockUpdateConfig,
  getRuntimeConfig: vi.fn(),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: mockSaveSecureValue,
  loadSecureValue: mockLoadSecureValue,
  removeSecureValue: mockRemoveSecureValue,
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  }),
  LazyStore: class {
    private _data = new Map()
    async get(key: string) { return this._data.get(key) ?? null }
    async set(key: string, val: unknown) { this._data.set(key, val) }
    async save() {}
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('{}'),
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  mockGetLLMConfig.mockResolvedValue({
    default: 'openai',
    providers: { openai: { api_key: 'sk-***', base_url: '', model: 'gpt-4o', compatible: '' } },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain H: Settings -> LLM Config -> Save', () => {
  it('H1: loadConfig fetches from backend and populates store', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    expect(store.config).toBeNull()
    expect(store.loading).toBe(false)

    await store.loadConfig()

    expect(store.config).not.toBeNull()
    expect(store.config!.llm).toBeDefined()
    expect(store.config!.llm.providers).toBeDefined()
    expect(store.config!.security).toBeDefined()
    expect(store.config!.general).toBeDefined()
    expect(store.config!.notification).toBeDefined()
    expect(store.config!.mcp).toBeDefined()
    expect(store.loading).toBe(false)
  })

  it('H1b: loadConfig with force=true reloads even if config exists', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()
    expect(store.config).not.toBeNull()

    // Add a provider so config has providers
    store.addProvider({
      name: 'Test',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      selectedModelId: 'gpt-4o',
    })

    // Without force, should NOT reload (has providers)
    await store.loadConfig()
    // With force, should reload
    await store.loadConfig({ force: true })

    // config should still exist (reloaded)
    expect(store.config).not.toBeNull()
  })

  it('H2: saveConfig writes to backend (localStorage in non-Tauri)', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const updatedConfig = JSON.parse(JSON.stringify(store.config!))
    updatedConfig.general.language = 'en'
    updatedConfig.security.rate_limit_rpm = 100

    await store.saveConfig(updatedConfig)

    expect(store.config!.general.language).toBe('en')
    expect(store.config!.security.rate_limit_rpm).toBe(100)

    // Non-Tauri: saved to localStorage
    const raw = localStorage.getItem('app_config')
    expect(raw).not.toBeNull()
    const saved = JSON.parse(raw!)
    expect(saved.general.language).toBe('en')
  })

  it('H2b: saveConfig strips API keys from persisted config', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    store.addProvider({
      name: 'Sensitive',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-REAL-SECRET-KEY',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      selectedModelId: 'gpt-4o',
    })

    const configToSave = JSON.parse(JSON.stringify(store.config!))
    await store.saveConfig(configToSave)

    // API key should be stored securely, not in localStorage
    const raw = localStorage.getItem('app_config')
    const saved = JSON.parse(raw!)
    for (const provider of saved.llm.providers) {
      expect(provider.apiKey).toBe('')
    }
  })

  it('H3: addProvider creates new provider with defaults', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const newProvider = store.addProvider({
      name: 'DeepSeek',
      type: 'deepseek',
      enabled: true,
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deep',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] },
        { id: 'deepseek-coder', name: 'DeepSeek Coder', capabilities: ['text'] },
      ],
      selectedModelId: 'deepseek-chat',
    })

    expect(newProvider).not.toBeNull()
    expect(newProvider!.id).toBeDefined()
    expect(newProvider!.name).toBe('DeepSeek')
    expect(newProvider!.type).toBe('deepseek')
    expect(newProvider!.selectedModelId).toBe('deepseek-chat')
    expect(store.config!.llm.providers).toContainEqual(
      expect.objectContaining({ name: 'DeepSeek' }),
    )
  })

  it('H3b: addProvider ensures unique name (appends number on conflict)', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const p1 = store.addProvider({
      name: 'MyProvider',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'key1',
      models: [{ id: 'm1', name: 'M1', capabilities: ['text'] }],
      selectedModelId: 'm1',
    })

    const p2 = store.addProvider({
      name: 'MyProvider',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'key2',
      models: [{ id: 'm2', name: 'M2', capabilities: ['text'] }],
      selectedModelId: 'm2',
    })

    expect(p1!.name).toBe('MyProvider')
    expect(p2!.name).toBe('MyProvider 2')
  })

  it('H3c: addProvider returns null if config is not loaded', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    // config is null before loadConfig
    const result = store.addProvider({
      name: 'Test',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: '',
      models: [],
      selectedModelId: '',
    })

    expect(result).toBeNull()
  })

  it('H4: removeProvider removes and reconciles', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const added = store.addProvider({
      name: 'Temporary',
      type: 'anthropic',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-temp',
      models: [{ id: 'claude-3', name: 'Claude 3', capabilities: ['text'] }],
      selectedModelId: 'claude-3',
    })

    expect(store.config!.llm.providers.some((p) => p.id === added!.id)).toBe(true)

    store.removeProvider(added!.id)

    expect(store.config!.llm.providers.some((p) => p.id === added!.id)).toBe(false)
  })

  it('H4b: removeProvider of default provider clears default selection', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    // Add provider and set as default
    const provider = store.addProvider({
      name: 'Default Provider',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-def',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      selectedModelId: 'gpt-4o',
    })

    store.config!.llm.defaultProviderId = provider!.id
    store.config!.llm.defaultModel = 'gpt-4o'

    // Remove all providers
    const allIds = store.config!.llm.providers.map((p) => p.id)
    for (const id of allIds) {
      store.removeProvider(id)
    }

    // Default should be cleared after reconciliation
    expect(store.config!.llm.defaultModel).toBe('')
    expect(store.config!.llm.defaultProviderId).toBe('')
  })

  it('H5: updateProvider persists changes', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const added = store.addProvider({
      name: 'Updatable',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-upd',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      selectedModelId: 'gpt-4o',
    })

    store.updateProvider(added!.id, {
      name: 'Updated Name',
      baseUrl: 'https://custom.openai.com',
    })

    const updated = store.config!.llm.providers.find((p) => p.id === added!.id)
    expect(updated!.name).toBe('Updated Name')
    expect(updated!.baseUrl).toBe('https://custom.openai.com')
  })

  it('H5b: updateProvider on non-existent ID is a no-op', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()
    const before = JSON.stringify(store.config)

    store.updateProvider('non-existent-id', { name: 'Ghost' })

    expect(JSON.stringify(store.config)).toBe(before)
  })

  it('H6: testLLMConnection calls test endpoint', async () => {
    const { testLLMConnection } = await import('@/api/config')

    const result = await testLLMConnection({
      provider: {
        type: 'openai',
        api_key: 'sk-test',
        base_url: '',
        model: 'gpt-4o',
      },
    })

    expect(mockTestLLMConnection).toHaveBeenCalledWith({
      provider: {
        type: 'openai',
        api_key: 'sk-test',
        base_url: '',
        model: 'gpt-4o',
      },
    })
    expect((result as any).success).toBe(true)
    expect(result.latency_ms).toBe(120)
  })

  it('H6b: testLLMConnection failure returns error info', async () => {
    mockTestLLMConnection.mockResolvedValueOnce({
      success: false,
      message: 'Invalid API key',
      latency_ms: 0,
    })

    const { testLLMConnection } = await import('@/api/config')
    const result = await testLLMConnection({
      provider: {
        type: 'openai',
        api_key: 'invalid',
        base_url: '',
        model: 'gpt-4o',
      },
    })

    expect((result as any).success).toBe(false)
    expect(result.message).toBe('Invalid API key')
  })

  it('H7: enabledProviders computed only includes enabled providers', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    store.addProvider({
      name: 'Enabled One',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'k1',
      models: [{ id: 'm1', name: 'M1', capabilities: ['text'] }],
      selectedModelId: 'm1',
    })

    store.addProvider({
      name: 'Disabled One',
      type: 'anthropic',
      enabled: false,
      baseUrl: '',
      apiKey: 'k2',
      models: [{ id: 'm2', name: 'M2', capabilities: ['text'] }],
      selectedModelId: 'm2',
    })

    // In non-Tauri env, enabledProviders uses runtimeProviders if set.
    // After addProvider, set runtimeProviders to null so it falls back to config.llm.providers
    store.runtimeProviders = null

    const enabled = store.enabledProviders
    expect(enabled.some((p) => p.name === 'Enabled One')).toBe(true)
    expect(enabled.some((p) => p.name === 'Disabled One')).toBe(false)
  })

  it('H8: availableModels aggregates models from enabled providers', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    store.addProvider({
      name: 'P1',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'k1',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5', capabilities: ['text'] },
      ],
      selectedModelId: 'gpt-4o',
    })

    store.addProvider({
      name: 'P2',
      type: 'anthropic',
      enabled: true,
      baseUrl: '',
      apiKey: 'k2',
      models: [
        { id: 'claude-3-opus', name: 'Claude 3 Opus', capabilities: ['text'] },
      ],
      selectedModelId: 'claude-3-opus',
    })

    // In non-Tauri env, runtimeProviders takes precedence for enabledProviders/availableModels.
    // Set to null so the computed falls back to config.llm.providers.
    store.runtimeProviders = null

    const models = store.availableModels
    expect(models.length).toBeGreaterThanOrEqual(3)
    expect(models.some((m) => m.modelId === 'gpt-4o')).toBe(true)
    expect(models.some((m) => m.modelId === 'claude-3-opus')).toBe(true)
    // Each model entry has providerName set
    for (const m of models) {
      expect(m.providerName).toBeDefined()
    }
  })
})
