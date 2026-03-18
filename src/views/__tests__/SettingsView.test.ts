import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SettingsView from '../SettingsView.vue'
import { useSettingsStore } from '@/stores/settings'
import zhCN from '@/i18n/locales/zh-CN'

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

// Mock secure-store: jsdom 中 PBKDF2 100k 迭代太慢，直接跳过加密
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// Mock Tauri Store（isTauri=true 时 settings store 会 import 它）
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

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
    messages: { 'zh-CN': zhCN },
  })
}

/**
 * Mock router (SettingsView 中 MCP 页面跳转需要)
 */
const mockRouter = {
  push: vi.fn(),
}

/**
 * 挂载 SettingsView 的辅助函数
 */
function mountSettingsView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createTestI18n()

  return mount(SettingsView, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        PageHeader: {
          props: ['title'],
          template: '<div class="page-header-stub">{{ title }}</div>',
        },
        LoadingState: {
          template: '<div data-testid="loading-state">加载中...</div>',
        },
      },
      mocks: {
        $router: mockRouter,
      },
    },
  })
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
    // 每个测试前设置 isTauri，使 settings store 走后端 LLM 加载路径
    ;(globalThis as Record<string, unknown>).isTauri = true
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  // ────────────────────────────────────────────────────
  // 1. 渲染所有设置分区导航
  // ────────────────────────────────────────────────────
  it('renders all settings sections in sidebar', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    const expectedSections = [
      'LLM 服务商',
      '安全设置',
      '通用设置',
      '外观设置',
      '通知设置',
      '通知推送',
      '存储设置',
      'MCP 服务配置',
      '运行引擎',
    ]

    for (const section of expectedSections) {
      expect(wrapper.text()).toContain(section)
    }
  })

  // ────────────────────────────────────────────────────
  // 2. 挂载时加载配置
  // ────────────────────────────────────────────────────
  it('loads config on mount', async () => {
    mountSettingsView()

    // loadConfig 是多层 async 链：
    // onMounted → loadConfig → LazyStore.get → loadLLMFromBackend → getLLMConfig
    // 使用 waitFor 模式确保异步加载完成
    const store = useSettingsStore()
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
    const wrapper = mountSettingsView()
    await flushPromises()

    // LLM 服务商配置表单应可见
    expect(wrapper.text()).toContain('LLM 服务商')
  })

  // ────────────────────────────────────────────────────
  // 4. 切换设置分区
  // ────────────────────────────────────────────────────
  it('switches between settings sections', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    // 切换到安全设置
    const securityBtn = wrapper.findAll('button').find((b) => b.text().includes('安全设置'))
    expect(securityBtn).toBeDefined()
    await securityBtn!.trigger('click')
    await flushPromises()

    // 安全设置内容应可见
    expect(wrapper.text()).toContain('安全网关')
    expect(wrapper.text()).toContain('注入检测')
    expect(wrapper.text()).toContain('PII 过滤')
    expect(wrapper.text()).toContain('内容过滤')

    // 切换到通用设置
    const generalBtn = wrapper.findAll('button').find((b) => b.text().includes('通用设置'))
    await generalBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('语言')
    expect(wrapper.text()).toContain('日志级别')
    expect(wrapper.text()).toContain('数据目录')

    // 切换到运行引擎
    const engineBtn = wrapper.findAll('button').find((b) => b.text().includes('运行引擎'))
    await engineBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('HexClaw Engine')
  })

  // ────────────────────────────────────────────────────
  // 5. 保存配置并显示确认
  // ────────────────────────────────────────────────────
  it('saves config when save button is clicked and shows confirmation', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    // 找到 "保存配置" 按钮
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存配置'))
    expect(saveBtn).toBeDefined()

    await saveBtn!.trigger('click')
    await flushPromises()

    // 按钮文字变为 "已保存"
    expect(wrapper.text()).toContain('已保存')
  })

  // ────────────────────────────────────────────────────
  // 6. loading 状态显示
  // ────────────────────────────────────────────────────
  it('shows loading state while config is being fetched', async () => {
    const { getLLMConfig } = await import('@/api/config')
    const mockedGetConfig = vi.mocked(getLLMConfig)

    // 让 getLLMConfig 延迟返回
    let resolveConfig!: (v: unknown) => void
    mockedGetConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve as (v: unknown) => void
      }),
    )

    const wrapper = mountSettingsView()
    // 需要 flushPromises 让 onMounted 执行，使 loading=true 生效
    await flushPromises()
    // 此时 store.loading 应为 true（getLLMConfig 尚未 resolve）
    const store = useSettingsStore()
    expect(store.loading).toBe(true)

    // 应显示 loading stub
    const loading = wrapper.find('[data-testid="loading-state"]')
    expect(loading.exists()).toBe(true)

    // 解决 promise
    resolveConfig!({
      default: 'openai',
      providers: {
        openai: { api_key: '', base_url: '', model: 'gpt-4o', compatible: '' },
      },
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
    })
    await flushPromises()

    // loading 应消失
    expect(store.loading).toBe(false)
  })

  // ────────────────────────────────────────────────────
  // 7. 安全设置区保存
  // ────────────────────────────────────────────────────
  it('saves security config when in security section', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    // 切换到安全设置
    const securityBtn = wrapper.findAll('button').find((b) => b.text().includes('安全设置'))
    await securityBtn!.trigger('click')
    await flushPromises()

    // 点击保存
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存配置'))
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存')
  })

  // ────────────────────────────────────────────────────
  // 8. 外观设置区渲染主题选项
  // ────────────────────────────────────────────────────
  it('renders theme options in appearance section', async () => {
    const wrapper = mountSettingsView()
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
  it('renders notification toggles', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    const notifBtn = wrapper.findAll('button').find((b) => b.text().includes('通知设置'))
    await notifBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('系统通知')
    expect(wrapper.text()).toContain('声音提示')
    expect(wrapper.text()).toContain('定时任务通知')
    expect(wrapper.text()).toContain('Heartbeat 异常告警')
  })

  // ────────────────────────────────────────────────────
  // 10. 存储设置区渲染存储信息
  // ────────────────────────────────────────────────────
  it('renders storage info in storage section', async () => {
    const wrapper = mountSettingsView()
    await flushPromises()

    const storageBtn = wrapper.findAll('button').find((b) => b.text().includes('存储设置'))
    await storageBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Qdrant')
    expect(wrapper.text()).toContain('SQLite')
    expect(wrapper.text()).toContain('语义缓存')
  })

  // ────────────────────────────────────────────────────
  // 11. 后端不可达时使用默认配置
  // ────────────────────────────────────────────────────
  it('falls back to default config when backend is unreachable', async () => {
    const { getLLMConfig } = await import('@/api/config')
    const mockedGetConfig = vi.mocked(getLLMConfig)
    mockedGetConfig.mockRejectedValue(new Error('Network error'))

    mountSettingsView()
    await flushPromises()

    const store = useSettingsStore()
    // 即使后端不可达，config 也不应为 null（使用默认值）
    expect(store.config).not.toBeNull()
    expect(store.config?.llm.providers).toBeDefined()
  })
})
