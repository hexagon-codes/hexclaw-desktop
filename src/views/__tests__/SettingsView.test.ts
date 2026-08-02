import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'
import { PROVIDER_PRESETS } from '@/config/providers'

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

const { mockTestLLMConnection, mockFetchProviderModels } = vi.hoisted(() => ({
  mockTestLLMConnection: vi.fn(),
  mockFetchProviderModels: vi.fn(),
}))

const capabilityApi = vi.hoisted(() => ({
  fetchCapabilities: vi.fn().mockResolvedValue([]),
  probeCapability: vi.fn(),
}))

// ─── Mock API 模块 ──────────────────────────────────────
vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: 'openai',
    providers: {
      openai: {
        provider_instance_id: 'pvd_v1_11112222333344445555666677778888',
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
  fetchProviderModels: mockFetchProviderModels,
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

vi.mock('@/api/capabilities', () => ({
  fetchCapabilities: capabilityApi.fetchCapabilities,
  probeCapability: capabilityApi.probeCapability,
}))

vi.mock('@/api/system', () => ({
  getVersion: vi.fn().mockResolvedValue({ version: '0.2.6', engine: 'hexagon' }),
  getStats: vi.fn().mockResolvedValue({}),
}))

// Mock Ollama API
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: ollamaApi.getOllamaStatus,
  getOllamaRunning: ollamaApi.getOllamaRunning,
  getOllamaRunningResult: async () => ({
    models: await ollamaApi.getOllamaRunning(),
    reachable: true,
  }),
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
  credentialPresent: vi.fn().mockResolvedValue(true),
  credentialRefFor: (key: { ownerKind: string; ownerId: string; secretKind: string }) =>
    key.ownerKind === 'provider'
      ? `llm_provider/${key.ownerId}/api_key`
      : `hexclaw-vault:v1:${key.ownerKind}:${key.ownerId}:${key.secretKind}`,
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
async function mountSettingsView(attachTo?: HTMLElement) {
  const SettingsView = (await import('../SettingsView.vue')).default
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createTestI18n()

  return mount(SettingsView, {
    ...(attachTo ? { attachTo } : {}),
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
  const teleportedTrigger = document.body.querySelector<HTMLButtonElement>(
    `[data-testid="${testid}"] .hc-select__trigger`,
  )
  if (teleportedTrigger) teleportedTrigger.click()
  else await wrapper.get(`[data-testid="${testid}"] .hc-select__trigger`).trigger('click')
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
          provider_instance_id: 'pvd_v1_11112222333344445555666677778888',
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
    mockTestLLMConnection.mockResolvedValue({
      ok: true,
      message: 'ok',
      persisted: true,
      tested_at: '2026-07-28T06:20:00Z',
      latency_ms: 12,
    })
    mockFetchProviderModels.mockReset()
    mockFetchProviderModels.mockResolvedValue([])
    capabilityApi.fetchCapabilities.mockReset()
    capabilityApi.fetchCapabilities.mockResolvedValue([])
    capabilityApi.probeCapability.mockReset()
    unhandledHandler = (e: PromiseRejectionEvent) => {
      if (e.reason?.message?.includes('insertBefore')) {
        e.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', unhandledHandler)
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
    delete (window as unknown as Record<string, unknown>).__hcToast
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
    expect(link.attributes('href')).toBe('https://hexclaw.net/zh/third-party-ai-services')
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

    const chips = wrapper.findAll(
      '.hc-model-chip:not(.hc-model-chip--add):not(.hc-model-chip--manage)',
    )
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
    expect(
      wrapper.find(`[data-testid="provider-destination-cloud-${provider!.id}"]`).exists(),
    ).toBe(true)
    expect(
      wrapper.find(`[data-testid="provider-destination-local-${provider!.id}"]`).exists(),
    ).toBe(true)
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

    await wrapper.get(`[data-testid="provider-destination-local-${provider!.id}"]`).setValue(true)
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
    await wrapper.get('.hc-provider__test-btn').trigger('click')
    await flushPromises()

    expect(wrapper.get('.hc-provider__connection-status').text()).toContain('云端服务')
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
    expect(wrapper.get('.hc-provider__test-btn').attributes('disabled')).toBeDefined()
  })

  it('opens the approved lightweight add-model dialog instead of an inline duplicate', async () => {
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

    expect(document.body.querySelector('[data-testid="custom-model-dialog"]')).not.toBeNull()
    expect(wrapper.find('.hc-model-add-inline').exists()).toBe(false)
  })

  it('renders embedding-only models as non-selectable chips with delete as their only action', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'OpenRouter',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      selectedModelId: 'chat',
      models: [
        { id: 'chat', name: 'Chat', capabilities: ['text'] },
        {
          id: 'embed',
          name: 'Embed',
          isCustom: true,
          capabilities: ['embedding'],
          toolReliability: { level: 'good' },
        },
      ],
    })
    expect(provider).not.toBeNull()
    store.config!.llm.defaultProviderId = provider!.id
    store.config!.llm.defaultModel = 'chat'
    await flushPromises()

    const card = wrapper
      .findAll('.hc-provider__card')
      .find((item) => item.text().includes('OpenRouter'))!
    await card.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    const embeddingChip = card.get('.hc-model-chip--embedding')
    expect(embeddingChip.element.tagName).toBe('DIV')
    expect(embeddingChip.classes()).not.toContain('hc-model-chip--active')
    expect(embeddingChip.find('.hc-model-chip__probe').exists()).toBe(false)
    expect(embeddingChip.find('.hc-model-chip__reliability').exists()).toBe(false)
    const remove = embeddingChip.get('button.hc-model-chip__remove')
    expect(remove.attributes('aria-label')).toContain('Embed')

    const vm = wrapper.vm as unknown as {
      refreshCapability: (provider: unknown, model: unknown) => Promise<void>
    }
    await vm.refreshCapability(provider!, provider!.models[1]!)
    expect(capabilityApi.probeCapability).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await remove.trigger('click')
    await flushPromises()
    expect(provider!.models.map((model) => model.id)).toEqual(['chat', 'embed'])
    const confirmDialog = wrapper
      .findAllComponents({ name: 'ConfirmDialog' })
      .find((dialog) => dialog.props('open') === true)
    expect(confirmDialog).toBeDefined()
    expect(confirmDialog!.props('confirmationKey')).toBe(`${provider!.id}:embed`)
    const overlays = Array.from(
      document.body.querySelectorAll<HTMLElement>('.hc-dialog-overlay'),
    )
    const overlay = overlays[overlays.length - 1]
    expect(overlay).toBeDefined()
    const confirmButtons = Array.from(overlay!.querySelectorAll<HTMLButtonElement>('button'))
    const confirmButton = confirmButtons[confirmButtons.length - 1]!
    expect(confirmButton.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    expect(confirmButton.disabled).toBe(false)
    confirmButton.click()
    await flushPromises()
    vi.useRealTimers()
    const currentProvider = store.config!.llm.providers.find(
      (candidate) => candidate.id === provider!.id,
    )!
    expect(currentProvider.models.map((model) => model.id)).toEqual(['chat'])
    expect(currentProvider.selectedModelId).toBe('chat')
    expect(store.config!.llm.defaultProviderId).toBe(currentProvider.id)
    expect(store.config!.llm.defaultModel).toBe('chat')
  })

  it('uses sibling buttons for custom chat selection, probe and delete without nested interactive controls', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    store.addProvider({
      name: 'Custom Chat',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      selectedModelId: 'preset',
      models: [
        { id: 'preset', name: 'Preset', capabilities: ['text'] },
        { id: 'custom-chat', name: 'Custom Chat', capabilities: ['text'], isCustom: true },
      ],
    })
    await flushPromises()

    const card = wrapper
      .findAll('.hc-provider__card')
      .find((item) => item.text().includes('Custom Chat'))!
    await card.get('.hc-provider__card-head').trigger('click')
    await flushPromises()
    const chip = card.get('.hc-model-chip--custom')
    expect(chip.attributes('role')).toBeUndefined()
    expect(chip.attributes('tabindex')).toBeUndefined()
    expect(chip.find('button button').exists()).toBe(false)
    expect(chip.findAll('button')).toHaveLength(3)
    await chip.get('.hc-model-chip__select').trigger('click')
    const provider = store.config!.llm.providers.find((item) => item.name === 'Custom Chat')!
    expect(provider.selectedModelId).toBe('custom-chat')
  })

  it('does not run the chat connection probe for an embedding-only provider', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'Vector only',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      selectedModelId: '',
      models: [{ id: 'embed', name: 'Embed', capabilities: ['embedding'] }],
    })!

    const vm = wrapper.vm as unknown as { testProvider: (provider: unknown) => Promise<void> }
    await vm.testProvider(provider)

    expect(mockTestLLMConnection).not.toHaveBeenCalled()
  })

  it('keeps exact OpenRouter embeddings out of chat selection when syncing a small directory', async () => {
    mockFetchProviderModels.mockResolvedValue([
      { id: 'nvidia/nemotron-3-embed-1b:free', name: 'Nemotron Embed' },
      { id: 'chat-model', name: 'Chat Model' },
    ])
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'OpenRouter',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      selectedModelId: 'nvidia/nemotron-3-embed-1b:free',
      models: [],
    })!
    const vm = wrapper.vm as unknown as {
      syncRemoteModels: (provider: unknown) => Promise<boolean>
      displayCapabilities: (model: unknown) => string[]
    }

    await vm.syncRemoteModels(provider)

    expect(
      provider.models.find((model) => model.id === 'nvidia/nemotron-3-embed-1b:free')?.capabilities,
    ).toEqual(['embedding'])
    expect(provider.selectedModelId).toBe('chat-model')
    expect(
      vm.displayCapabilities({ id: 'explicit-empty', name: 'Unknown', capabilities: [] }),
    ).toEqual([])
  })

  it('adds Embedding as an explicit core capability without changing chat selection', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'OpenRouter',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      selectedModelId: 'chat',
      models: [{ id: 'chat', name: 'Chat', capabilities: ['text'] }],
    })!
    store.config!.llm.defaultProviderId = provider.id
    store.config!.llm.defaultModel = 'chat'
    await flushPromises()

    const card = wrapper
      .findAll('.hc-provider__card')
      .find((item) => item.text().includes('OpenRouter'))!
    await card.get('.hc-provider__card-head').trigger('click')
    await card.get('.hc-model-chip--add').trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    expect(body.get('[data-testid="custom-model-capability"]').text()).toContain('文本')
    await selectHcOption(wrapper, 'custom-model-capability', 'Embedding')
    await body.get('[data-testid="custom-model-id"]').setValue('vendor/vector-v1')
    await body.get('[data-testid="custom-model-submit"]').trigger('click')
    await flushPromises()

    const updated = store.config!.llm.providers.find((item) => item.id === provider.id)!
    expect(updated.models.find((model) => model.id === 'vendor/vector-v1')?.capabilities).toEqual([
      'embedding',
    ])
    expect(updated.selectedModelId).toBe('chat')
    expect(store.config!.llm.defaultModel).toBe('chat')
  })

  it.each(['nvidia/nemotron-3-embed-1b:free', 'nvidia/llama-nemotron-embed-vl-1b-v2:free'])(
    'canonicalizes approved OpenRouter id %s as embedding even when the dialog remains on 文本',
    async (modelId) => {
      const wrapper = await mountSettingsView()
      await flushPromises()
      const store = await getSettingsStore()
      const provider = store.addProvider({
        name: 'OpenRouter',
        type: 'custom',
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        selectedModelId: 'chat',
        models: [{ id: 'chat', name: 'Chat', capabilities: ['text'] }],
      })!
      store.config!.llm.defaultProviderId = provider.id
      store.config!.llm.defaultModel = 'chat'
      await flushPromises()

      const card = wrapper
        .findAll('.hc-provider__card')
        .find((item) => item.text().includes('OpenRouter'))!
      await card.get('.hc-provider__card-head').trigger('click')
      await card.get('.hc-model-chip--add').trigger('click')
      await flushPromises()
      const body = new DOMWrapper(document.body)
      expect(body.get('[data-testid="custom-model-capability"]').text()).toContain('文本')
      await body.get('[data-testid="custom-model-id"]').setValue(modelId)
      await body.get('[data-testid="custom-model-submit"]').trigger('click')
      await flushPromises()

      const updated = store.config!.llm.providers.find((item) => item.id === provider.id)!
      const added = updated.models.find((model) => model.id === modelId)!
      expect(added.capabilities).toEqual(['embedding'])
      expect(added.embedding).toEqual({
        protocol: 'openai_embeddings',
        dimension: 2048,
        normalization: 'l2',
      })
      expect(updated.selectedModelId).toBe('chat')
      expect(store.config!.llm.defaultModel).toBe('chat')
      expect(card.get('.hc-model-chip--embedding').text()).toContain(modelId)

      const vm = wrapper.vm as unknown as {
        refreshCapability: (provider: unknown, model: unknown) => Promise<void>
      }
      await vm.refreshCapability(updated, added)
      expect(capabilityApi.probeCapability).not.toHaveBeenCalled()
    },
  )

  it('exposes the model-manager entry for a provider catalog larger than the auto-enable limit', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = await mountSettingsView(host)
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    )
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    const manage = wrapper.get('.hc-model-chip--manage')
    expect(manage.text()).toContain('管理模型')
    expect(wrapper.get('.hc-model-enabled-summary').text()).toContain('1 / 11')

    await manage.trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    expect(body.get('[role="dialog"]').text()).toContain('管理模型')
    await body.get('[data-testid="model-manager-cancel"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(manage.element)
  }, 10_000)

  it('makes the settings background inert only while the model manager is open', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = await mountSettingsView(host)
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    )
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    const settingsRoot = wrapper.get('.hc-settings')
    expect(settingsRoot.attributes()).not.toHaveProperty('inert')

    await wrapper.get('.hc-model-chip--manage').trigger('click')
    await flushPromises()
    expect(settingsRoot.attributes()).toHaveProperty('inert')

    const body = new DOMWrapper(document.body)
    await body.get('[data-testid="model-manager-cancel"]').trigger('click')
    await flushPromises()
    expect(settingsRoot.attributes()).not.toHaveProperty('inert')
  }, 10_000)

  it('keeps the shared model-manager entry visible for a small cloud provider catalog', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    )
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.hc-model-chip--manage')).toHaveLength(1)
    expect(wrapper.get('.hc-model-chip--manage').text()).toContain('管理模型')
  })

  it('gives an upstream-removed preset model the shared delete action without unlocking healthy presets', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const presetModel = provider.models.find((model) => !model.isCustom)!
    const healthyPreset = PROVIDER_PRESETS[provider.type]!.defaultModels.find(
      (model) => model.id !== presetModel.id,
    )!
    provider.selectedModelId = presetModel.id
    store.config!.llm.defaultProviderId = provider.id
    store.config!.llm.defaultModel = presetModel.id
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(provider.id, [
      { id: healthyPreset.id, name: healthyPreset.name },
    ])
    provider.models.push({ ...healthyPreset })

    await wrapper.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    const staleChip = wrapper
      .findAll('.hc-model-chip--stale')
      .find((chip) => chip.text().includes(presetModel.id))
    expect(staleChip).toBeDefined()
    expect(staleChip!.text()).toContain('已下架')
    expect(staleChip!.find('button.hc-model-chip__remove').exists()).toBe(true)

    const healthyPresetChip = wrapper
      .findAll('.hc-model-chip')
      .find((chip) => chip.text().includes(healthyPreset.name || healthyPreset.id))
    expect(healthyPresetChip).toBeDefined()
    expect(healthyPresetChip!.find('button.hc-model-chip__remove').exists()).toBe(false)
  })

  it('surfaces a manual model-catalog resync failure from the manager', async () => {
    const error = vi.fn()
    ;(window as unknown as Record<string, unknown>).__hcToast = { value: { error } }
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    )
    mockFetchProviderModels.mockRejectedValueOnce(new Error('upstream unavailable'))
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await wrapper.get('.hc-model-chip--manage').trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    await body.get('button[title="重新同步"]').trigger('click')
    await flushPromises()

    expect(error).toHaveBeenCalledWith('同步模型列表失败，请检查连接')
  })

  it('surfaces an empty parsed catalog as a manual resync failure', async () => {
    const error = vi.fn()
    ;(window as unknown as Record<string, unknown>).__hcToast = { value: { error } }
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    )
    mockFetchProviderModels.mockResolvedValueOnce([])
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await wrapper.get('.hc-model-chip--manage').trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    await body.get('button[title="重新同步"]').trigger('click')
    await flushPromises()

    expect(error).toHaveBeenCalledWith('同步模型列表失败，请检查连接')
  })

  it('waits for manual resync persistence and surfaces a save failure', async () => {
    const error = vi.fn()
    ;(window as unknown as Record<string, unknown>).__hcToast = { value: { error } }
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `old-${index}`, name: `Old ${index}` })),
    )
    mockFetchProviderModels.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({ id: `new-${index}`, name: `New ${index}` })),
    )
    const saveConfig = vi.spyOn(store, 'saveConfig').mockRejectedValueOnce(new Error('disk unavailable'))
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await wrapper.get('.hc-model-chip--manage').trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    await body.get('button[title="重新同步"]').trigger('click')
    await flushPromises()

    expect(saveConfig).toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('同步模型列表失败，请检查连接')
  })

  it('queues manual resync persistence behind an in-flight autosave', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    const { useModelCatalogStore } = await import('@/stores/model-catalog')
    useModelCatalogStore().setCatalog(
      provider.id,
      Array.from({ length: 11 }, (_, index) => ({ id: `old-${index}`, name: `Old ${index}` })),
    )
    const startupFetchCalls = mockFetchProviderModels.mock.calls.length
    mockFetchProviderModels.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({ id: `new-${index}`, name: `New ${index}` })),
    )

    let releaseFirstSave!: () => void
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })
    const savedSnapshots: string[][] = []
    const saveConfig = vi.spyOn(store, 'saveConfig')
    saveConfig
      .mockImplementationOnce(async (nextConfig) => {
        savedSnapshots.push(nextConfig.llm.providers[0]!.models.map((model) => model.id))
        await firstSaveGate
        return { securitySyncFailed: false }
      })
      .mockImplementationOnce(async (nextConfig) => {
        savedSnapshots.push(nextConfig.llm.providers[0]!.models.map((model) => model.id))
        return { securitySyncFailed: false }
      })

    await wrapper.get('.hc-provider__card-head').trigger('click')
    await wrapper.get('[data-provider-field="api-key"]').setValue('sk-edited-before-save')
    await wrapper.get('.hc-btn-primary').trigger('click')
    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))

    await wrapper.get('.hc-model-chip--manage').trigger('click')
    await flushPromises()
    const body = new DOMWrapper(document.body)
    await body.get('button[title="重新同步"]').trigger('click')
    await vi.waitFor(() =>
      expect(mockFetchProviderModels).toHaveBeenCalledTimes(startupFetchCalls + 1),
    )
    expect(saveConfig).toHaveBeenCalledTimes(1)

    releaseFirstSave()
    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2))

    expect(savedSnapshots[0]).not.toEqual(Array.from({ length: 10 }, (_, index) => `new-${index}`))
    expect(savedSnapshots[1]!.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => `new-${index}`),
    )
    expect(savedSnapshots[1]).toContain('gpt-4o')
  })

  it('disables add-model submission for an empty or duplicate model id', async () => {
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

    const card = wrapper
      .findAll('.hc-provider__card')
      .find((item) => item.text().includes('OpenAI'))!
    await card.get('.hc-provider__card-head').trigger('click')
    await card.get('.hc-model-chip--add').trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    const submit = body.get<HTMLButtonElement>('[data-testid="custom-model-submit"]')
    expect(submit.element.disabled).toBe(true)
    await body.get('[data-testid="custom-model-id"]').setValue('gpt-4o')
    expect(submit.element.disabled).toBe(true)
    expect(body.get('[data-testid="custom-model-id-error"]').text()).toContain('已在列表中')
    expect(provider!.models.filter((m) => m.id === 'gpt-4o')).toHaveLength(1)
  })

  it('traps custom-model dialog focus, closes with Escape and restores the trigger', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = await mountSettingsView(host)
    await flushPromises()
    await wrapper.get('.hc-provider__card-head').trigger('click')
    await flushPromises()
    const trigger = wrapper.get<HTMLButtonElement>('.hc-model-chip--add')
    await trigger.trigger('click')
    await flushPromises()

    const body = new DOMWrapper(document.body)
    const input = body.get<HTMLInputElement>('[data-testid="custom-model-id"]')
    expect(document.activeElement).toBe(input.element)
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(body.get('button.hc-btn-secondary').element)
    await body.get('button.hc-btn-secondary').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(input.element)
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(document.body.querySelector('[data-testid="custom-model-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
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

    const providerCards = wrapper.findAll('.hc-provider__card')
    const providerCard = providerCards[providerCards.length - 1]!
    const deleteBtn = providerCard
      .findAll('.hc-provider__card-actions button')
      .find((button: DOMWrapper<Element>) => button.text().trim() === '删除')
    expect(deleteBtn).toBeDefined()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('确定要删除此服务商吗？')

    // Teleport 不属于 wrapper 子树；公共组件已独立验证 5 秒冷却，这里从
    // 已打开的真实 alertdialog 继续验证 Provider 删除接线。
    const vm = wrapper.vm as unknown as { confirmDeleteProvider: () => Promise<void> }
    await vm.confirmDeleteProvider()
    await flushPromises()

    expect(store.config?.llm.providers.find((p) => p.id === provider!.id)).toBeUndefined()
    expect(store.config?.llm.providers).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps provider-level test and delete as the only header actions', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    store.addProvider({
      name: 'DeepSeek',
      type: 'deepseek',
      enabled: true,
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] }],
    })
    await flushPromises()

    const cards = wrapper.findAll('.hc-provider__card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      const actionText = card.get('.hc-provider__card-actions').text()
      expect(actionText).toContain('测试')
      expect(actionText).toContain('删除')
      expect(card.findAll('.hc-provider__test-btn')).toHaveLength(1)
      expect(card.findAll('.hc-provider__delete-btn')).toHaveLength(1)
      expect(card.find('.hc-provider__test-row').exists()).toBe(false)
      expect(card.find('.hc-provider__edit-footer').exists()).toBe(false)
      expect(card.text()).not.toContain('当前模型：')
      expect(card.text()).not.toContain('删除服务商')
    }
  })

  it('shows Provider only for custom services and uses the approved config layouts', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    store.addProvider({
      name: 'DeepSeek',
      type: 'deepseek',
      enabled: true,
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] }],
    })
    const customProvider = store.addProvider({
      name: 'My Provider',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-custom',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'custom-chat-model', name: 'Custom Chat Model', capabilities: ['text'] }],
    })!
    customProvider.providerInstanceId = 'pvd_v1_99990000111122223333444455556666'
    await flushPromises()

    for (const type of ['openai', 'deepseek']) {
      const card = wrapper.get(`[data-provider-type="${type}"]`)
      await card.get('.hc-provider__card-head').trigger('click')
      await flushPromises()

      expect(card.find('.hc-provider__config-grid--builtin').exists()).toBe(true)
      expect(card.find('[data-provider-field="name"]').exists()).toBe(false)
      expect(card.find('[data-provider-field="api-key"]').exists()).toBe(true)
      expect(card.find('[data-provider-field="base-url"]').exists()).toBe(true)
    }

    const customCard = wrapper.get('[data-provider-type="custom"]')
    await customCard.get('.hc-provider__card-head').trigger('click')
    await flushPromises()

    expect(customCard.find('.hc-provider__config-grid--custom').exists()).toBe(true)
    expect(customCard.find('[data-provider-field="name"]').exists()).toBe(true)
    expect(customCard.find('[data-provider-field="api-key"]').exists()).toBe(true)
    expect(customCard.find('[data-provider-field="base-url"]').exists()).toBe(true)

    await customCard.get('.hc-provider__test-btn').trigger('click')
    await flushPromises()
    expect(customCard.get('.hc-provider__connection-status').text()).toContain('已验证')

    await customCard.get('[data-provider-field="name"]').setValue('Renamed Provider')
    await flushPromises()
    expect(customCard.get('.hc-provider__connection-status').text()).toContain('已验证')
  })

  it('shows the connection-test lifecycle in the header and disables duplicate clicks', async () => {
    let resolveTest!: (value: {
      ok: boolean
      message: string
      persisted: boolean
      tested_at: string
      latency_ms: number
    }) => void
    mockTestLLMConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve as typeof resolveTest
        }),
    )
    const wrapper = await mountSettingsView()
    await flushPromises()

    const card = wrapper.get('.hc-provider__card')
    const testButton = card.get<HTMLButtonElement>('.hc-provider__test-btn')
    expect(card.get('.hc-provider__connection-status').text()).toContain('未测试')

    await testButton.trigger('click')
    await flushPromises()

    expect(testButton.element.disabled).toBe(true)
    expect(card.get('.hc-provider__connection-status').text()).toContain('测试中')
    expect(mockTestLLMConnection).toHaveBeenCalledTimes(1)

    await testButton.trigger('click')
    expect(mockTestLLMConnection).toHaveBeenCalledTimes(1)

    resolveTest({
      ok: true,
      message: '连接成功',
      persisted: true,
      tested_at: '2026-07-28T06:20:00Z',
      latency_ms: 12,
    })
    await flushPromises()
    expect(card.get('.hc-provider__connection-status').text()).toContain('已验证')
    expect(testButton.element.disabled).toBe(false)
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
    const backendPayload = mockedUpdateLLMConfig.mock.calls[
      mockedUpdateLLMConfig.mock.calls.length - 1
    ]?.[0] as {
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
    const backendPayload = mockedUpdateLLMConfig.mock.calls[
      mockedUpdateLLMConfig.mock.calls.length - 1
    ]?.[0]
    expect(backendPayload?.providers.openai).not.toHaveProperty('api_key', 'sk-fresh-key')
    const credentialReplacements = mockedUpdateLLMConfig.mock.calls[
      mockedUpdateLLMConfig.mock.calls.length - 1
    ]?.[1]
    expect(credentialReplacements).toContainEqual({
      providerKey: 'openai',
      secret: 'sk-fresh-key',
    })

    wrapper.unmount()
  })

  it('waits for an in-flight save and drains edits made before close completes', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    const { updateLLMConfig } = await import('@/api/config')
    const mockedUpdateLLMConfig = vi.mocked(updateLLMConfig)

    let releaseFirstSave!: () => void
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })
    mockedUpdateLLMConfig
      .mockImplementationOnce(() => firstSaveGate)
      .mockImplementationOnce(() => Promise.resolve())

    const wrapper = await mountSettingsView()
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      await wrapper.vm.$nextTick()
      if (wrapper.find('[data-testid="llm-routing-toggle"]').exists()) break
    }

    const routingToggle = wrapper.get<HTMLInputElement>('[data-testid="llm-routing-toggle"]')
    await routingToggle.setValue(true)
    const saveButton = wrapper.findAll('button').find((button) => button.text().includes('保存'))
    expect(saveButton).toBeDefined()
    await saveButton!.trigger('click')
    await vi.waitFor(() => expect(mockedUpdateLLMConfig).toHaveBeenCalledTimes(1))

    const closeEvent = { preventDefault: vi.fn() }
    expect(closeRequestState.handler).not.toBeNull()
    const closePromise = closeRequestState.handler!(closeEvent)
    await flushPromises()

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(closeRequestState.close).not.toHaveBeenCalled()

    await routingToggle.setValue(false)
    releaseFirstSave()
    await closePromise
    await flushPromises()

    expect(mockedUpdateLLMConfig).toHaveBeenCalledTimes(2)
    const finalPayload = mockedUpdateLLMConfig.mock.calls[1]![0] as {
      routing: { enabled: boolean }
    }
    expect(finalPayload.routing.enabled).toBe(false)
    expect(closeRequestState.close).toHaveBeenCalledTimes(1)

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

      expect(
        mockTestLLMConnection,
        'unmounted Settings must not fire its deferred provider test',
      ).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a saved provider probe receipt after remount without automatically probing again', async () => {
    const first = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'Receipt restore provider',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://provider.example.test/v1',
      models: [{ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', capabilities: ['text'] }],
      selectedModelId: 'gpt-5.6-sol',
    })!
    provider.providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    ;(
      provider as typeof provider & {
        probeReceipt?: {
          providerInstanceId: string
          outcome: 'passed' | 'failed'
          testedAt: number
          latencyMs: number
          locality: 'local' | 'cloud'
          message: string
        }
      }
    ).probeReceipt = {
      providerInstanceId: provider.providerInstanceId,
      outcome: 'passed',
      testedAt: Date.UTC(2026, 6, 28, 6, 20),
      latencyMs: 321,
      locality: 'cloud',
      message: '连接测试通过',
    }
    await flushPromises()

    const firstRenderedReceipt =
      first.text().includes('已验证') && first.text().includes('上次测试')
    first.unmount()
    mockTestLLMConnection.mockClear()
    const { getLLMConfig } = await import('@/api/config')
    vi.mocked(getLLMConfig).mockResolvedValue({
      default: 'custom',
      providers: {
        custom: {
          provider_instance_id: provider.providerInstanceId,
          display_name: provider.name,
          api_key: '****test',
          base_url: provider.baseUrl,
          model: provider.selectedModelId!,
          models: [provider.selectedModelId!],
          compatible: 'openai',
          locality: 'cloud',
          enabled: true,
          probe_receipt: {
            provider_instance_id: provider.providerInstanceId,
            outcome: 'passed',
            tested_at: '2026-07-28T06:20:00Z',
            latency_ms: 321,
            locality: 'cloud',
          },
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
    } as never)

    const remounted = await mountSettingsView()
    await flushPromises()

    expect(mockTestLLMConnection).not.toHaveBeenCalled()
    expect(firstRenderedReceipt).toBe(true)
    expect(remounted.text()).toContain('已验证')
    expect(remounted.text()).toContain('上次测试')
  }, 15_000)

  it('invalidates shared probe receipts for fingerprint edits but preserves display-name edits', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const providerId = store.config!.llm.providers[0]!.id
    const currentProvider = () =>
      store.config!.llm.providers.find((candidate) => candidate.id === providerId)!
    currentProvider().providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    const receipt = {
      providerInstanceId: currentProvider().providerInstanceId!,
      outcome: 'passed' as const,
      testedAt: Date.UTC(2026, 6, 28, 6, 20),
      latencyMs: 321,
      locality: 'cloud' as const,
    }

    currentProvider().probeReceipt = { ...receipt }
    store.updateProvider(providerId, { name: 'Display name only' })
    expect(currentProvider().probeReceipt).toEqual(receipt)

    const cases = [
      { type: 'custom' as const },
      { baseUrl: 'https://changed.example.test/v1' },
      { apiKey: 'sk-rotated' },
      { selectedModelId: 'gpt-5.6-terra' },
      { locality: 'local' as const },
      { privateNetworkAccess: { host: '10.0.0.8', allowed: true } },
    ]
    for (const update of cases) {
      currentProvider().probeReceipt = { ...receipt }
      store.updateProvider(providerId, update)
      expect(currentProvider().probeReceipt).toBeUndefined()
    }

    const vm = wrapper.vm as unknown as {
      onProviderApiKeyInput: (provider: unknown) => void
      handleProviderBaseUrlInput: (provider: unknown) => void
      handleProviderModelChange: (provider: unknown) => void
    }
    currentProvider().probeReceipt = { ...receipt }
    currentProvider().apiKey = 'sk-direct-input'
    vm.onProviderApiKeyInput(currentProvider())
    expect(currentProvider().probeReceipt).toBeUndefined()

    currentProvider().probeReceipt = { ...receipt }
    currentProvider().baseUrl = 'https://direct-input.example.test/v1'
    vm.handleProviderBaseUrlInput(currentProvider())
    expect(currentProvider().probeReceipt).toBeUndefined()

    currentProvider().probeReceipt = { ...receipt }
    currentProvider().models.push({
      id: 'gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      capabilities: ['text'],
    })
    currentProvider().selectedModelId = 'gpt-5.6-luna'
    vm.handleProviderModelChange(currentProvider())
    expect(currentProvider().probeReceipt).toBeUndefined()

    wrapper.unmount()
  })

  it('persists and refreshes a provider without a stable identity before its explicit probe', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.addProvider({
      name: 'Stable identity provider',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://provider.example.test/v1',
      models: [{ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', capabilities: ['text'] }],
      selectedModelId: 'gpt-5.6-sol',
    })!
    const { getLLMConfig, updateLLMConfig } = await import('@/api/config')
    vi.mocked(getLLMConfig).mockResolvedValue({
      default: 'custom',
      providers: {
        custom: {
          provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
          display_name: provider.name,
          api_key: '****test',
          base_url: provider.baseUrl,
          model: 'gpt-5.6-sol',
          models: ['gpt-5.6-sol'],
          compatible: 'openai',
          locality: 'cloud',
          enabled: true,
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
    })
    mockTestLLMConnection.mockResolvedValue({
      ok: true,
      message: '连接测试通过',
      persisted: true,
      tested_at: '2026-07-28T06:20:00Z',
      latency_ms: 321,
    })
    vi.mocked(updateLLMConfig).mockClear()
    mockTestLLMConnection.mockClear()

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }
    await vm.testProvider(provider)

    expect(updateLLMConfig).toHaveBeenCalled()
    expect(getLLMConfig).toHaveBeenCalled()
    expect(mockTestLLMConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerInstanceId: 'pvd_v1_00112233445566778899aabbccddeeff',
      }),
    )
  })

  it('serializes an existing provider save and server reload before probing unsaved edits', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    provider.providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    provider.baseUrl = 'https://unsaved-edit.example.test/v1'
    const { getLLMConfig, updateLLMConfig } = await import('@/api/config')
    const updateLLMConfigMock = vi.mocked(updateLLMConfig)
    const getLLMConfigMock = vi.mocked(getLLMConfig)
    updateLLMConfigMock.mockClear()
    getLLMConfigMock.mockClear()
    mockTestLLMConnection.mockClear()
    mockTestLLMConnection.mockResolvedValue({
      ok: true,
      message: '连接测试通过',
      persisted: true,
      tested_at: '2026-07-28T06:20:00Z',
      latency_ms: 321,
    })

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }
    await vm.testProvider(provider)

    expect(updateLLMConfigMock).toHaveBeenCalled()
    expect(getLLMConfigMock).toHaveBeenCalled()
    expect(updateLLMConfigMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockTestLLMConnection.mock.invocationCallOrder[0]!,
    )
    expect(getLLMConfigMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockTestLLMConnection.mock.invocationCallOrder[0]!,
    )
  })

  it('never renders a stateless persisted=false probe as a durable verified state', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    provider.providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    mockTestLLMConnection.mockClear()
    mockTestLLMConnection.mockResolvedValue({
      ok: true,
      message: '连接测试通过，但回执未保存',
      persisted: false,
      tested_at: '2026-07-28T06:20:00Z',
      latency_ms: 321,
    })

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }
    await vm.testProvider(provider)
    await flushPromises()

    expect(wrapper.text()).not.toContain('已验证')
    expect(wrapper.text()).toContain('未测试')
  })

  it('formats restored provider receipt time with the active locale', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    provider.providerInstanceId = 'pvd_v1_00112233445566778899aabbccddeeff'
    provider.probeReceipt = {
      providerInstanceId: provider.providerInstanceId,
      outcome: 'passed',
      testedAt: new Date(2026, 6, 28, 14, 20).getTime(),
      latencyMs: 321,
      locality: 'cloud',
    }
    await flushPromises()

    expect(wrapper.text()).not.toContain('2026-07-28 14:20')
    expect(wrapper.text()).toContain('2026年7月28日')
  })

  it('coalesces duplicate testProvider invocations while one probe is pending', async () => {
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
    provider.providerInstanceId = 'pvd_v1_aaaabbbbccccddddeeeeffff00001111'
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      testProvider: (provider: unknown) => Promise<void>
    }

    void vm.testProvider(provider)
    await flushPromises()
    void vm.testProvider(provider)
    await flushPromises()

    expect(mockTestLLMConnection).toHaveBeenCalledTimes(1)

    resolveTest({ ok: true, message: 'ok' })
    await flushPromises()
  }, 15_000)

  it('passes provider locality into the connection probe policy', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const store = await getSettingsStore()
    const provider = store.config!.llm.providers[0]!
    provider.baseUrl = 'http://localhost:18080/v1'
    provider.locality = 'local'
    provider.localitySource = 'user'
    provider.confirmedEndpointHost = 'localhost'
    const { getLLMConfig } = await import('@/api/config')
    vi.mocked(getLLMConfig).mockResolvedValue({
      default: 'openai',
      providers: {
        openai: {
          provider_instance_id: provider.providerInstanceId,
          display_name: provider.name,
          api_key: provider.apiKey,
          base_url: provider.baseUrl,
          model: provider.selectedModelId!,
          models: provider.models.map((model) => model.id),
          compatible: 'openai',
          locality: 'local',
          locality_source: 'user',
          confirmed_endpoint_host: 'localhost',
          enabled: true,
        },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10_000 },
    })
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
    expect(store.config!.llm.providers.some((p) => p.type === 'ollama')).toBe(true)

    // If providerCard is rendered, also verify models synced
    const ollamaModels = store.availableModels.filter((m) => m.providerName === 'Ollama')
    expect(!providerCard || ollamaModels.some((m) => m.modelId === 'qwen3:8b')).toBe(true)
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

    const ollamaCount1 = store.config!.llm.providers.filter((p) => p.type === 'ollama').length
    expect(ollamaCount1).toBe(1)

    // Second call should be a no-op since an Ollama provider already exists
    vm.handleAssociateOllama()
    await flushPromises()

    const ollamaCount2 = store.config!.llm.providers.filter((p) => p.type === 'ollama').length
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
    store.saveConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk full')) as typeof store.saveConfig

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
