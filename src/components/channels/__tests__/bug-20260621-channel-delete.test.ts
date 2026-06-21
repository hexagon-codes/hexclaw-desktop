import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ConnectionChannelCards from '../ConnectionChannelCards.vue'
import zhCN from '@/i18n/locales/zh-CN'

// BUG-20260621 channel-delete 回归：锁定「连接·通道与账号删除」流程。
// 现有 ConnectionChannelCards.test.ts 的 im-channels mock 未覆盖 deleteIMInstance，
// 默认会落到真实实现去打后端。这里在 hoisted mock 里补上 deleteIMInstance: vi.fn()
// 并在 vi.mock 返回里覆盖它（mockResolvedValue(true)），其余沿用现有约定。
const {
  getIMInstances,
  updateIMInstance,
  deleteIMInstance,
  testSavedIMInstanceRuntime,
  listIMInstancesHealth,
  getCronJobs,
} = vi.hoisted(() => ({
  getIMInstances: vi.fn(),
  updateIMInstance: vi.fn(),
  deleteIMInstance: vi.fn(),
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
    deleteIMInstance,
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
      // ConfirmDialog 用 <Teleport to="body">，teleport: true 让其内联渲染从而可被 find 命中
      stubs: { ChannelConfigModal: { template: '<div class="modal-stub" />' }, teleport: true },
    },
  })
}

describe('BUG-20260621 channel-delete', () => {
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
    deleteIMInstance.mockResolvedValue(true)
    testSavedIMInstanceRuntime.mockResolvedValue({ success: true, message: 'ok' })
    getCronJobs.mockResolvedValue({ jobs: [], total: 0 })
    listIMInstancesHealth.mockResolvedValue([])
  })

  it('renders a danger delete button on the instance card', async () => {
    const wrapper = mountCards()
    await flushPromises()

    const dangerBtn = wrapper.find('.hc-cxbtn--danger')
    expect(dangerBtn.exists()).toBe(true)
    expect(dangerBtn.text()).toContain('删除')
  })

  it('opens ConfirmDialog and calls deleteIMInstance with the instance id on confirm', async () => {
    const wrapper = mountCards()
    await flushPromises()

    // 删除前没有确认弹层
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)

    // 点删除按钮 → 弹出 ConfirmDialog
    const dangerBtn = wrapper.find('.hc-cxbtn--danger')
    expect(dangerBtn.exists()).toBe(true)
    await dangerBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('.hc-dialog').exists()).toBe(true)
    const confirmBtn = wrapper.find('.hc-dialog__btn--danger')
    expect(confirmBtn.exists()).toBe(true)

    // 点确认 → deleteIMInstance('feishu-1') 被调用一次，且未误删（不应在确认前调用）
    expect(deleteIMInstance).not.toHaveBeenCalled()
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(deleteIMInstance).toHaveBeenCalledTimes(1)
    expect(deleteIMInstance).toHaveBeenCalledWith('feishu-1')
  })
})
