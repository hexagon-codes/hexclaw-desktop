// U5 契约：开机自启开关必须桥接到 Rust `set_autostart` command。
//
// 旧实现 `@change="autoSave()"` 只把布尔值落 Tauri Store，全前端 0 处调用 plugin-autostart，
// 于是开关是个「假开关」——系统层面永不注册/注销 LaunchAgent。
//
// RED（旧代码）：切换 auto_start 开关 → 从不 invoke('set_autostart') → 断言失败。
// GREEN（修复后）：@change 调 handleAutoStartChange → invoke('set_autostart', { enable }) → 断言通过。
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { mockRouter } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn() },
}))

// 捕获 Tauri invoke 调用（U5 断言核心）
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('vue-router', () => ({
  useRouter: vi.fn().mockReturnValue(mockRouter),
}))

// settings store 在 isTauri=true 时 import Tauri Store
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
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    close: vi.fn(),
  }),
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.5.0'),
}))

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
  testLLMConnection: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
  updateLLMConfig: vi.fn().mockImplementation((config) => Promise.resolve(config)),
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
  getRuntimeConfig: vi.fn().mockResolvedValue({
    server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
    llm: { default: 'openai', providers: {} },
    knowledge: { enabled: true },
    mcp: { enabled: true },
    cron: { enabled: true },
    webhook: { enabled: false },
    canvas: { enabled: true },
    voice: { enabled: true },
    security: {},
  }),
}))

vi.mock('@/api/system', () => ({
  getVersion: vi.fn().mockResolvedValue({ version: '0.5.0', engine: 'hexagon' }),
  getStats: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({
    running: false,
    associated: false,
    model_count: 0,
    models: [],
  }),
  getOllamaRunning: vi.fn().mockResolvedValue([]),
  getOllamaRunningResult: vi.fn().mockResolvedValue({ models: [], reachable: true }),
  pullOllamaModel: vi.fn(),
  deleteOllamaModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
  restartOllama: vi.fn(),
}))

// lucide 图标统一 stub
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
    missingWarn: false,
    fallbackWarn: false,
  })
}

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
          template: '<div class="page-header-stub">{{ title }}</div>',
        },
        LoadingState: { template: '<div>加载中...</div>' },
      },
    },
  })
}

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

describe('U5 — 开机自启开关桥接 set_autostart command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    document.body.innerHTML = ''
    // 桌面运行时：isDesktopRuntime() 为 true 才会走 invoke 分支
    ;(globalThis as Record<string, unknown>).isTauri = true
    // 启动时同步：is_autostart_enabled 返回 false（未启用）
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'is_autostart_enabled') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
  })

  // timeout 15s：SettingsView 全量挂载在全套并发满载时偶发超过默认 5s（20260712 flaky 定案，非产品问题）
  it('启动时用 is_autostart_enabled 同步开关状态', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('is_autostart_enabled')
    })
    wrapper.unmount()
  }, 15_000)

  it('切换开关 @change 会 invoke set_autostart（enable=true）', async () => {
    const wrapper = await mountSettingsView()
    await flushPromises()

    // 切到系统设置分区（auto_start 开关在此）
    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    expect(systemBtn, '系统设置 tab').toBeDefined()
    await systemBtn!.trigger('click')
    await flushPromises()

    const toggle = wrapper.find('[data-testid="auto-start-toggle"]')
    expect(toggle.exists(), 'auto-start-toggle 开关存在').toBe(true)

    invokeMock.mockClear()
    // 勾选开关 → v-model 置 true → 触发 @change
    await toggle.setValue(true)
    await toggle.trigger('change')
    await flushPromises()

    // 契约核心：@change 必须桥接到 Rust set_autostart，且带 enable=true
    expect(invokeMock).toHaveBeenCalledWith('set_autostart', { enable: true })
    wrapper.unmount()
  })

  it('关闭开关 @change 会 invoke set_autostart（enable=false）', async () => {
    // 初始 is_autostart_enabled=true → 开关初始为开
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'is_autostart_enabled') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })
    const wrapper = await mountSettingsView()
    await flushPromises()

    const systemBtn = wrapper.findAll('button').find((b) => b.text().includes('系统设置'))
    await systemBtn!.trigger('click')
    await flushPromises()

    const toggle = wrapper.find('[data-testid="auto-start-toggle"]')
    expect(toggle.exists()).toBe(true)

    invokeMock.mockClear()
    await toggle.setValue(false)
    await toggle.trigger('change')
    await flushPromises()

    expect(invokeMock).toHaveBeenCalledWith('set_autostart', { enable: false })
    wrapper.unmount()
  })
})
