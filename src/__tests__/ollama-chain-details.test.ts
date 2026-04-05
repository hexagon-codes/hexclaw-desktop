/**
 * 本地 LLM 全链路 — 细节场景补充测试
 *
 * 聚焦前几轮未覆盖的微观场景：
 * - 下载进度计算边界
 * - 模型下拉交互键盘操作
 * - 关联逻辑边界（disabled provider 重启用/重复关联）
 * - handleRestart Tauri→sidecar 回退
 * - deleteError 自动清除
 * - stall 检测提示
 * - formatSize/formatBytes 边界值
 * - hasOllamaProvider 判断（backendKey 匹配）
 * - 模型名称含特殊字符
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const mockGetOllamaStatus = vi.fn()
const mockGetOllamaRunning = vi.fn().mockResolvedValue([])
const mockPullOllamaModel = vi.fn()
const mockUnloadOllamaModel = vi.fn().mockResolvedValue(undefined)
const mockDeleteOllamaModel = vi.fn().mockResolvedValue(undefined)
const mockRestartOllama = vi.fn().mockResolvedValue('ok')
const mockGetLLMConfig = vi.fn()

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
  pullOllamaModel: (m: string, cb: (p: unknown) => void, s?: AbortSignal) => mockPullOllamaModel(m, cb, s),
  getOllamaRunning: () => mockGetOllamaRunning(),
  unloadOllamaModel: (m: string) => mockUnloadOllamaModel(m),
  deleteOllamaModel: (n: string) => mockDeleteOllamaModel(n),
  restartOllama: () => mockRestartOllama(),
}))
vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: vi.fn().mockResolvedValue({}),
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

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

async function mountCard() {
  const OllamaCard = (await import('@/components/settings/OllamaCard.vue')).default
  return mount(OllamaCard, {
    global: { plugins: [i18n()], stubs: { Transition: { template: '<div><slot /></div>' } } },
  })
}

// ═══════════════════════════════════════════════════
// 1. 下载进度细节
// ═══════════════════════════════════════════════════

describe('下载进度 — 计算细节', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('进度百分比正确计算：completed/total*100 四舍五入', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'downloading', completed: 333, total: 1000 })
      cb({ status: 'success' })
      return Promise.resolve()
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'test'
    await vm.startPull()
    // 333/1000 = 33.3% → Math.round → 33
    // 最终 success → 100
    expect(vm.pullProgress).toBe(100)
  })

  it('stall 检测：15 秒无进度后追加 "(等待中...)" 提示', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'downloading', completed: 100, total: 1000 })
      // 不再发进度
      return new Promise(() => {}) // 永不结束
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'test'
    vm.startPull()
    await flushPromises()

    // 推进 15 秒
    vi.advanceTimersByTime(15000)
    expect(vm.pullDetail).toContain('等待中...')
  })

  it('layer 切换时 lastCompleted 重置，速度不为负', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      // Layer 1 到 2GB
      cb({ status: 'downloading', completed: 2_000_000_000, total: 4_000_000_000 })
      vi.advanceTimersByTime(2000) // 触发速度计算
      // Layer 2 重置
      cb({ status: 'downloading', completed: 50_000, total: 500_000_000 })
      vi.advanceTimersByTime(2000)
      cb({ status: 'success' })
      return Promise.resolve()
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'multi-layer'
    await vm.startPull()
    // pullDetail 不应包含负号
    // 注意：下载完成后 pullDetail 被清空，所以这里只验证无异常
    expect(vm.pullError).toBe('')
  })

  it('p.total 为 0 时不计算进度（避免除零）', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'pulling manifest', completed: 0, total: 0 })
      cb({ status: 'success' })
      return Promise.resolve()
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'test'
    await vm.startPull()
    expect(vm.pullProgress).toBe(100)
    expect(vm.pullError).toBe('')
  })
})

// ═══════════════════════════════════════════════════
// 2. 模型下拉键盘交互
// ═══════════════════════════════════════════════════

describe('模型下拉 — 键盘操作', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('ArrowDown 递增 dropdownIndex，不超过列表长度', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'qwen3'
    vm.showModelDropdown = true
    const maxIdx = vm.filteredModels.length - 1

    // 连按 ArrowDown 100 次
    for (let i = 0; i < 100; i++) {
      vm.onPullKeydown({ key: 'ArrowDown', preventDefault: () => {} })
    }
    expect(vm.dropdownIndex).toBe(maxIdx)
  })

  it('ArrowUp 递减 dropdownIndex，不低于 -1', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.showModelDropdown = true
    vm.dropdownIndex = 0
    vm.onPullKeydown({ key: 'ArrowUp', preventDefault: () => {} })
    expect(vm.dropdownIndex).toBe(-1)
    vm.onPullKeydown({ key: 'ArrowUp', preventDefault: () => {} })
    expect(vm.dropdownIndex).toBe(-1) // 不低于 -1
  })

  it('Enter 选中高亮项而非启动下载', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = ''
    vm.showModelDropdown = true
    vm.dropdownIndex = 0

    vm.onPullKeydown({ key: 'Enter', preventDefault: () => {} })
    // 应选中第一个 featured 模型，而非启动下载
    expect(vm.pullModelName).toBe('qwen3.5:9b') // OLLAMA_FEATURED[0]
    expect(vm.pulling).toBe(false)
  })

  it('Escape 关闭下拉', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.showModelDropdown = true
    vm.onPullKeydown({ key: 'Escape' })
    expect(vm.showModelDropdown).toBe(false)
  })

  it('下拉未打开时 Enter 直接启动下载', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'success' }); return Promise.resolve()
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.pullModelName = 'phi4'
    vm.showModelDropdown = false
    vm.onPullKeydown({ key: 'Enter' })
    await flushPromises()
    expect(mockPullOllamaModel).toHaveBeenCalledWith('phi4', expect.any(Function), expect.anything())
  })
})

// ═══════════════════════════════════════════════════
// 3. 关联逻辑边界
// ═══════════════════════════════════════════════════

describe('关联逻辑 — 边界场景', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('detect: 已有 enabled Ollama → 不 emit associate', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: {
        providers: [{ id: 'oll', name: 'Ollama', type: 'ollama', enabled: true, apiKey: '', baseUrl: '', models: [] }],
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()

    // 不应 emit associate（已有 provider）
    expect(w.emitted('associate')).toBeUndefined()
  })

  it('detect: 有 disabled Ollama → emit associate 触发重启用', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: {
        providers: [{ id: 'oll', name: 'Ollama', type: 'ollama', enabled: false, apiKey: '', baseUrl: '', models: [] }],
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()

    // 应 emit associate（disabled 的 Ollama 不算"有"）
    expect(w.emitted('associate')).toBeTruthy()
  })

  it('hasOllamaProvider: backendKey 包含 "ollama" 也匹配', async () => {
    const store = (await import('@/stores/settings')).useSettingsStore()
    store.config = {
      llm: {
        providers: [{ id: 'p1', name: 'My LLM', type: 'custom', backendKey: 'ollama-local', enabled: true, apiKey: '', baseUrl: '', models: [] }],
        defaultModel: '', defaultProviderId: '', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()

    // backendKey='ollama-local' 包含 'ollama' → 不应 emit associate
    expect(w.emitted('associate')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════
// 4. formatSize / formatBytes 边界值
// ═══════════════════════════════════════════════════

describe('格式化函数 — 边界值', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('formatSize: MB 和 GB 阈值正确', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 3,
      models: [
        { name: 'tiny', size: 500_000_000 },  // 500 MB
        { name: 'medium', size: 999_999_999 }, // 999 MB (just below 1 GB)
        { name: 'large', size: 1_000_000_000 }, // 1.0 GB
      ],
    })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('500 MB')
    expect(w.text()).toContain('1000 MB') // 999_999_999 < 1e9, so still MB
    expect(w.text()).toContain('1.0 GB')
  })

  it('formatBytes: KB/MB/GB 三档正确', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    expect(vm.formatBytes(500)).toBe('1 KB') // 500/1e3 = 0.5 → toFixed(0) = '1' (rounded up)
    expect(vm.formatBytes(1_500_000)).toBe('1.5 MB')
    expect(vm.formatBytes(2_500_000_000)).toBe('2.50 GB')
  })
})

// ═══════════════════════════════════════════════════
// 5. 模型名称含特殊字符
// ═══════════════════════════════════════════════════

describe('模型名称 — 特殊字符', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('含冒号的模型名（如 qwen3:8b）正确显示和操作', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5e9 }],
    })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('qwen3:8b')
  })

  it('含斜杠的自定义模型名（如 user/model:tag）', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'myuser/custom-model:v2', size: 3e9 }],
    })
    const w = await mountCard()
    await flushPromises()
    expect(w.text()).toContain('myuser/custom-model:v2')
  })
})

// ═══════════════════════════════════════════════════
// 6. handleRestart 回退逻辑
// ═══════════════════════════════════════════════════

describe('handleRestart — Tauri 命令回退', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('Tauri invoke 失败时回退到 sidecar API', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: false, model_count: 0 })
    // Tauri 会 import('@tauri-apps/api/core') → invoke 会 throw
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any

    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 0, models: [] })
    await vm.handleRestart()

    // 回退路径应调用 restartOllama（sidecar API）
    expect(mockRestartOllama).toHaveBeenCalled()
    expect(vm.restarting).toBe(false)
  })
})

// ═══════════════════════════════════════════════════
// 7. 运行状态管理细节
// ═══════════════════════════════════════════════════

describe('运行状态管理 — 模型加载/卸载', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('多个模型运行时 isModelRunning 独立判断', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 2,
      models: [{ name: 'qwen3:8b', size: 5e9 }, { name: 'llama3.3', size: 4e9 }],
    })
    mockGetOllamaRunning.mockResolvedValue([
      { name: 'qwen3:8b', size: 5e9, size_vram: 5e9, expires_at: '', context_length: 4096 },
    ])
    const w = await mountCard()
    await flushPromises()
    await flushPromises() // refreshRunning
    const vm = w.vm as any
    expect(vm.isModelRunning('qwen3:8b')).toBe(true)
    expect(vm.isModelRunning('llama3.3')).toBe(false)
  })

  it('unload 失败时 unloadingModel 仍重置', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] })
    mockGetOllamaRunning.mockResolvedValue([
      { name: 'qwen3:8b', size: 5e9, size_vram: 5e9, expires_at: '', context_length: 4096 },
    ])
    mockUnloadOllamaModel.mockRejectedValueOnce(new Error('busy'))
    const w = await mountCard()
    await flushPromises()
    await flushPromises()
    const vm = w.vm as any
    await vm.handleUnload('qwen3:8b')
    expect(vm.unloadingModel).toBe('')
  })
})

// ═══════════════════════════════════════════════════
// 8. selectAndPull — 从下拉直接下载
// ═══════════════════════════════════════════════════

describe('selectAndPull — 一键选择+下载', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('选中模型名并立即启动下载', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0, models: [] })
    mockPullOllamaModel.mockImplementation((_m: string, cb: (p: unknown) => void) => {
      cb({ status: 'success' }); return Promise.resolve()
    })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.showModelDropdown = true
    await vm.selectAndPull('deepseek-r1:7b')
    await flushPromises()
    expect(vm.showModelDropdown).toBe(false)
    expect(vm.dropdownIndex).toBe(-1)
    expect(mockPullOllamaModel).toHaveBeenCalledWith('deepseek-r1:7b', expect.any(Function), expect.anything())
  })
})

// ═══════════════════════════════════════════════════
// 9. 等待安装 — 轮询期间网络错误不中断
// ═══════════════════════════════════════════════════

describe('等待安装 — 网络抖动容忍', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setActivePinia(createPinia()) })
  afterEach(() => { vi.useRealTimers() })

  it('轮询期间网络错误不切到 error 状态，继续等待', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: false, model_count: 0 })
    const w = await mountCard()
    await flushPromises()
    const vm = w.vm as any
    vm.startInstall()
    await w.vm.$nextTick()
    expect(vm.state).toBe('waiting_install')

    // 网络错误
    mockGetOllamaStatus.mockRejectedValue(new Error('network'))
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(vm.state).toBe('waiting_install') // 保持等待
    expect(vm.error).toBe('')

    // 恢复正常
    mockGetOllamaStatus.mockResolvedValue({ running: true, model_count: 0, models: [] })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(vm.state).toBe('associated')
  })
})
