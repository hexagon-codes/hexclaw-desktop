/**
 * LogsView — P0-P2 最佳实践重构的行为回归。
 * 覆盖：域过滤下线 / 虚拟列表回退全量渲染 / error-warn 整行 tint /
 *       详情抽屉展开 fields+trace_id / 历史检索 / 单行复制 / 状态栏错误警告计数。
 * 注：jsdom 无布局，viewportH=0 → 虚拟列表回退「全量渲染」，故能断言到行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import LogsView from '@/views/LogsView.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { useLogsStore } from '@/stores/logs'
import zhCN from '@/i18n/locales/zh-CN'
import type { LogEntry } from '@/types'

const { connectLogStream, getLogs, getLogStats, nativeRuntime, saveBlobInAppMock } = vi.hoisted(() => ({
  connectLogStream: vi.fn(),
  getLogs: vi.fn(),
  getLogStats: vi.fn(),
  nativeRuntime: { enabled: false },
  saveBlobInAppMock: vi.fn(),
}))

vi.mock('@/api/logs', () => ({ connectLogStream, getLogs, getLogStats }))
vi.mock('@/utils/platform', () => ({ isTauri: () => nativeRuntime.enabled }))
vi.mock('@/utils/download', () => ({
  saveBlobInApp: (...args: unknown[]) => saveBlobInAppMock(...args),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function entry(p: Partial<LogEntry> & { id: string; level: LogEntry['level'] }): LogEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'engine',
    message: 'msg',
    ...p,
  }
}

let pinia: ReturnType<typeof createPinia>

function mountView() {
  pinia = createPinia()
  setActivePinia(pinia)
  return mount(LogsView, {
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
    },
  })
}

describe('LogsView (P0-P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeRuntime.enabled = false
    saveBlobInAppMock.mockResolvedValue('/tmp/hexclaw-logs.log')
    connectLogStream.mockReturnValue({ onopen: null, onclose: null, onmessage: null, close: vi.fn() })
    getLogStats.mockResolvedValue({ total: 0, by_level: {}, by_source: {}, requests_per_minute: 0 })
    getLogs.mockResolvedValue({ logs: [], total: 0 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the static 5-bucket domain facet and filters the live buffer by domain', async () => {
    const w = mountView()
    const store = useLogsStore()
    store.entries = [
      entry({ id: 'a', level: 'info', source: 'telegram', domain: 'integration', message: 'im inbound' }),
      entry({ id: 'b', level: 'info', source: 'llm', domain: 'engine', message: 'engine tick' }),
    ]
    await flushPromises()

    // 静态选项：全部域 + 5 个固定子系统桶（对齐后端 inferLogDomain）——不从 entries 派生
    const sel = w.findComponent(HcSelect)
    const labels = (sel.props('options') as Array<{ label: string }>).map((o) => o.label)
    expect(labels.some((l) => l.startsWith('全部域'))).toBe(true)
    expect(labels.some((l) => l.startsWith('引擎'))).toBe(true)
    expect(labels.some((l) => l.startsWith('集成'))).toBe(true)
    expect(labels.some((l) => l.startsWith('自动化'))).toBe(true)
    expect(labels.some((l) => l.startsWith('对话'))).toBe(true)
    expect(labels.some((l) => l.startsWith('知识库'))).toBe(true)

    // 选「集成」→ 实时缓冲只剩 integration 的那条
    store.setFilter({ domain: 'integration' })
    await flushPromises()
    expect(w.text()).toContain('im inbound')
    expect(w.text()).not.toContain('engine tick')
  })

  it('history search passes the selected domain to the backend query', async () => {
    const w = mountView()
    const store = useLogsStore()
    store.setFilter({ domain: 'integration', keyword: 'x' })
    await flushPromises()
    await w.findAll('.hc-logs__action-btn')[0]!.trigger('click')
    await flushPromises()
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ domain: 'integration', keyword: 'x' }))
  })

  it('applies error / warn full-row tint classes', async () => {
    const w = mountView()
    const store = useLogsStore()
    store.entries = [entry({ id: '1', level: 'error', message: 'boom' }), entry({ id: '2', level: 'warn', message: 'careful' })]
    await flushPromises()
    expect(w.find('.hc-logs__row--error').exists()).toBe(true)
    expect(w.find('.hc-logs__row--warn').exists()).toBe(true)
  })

  it('opens the detail drawer showing structured fields + trace_id', async () => {
    const w = mountView()
    const store = useLogsStore()
    store.entries = [entry({ id: 'x', level: 'error', message: 'db fail', trace_id: 'trace-abc', fields: { user_id: 42, op: 'query' } })]
    await flushPromises()

    await w.find('.hc-logs__row').trigger('click')
    await flushPromises()

    expect(w.find('.hc-logs__drawer').exists()).toBe(true)
    expect(w.text()).toContain('trace-abc')
    expect(w.text()).toContain('user_id')
    expect(w.text()).toContain('42')
    expect(w.text()).toContain('op')
  })

  it('history-search button queries getLogs server-side and shows the history banner', async () => {
    getLogs.mockResolvedValue({ logs: [entry({ id: 'h1', level: 'info', message: 'ancient log line' })], total: 1 })
    const w = mountView()
    const store = useLogsStore()
    store.setFilter({ keyword: 'ancient' })
    await flushPromises()

    // 工具栏第一个 action 按钮 = 搜索全部历史
    await w.findAll('.hc-logs__action-btn')[0]!.trigger('click')
    await flushPromises()

    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ keyword: 'ancient' }))
    expect(store.mode).toBe('history')
    expect(w.find('.hc-logs__histbar').exists()).toBe(true)
    expect(w.text()).toContain('ancient log line')
  })

  it('copies a log line to the clipboard from the row copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountView()
    const store = useLogsStore()
    store.entries = [entry({ id: '1', level: 'info', message: 'copy-me' })]
    await flushPromises()

    await w.find('.hc-logs__row-copy').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalled()
    expect(String(writeText.mock.calls[0]![0])).toContain('copy-me')
  })

  it('saves log text through the shared Blob boundary in Tauri', async () => {
    nativeRuntime.enabled = true
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logs')
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const w = mountView()
    const store = useLogsStore()
    store.entries = [entry({ id: '1', level: 'info', message: 'native-log-line' })]
    await flushPromises()

    await w.findAll('.hc-logs__action-btn')[1]!.trigger('click')

    expect(saveBlobInAppMock).toHaveBeenCalledTimes(1)
    const [blob, filename] = saveBlobInAppMock.mock.calls[0] as [Blob, string]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(filename).toMatch(/^hexclaw-logs-\d{4}-\d{2}-\d{2}\.log$/)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(anchorClick).not.toHaveBeenCalled()
  })

  it('keeps the object URL and anchor download path in the browser', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logs')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createElement = document.createElement.bind(document)
    let anchor: HTMLAnchorElement | undefined
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      const element = createElement(tagName, options)
      if (tagName === 'a') anchor = element as HTMLAnchorElement
      return element
    })
    const w = mountView()
    const store = useLogsStore()
    store.entries = [entry({ id: '1', level: 'info', message: 'browser-log-line' })]
    await flushPromises()

    await w.findAll('.hc-logs__action-btn')[1]!.trigger('click')

    expect(saveBlobInAppMock).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(anchor?.href).toBe('blob:logs')
    expect(anchor?.download).toMatch(/^hexclaw-logs-\d{4}-\d{2}-\d{2}\.log$/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:logs')
  })

  it('shows error / warn counts (not req/min) in the status bar', async () => {
    const w = mountView()
    const store = useLogsStore()
    store.entries = [
      entry({ id: '1', level: 'error' }),
      entry({ id: '2', level: 'error' }),
      entry({ id: '3', level: 'warn' }),
    ]
    await flushPromises()
    const bar = w.find('.hc-logs__statusbar').text()
    expect(bar).toContain('错误 2')
    expect(bar).toContain('警告 1')
    expect(bar).not.toContain('req/min')
  })
})
