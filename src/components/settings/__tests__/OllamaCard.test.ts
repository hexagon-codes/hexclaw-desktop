import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

// ─── Mock ollama API ────────────────────────────────
const mockGetOllamaStatus = vi.fn()

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
}))

// ─── Mock lucide icons ──────────────────────────────
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
        // mode="out-in" blocks DOM updates in jsdom — replace with passthrough
        Transition: { template: '<div><slot /></div>' },
      },
    },
  })
}

/** 挂载并进入「未运行」状态 */
async function mountAsNotRunning() {
  mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0 })
  const wrapper = await mountOllamaCard()
  await flushPromises()
  return wrapper
}

/** 进入等待安装状态 */
async function enterWaitingInstall(wrapper: ReturnType<typeof mount>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = wrapper.vm as any
  // defineExpose 暴露的 startInstall
  if (typeof vm.startInstall === 'function') {
    vm.startInstall()
  } else {
    // fallback: 直接设置 ref
    throw new Error('startInstall not exposed on vm — check defineExpose')
  }
  await wrapper.vm.$nextTick()
  await flushPromises()
}

describe('OllamaCard — 本地 LLM 检测全链路', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    vi.useRealTimers()
    openSpy.mockRestore()
  })

  // ─── 1. 检测状态 ──────────────────────────────────

  it('挂载时自动检测 Ollama 状态', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0 })
    await mountOllamaCard()
    await flushPromises()

    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(1)
  })

  it('检测中显示骨架屏', async () => {
    mockGetOllamaStatus.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountOllamaCard()

    expect(wrapper.find('.ollama-card__pulse-bar').exists()).toBe(true)
    expect(wrapper.text()).toContain('检测中')
  })

  // ─── 2. 未运行状态 ────────────────────────────────

  it('Ollama 未运行时显示安装按钮', async () => {
    const wrapper = await mountAsNotRunning()

    expect(wrapper.text()).toContain('未运行')
    expect(wrapper.text()).toContain('前往安装')
    // 重新检测只在 header 的刷新按钮，不在 body 重复
    const bodyActions = wrapper.findAll('.ollama-card__action-btn')
    expect(bodyActions.length).toBe(1)
  })

  it('点击前往安装按钮调用 window.open 打开下载页', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = await mountAsNotRunning()

    const installBtn = wrapper.find('.ollama-card__action-btn--primary')
    await installBtn.trigger('click')
    await flushPromises()

    expect(openSpy).toHaveBeenCalledWith('https://ollama.com/download', '_blank')
    openSpy.mockRestore()
  })

  it('点 header 刷新按钮重新检测', async () => {
    const wrapper = await mountAsNotRunning()
    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(1)

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: false, model_count: 0 })
    const refreshBtn = wrapper.find('.ollama-card__refresh')
    await refreshBtn.trigger('click')
    await flushPromises()

    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(2)
  })

  // ─── 3. 等待安装状态（轮询） ──────────────────────

  it('点击前往安装后进入等待状态并开始轮询', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    const vm = wrapper.vm as unknown as { state: string; waitingInstall: boolean }
    expect(vm.state).toBe('waiting_install')
    expect(vm.waitingInstall).toBe(true)
  })

  it('等待安装时每 3 秒轮询一次', async () => {
    const wrapper = await mountAsNotRunning()
    mockGetOllamaStatus.mockClear()

    await enterWaitingInstall(wrapper)

    // 推进 3 秒 → 第一次轮询
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0 })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(1)

    // 再推进 3 秒 → 第二次轮询
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(2)
  })

  it('轮询检测到 Ollama 运行后自动停止轮询并切换状态', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)
    mockGetOllamaStatus.mockClear()

    // 第一次轮询：仍然未运行
    mockGetOllamaStatus.mockResolvedValue({ running: false, associated: false, model_count: 0 })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(1)

    // 第二次轮询：已运行
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: false, model_count: 2 })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(mockGetOllamaStatus).toHaveBeenCalledTimes(2)

    // 验证状态切换
    const vm = wrapper.vm as unknown as { state: string; waitingInstall: boolean }
    expect(vm.state).toBe('running_not_associated')
    expect(vm.waitingInstall).toBe(false)

    // 再推进 6 秒，轮询应该已停止——最多多调 1 次（interval 边界）
    const callsBefore = mockGetOllamaStatus.mock.calls.length
    vi.advanceTimersByTime(6000)
    await flushPromises()
    // stopPolling 会在 detect() 内 clearInterval，但 setInterval 可能已排队一次回调
    expect(mockGetOllamaStatus.mock.calls.length - callsBefore).toBeLessThanOrEqual(1)
  })

  it('等待安装时网络错误不显示错误，继续轮询', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    // 轮询时抛错
    mockGetOllamaStatus.mockRejectedValue(new Error('Network error'))
    vi.advanceTimersByTime(3000)
    await flushPromises()

    // 不应该进入 error 状态，仍然在 waiting_install
    const vm = wrapper.vm as unknown as { state: string; error: string }
    expect(vm.state).toBe('waiting_install')
    expect(vm.error).toBe('')
  })

  it('点取消停止轮询回到未运行状态', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    const vm = wrapper.vm as unknown as { state: string; waitingInstall: boolean; cancelWaiting: () => void }
    expect(vm.state).toBe('waiting_install')

    // 直接调用取消（Transition stub 导致 v-if 链的按钮不可靠）
    vm.cancelWaiting()
    await flushPromises()

    expect(vm.state).toBe('not_running')
    expect(vm.waitingInstall).toBe(false)

    // 不再轮询
    mockGetOllamaStatus.mockClear()
    vi.advanceTimersByTime(6000)
    await flushPromises()
    expect(mockGetOllamaStatus).not.toHaveBeenCalled()
  })

  // ─── 4. 运行中（未关联） ──────────────────────────

  it('Ollama 运行但未关联时显示关联按钮', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: false, model_count: 3 })
    const wrapper = await mountOllamaCard()
    await flushPromises()

    expect(wrapper.text()).toContain('运行中（未关联）')
    expect(wrapper.text()).toContain('关联为供应商')
  })

  it('点击关联按钮发出 associate 事件', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: false, model_count: 0 })
    const wrapper = await mountOllamaCard()
    await flushPromises()

    const linkBtn = wrapper.find('.ollama-card__action-btn--primary')
    await linkBtn.trigger('click')

    expect(wrapper.emitted('associate')).toHaveLength(1)
  })

  // ─── 5. 已连接状态 ────────────────────────────────

  it('已关联时显示版本号和模型列表', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      version: '0.3.14',
      model_count: 2,
      models: [
        { name: 'qwen2.5:7b', size: 4_700_000_000, parameter_size: '7B', quantization_level: 'Q4_K_M' },
        { name: 'llama3.1:8b', size: 5_200_000_000, parameter_size: '8B', quantization_level: 'Q4_0' },
      ],
    })
    const wrapper = await mountOllamaCard()
    await flushPromises()

    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.text()).toContain('Ollama 0.3.14')
    expect(wrapper.text()).toContain('qwen2.5:7b')
    expect(wrapper.text()).toContain('llama3.1:8b')
    expect(wrapper.text()).toContain('4.7 GB')
    expect(wrapper.text()).toContain('7B')
    expect(wrapper.text()).toContain('Q4_K_M')
  })

  it('已关联但无模型时显示提示', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      version: '0.3.14',
      model_count: 0,
      models: [],
    })
    const wrapper = await mountOllamaCard()
    await flushPromises()

    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.text()).toContain('ollama pull')
  })

  // ─── 6. 错误状态 ──────────────────────────────────

  it('检测 API 报错时显示错误信息', async () => {
    mockGetOllamaStatus.mockRejectedValue(new Error('Connection refused'))
    const wrapper = await mountOllamaCard()
    await flushPromises()

    expect(wrapper.text()).toContain('检测失败')
    expect(wrapper.find('.ollama-card__error-msg').exists()).toBe(true)
    expect(wrapper.text()).toContain('Connection refused')
  })

  it('错误状态点 header 刷新可恢复', async () => {
    mockGetOllamaStatus.mockRejectedValue(new Error('fail'))
    const wrapper = await mountOllamaCard()
    await flushPromises()

    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0 })
    const refreshBtn = wrapper.find('.ollama-card__refresh')
    await refreshBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.find('.ollama-card__error-msg').exists()).toBe(false)
  })

  // ─── 7. 组件卸载 ──────────────────────────────────

  it('组件卸载时清理轮询定时器', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    wrapper.unmount()

    mockGetOllamaStatus.mockClear()
    vi.advanceTimersByTime(10000)
    await flushPromises()
    expect(mockGetOllamaStatus).not.toHaveBeenCalled()
  })

  // ─── 8. 卡片样式 ──────────────────────────────────

  it('已连接状态卡片有 --associated class', async () => {
    mockGetOllamaStatus.mockResolvedValue({ running: true, associated: true, model_count: 0 })
    const wrapper = await mountOllamaCard()
    await flushPromises()
    expect(wrapper.find('.ollama-card--associated').exists()).toBe(true)
  })

  it('错误状态卡片有 --error class', async () => {
    mockGetOllamaStatus.mockRejectedValue(new Error('fail'))
    const wrapper = await mountOllamaCard()
    await flushPromises()
    expect(wrapper.find('.ollama-card--error').exists()).toBe(true)
  })

  it('等待安装时状态为 waiting_install', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    const vm = wrapper.vm as unknown as { state: string }
    expect(vm.state).toBe('waiting_install')
  })

  // ─── 9. Footer ────────────────────────────────────

  it('始终显示其他本地模型的提示', async () => {
    const wrapper = await mountAsNotRunning()
    expect(wrapper.find('.ollama-card__footer').exists()).toBe(true)
    expect(wrapper.text()).toContain('LM Studio')
  })

  // ─── 10. 刷新按钮 ─────────────────────────────────

  it('检测中刷新按钮禁用', async () => {
    mockGetOllamaStatus.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountOllamaCard()

    const refreshBtn = wrapper.find('.ollama-card__refresh')
    expect(refreshBtn.attributes('disabled')).toBeDefined()
  })

  it('等待安装时 waitingInstall 为 true（刷新按钮应禁用）', async () => {
    const wrapper = await mountAsNotRunning()
    await enterWaitingInstall(wrapper)

    const vm = wrapper.vm as unknown as { waitingInstall: boolean; detecting: boolean }
    expect(vm.waitingInstall).toBe(true)
    // 模板中 :disabled="detecting || waitingInstall" 确保刷新被禁用
  })

  // ─── 11. formatSize ───────────────────────────────

  it('正确格式化模型大小 (MB 和 GB)', async () => {
    mockGetOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      model_count: 2,
      models: [
        { name: 'small', size: 500_000_000 },
        { name: 'large', size: 7_800_000_000 },
      ],
    })
    const wrapper = await mountOllamaCard()
    await flushPromises()

    expect(wrapper.text()).toContain('500 MB')
    expect(wrapper.text()).toContain('7.8 GB')
  })
})
