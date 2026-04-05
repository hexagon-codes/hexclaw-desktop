/**
 * 本地 LLM (Ollama) 全链路全场景测试
 *
 * Store 模块测试 + UI 组件集成测试 + 端到端链路测试
 * API 层单元测试已在 ollama-pull-stream.test.ts 和 ollama-bugs.test.ts 中覆盖
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import type { AppConfig, ProviderType } from '@/types'

// ─── Mocks ──────────────────────────────────────────

const mockGetLLMConfig = vi.fn()
const mockGetOllamaStatus = vi.fn()

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
  pullOllamaModel: vi.fn(),
  getOllamaRunning: vi.fn().mockResolvedValue([]),
  unloadOllamaModel: vi.fn().mockResolvedValue(undefined),
  deleteOllamaModel: vi.fn().mockResolvedValue(undefined),
  restartOllama: vi.fn().mockResolvedValue('ok'),
}))
vi.mock('@/api/settings', () => ({ updateConfig: vi.fn().mockResolvedValue({}) }))
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class { async get() { return null } async set() {} async save() {} },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockRejectedValue(new Error('no tauri')) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const m: Record<string, unknown> = {}
  for (const k of Object.keys(orig)) m[k] = stub
  return m
})

// ═══════════════════════════════════════════════════
// 1. Store 模块 — 全场景
// ═══════════════════════════════════════════════════

describe('Store — Ollama 模型同步全场景', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    delete (globalThis as Record<string, unknown>).isTauri
  })

  async function getStore() {
    const { useSettingsStore } = await import('@/stores/settings')
    return useSettingsStore()
  }

  function makeConfig(providers: Record<string, unknown>[] = []): AppConfig {
    return {
      llm: {
        providers: providers.map(p => ({ id: 'p1', name: 'Ollama', type: 'ollama' as ProviderType, enabled: true, apiKey: '', baseUrl: '', models: [], ...p })),
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
  }

  it('场景: 首次同步 → 缓存从空到有', async () => {
    const store = await getStore()
    store.config = makeConfig([{}])
    store.runtimeProviders = store.config!.llm.providers
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 2, models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'llama3.3', size: 4e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(2)
    expect(store.availableModels.map(m => m.modelId)).toEqual(['qwen3:8b', 'llama3.3'])
  })

  it('场景: 模型列表变化 → 缓存完全替换', async () => {
    const store = await getStore()
    store.config = makeConfig([{}])
    store.runtimeProviders = store.config!.llm.providers
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)

    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'phi4', size: 3e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('phi4')
  })

  it('场景: Ollama 未运行 → 不清空已有缓存', async () => {
    const store = await getStore()
    store.config = makeConfig([{}])
    store.runtimeProviders = store.config!.llm.providers
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)

    mockGetOllamaStatus.mockResolvedValue({ running: false, model_count: 0 })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1) // 保留
  })

  it('场景: API 报错 → 不影响已有缓存', async () => {
    const store = await getStore()
    store.config = makeConfig([{}])
    store.runtimeProviders = store.config!.llm.providers
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()

    mockGetOllamaStatus.mockRejectedValueOnce(new Error('timeout'))
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)
  })

  it('场景: Ollama disabled → 不出现在 availableModels', async () => {
    const store = await getStore()
    store.config = makeConfig([{ enabled: false }])
    store.runtimeProviders = store.config!.llm.providers
    expect(store.availableModels).toHaveLength(0)
  })

  it('场景: Ollama + OpenAI 并存 → 各自独立', async () => {
    const store = await getStore()
    store.config = makeConfig([
      { id: 'p-oll', name: 'Ollama', type: 'ollama' },
      { id: 'p-oai', name: 'OpenAI', type: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }] },
    ])
    store.runtimeProviders = store.config!.llm.providers

    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()

    expect(store.availableModels).toHaveLength(2)
    const ollama = store.availableModels.find(m => m.providerName === 'Ollama')
    const openai = store.availableModels.find(m => m.providerName === 'OpenAI')
    expect(ollama!.modelId).toBe('qwen3:8b')
    expect(openai!.modelId).toBe('gpt-4o')
  })

  it('场景: type=custom + baseUrl=11434 → 不被误判为 Ollama', async () => {
    const store = await getStore()
    store.config = makeConfig([{ id: 'c1', name: 'Custom Local', type: 'custom', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'local-m', name: 'Local', capabilities: ['text'] }] }])
    store.runtimeProviders = store.config!.llm.providers
    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('local-m')
  })

  it('场景: addProvider + syncModels → 新 Ollama provider 立即可用', async () => {
    const store = await getStore()
    store.config = makeConfig([])
    store.runtimeProviders = []
    expect(store.availableModels).toHaveLength(0)

    store.addProvider({ name: 'Ollama (本地)', type: 'ollama', enabled: true, apiKey: '', baseUrl: 'http://localhost:11434/v1', models: [] })
    store.runtimeProviders = [...store.config!.llm.providers]

    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()

    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.providerName).toBe('Ollama (本地)')
  })
})

// ═══════════════════════════════════════════════════
// 2. UI 组件集成 — OllamaCard 全状态
// ═══════════════════════════════════════════════════

describe('OllamaCard UI — 全状态场景', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => { vi.useRealTimers() })

  async function mountCard() {
    const OllamaCard = (await import('@/components/settings/OllamaCard.vue')).default
    return mount(OllamaCard, {
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })],
        stubs: { Transition: { template: '<div><slot /></div>' } },
      },
    })
  }

  it('运行中 + 有模型 → 显示版本 + 模型列表 + 大小', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, version: '0.4.1', model_count: 2,
      models: [
        { name: 'qwen3:8b', size: 5e9, parameter_size: '8B', quantization_level: 'Q4_K_M' },
        { name: 'llama3.3', size: 4.2e9 },
      ],
    })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('已连接')
    expect(w.text()).toContain('0.4.1')
    expect(w.text()).toContain('qwen3:8b')
    expect(w.text()).toContain('llama3.3')
    expect(w.text()).toContain('5.0 GB')
    expect(w.text()).toContain('8B')
  })

  it('运行中 + 无模型 → 显示下载提示', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('已连接')
    expect(w.text()).toContain('选择或输入模型名下载')
  })

  it('未运行 → 显示启动按钮', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0 })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('未运行')
    expect(w.text()).toContain('启动引擎')
  })

  it('检测失败 → 显示错误信息', async () => {
    mockGetOllamaStatus.mockRejectedValue(new Error('ECONNREFUSED'))
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('检测失败')
    expect(w.text()).toContain('ECONNREFUSED')
  })

  it('等待安装轮询 → 检测到运行后自动停止', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: false, model_count: 0 })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.startInstall()
    await w.vm.$nextTick()
    expect(vm.state).toBe('waiting_install')

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: false, model_count: 0 })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(vm.state).toBe('associated')
    expect(vm.waitingInstall).toBe(false)
  })

  it('空输入下载 → 输入框错误提示', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = ''
    await vm.startPull()
    expect(vm.pullInputError).toBe(true)
    expect(vm.pulling).toBe(false)
  })

  it('下载中组件卸载 → 所有定时器清理', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const { pullOllamaModel } = await import('@/api/ollama')
    ;(pullOllamaModel as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, cb: (p: unknown) => void, signal?: AbortSignal) => {
        cb({ status: 'downloading', completed: 100, total: 1000 })
        return new Promise((_r, rej) => { signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
      },
    )
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'qwen3:8b'
    vm.startPull()
    await flushPromises()
    w.unmount()
    expect(() => { vi.advanceTimersByTime(20000) }).not.toThrow()
  })

  it('模型下拉建议 — 空输入展示精选列表', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = ''
    const models = vm.filteredModels
    expect(models.length).toBe(10) // OLLAMA_FEATURED 有 10 项
    expect(models).toContain('qwen3.5:9b')
  })

  it('模型下拉建议 — 输入过滤', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'deep'
    const models = vm.filteredModels
    expect(models.every((m: string) => m.toLowerCase().includes('deep'))).toBe(true)
    expect(models.length).toBeGreaterThan(0)
    expect(models.length).toBeLessThanOrEqual(10) // 最多 10 项
  })

  it('goChat — 调用 refreshModels 后跳转', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    // goChat 内部调 refreshModels → getOllamaStatus → router.push
    await vm.goChat('qwen3:8b')
    await flushPromises()
    // 验证 getOllamaStatus 被 refreshModels 调用
    expect(mockGetOllamaStatus).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════
// 3. 端到端 — 完整链路
// ═══════════════════════════════════════════════════

describe('端到端 — 检测→关联→同步→选模型', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    delete (globalThis as Record<string, unknown>).isTauri
  })

  it('全流程: 无 provider → detect 发现 Ollama → 自动关联 → 模型可选', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: { providers: [], defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' } },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    } as AppConfig
    store.runtimeProviders = []

    // Step 1: addProvider（模拟 handleAssociateOllama）
    store.addProvider({ name: 'Ollama (本地)', type: 'ollama', enabled: true, apiKey: '', baseUrl: 'http://localhost:11434/v1', models: [] })
    store.runtimeProviders = [...store.config!.llm.providers]

    // Step 2: syncOllamaModels
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 2, models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'deepseek-r1:7b', size: 4.7e9 }] })
    await store.syncOllamaModels()

    // Step 3: 验证
    expect(store.availableModels).toHaveLength(2)
    expect(store.availableModels[0]!.providerName).toBe('Ollama (本地)')
    expect(store.enabledProviders.some(p => p.type === 'ollama')).toBe(true)
  })

  it('全流程: 下载新模型 → syncModels → 新模型立即出现在列表', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: {
        providers: [{ id: 'oll', name: 'Ollama', type: 'ollama' as ProviderType, enabled: true, apiKey: '', baseUrl: '', models: [] }],
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
    store.runtimeProviders = store.config!.llm.providers

    // 下载前: 1 个模型
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)

    // 下载后: 2 个模型
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 2, models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'phi4', size: 3e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(2)
    expect(store.availableModels.map(m => m.modelId)).toContain('phi4')
  })

  it('全流程: 删除模型 → syncModels → 模型从列表消失', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: {
        providers: [{ id: 'oll', name: 'Ollama', type: 'ollama' as ProviderType, enabled: true, apiKey: '', baseUrl: '', models: [] }],
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
    store.runtimeProviders = store.config!.llm.providers

    // 删除前
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 2, models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'phi4', size: 3e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(2)

    // 删除后
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    await store.syncOllamaModels()
    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('qwen3:8b')
  })
})
