/**
 * 本地 LLM — 真实用户操作 + 真实数据模拟测试
 *
 * 模拟真实的 Ollama API 响应格式，按用户实际操作顺序测试完整链路。
 * 不使用简化 mock，而是严格对齐后端真实返回的数据结构。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

// ─── 真实 Ollama API 响应数据 ───────────────────────
// 来自 hexclaw 后端 handler_ollama.go 的实际返回格式

/** GET /api/v1/ollama/status — 后端 handleOllamaStatus 真实返回 */
const REAL_STATUS_RUNNING = {
  running: true,
  version: '0.6.2',
  associated: true,
  model_count: 3,
  models: [
    { name: 'qwen3:8b', size: 4_920_000_000, modified: '2026-03-28T10:15:00+08:00', family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
    { name: 'deepseek-r1:7b', size: 4_680_000_000, modified: '2026-03-25T14:22:00+08:00', family: 'deepseek', parameter_size: '7.6B', quantization_level: 'Q4_0' },
    { name: 'nomic-embed-text', size: 274_000_000, modified: '2026-03-20T09:00:00+08:00', family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' },
  ],
}

const REAL_STATUS_STOPPED = { running: false, version: '', associated: false, model_count: 0, models: null }

/** GET /api/v1/ollama/running — 后端 handleOllamaRunning 真实返回 */
const REAL_RUNNING_MODELS = {
  models: [
    { name: 'qwen3:8b', size: 4_920_000_000, size_vram: 4_920_000_000, expires_at: '2026-04-03T15:30:00+08:00', parameter_size: '8.2B', quantization_level: 'Q4_K_M', context_length: 32768 },
  ],
}

/** POST /api/v1/ollama/pull — SSE 事件流真实序列 */
const REAL_PULL_EVENTS = [
  { status: 'pulling manifest' },
  { status: 'pulling 8ffd8fac9039', digest: 'sha256:8ffd8fac90397c498e2c27e97d69f3fce90ef52aacd5e29d2f805ccbe5243e5f', total: 4920000000, completed: 0 },
  { status: 'pulling 8ffd8fac9039', digest: 'sha256:8ffd8fac90397c498e2c27e97d69f3fce90ef52aacd5e29d2f805ccbe5243e5f', total: 4920000000, completed: 1230000000 },
  { status: 'pulling 8ffd8fac9039', digest: 'sha256:8ffd8fac90397c498e2c27e97d69f3fce90ef52aacd5e29d2f805ccbe5243e5f', total: 4920000000, completed: 2460000000 },
  { status: 'pulling 8ffd8fac9039', digest: 'sha256:8ffd8fac90397c498e2c27e97d69f3fce90ef52aacd5e29d2f805ccbe5243e5f', total: 4920000000, completed: 3690000000 },
  { status: 'pulling 8ffd8fac9039', digest: 'sha256:8ffd8fac90397c498e2c27e97d69f3fce90ef52aacd5e29d2f805ccbe5243e5f', total: 4920000000, completed: 4920000000 },
  { status: 'pulling 966de95ca8a6', digest: 'sha256:966de95ca8a6', total: 1500000, completed: 0 },
  { status: 'pulling 966de95ca8a6', digest: 'sha256:966de95ca8a6', total: 1500000, completed: 1500000 },
  { status: 'pulling 62fbfd9ed093', digest: 'sha256:62fbfd9ed093', total: 182, completed: 182 },
  { status: 'verifying sha256 digest' },
  { status: 'writing manifest' },
  { status: 'success' },
]

// ─── Mocks ──────────────────────────────────────────

const mockGetOllamaStatus = vi.fn()
const mockGetOllamaRunning = vi.fn()
const mockPullOllamaModel = vi.fn()
const mockUnloadOllamaModel = vi.fn()
const mockDeleteOllamaModel = vi.fn()
const mockRestartOllama = vi.fn()

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
  pullOllamaModel: (m: string, cb: (p: unknown) => void, s?: AbortSignal) => mockPullOllamaModel(m, cb, s),
  getOllamaRunning: () => mockGetOllamaRunning(),
  unloadOllamaModel: (m: string) => mockUnloadOllamaModel(m),
  deleteOllamaModel: (n: string) => mockDeleteOllamaModel(n),
  restartOllama: () => mockRestartOllama(),
}))
vi.mock('@/api/config', () => ({ getLLMConfig: vi.fn(), updateLLMConfig: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/settings', () => ({ updateConfig: vi.fn().mockResolvedValue({}) }))
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class { async get() { return null } async set() {} async save() {} },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockRejectedValue(new Error('')) }))
vi.mock('lucide-vue-next', async (orig) => {
  const o = await orig<Record<string, unknown>>()
  const s = { template: '<span />' }
  const r: Record<string, unknown> = {}
  for (const k of Object.keys(o)) r[k] = s
  return r
})

function makeI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

async function mountCard() {
  const C = (await import('@/components/settings/OllamaCard.vue')).default
  return mount(C, {
    global: { plugins: [makeI18n()], stubs: { Transition: { template: '<div><slot /></div>' } } },
  })
}

// ═══════════════════════════════════════════════════
// 用户旅程 1: 新用户首次打开 → 发现 Ollama 已装好 → 下载模型 → 去对话
// ═══════════════════════════════════════════════════

describe('旅程 1: 新用户首次使用 Ollama', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 检测 → 无模型 → 下载 qwen3:8b → 进度实时更新 → 完成 → 去对话', async () => {
    // Step 1: 用户打开设置页，OllamaCard 自动检测
    mockGetOllamaStatus.mockResolvedValue({
      ...REAL_STATUS_RUNNING,
      model_count: 0, models: [],
    })
    mockGetOllamaRunning.mockResolvedValue([])

    const w = await mountCard()
    await flushPromises()

    // 验证：已连接，无模型提示
    expect(w.text()).toContain('已连接')
    expect(w.text()).toContain('Ollama 0.6.2')
    expect(w.text()).toContain('选择或输入模型名下载')

    // Step 2: 用户在输入框输入 "qwen3"
    const vm = w.vm as any
    vm.pullModelName = 'qwen3'
    await w.vm.$nextTick()

    // 验证：下拉建议过滤出 qwen3 系列
    expect(vm.filteredModels.length).toBeGreaterThan(0)
    expect(vm.filteredModels.every((m: string) => m.includes('qwen3'))).toBe(true)

    // Step 3: 用户选中 qwen3:8b
    vm.selectModel('qwen3:8b')
    expect(vm.pullModelName).toBe('qwen3:8b')
    expect(vm.showModelDropdown).toBe(false)

    // Step 4: 用户点击下载
    const progressValues: number[] = []
    const statusValues: string[] = []

    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      for (const event of REAL_PULL_EVENTS) {
        cb(event)
        if ((event as any).completed !== undefined) {
          progressValues.push(vm.pullProgress)
        }
        statusValues.push(vm.pullStatus)
      }
      return Promise.resolve()
    })

    // 下载完成后刷新模型列表
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)

    await vm.startPull()
    await flushPromises()

    // 验证：下载过程
    expect(statusValues).toContain('pulling manifest')
    expect(statusValues).toContain('verifying sha256 digest')
    expect(statusValues).toContain('success')
    expect(vm.pullProgress).toBe(100)
    expect(vm.pullStatus).toBe('__pull_done__') // PULL_DONE sentinel
    expect(vm.lastDownloaded).toBe('qwen3:8b')
    expect(vm.pullModelName).toBe('') // 输入框已清空

    // Step 5: 模型列表已刷新
    expect(mockGetOllamaStatus).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 2: 老用户打开 → 看到已有模型 → 管理模型（卸载/删除）
// ═══════════════════════════════════════════════════

describe('旅程 2: 老用户管理已有模型', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 查看模型列表 → 查看运行状态 → 卸载运行中模型 → 删除模型', async () => {
    // Step 1: 打开设置页，看到 3 个模型
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)
    mockGetOllamaRunning.mockResolvedValue(REAL_RUNNING_MODELS.models)

    const w = await mountCard()
    await flushPromises()
    await flushPromises() // refreshRunning

    // 验证：3 个模型都显示
    expect(w.text()).toContain('qwen3:8b')
    expect(w.text()).toContain('deepseek-r1:7b')
    expect(w.text()).toContain('nomic-embed-text')

    // 验证：模型大小显示
    expect(w.text()).toContain('4.9 GB') // qwen3:8b
    expect(w.text()).toContain('274 MB') // nomic-embed-text

    // 验证：参数大小
    expect(w.text()).toContain('8.2B')
    expect(w.text()).toContain('7.6B')
    expect(w.text()).toContain('137M')

    // 验证：运行状态
    const vm = w.vm as any
    expect(vm.isModelRunning('qwen3:8b')).toBe(true)
    expect(vm.isModelRunning('deepseek-r1:7b')).toBe(false)
    expect(w.text()).toContain('运行中')
    expect(w.text()).toContain('未加载')

    // Step 2: 用户卸载 qwen3:8b
    mockUnloadOllamaModel.mockResolvedValue(undefined)
    mockGetOllamaRunning.mockResolvedValue([])
    await vm.handleUnload('qwen3:8b')
    await flushPromises()

    expect(mockUnloadOllamaModel).toHaveBeenCalledWith('qwen3:8b')
    expect(vm.isModelRunning('qwen3:8b')).toBe(false)
    expect(vm.unloadingModel).toBe('')

    // Step 3: 用户删除 nomic-embed-text
    mockDeleteOllamaModel.mockResolvedValue(undefined)
    mockGetOllamaStatus.mockResolvedValue({
      ...REAL_STATUS_RUNNING,
      model_count: 2,
      models: REAL_STATUS_RUNNING.models.filter(m => m.name !== 'nomic-embed-text'),
    })

    await vm.handleDelete('nomic-embed-text')
    await flushPromises()

    expect(mockDeleteOllamaModel).toHaveBeenCalledWith('nomic-embed-text')
    expect(vm.deletingModel).toBe('')
    expect(vm.deleteError).toBe('')
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 3: Ollama 未运行 → 重启 → 重新检测
// ═══════════════════════════════════════════════════

describe('旅程 3: Ollama 未运行时重启', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 发现未运行 → 点启动引擎 → 等待 → 恢复运行', async () => {
    // Step 1: Ollama 未运行
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_STOPPED)
    mockGetOllamaRunning.mockResolvedValue([])

    const w = await mountCard()
    await flushPromises()

    expect(w.text()).toContain('未运行')
    expect(w.text()).toContain('启动引擎')

    const vm = w.vm as any

    // Step 2: 用户点击"启动引擎"（handleRestartEngine）
    // Tauri invoke 在测试环境会失败，触发 detect
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)

    await vm.handleRestartEngine()
    await flushPromises()

    // 验证：恢复到已连接状态
    expect(vm.state).toBe('associated')
    expect(vm.restarting).toBe(false)
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 4: 下载失败 → 重试 → 成功
// ═══════════════════════════════════════════════════

describe('旅程 4: 下载失败后重试', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 下载报错 → 显示错误 → 用户修改名称 → 重试成功', async () => {
    mockGetOllamaStatus.mockResolvedValue({ ...REAL_STATUS_RUNNING, model_count: 0, models: [] })
    mockGetOllamaRunning.mockResolvedValue([])

    const w = await mountCard()
    await flushPromises()

    const vm = w.vm as any

    // Step 1: 用户输入错误的模型名
    vm.pullModelName = 'nonexistent-model-xyz'
    mockPullOllamaModel.mockRejectedValueOnce(new Error('model "nonexistent-model-xyz" not found'))

    await vm.startPull()
    await flushPromises()

    // 验证：显示错误
    expect(vm.pullError).toBe('model "nonexistent-model-xyz" not found')
    expect(vm.pulling).toBe(false)
    expect(vm.pullInputError).toBe(true)

    // Step 2: 错误提示 3 秒后消失
    vi.advanceTimersByTime(3000)
    expect(vm.pullInputError).toBe(false)

    // Step 3: 用户改为正确的模型名并重试
    vm.pullModelName = 'qwen3:8b'
    // 清除旧错误（input 事件会做这个）
    vm.pullError = ''

    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'success' })
      return Promise.resolve()
    })
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)

    await vm.startPull()
    await flushPromises()

    // 验证：成功
    expect(vm.pullError).toBe('')
    expect(vm.pullProgress).toBe(100)
    expect(vm.lastDownloaded).toBe('qwen3:8b')
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 5: 下载中取消
// ═══════════════════════════════════════════════════

describe('旅程 5: 下载中用户取消（页面离开）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 开始下载 → 进度到 50% → 用户离开页面 → abort 触发 → 无残留', async () => {
    mockGetOllamaStatus.mockResolvedValue({ ...REAL_STATUS_RUNNING, model_count: 0, models: [] })
    mockGetOllamaRunning.mockResolvedValue([])

    let abortSignal: AbortSignal | undefined
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void, signal?: AbortSignal) => {
      abortSignal = signal
      // 发送 50% 进度
      cb({ status: 'downloading', completed: 2460000000, total: 4920000000, digest: 'sha256:abc' })
      // 返回一个会被 abort 中断的 promise
      return new Promise((_r, rej) => { signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
    })

    const w = await mountCard()
    await flushPromises()

    const vm = w.vm as any
    vm.pullModelName = 'qwen3:8b'
    const pullPromise = vm.startPull()
    await flushPromises()

    // 验证：正在下载
    expect(vm.pulling).toBe(true)
    expect(vm.pullProgress).toBe(50)

    // 用户离开页面 → 组件卸载
    w.unmount()

    // 验证：abort 被调用
    expect(abortSignal?.aborted).toBe(true)

    // 验证：定时器不泄漏
    expect(() => { vi.advanceTimersByTime(20000) }).not.toThrow()

    try { await pullPromise } catch { /* expected */ }
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 6: 模型选择 → 发消息（Store 集成）
// ═══════════════════════════════════════════════════

describe('旅程 6: 选择本地模型后发消息', () => {
  beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()) })

  it('完整流程: syncModels → 模型出现在列表 → 选择 → chatParams 正确', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    // 模拟已有 Ollama provider
    store.config = {
      llm: {
        providers: [{
          id: 'ollama-1',
          name: 'Ollama (本地)',
          type: 'ollama',
          enabled: true,
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
          backendKey: 'ollama',
          models: [],
        }],
        defaultModel: '',
        defaultProviderId: '',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
    store.runtimeProviders = store.config.llm.providers

    // Step 1: sync 模型
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)
    await store.syncOllamaModels()

    // Step 2: 验证模型在列表中
    expect(store.availableModels).toHaveLength(3)
    const qwen = store.availableModels.find(m => m.modelId === 'qwen3:8b')
    expect(qwen).toBeDefined()
    expect(qwen!.providerKey).toBe('ollama')
    expect(qwen!.providerName).toBe('Ollama (本地)')

    // Step 3: 模拟 ChatView.selectModel 的效果
    const chatParams = {
      provider: qwen!.providerKey || undefined,
      model: qwen!.modelId,
    }
    expect(chatParams.provider).toBe('ollama')
    expect(chatParams.model).toBe('qwen3:8b')

    // Step 4: 验证 embedding 模型也在列表中（用户可能不小心选到）
    const embed = store.availableModels.find(m => m.modelId === 'nomic-embed-text')
    expect(embed).toBeDefined()
    expect(embed!.capabilities).toEqual(['text']) // embedding 模型标记为 text 能力
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 7: 删除运行中模型的真实数据流
// ═══════════════════════════════════════════════════

describe('旅程 7: 删除运行中模型（真实数据流）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('完整流程: 模型运行中 → 先 unload → 等 refreshRunning → delete → refreshModels', async () => {
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)
    mockGetOllamaRunning.mockResolvedValue(REAL_RUNNING_MODELS.models)

    const w = await mountCard()
    await flushPromises()
    await flushPromises()

    const vm = w.vm as any
    expect(vm.isModelRunning('qwen3:8b')).toBe(true)

    // 删除前设置 mock 链：unload → refreshRunning(空) → delete → refreshModels
    mockUnloadOllamaModel.mockResolvedValue(undefined)
    mockGetOllamaRunning.mockResolvedValue([]) // unload 后无运行中模型
    mockDeleteOllamaModel.mockResolvedValue(undefined)
    mockGetOllamaStatus.mockResolvedValue({
      ...REAL_STATUS_RUNNING,
      model_count: 2,
      models: REAL_STATUS_RUNNING.models.filter(m => m.name !== 'qwen3:8b'),
    })

    await vm.handleDelete('qwen3:8b')
    await flushPromises()

    // 验证调用顺序
    expect(mockUnloadOllamaModel).toHaveBeenCalledWith('qwen3:8b')
    expect(mockDeleteOllamaModel).toHaveBeenCalledWith('qwen3:8b')

    // unload 在 delete 之前
    const unloadOrder = mockUnloadOllamaModel.mock.invocationCallOrder[0]!
    const deleteOrder = mockDeleteOllamaModel.mock.invocationCallOrder[0]!
    expect(unloadOrder).toBeLessThan(deleteOrder)

    expect(vm.deletingModel).toBe('')
    expect(vm.deleteError).toBe('')
  })
})

// ═══════════════════════════════════════════════════
// 用户旅程 8: 网络不稳定场景
// ═══════════════════════════════════════════════════

describe('旅程 8: 网络不稳定 — 检测/下载/刷新各种失败', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('场景: 检测失败 → 刷新恢复 → 下载失败 → 不影响已有模型', async () => {
    // Step 1: 检测失败
    mockGetOllamaStatus.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'))
    mockGetOllamaRunning.mockResolvedValue([])

    const w = await mountCard()
    await flushPromises()

    const vm = w.vm as any
    expect(vm.state).toBe('error')
    expect(w.text()).toContain('ECONNREFUSED')

    // Step 2: 用户点刷新，恢复正常
    mockGetOllamaStatus.mockResolvedValue(REAL_STATUS_RUNNING)
    await vm.detect()
    await flushPromises()

    expect(vm.state).toBe('associated')
    expect(w.text()).toContain('qwen3:8b')

    // Step 3: 用户尝试下载，网络又断了
    mockPullOllamaModel.mockRejectedValue(new Error('network timeout'))
    vm.pullModelName = 'phi4'
    await vm.startPull()
    await flushPromises()

    expect(vm.pullError).toBe('network timeout')
    expect(vm.pulling).toBe(false)

    // Step 4: 已有模型列表不受影响
    expect(w.text()).toContain('qwen3:8b')
    expect(w.text()).toContain('deepseek-r1:7b')
  })
})
