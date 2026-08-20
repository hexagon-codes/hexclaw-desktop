import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ConnectionChannelCards from '../ConnectionChannelCards.vue'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getIMInstances,
  updateIMInstance,
  testSavedIMInstanceRuntime,
  listIMInstancesHealth,
  getCronJobs,
} = vi.hoisted(() => ({
  getIMInstances: vi.fn(),
  updateIMInstance: vi.fn(),
  testSavedIMInstanceRuntime: vi.fn(),
  listIMInstancesHealth: vi.fn(),
  getCronJobs: vi.fn(),
}))

vi.mock('@/api/im-channels', async () => {
  const actual = await vi.importActual<typeof import('@/api/im-channels')>('@/api/im-channels')
  return {
    ...actual,
    getIMInstances,
    updateIMInstance,
    testSavedIMInstanceRuntime,
    listIMInstancesHealth,
  }
})

vi.mock('@/api/tasks', () => ({
  getCronJobs,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
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

function mountCards() {
  return mount(ConnectionChannelCards, {
    global: {
      plugins: [createTestI18n()],
      stubs: { ChannelConfigModal: { template: '<div class="modal-stub" />' }, teleport: true },
    },
  })
}

describe('ConnectionChannelCards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getIMInstances.mockResolvedValue([
      {
        id: 'feishu-1',
        name: '飞书 · 日报机器人',
        type: 'feishu',
        enabled: true,
        config: { app_id: 'cli_xxx', app_secret: 'secret' },
        createdAt: 1,
      },
    ])
    updateIMInstance.mockResolvedValue(true)
    testSavedIMInstanceRuntime.mockResolvedValue({ success: true, message: 'ok' })
    // 默认：无引用任务、无健康异常（各用例按需覆盖）
    getCronJobs.mockResolvedValue({ jobs: [], total: 0 })
    listIMInstancesHealth.mockResolvedValue([])
  })

  it('renders the instance card; email placeholder card is no longer shown (email added via top + Add)', async () => {
    const wrapper = mountCards()
    await flushPromises()

    expect(wrapper.text()).toContain('飞书 · 日报机器人')
    // 邮箱占位卡已移除：不再常驻渲染「邮箱（SMTP / IMAP）」配置卡
    expect(wrapper.text()).not.toContain(zhCN.connections.channels.emailName)
    // 已启用且配置完整 → 已连接 pill
    expect(wrapper.find('.hc-cxpill--green').exists()).toBe(true)
  })

  it('shows an empty state (no email placeholder) when there are no instances', async () => {
    getIMInstances.mockResolvedValueOnce([])
    const wrapper = mountCards()
    await flushPromises()

    expect(wrapper.find('.hc-empty').exists()).toBe(true)
    expect(wrapper.text()).toContain(zhCN.connections.channels.emptyTitle)
    expect(wrapper.text()).not.toContain(zhCN.connections.channels.emailName)
  })

  it('does not render an in-grid dashed add card (add lives in the top toolbar)', async () => {
    const wrapper = mountCards()
    await flushPromises()
    expect(wrapper.find('.hc-cxcard--dashed').exists()).toBe(false)
  })

  it('toggles an instance enabled state through updateIMInstance', async () => {
    const wrapper = mountCards()
    await flushPromises()

    const disableBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes(zhCN.connections.channels.disable))
    expect(disableBtn).toBeDefined()
    await disableBtn!.trigger('click')
    await flushPromises()

    expect(updateIMInstance).toHaveBeenCalledWith('feishu-1', { enabled: false })
  })

  it('runs a runtime test through testSavedIMInstanceRuntime', async () => {
    const wrapper = mountCards()
    await flushPromises()

    const testBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes(zhCN.connections.channels.test))
    expect(testBtn).toBeDefined()
    await testBtn!.trigger('click')
    await flushPromises()

    expect(testSavedIMInstanceRuntime).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.hc-cxcard__testresult.is-ok').exists()).toBe(true)
  })

  it('opens the config modal via the exposed openCreate (top toolbar add)', async () => {
    const wrapper = mountCards()
    await flushPromises()

    ;(wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    await flushPromises()

    expect(wrapper.find('.modal-stub').exists()).toBe(true)
  })

  it('keeps cron reference data loading without rendering a reference chip or copy', async () => {
    // 返回含多种投递目标的后台任务，确认数据仍会加载但不投影可见 UI。
    getCronJobs.mockResolvedValue({
      jobs: [
        { id: 'j1', deliver: ['feishu-1'] }, // 命中实例 id
        { id: 'j2', deliver: ['飞书 · 日报机器人'] }, // 命中实例 name
        { id: 'j3', deliver: ['feishu'] }, // 命中 provider(type)
        { id: 'j4', deliver: ['chat'] }, // 桌面 chat 流，不计
      ],
      total: 4,
    })
    const wrapper = mountCards()
    await flushPromises()

    expect(getCronJobs).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.hc-cxrefchip').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(
      zhCN.connections.channels.refchip.replace('{count}', '3'),
    )
  })

  it('renders no reference chip when no cron job references the connection', async () => {
    getCronJobs.mockResolvedValue({ jobs: [{ id: 'j1', deliver: ['chat'] }], total: 1 })
    const wrapper = mountCards()
    await flushPromises()

    expect(wrapper.find('.hc-cxrefchip').exists()).toBe(false)
  })

  it('degrades silently (no chip, no error) when cron jobs cannot be fetched', async () => {
    getCronJobs.mockRejectedValue(new Error('backend down'))
    const wrapper = mountCards()
    await flushPromises()

    expect(wrapper.find('.hc-cxrefchip').exists()).toBe(false)
    expect(wrapper.find('.hc-cxstream__alert').exists()).toBe(false)
  })

  it('renders a red credential-invalid pill when instance health reports an error', async () => {
    listIMInstancesHealth.mockResolvedValue([
      { name: '飞书 · 日报机器人', provider: 'feishu', status: 'error', enabled: true, last_error: 'token expired' },
    ])
    const wrapper = mountCards()
    await flushPromises()

    const pill = wrapper.find('.hc-cxpill--red')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain(zhCN.connections.legend.invalid)
    // 不再是 green
    expect(wrapper.find('.hc-cxpill--green').exists()).toBe(false)
  })

  it('keeps the green pill when health is reported healthy (no last_error)', async () => {
    listIMInstancesHealth.mockResolvedValue([
      { name: '飞书 · 日报机器人', provider: 'feishu', status: 'running', enabled: true },
    ])
    const wrapper = mountCards()
    await flushPromises()

    expect(wrapper.find('.hc-cxpill--green').exists()).toBe(true)
    expect(wrapper.find('.hc-cxpill--red').exists()).toBe(false)
  })
})
