import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
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
  updateLLMConfig: vi.fn().mockImplementation((config) => Promise.resolve(config)),
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

describe('SettingsView — E2E 关键路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    document.body.innerHTML = ''
    closeRequestState.handler = null
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  // ────────────────────────────────────────────────────
  // 1. 渲染所有设置分区导航
  // ────────────────────────────────────────────────────
  it('renders all settings sections in sidebar', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const expectedSections = ['LLM 服务商', '外观设置', '存储设置']

    for (const section of expectedSections) {
      expect(wrapper.text()).toContain(section)
    }
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

  it('does not mount edit model modal content until a model is being edited', async () => {
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

    expect(document.body.textContent).not.toContain('编辑模型')

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const editModelBtn = wrapper.find('.hc-model-card__action')
    expect(editModelBtn.exists()).toBe(true)
    await editModelBtn.trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('编辑模型')
  })

  it('opens add model form without rendering the edit model modal', async () => {
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

    const providerHead = wrapper.find('.hc-provider__card-head')
    expect(providerHead.exists()).toBe(true)
    await providerHead.trigger('click')
    await flushPromises()

    const addModelBtn = wrapper.findAll('button').find((b) => b.text().includes('添加模型'))
    expect(addModelBtn).toBeDefined()
    await addModelBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.hc-model-add-form').exists()).toBe(true)
    expect(document.body.textContent).not.toContain('编辑模型')
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
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      if (!store.loading && store.config) break
    }

    const added = store.addProvider({
      name: '智谱',
      type: 'custom',
      enabled: true,
      apiKey: 'sk-zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
    })
    await flushPromises()

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
      if (wrapper.find('.hc-provider__header .hc-btn-sm').exists()) break
    }

    const addProviderBtn = wrapper.find('.hc-provider__header .hc-btn-sm')
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

  // ────────────────────────────────────────────────────
  // 4. 切换设置分区
  // ────────────────────────────────────────────────────
  it('switches between settings sections', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const appearanceBtn = wrapper.findAll('button').find((b) => b.text().includes('外观设置'))
    expect(appearanceBtn).toBeDefined()
    await appearanceBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('浅色')
    expect(wrapper.text()).toContain('深色')
    expect(wrapper.text()).toContain('跟随系统')

    const storageBtn = wrapper.findAll('button').find((b) => b.text().includes('存储设置'))
    expect(storageBtn).toBeDefined()
    await storageBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('运行时状态')
    expect(wrapper.text()).toContain('桌面模式')
    expect(wrapper.text()).toContain('desktop')
  })

  // ────────────────────────────────────────────────────
  // 5. 工具栏保存配置并显示确认
  // ────────────────────────────────────────────────────
  it('saves config from toolbar and shows confirmation', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存设置'))
    expect(saveBtn).toBeDefined()

    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存')
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
      // 此时 store.loading 应为 true（getLLMConfig 尚未 resolve）
      const store = await getSettingsStore()
      expect(store.loading).toBe(true)

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
  it('saves config when in appearance section', async () => {
    delete (globalThis as Record<string, unknown>).isTauri
    const wrapper = await mountSettingsView()
    await flushPromises()

    const appearanceBtn = wrapper.findAll('button').find((b) => b.text().includes('外观设置'))
    expect(appearanceBtn).toBeDefined()
    await appearanceBtn!.trigger('click')
    await flushPromises()

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存设置'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存')
    expect(localStorage.getItem('app_config')).toBeTruthy()
  })

  // ────────────────────────────────────────────────────
  // 8. 外观设置区渲染主题选项
  // ────────────────────────────────────────────────────
  it('renders theme options in appearance section', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const appearanceBtn = wrapper.findAll('button').find((b) => b.text().includes('外观设置'))
    await appearanceBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('浅色')
    expect(wrapper.text()).toContain('深色')
    expect(wrapper.text()).toContain('跟随系统')
  })

  // ────────────────────────────────────────────────────
  // 9. 通知设置区渲染所有开关
  // ────────────────────────────────────────────────────
  it('renders storage section details', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const storageBtn = wrapper.findAll('button').find((b) => b.text().includes('存储设置'))
    expect(storageBtn).toBeDefined()
    await storageBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('运行时状态')
    expect(wrapper.text()).toContain('本地数据存储')
    expect(wrapper.text()).toContain('本地会话库')
    expect(wrapper.text()).toContain('向量数据库')
    expect(wrapper.text()).toContain('语义缓存')
    expect(wrapper.text()).not.toContain('已启用模块')
  })

  // ────────────────────────────────────────────────────
  // 10. 存储设置区渲染存储信息
  // ────────────────────────────────────────────────────
  it('renders storage info in storage section', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    const storageBtn = wrapper.findAll('button').find((b) => b.text().includes('存储设置'))
    await storageBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('gpt-4o')
    expect(wrapper.text()).toContain('127.0.0.1:16060')
    expect(wrapper.text()).toContain('SQLite')
    expect(wrapper.text()).toContain('hexclaw.db')
    expect(wrapper.text()).toContain('FTS5 + 向量 BLOB')
    expect(wrapper.text()).toContain('语义缓存')
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
