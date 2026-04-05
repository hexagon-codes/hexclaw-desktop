/**
 * OllamaCard Bug 复现 & 验证
 *
 * Bug 1: stallTimer 组件卸载时泄漏
 * Bug 2: 下载速度 layer 切换时负值
 * Bug 5: header 重启按钮路径
 * Bug 6: 删除模型 — 先 unload + 错误反馈
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockGetOllamaStatus = vi.fn()
const mockPullOllamaModel = vi.fn()
const mockGetOllamaRunning = vi.fn()
const mockUnloadOllamaModel = vi.fn()
const mockDeleteOllamaModel = vi.fn()
const mockRestartOllama = vi.fn()

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
  pullOllamaModel: (model: string, cb: (p: unknown) => void, signal?: AbortSignal) =>
    mockPullOllamaModel(model, cb, signal),
  getOllamaRunning: () => mockGetOllamaRunning(),
  unloadOllamaModel: (model: string) => mockUnloadOllamaModel(model),
  deleteOllamaModel: (name: string) => mockDeleteOllamaModel(name),
  restartOllama: () => mockRestartOllama(),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockRejectedValue(new Error('not in Tauri')),
}))

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
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountOllamaCard() {
  const OllamaCard = (await import('../OllamaCard.vue')).default
  return mount(OllamaCard, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        Transition: { template: '<div><slot /></div>' },
      },
    },
  })
}

describe('Bug 1: stallTimer 组件卸载时泄漏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockGetOllamaRunning.mockResolvedValue([])
    mockRestartOllama.mockResolvedValue('ok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('下载中卸载组件后 stallTimer 不应继续触发', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 0, models: [],
    })

    mockPullOllamaModel.mockImplementation(
      (_model: string, cb: (p: unknown) => void, signal?: AbortSignal) => {
        cb({ status: 'downloading', completed: 100, total: 1000 })
        return new Promise((_resolve, reject) => {
          if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    )

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    vm.pullModelName = 'qwen3:8b'
    const pullPromise = vm.startPull()
    await flushPromises()

    // 卸载组件
    wrapper.unmount()

    // 推进 16 秒 — 修复后 stallTimer 已被清理，不会操作已卸载的 ref
    expect(() => {
      vi.advanceTimersByTime(16000)
    }).not.toThrow()

    try { await pullPromise } catch { /* expected abort */ }
  })
})

describe('Bug 2: 下载速度在 layer 切换时显示负值', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockGetOllamaRunning.mockResolvedValue([])
    mockRestartOllama.mockResolvedValue('ok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('layer 切换时 speed 不应为负数', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 0, models: [],
    })

    mockPullOllamaModel.mockImplementation(
      (_model: string, cb: (p: unknown) => void) => {
        // Layer 1: completed 到 2GB
        cb({ status: 'downloading', completed: 2_000_000_000, total: 4_000_000_000, digest: 'sha256:layer1' })
        vi.advanceTimersByTime(2000)

        // Layer 2 开始: completed 重置为接近 0
        cb({ status: 'downloading', completed: 100_000, total: 500_000_000, digest: 'sha256:layer2' })
        vi.advanceTimersByTime(2000)

        cb({ status: 'success' })
        return Promise.resolve()
      },
    )

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    vm.pullModelName = 'qwen3:8b'
    await vm.startPull()
    await flushPromises()

    const detail = vm.pullDetail as string
    // 修复后：不应包含负号开头的数字（如 "-1.9 GB/s"）
    expect(detail).not.toMatch(/-\d/)
  })
})

describe('Bug 6: 删除模型 — 先 unload 运行中模型 + 错误反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockGetOllamaRunning.mockResolvedValue([])
    mockRestartOllama.mockResolvedValue('ok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('删除失败时应设置 deleteError（用户能看到错误）', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    mockDeleteOllamaModel.mockRejectedValue(new Error('model is in use'))

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    await vm.handleDelete('qwen3:8b')
    await flushPromises()

    // deletingModel 应重置
    expect(vm.deletingModel).toBe('')
    // 修复后：deleteError 应包含错误信息
    expect(vm.deleteError).toBe('model is in use')

    // 3 秒后错误自动清除
    vi.advanceTimersByTime(3000)
    expect(vm.deleteError).toBe('')
  })

  it('删除运行中的模型应先 unload', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    mockGetOllamaRunning.mockResolvedValue([
      { name: 'qwen3:8b', size: 5_000_000_000, size_vram: 5_000_000_000, expires_at: '', context_length: 4096 },
    ])
    mockUnloadOllamaModel.mockResolvedValue(undefined)
    mockDeleteOllamaModel.mockResolvedValue(undefined)

    const wrapper = await mountOllamaCard()
    await flushPromises()
    await flushPromises() // wait for refreshRunning

    const vm = wrapper.vm as any
    expect(vm.isModelRunning('qwen3:8b')).toBe(true)

    await vm.handleDelete('qwen3:8b')
    await flushPromises()

    // 修复后：应先 unload 再 delete
    expect(mockUnloadOllamaModel).toHaveBeenCalledWith('qwen3:8b')
    expect(mockDeleteOllamaModel).toHaveBeenCalledWith('qwen3:8b')
    // unload 应在 delete 之前调用
    const unloadOrder = mockUnloadOllamaModel.mock.invocationCallOrder[0]
    const deleteOrder = mockDeleteOllamaModel.mock.invocationCallOrder[0]
    expect(unloadOrder).toBeLessThan(deleteOrder!)
  })

  it('非运行中模型删除不调 unload', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    // 没有运行中的模型
    mockGetOllamaRunning.mockResolvedValue([])
    mockDeleteOllamaModel.mockResolvedValue(undefined)

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    await vm.handleDelete('qwen3:8b')
    await flushPromises()

    expect(mockUnloadOllamaModel).not.toHaveBeenCalled()
    expect(mockDeleteOllamaModel).toHaveBeenCalledWith('qwen3:8b')
  })
})

describe('Bug 7: 下载完成后 tags 延迟刷新时，模型列表仍应被检测到', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockGetOllamaRunning.mockResolvedValue([])
    mockRestartOllama.mockResolvedValue('ok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次刷新仍为空时，会补一次刷新直到新模型出现在卡片中', async () => {
    mockGetOllamaStatus
      // onMounted -> detect()
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 0, models: [],
      })
      // detect() -> settingsStore.syncOllamaModels()
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 0, models: [],
      })
      // startPull() -> refreshModels()，此时 /api/tags 仍未刷新
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 0, models: [],
      })
      // refreshModels() -> settingsStore.syncOllamaModels()，缓存已能拿到新模型
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 1,
        models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
      })
      // 补偿刷新后，卡片状态也拿到新模型
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 1,
        models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
      })
      .mockResolvedValueOnce({
        running: true, associated: true, model_count: 1,
        models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
      })

    mockPullOllamaModel.mockImplementation((_model: string, cb: (p: unknown) => void) => {
      cb({ status: 'success' })
      return Promise.resolve()
    })

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    vm.pullModelName = 'qwen3:8b'

    const pullPromise = vm.startPull()
    await flushPromises()

    vi.advanceTimersByTime(1000)
    await flushPromises()
    await pullPromise
    await flushPromises()

    expect(vm.status.models).toEqual([{ name: 'qwen3:8b', size: 5_000_000_000 }])
    expect(wrapper.text()).toContain('qwen3:8b')
  })
})

describe('Bug 8: 下载流结束但本地仍无模型时，不应误报下载完成', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    mockGetOllamaRunning.mockResolvedValue([])
    mockRestartOllama.mockResolvedValue('ok')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('模型多次刷新仍不可见时，显示错误而不是下载完成', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 0, models: [],
    })

    mockPullOllamaModel.mockImplementation((_model: string, cb: (p: unknown) => void) => {
      cb({ status: 'success' })
      return Promise.resolve()
    })

    const wrapper = await mountOllamaCard()
    await flushPromises()

    const vm = wrapper.vm as any
    vm.pullModelName = 'qwen3:8b'

    await vm.startPull()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()

    expect(vm.pullStatus).not.toBe('__pull_done__')
    expect(vm.lastDownloaded).toBe('')
    expect(vm.pullError).toContain('本地未检测到模型')
    expect(wrapper.text()).not.toContain('下载完成')
  })
})
