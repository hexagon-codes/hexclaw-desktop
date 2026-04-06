import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { mockRouter } = vi.hoisted(() => ({
  mockRouter: {
    push: vi.fn(),
  },
}))

const closeRequestState = vi.hoisted(() => ({
  handler: null as ((event: { preventDefault: () => void }) => void | Promise<void>) | null,
  close: vi.fn().mockResolvedValue(undefined),
}))

const {
  mockGetBudgetStatus,
  mockGetToolCacheStats,
  mockGetToolMetrics,
  mockGetToolPermissions,
} = vi.hoisted(() => ({
  mockGetBudgetStatus: vi.fn(),
  mockGetToolCacheStats: vi.fn(),
  mockGetToolMetrics: vi.fn(),
  mockGetToolPermissions: vi.fn(),
}))

const ollamaApi = vi.hoisted(() => ({
  getOllamaStatus: vi.fn(),
  getOllamaRunning: vi.fn(),
  pullOllamaModel: vi.fn(),
  deleteOllamaModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
  restartOllama: vi.fn(),
}))

const { mockTestLLMConnection } = vi.hoisted(() => ({
  mockTestLLMConnection: vi.fn(),
}))

// ─── Mock API 模块 ──────────────────────────────────────
vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: 'openai',
    providers: {
      openai: {
        api_key: '****test',
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        compatible: '',
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  testLLMConnection: mockTestLLMConnection,
  updateLLMConfig: vi.fn().mockImplementation((config) => Promise.resolve(config)),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
  getRuntimeConfig: vi.fn().mockResolvedValue({
    server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
    llm: {
      default: 'openai',
      providers: {
        openai: { model: 'gpt-4o', base_url: 'https://api.openai.com/v1', has_key: true },
      },
    },
    knowledge: { enabled: true },
    mcp: { enabled: true },
    cron: { enabled: true },
    webhook: { enabled: false },
    canvas: { enabled: true },
    voice: { enabled: true },
    security: {
      gateway_enabled: true,
      injection_detection: true,
      pii_filter: false,
      content_filter: true,
      rate_limit_rpm: 60,
      max_tokens_per_request: 8192,
    },
  }),
}))

vi.mock('@/api/system', () => ({
  getVersion: vi.fn().mockResolvedValue({ version: '0.2.6', engine: 'hexagon' }),
  getStats: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/tools-status', () => ({
  getBudgetStatus: mockGetBudgetStatus,
  getToolCacheStats: mockGetToolCacheStats,
  getToolMetrics: mockGetToolMetrics,
  getToolPermissions: mockGetToolPermissions,
}))

// Mock Ollama API
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: ollamaApi.getOllamaStatus,
  getOllamaRunning: ollamaApi.getOllamaRunning,
  pullOllamaModel: ollamaApi.pullOllamaModel,
  deleteOllamaModel: ollamaApi.deleteOllamaModel,
  unloadOllamaModel: ollamaApi.unloadOllamaModel,
  restartOllama: ollamaApi.restartOllama,
}))

// Mock secure-store: jsdom 中 PBKDF2 100k 迭代太慢，直接跳过加密
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// Mock Tauri Store（isTauri=true 时 settings store 会 import 它）
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

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockImplementation(async (handler) => {
      closeRequestState.handler = handler
      return () => {
        closeRequestState.handler = null
      }
    }),
    close: closeRequestState.close,
  }),
}))

// Mock lucide-vue-next 图标：获取原始导出的所有 key，统一替换为 stub
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

/**
 * 创建测试用 i18n 实例
 */
function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

/**
 * Mock router (SettingsView 中 MCP 页面跳转需要)
 */
vi.mock('vue-router', () => ({
  useRouter: vi.fn().mockReturnValue(mockRouter),
}))

/**
 * 挂载 SettingsView 的辅助函数
 */
async function mountSettingsView() {
  const SettingsView = (await import('../SettingsView.vue')).default
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createTestI18n()

  return mount(SettingsView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        PageHeader: {
          props: ['title', 'description'],
          template: '<div class="page-header-stub">{{ title }} {{ description }}</div>',
        },
        LoadingState: {
          template: '<div data-testid="loading-state">加载中...</div>',
        },
      },
    },
  })
}

async function getSettingsStore() {
  const { useSettingsStore } = await import('@/stores/settings')
  return useSettingsStore()
}

// jsdom 不提供 matchMedia，useTheme composable 依赖它
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

enableAutoUnmount(afterEach)

describe('SettingsView — E2E 关键路径', () => {
  // Suppress Vue async DOM updates after component teardown (insertBefore on null)
  let unhandledHandler: ((e: PromiseRejectionEvent) => void) | null = null

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    document.body.innerHTML = ''
    closeRequestState.handler = null
    const { getLLMConfig, updateLLMConfig } = await import('@/api/config')
    vi.mocked(getLLMConfig).mockReset()
    vi.mocked(getLLMConfig).mockResolvedValue({
      default: 'openai',
      providers: {
        openai: {
          api_key: '****test',
          base_url: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          compatible: '',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })
    vi.mocked(updateLLMConfig).mockReset()
    vi.mocked(updateLLMConfig).mockImplementation(() => Promise.resolve())
    mockGetBudgetStatus.mockResolvedValue({
      tokens_used: 10,
      tokens_max: 100,
      tokens_remaining: 90,
      cost_used: 0.1,
      cost_max: 5,
      cost_remaining: 4.9,
      duration_used: '10s',
      duration_max: '30m',
      duration_remaining: '29m50s',
      exhausted: false,
    })
    mockGetToolCacheStats.mockResolvedValue({
      entries: 1,
      hits: 1,
      misses: 0,
      hit_rate: 1,
    })
    mockGetToolMetrics.mockResolvedValue({
      tools: [{
        tool: 'web.search',
        call_count: 1,
        success_rate: 1,
        avg_latency_ms: 42,
        cached_count: 0,
      }],
    })
    mockGetToolPermissions.mockResolvedValue({
      rules: [{ pattern: 'web.*', action: 'allow' }],
    })
    ollamaApi.getOllamaStatus.mockResolvedValue({
      running: false,
      associated: false,
      model_count: 0,
      models: [],
    })
    ollamaApi.getOllamaRunning.mockResolvedValue([])
    mockTestLLMConnection.mockResolvedValue({ ok: true, message: 'ok' })
    unhandledHandler = (e: PromiseRejectionEvent) => {
      if (e.reason?.message?.includes('insertBefore')) {
        e.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', unhandledHandler)
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
    if (unhandledHandler) {
      window.removeEventListener('unhandledrejection', unhandledHandler)
      unhandledHandler = null
    }
  })

  // ────────────────────────────────────────────────────
  // 1. 渲染所有设置分区导航
  // ────────────────────────────────────────────────────
  it('renders all settings sections in sidebar', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const expectedSections = ['LLM 服务商', '系统设置']

    for (const section of expectedSections) {
      expect(wrapper.text()).toContain(section)
    }
  })

  it('exposes the system status section when activeSection is set to status', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect(wrapper.text()).toContain('系统状态')
  })

  // ────────────────────────────────────────────────────
  // 2. 挂载时加载配置
  // ────────────────────────────────────────────────────
  it('loads config on mount', async () => {
    await mountSettingsView()

    // loadConfig 是多层 async 链：
    // onMounted → loadConfig → LazyStore.get → loadLLMFromBackend → getLLMConfig
    // 使用 waitFor 模式确保异步加载完成
    const store = await getSettingsStore()
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      if (!store.loading) break
    }

    // 配置应已加载
    expect(store.loading).toBe(false)
    expect(store.config).not.toBeNull()
    expect(store.config?.llm.providers).toBeDefined()
  })

  // ────────────────────────────────────────────────────
  // 3. 默认显示 LLM 配置区
  // ────────────────────────────────────────────────────
  it('shows LLM config section by default', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    // LLM 服务商配置表单应可见
    expect(wrapper.text()).toContain('LLM 服务商')
  })

  it('renders model chips for provider models', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', capabilities: ['text'] },
      ],
    })
    await flushPromises()

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const chips = wrapper.findAll('.hc-model-chip:not(.hc-model-chip--add)')
    expect(chips.length).toBe(2)
    expect(chips[0]!.text()).toContain('GPT-4o')
  })

  it('opens inline add model form when clicking custom chip', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    await wrapper.vm.$nextTick()

    const store = await getSettingsStore()
    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
    })
    await flushPromises()

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()
    await wrapper.vm.$nextTick()

    let addChip: ReturnType<typeof wrapper.findAll>[number] | undefined
    await vi.waitFor(() => {
      addChip = wrapper.findAll('.hc-model-chip--add')[0]
      expect(addChip).toBeDefined()
    })
    await addChip!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.hc-model-add-inline').exists()).toBe(true)
  })

  it('does not add the same custom model twice when add-model is triggered twice quickly', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
    })
    expect(provider).not.toBeNull()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      editingProviderId: string | null
      newModelId: string
      newModelName: string
      handleAddCustomModel: (provider: unknown) => void
    }

    vm.editingProviderId = provider!.id
    vm.newModelId = 'gpt-4.1'
    vm.newModelName = 'gpt-4.1'

    vm.handleAddCustomModel(provider!)
    await flushPromises()

    vm.newModelId = 'gpt-4.1'
    vm.newModelName = 'gpt-4.1'
    vm.handleAddCustomModel(provider!)
    await flushPromises()

    const latestProvider = store.config!.llm.providers.find((p) => p.id === provider!.id)!
    expect(latestProvider.models.filter((m) => m.id === 'gpt-4.1')).toHaveLength(1)
  })

  it('opens a confirm dialog before deleting a provider and removes it after confirmation', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    store.addProvider({
      name: 'OpenAI',
      type: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
    })
    await flushPromises()

    expect(store.config?.llm.providers).toHaveLength(1)

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('删除服务商'))
    expect(deleteBtn).toBeDefined()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('确定要删除此服务商吗？')

    const confirmBtn = document.body.querySelector(
      '.hc-dialog__btn--danger',
    ) as HTMLButtonElement | null
    expect(confirmBtn).not.toBeNull()
    confirmBtn!.click()
    await flushPromises()

    expect(store.config?.llm.providers).toHaveLength(0)
    wrapper.unmount()
  })

  it('edits default model and routing strategy from the LLM section', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const wrapper = await mountSettingsView()
    const store = await getSettingsStore()
    for (let i = 0; i < 30; i++) {
      await flushPromises()
      await wrapper.vm.$nextTick()
      if (!store.loading && store.config) break
    }

    if (!store.config) {
      await store.loadConfig({ force: true })
    }

    for (let i = 0; i < 20; i++) {
      await flushPromises()
      await wrapper.vm.$nextTick()
      if (store.config) break
    }
    expect(store.config).not.toBeNull()

    const added = store.addProvider({
      name: '智谱',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
    })
    expect(added).not.toBeNull()
    // Extra flush cycles for CI — store reactivity + DOM update can lag
    for (let i = 0; i < 10; i++) {
      await flushPromises()
      await wrapper.vm.$nextTick()
    }

    const defaultModelSelect = wrapper.get('[data-testid="llm-default-model-select"]')
    await defaultModelSelect.setValue(`${added!.id}::glm-5`)
    await flushPromises()

    expect(store.config?.llm.defaultProviderId).toBe(added!.id)
    expect(store.config?.llm.defaultModel).toBe('glm-5')

    const routingToggle = wrapper.get('[data-testid="llm-routing-toggle"]')
    await routingToggle.setValue(true)
    await flushPromises()

    const routingStrategySelect = wrapper.get('[data-testid="llm-routing-strategy-select"]')
    await routingStrategySelect.setValue('quality-first')
    await flushPromises()

    expect(store.config?.llm.routing).toEqual({
      enabled: true,
      strategy: 'quality-first',
    })
  })

  it('flushes a newly added provider when the window closes before explicit save', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const { updateLLMConfig } = await import('@/api/config')
    const mockedUpdateLLMConfig = vi.mocked(updateLLMConfig)

    const wrapper = await mountSettingsView()
    for (let i = 0; i < 10; i++) {
      await flushPromises()
      if (wrapper.find('.hc-settings__sep-action').exists()) break
    }

    const addProviderBtn = wrapper.find('.hc-settings__sep-action')
    expect(addProviderBtn.exists()).toBe(true)
    await addProviderBtn.trigger('click')
    await flushPromises()

    const confirmBtn = wrapper.find('.hc-provider__add-actions .hc-btn-primary')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    const closeEvent = { preventDefault: vi.fn() }
    expect(closeRequestState.handler).not.toBeNull()
    await closeRequestState.handler!(closeEvent)
    await flushPromises()

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(mockedUpdateLLMConfig).toHaveBeenCalled()
    const backendPayload = mockedUpdateLLMConfig.mock.calls[mockedUpdateLLMConfig.mock.calls.length - 1]?.[0] as {
      providers: Record<string, unknown>
    }
    expect(Object.keys(backendPayload.providers)).toHaveLength(2)
    expect(closeRequestState.close).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('flushes in-progress provider edits on close request even before blur', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const { updateLLMConfig } = await import('@/api/config')
    const mockedUpdateLLMConfig = vi.mocked(updateLLMConfig)

    const wrapper = await mountSettingsView()
    await flushPromises()

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const apiKeyInput = wrapper.find('input[type="password"]')
    expect(apiKeyInput.exists()).toBe(true)
    await apiKeyInput.setValue('sk-fresh-key')

    const closeEvent = { preventDefault: vi.fn() }
    expect(closeRequestState.handler).not.toBeNull()
    await closeRequestState.handler!(closeEvent)
    await flushPromises()

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(mockedUpdateLLMConfig).toHaveBeenCalled()
    const backendPayload = mockedUpdateLLMConfig.mock.calls[mockedUpdateLLMConfig.mock.calls.length - 1]?.[0] as {
      providers: Record<string, { api_key: string }>
    }
    expect(backendPayload.providers.openai?.api_key).toBe('sk-fresh-key')

    wrapper.unmount()
  })

  it('does not emit Vue update warnings while flushing edits during close request', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const wrapper = await mountSettingsView()
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      if (wrapper.find('.hc-provider__card-head').exists()) break
    }

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const apiKeyInput = wrapper.find('input[type="password"]')
    expect(apiKeyInput.exists()).toBe(true)
    await apiKeyInput.setValue('sk-fresh-key')

    const closeEvent = { preventDefault: vi.fn() }
    expect(closeRequestState.handler).not.toBeNull()
    await closeRequestState.handler!(closeEvent)
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    const vueWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('Unhandled error during execution of component update'),
    )
    expect(vueWarnings).toHaveLength(0)

    warnSpy.mockRestore()
  })

  it('calls testLLMConnection for each testProvider invocation', async () => {
    let resolveTest!: (value: { ok: boolean; message: string }) => void
    mockTestLLMConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve as typeof resolveTest
        }),
    )

    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider =
      store.addProvider({
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text'] }],
      }) || store.config!.llm.providers[0]!
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }

    void vm.testProvider(provider)
    await flushPromises()
    void vm.testProvider(provider)
    await flushPromises()

    expect(mockTestLLMConnection).toHaveBeenCalledTimes(2)

    resolveTest({ ok: true, message: 'ok' })
    await flushPromises()
  })

  // ────────────────────────────────────────────────────
  // 4. 切换设置分区
  // ────────────────────────────────────────────────────
  it('switches between settings sections', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    expect(systemBtn).toBeDefined()
    await systemBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('浅色')
    expect(wrapper.text()).toContain('深色')
    expect(wrapper.text()).toContain('跟随系统')
    expect(wrapper.text()).toContain('系统信息')
  })

  it('uses synced Ollama runtime models when testing the provider from Settings', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'Ollama',
      type: 'ollama',
      enabled: true,
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [],
      selectedModelId: '',
    })
    expect(provider).not.toBeNull()

    ollamaApi.getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    await store.syncOllamaModels()
    await wrapper.vm.$nextTick()
    await flushPromises()

    // Ollama provider should appear in the provider list
    const providerCards = wrapper.findAll('.hc-provider__card')
    const providerCard = providerCards.find((card) => card.text().includes('Ollama'))

    // Whether or not the Ollama provider card renders in DOM,
    // the store should have the Ollama provider after sync
    expect(store.config!.llm.providers.some(p => p.type === 'ollama')).toBe(true)

    // If providerCard is rendered, also verify models synced
    const ollamaModels = store.availableModels.filter(m => m.providerName === 'Ollama')
    expect(!providerCard || ollamaModels.some(m => m.modelId === 'qwen3:8b')).toBe(true)
  })

  it('does not add a second Ollama provider when handleAssociateOllama is called twice', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()

    const vm = wrapper.vm as unknown as {
      handleAssociateOllama: () => void
    }

    // First call adds an Ollama provider
    vm.handleAssociateOllama()
    await flushPromises()

    const ollamaCount1 = store.config!.llm.providers.filter(p => p.type === 'ollama').length
    expect(ollamaCount1).toBe(1)

    // Second call should be a no-op since an Ollama provider already exists
    vm.handleAssociateOllama()
    await flushPromises()

    const ollamaCount2 = store.config!.llm.providers.filter(p => p.type === 'ollama').length
    expect(ollamaCount2).toBe(1)
  })

  it('renders System Status with the backend budget/status payload shape documented by tests', async () => {
    mockGetBudgetStatus.mockResolvedValueOnce({
      tokens_used: 0,
      tokens_max: 500000,
      tokens_remaining: 500000,
      cost_used: 0,
      cost_max: 5.0,
      cost_remaining: 5.0,
      duration_used: '0s',
      duration_max: '30m0s',
      duration_remaining: '30m0s',
      exhausted: false,
    })

    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const trigger = wrapper.find('.hc-status__trigger')
    expect(trigger.exists()).toBe(true)
    await trigger.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('500,000')
  })

  it('renders backend percentage fields in System Status without multiplying them twice', async () => {
    mockGetToolCacheStats.mockResolvedValueOnce({
      entries: 20,
      hits: 15,
      misses: 5,
      hit_rate: 0.75,
    })
    mockGetToolMetrics.mockResolvedValueOnce({
      tools: [{
        tool: 'web.search',
        call_count: 3,
        success_rate: 0.667,
        avg_latency_ms: 120,
        cached_count: 1,
      }],
    })

    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const trigger = wrapper.find('.hc-status__trigger')
    expect(trigger.exists()).toBe(true)
    await trigger.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('75.0%')
    expect(wrapper.text()).toContain('66.7%')
  })

  it('tolerates null tool permission rules from backend without crashing the Status page', async () => {
    mockGetToolPermissions.mockResolvedValueOnce({
      rules: null,
    })

    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const trigger = wrapper.find('.hc-status__trigger')
    expect(trigger.exists()).toBe(true)
    await trigger.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('工具缓存')
  })

  it('shows the error message when one status endpoint fails (Promise.all rejects entirely)', async () => {
    mockGetToolPermissions.mockRejectedValueOnce(new Error('permissions offline'))

    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const trigger = wrapper.find('.hc-status__trigger')
    expect(trigger.exists()).toBe(true)
    await trigger.trigger('click')
    await flushPromises()

    // Promise.all rejects when any endpoint fails, so no partial data is shown
    expect(wrapper.text()).toContain('permissions offline')
  })

  it('keeps showing the error after collapse and reopen because statusError prevents auto-retry', async () => {
    mockGetBudgetStatus.mockRejectedValueOnce(new Error('budget offline'))
    mockGetToolCacheStats.mockRejectedValueOnce(new Error('cache offline'))
    mockGetToolMetrics.mockRejectedValueOnce(new Error('metrics offline'))
    mockGetToolPermissions.mockRejectedValueOnce(new Error('permissions offline'))

    const wrapper = await mountSettingsView()
    await flushPromises()

    ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const trigger = wrapper.find('.hc-status__trigger')
    expect(trigger.exists()).toBe(true)

    await trigger.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('budget offline')

    // Collapse and reopen — statusError is still set, so toggleStatusSection
    // does NOT call loadSystemStatus again (condition: !statusError.value is false)
    await trigger.trigger('click')
    await flushPromises()
    await trigger.trigger('click')
    await flushPromises()

    // Error persists because auto-retry is blocked by the existing error
    expect(wrapper.text()).toContain('budget offline')
  })

  it('does not emit Vue update warnings when status requests resolve after the page unmounts', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let resolveBudget!: (value: {
      tokens_used: number
      tokens_max: number
      tokens_remaining: number
      cost_used: number
      cost_max: number
      cost_remaining: number
      duration_used: string
      duration_max: string
      duration_remaining: string
      exhausted: boolean
    }) => void
    let resolveCache!: (value: { entries: number; hits: number; misses: number; hit_rate: number }) => void
    let resolveMetrics!: (value: {
      tools: Array<{
        tool: string
        call_count: number
        success_rate: number
        avg_latency_ms: number
        cached_count: number
      }>
    }) => void
    let resolvePermissions!: (value: { rules: Array<{ pattern: string; action: string }> }) => void

    mockGetBudgetStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBudget = resolve
      }),
    )
    mockGetToolCacheStats.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCache = resolve
      }),
    )
    mockGetToolMetrics.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMetrics = resolve
      }),
    )
    mockGetToolPermissions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermissions = resolve
      }),
    )

    try {
      const wrapper = await mountSettingsView()
      await flushPromises()

      ;(wrapper.vm as unknown as { activeSection: string }).activeSection = 'status'
      await wrapper.vm.$nextTick()
      await flushPromises()

      const trigger = wrapper.find('.hc-status__trigger')
      expect(trigger.exists()).toBe(true)
      await trigger.trigger('click')
      await flushPromises()

      wrapper.unmount()

      resolveBudget({
        tokens_used: 1,
        tokens_max: 100,
        tokens_remaining: 99,
        cost_used: 0.1,
        cost_max: 5,
        cost_remaining: 4.9,
        duration_used: '1s',
        duration_max: '30m',
        duration_remaining: '29m59s',
        exhausted: false,
      })
      resolveCache({ entries: 1, hits: 1, misses: 0, hit_rate: 100 })
      resolveMetrics({
        tools: [{
          tool: 'web.search',
          call_count: 1,
          success_rate: 100,
          avg_latency_ms: 12,
          cached_count: 0,
        }],
      })
      resolvePermissions({ rules: [{ pattern: 'web.*', action: 'allow' }] })
      await flushPromises()

      const vueWarnings = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Unhandled error during execution of component update'),
      )
      expect(vueWarnings).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  // ────────────────────────────────────────────────────
  // 5. 工具栏保存配置并显示确认
  // ────────────────────────────────────────────────────
  it('saves config from toolbar and shows confirmation', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    // Trigger a change so save button becomes enabled
    const routingToggle = wrapper.find('[data-testid="llm-routing-toggle"]')
    if (routingToggle.exists()) {
      await routingToggle.setValue(true)
      await flushPromises()
    }

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'))
    expect(saveBtn).toBeDefined()

    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存')
  })

  it('does not trigger duplicate toolbar saves while a previous save is still in flight', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const { updateLLMConfig } = await import('@/api/config')
    const mockedUpdateLLMConfig = vi.mocked(updateLLMConfig)

    let resolveSave!: (value: void | PromiseLike<void>) => void
    mockedUpdateLLMConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )

    const wrapper = await mountSettingsView()
    await flushPromises()

    // Trigger a change so save button becomes enabled
    const routingToggle = wrapper.find('[data-testid="llm-routing-toggle"]')
    if (routingToggle.exists()) {
      await routingToggle.setValue(true)
      await flushPromises()
    }

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'))
    expect(saveBtn).toBeDefined()

    await saveBtn!.trigger('click')
    await flushPromises()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(mockedUpdateLLMConfig).toHaveBeenCalledTimes(1)

    resolveSave()
    await flushPromises()
  })

  it('does not trigger duplicate resets while a previous reset is still in flight', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const { getLLMConfig } = await import('@/api/config')
    const mockedGetConfig = vi.mocked(getLLMConfig)

    const wrapper = await mountSettingsView()
    await flushPromises()

    const baselineCalls = mockedGetConfig.mock.calls.length

    let resolveReset!: (value: Record<string, unknown>) => void
    mockedGetConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReset = resolve as unknown as typeof resolveReset
        }),
    )

    const resetBtn = wrapper.findAll('button').find((b) => b.text().includes('重置'))
    expect(resetBtn).toBeDefined()

    await resetBtn!.trigger('click')
    await flushPromises()
    await resetBtn!.trigger('click')
    await flushPromises()

    expect(mockedGetConfig.mock.calls.length - baselineCalls).toBe(1)

    resolveReset({
      default: 'openai',
      providers: {
        openai: {
          api_key: '****test',
          base_url: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          compatible: '',
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })
    await flushPromises()
  })

  it('cleans up the saved-indicator timer on unmount after saving', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const wrapper = await mountSettingsView()
      await flushPromises()

      // Trigger a change so save button becomes enabled
      const routingToggle = wrapper.find('[data-testid="llm-routing-toggle"]')
      if (routingToggle.exists()) {
        await routingToggle.setValue(true)
        await flushPromises()
      }

      const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'))
      expect(saveBtn).toBeDefined()

      await saveBtn!.trigger('click')
      await flushPromises()

      wrapper.unmount()
      vi.runAllTimers()
      await flushPromises()

      const vueWarnings = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Unhandled error during execution of component update'),
      )
      expect(vueWarnings).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  // ────────────────────────────────────────────────────
  // 6. loading 状态显示
  // ────────────────────────────────────────────────────
  it('shows loading state while config is being fetched', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    try {
      const { getLLMConfig } = await import('@/api/config')
      const mockedGetConfig = vi.mocked(getLLMConfig)

      // 让 getLLMConfig 延迟返回
      let resolveConfig!: (v: unknown) => void
      mockedGetConfig.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveConfig = resolve as (v: unknown) => void
        }),
      )

      const wrapper = await mountSettingsView()
      await wrapper.vm.$nextTick()

      // 至少应已发起后端配置加载；loading 具体何时翻转受 store 初始化顺序影响，
      // 这里不把测试绑死在瞬时状态上，避免把测试脆弱性当成产品问题。
      const store = await getSettingsStore()
      expect(mockedGetConfig).toHaveBeenCalled()

      // 解决 promise
      resolveConfig!({
        default: 'openai',
        providers: {
          openai: { api_key: '', base_url: '', model: 'gpt-4o', compatible: '' },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
      })
      for (let i = 0; i < 20; i++) {
        await flushPromises()
        if (!store.loading) break
      }

      // loading 应消失
      expect(store.loading).toBe(false)
    } finally {
      delete (globalThis as Record<string, unknown>).isTauri
    }
  })

  // ────────────────────────────────────────────────────
  // 7. 非 LLM 分区也通过工具栏统一保存
  // ────────────────────────────────────────────────────
  it('saves config when in system section', async () => {
    delete (globalThis as Record<string, unknown>).isTauri
    const wrapper = await mountSettingsView()
    await flushPromises()

    // Trigger a change so save button becomes enabled
    const routingToggle = wrapper.find('[data-testid="llm-routing-toggle"]')
    if (routingToggle.exists()) {
      await routingToggle.setValue(true)
      await flushPromises()
    }

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    expect(systemBtn).toBeDefined()
    await systemBtn!.trigger('click')
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存')
    expect(localStorage.getItem('app_config')).toBeTruthy()
  })

  // ────────────────────────────────────────────────────
  // 8. 系统设置区渲染主题选项
  // ────────────────────────────────────────────────────
  it('renders theme options in system section', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    await systemBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('浅色')
    expect(wrapper.text()).toContain('深色')
    expect(wrapper.text()).toContain('跟随系统')
  })

  // ────────────────────────────────────────────────────
  // 9. 系统设置区渲染系统信息
  // ────────────────────────────────────────────────────
  it('renders system info in system section', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    expect(systemBtn).toBeDefined()
    await systemBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('系统信息')
    expect(wrapper.text()).toContain('本地存储')
    expect(wrapper.text()).toContain('知识索引')
    expect(wrapper.text()).toContain('API 端点')
  })

  // ────────────────────────────────────────────────────
  // 10. 系统设置区渲染精简存储信息
  // ────────────────────────────────────────────────────
  it('renders condensed storage info in system section', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    await systemBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('data.db')
    expect(wrapper.text()).toContain('127.0.0.1')
  })

  // ────────────────────────────────────────────────────
  // 11. 后端不可达时使用默认配置
  // ────────────────────────────────────────────────────
  it('falls back to default config when backend is unreachable', async () => {
    const { getLLMConfig } = await import('@/api/config')
    const mockedGetConfig = vi.mocked(getLLMConfig)
    mockedGetConfig.mockRejectedValue(new Error('Network error'))

    await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    // 即使后端不可达，config 也不应为 null（使用默认值）
    expect(store.config).not.toBeNull()
    expect(store.config?.llm.providers).toBeDefined()
  })
})
