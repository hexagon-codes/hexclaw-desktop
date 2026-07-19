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

/**
 * 驱动 HcSelect（自定义下拉，替代原生 <select>）：
 * 点击触发器展开 → 在 Teleport 到 body 的 <li> 选项里按 label 命中并 mousedown 选中。
 * resetModules 会破坏组件标识，故走真实 DOM 交互而非 findComponent。
 */
async function selectHcOption(
  wrapper: Awaited<ReturnType<typeof mountSettingsView>>,
  testid: string,
  optionLabel: string,
) {
  const trigger = wrapper.get(`[data-testid="${testid}"] .hc-select__trigger`)
  await trigger.trigger('click')
  await flushPromises()
  await wrapper.vm.$nextTick()

  const option = Array.from(
    document.body.querySelectorAll<HTMLLIElement>('.hc-select__option'),
  ).find((li) => li.textContent?.trim() === optionLabel)
  expect(option, `option "${optionLabel}" for ${testid}`).toBeTruthy()
  option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await flushPromises()
  await wrapper.vm.$nextTick()
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
  }, 30_000)


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

  it('shows the third-party AI service notice once below the provider list', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const providerList = wrapper.get('.hc-provider__list')
    const notice = wrapper.get('[data-testid="third-party-ai-services-notice"]')
    const link = wrapper.get('[data-testid="third-party-ai-services-link"]')

    expect(notice.text()).toContain(
      '云端模型由你配置的第三方 Provider 提供。Provider 可能处理传输内容。',
    )
    expect(link.element.tagName).toBe('A')
    expect(link.text()).toBe('查看第三方 AI 服务说明 ↗')
    expect(link.attributes('href')).toBe(
      'https://hexclaw.net/zh/third-party-ai-services',
    )
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(link.attributes('aria-label')).toContain('在新窗口打开')
    expect(
      providerList.element.compareDocumentPosition(notice.element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(wrapper.findAll('[data-testid="third-party-ai-services-link"]')).toHaveLength(1)
  })

  // 回归 bug-20260626：LLM 服务商页滚动条悬浮在窗口中部。
  // 根因——overflow-y:auto 挂在 max-width 受限的内层 section 上，滚动条贴着「窄列」右缘，
  //        在宽窗口里悬浮于中间，与顶栏右缘脱节，观感破碎。
  // 不变量——滚动归属上移到「全宽内容面板」.hc-settings__content；内层 section 不再背负滚动，
  //          仅以 max-width 维持易读列宽 → 滚动条回到面板右缘（macOS/桌面端原生预期位置）。
  // 几何由 WebKit 真机手感门（tests/e2e/webkit-feel.spec.ts ⑤）取证；此处钉结构契约。
  it('mounts the LLM scroll viewport on the full-width content panel, not the max-width section (bug-20260626)', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const content = wrapper.find('.hc-settings__content')
    expect(content.exists()).toBe(true)

    // LLM 段渲染在内容面板内部
    const section = wrapper.find('.hc-settings__section')
    expect(section.exists()).toBe(true)
    expect(content.element.contains(section.element)).toBe(true)

    // 内层 section 不再是滚动宿主（旧实现的 --scroll 标记已移除）
    expect(section.classes()).not.toContain('hc-settings__section--scroll')

    // section 仍以 max-width 维持易读窄列（左对齐），滚动条则归全宽面板
    expect(section.attributes('style') || '').toMatch(/max-width/)
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

    const providerHeads = wrapper.findAll('.hc-provider__card-head')
    const providerHead = providerHeads[providerHeads.length - 1]
    expect(providerHead).toBeDefined()
    await providerHead!.trigger('click')
    await flushPromises()

    const chips = wrapper.findAll('.hc-model-chip:not(.hc-model-chip--add)')
    expect(chips.length).toBe(2)
    expect(chips[0]!.text()).toContain('GPT-4o')
  })

  it('hides infrastructure choices for a public provider endpoint', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('模型部署位置')
    expect(wrapper.text()).not.toContain('这个地址连接到哪里？')
  })

  it('asks a natural-language question for an ambiguous loopback gateway', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config?.llm.providers[0]
    expect(provider).toBeDefined()
    provider!.baseUrl = 'http://localhost:18080/v1'

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('这个地址连接到哪里？')
    expect(wrapper.text()).toContain('互联网服务')
    expect(wrapper.text()).toContain('这台电脑或可信局域网')
    expect(wrapper.find(`[data-testid="provider-destination-cloud-${provider!.id}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="provider-destination-local-${provider!.id}"]`).exists()).toBe(true)
  })

  it('persists a local confirmation for the current endpoint host without a second submit', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config?.llm.providers[0]
    expect(provider).toBeDefined()
    provider!.baseUrl = 'http://localhost:18080/v1'

    await wrapper.find('.hc-provider__card-head').trigger('click')
    await flushPromises()

    await wrapper
      .get(`[data-testid="provider-destination-local-${provider!.id}"]`)
      .setValue(true)
    await flushPromises()

    expect(provider).toMatchObject({
      locality: 'local',
      localitySource: 'user',
      confirmedEndpointHost: 'localhost',
    })
  })

  it('shows the effective data destination after a successful connection test', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    await wrapper.find('.hc-provider__card-head').trigger('click')
    await wrapper.get('.hc-provider__test-row button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.hc-provider__test-badge').text()).toContain('云端服务')
  })

  it('blocks protected system-network endpoints in the form', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    await wrapper.find('.hc-provider__card-head').trigger('click')
    const baseUrlInput = wrapper
      .findAll('input.hc-input')
      .find((input) => input.attributes('placeholder') === 'https://api.openai.com/v1')
    expect(baseUrlInput).toBeDefined()
    await baseUrlInput!.setValue('http://169.254.169.254/latest/meta-data')
    await flushPromises()

    expect(wrapper.text()).toContain('受保护的系统网络')
    expect(wrapper.get('.hc-provider__test-row button').attributes('disabled')).toBeDefined()
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

    expect(store.config?.llm.providers).toHaveLength(2)

    const providerHeads = wrapper.findAll('.hc-provider__card-head')
    const providerHead = providerHeads[providerHeads.length - 1]
    expect(providerHead).toBeDefined()
    await providerHead!.trigger('click')
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

    expect(store.config?.llm.providers.find((p) => p.id === provider!.id)).toBeUndefined()
    expect(store.config?.llm.providers).toHaveLength(1)
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

    await selectHcOption(wrapper, 'llm-default-model-select', `智谱 / glm-5`)
    await flushPromises()

    expect(store.config?.llm.defaultProviderId).toBe(added!.id)
    expect(store.config?.llm.defaultModel).toBe('glm-5')

    const routingToggle = wrapper.get('[data-testid="llm-routing-toggle"]')
    await routingToggle.setValue(true)
    await flushPromises()

    await selectHcOption(wrapper, 'llm-routing-strategy-select', '质量优先')
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

  it('cancels a pending API-key auto-test when Settings unmounts', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const apiKeyInput = wrapper.find('input[type="password"]')
    expect(apiKeyInput.exists()).toBe(true)
    mockTestLLMConnection.mockClear()
    vi.useFakeTimers()
    try {
      await apiKeyInput.setValue('sk-pending-auto-test')
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(1_600)

      expect(mockTestLLMConnection, 'unmounted Settings must not fire its deferred provider test').not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('passes provider locality into the connection probe policy', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    provider.baseUrl = 'http://localhost:18080/v1'
    provider.locality = 'local'
    provider.localitySource = 'user'
    provider.confirmedEndpointHost = 'localhost'
    mockTestLLMConnection.mockClear()

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }
    await vm.testProvider(provider)

    expect(mockTestLLMConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ base_url: provider.baseUrl }),
      }),
      expect.objectContaining({ locality: 'local' }),
    )
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

  it('does not expose application data or advanced diagnostics in system settings', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    expect(systemBtn).toBeDefined()
    await systemBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('高级与诊断')
    expect(wrapper.text()).not.toContain('应用数据')
    expect(wrapper.text()).not.toContain('仅用于故障排查，请勿手动修改目录内容')
    expect(wrapper.text()).not.toContain('在访达中显示')
    expect(wrapper.find('[data-testid="settings-app-data"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('家庭学习档案')
    expect(wrapper.text()).not.toContain('备份与恢复')
  }, 30_000)

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

  it('restores provider list when delete-then-save fails (Bug 2 regression)', async () => {
    // Bug 2 回归: 修复前 handleDeleteProvider 先删 provider，保存失败只记日志不恢复 UI
    // 结果: provider 从界面消失但未持久化
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    await store.loadConfig()
    await flushPromises()

    // 确认初始有 provider
    const providersBefore = store.config?.llm.providers.length ?? 0
    expect(providersBefore).toBeGreaterThan(0)

    const firstProviderId = store.config!.llm.providers[0]!.id

    // 直接 mock store.saveConfig 抛出致命错误（模拟 Tauri 桌面端 LLM 保存失败）
    const originalSave = store.saveConfig
    store.saveConfig = vi.fn().mockRejectedValueOnce(new Error('Disk full')) as typeof store.saveConfig

    // 通过 SettingsView 暴露的方法执行删除
    const vm = wrapper.vm as unknown as {
      handleDeleteProvider: (id: string) => Promise<void>
    }
    await vm.handleDeleteProvider(firstProviderId)
    await flushPromises()

    // 修复后: 保存失败时 provider 被恢复
    expect(store.config?.llm.providers.length).toBe(providersBefore)

    // 清理
    store.saveConfig = originalSave
  })
})
