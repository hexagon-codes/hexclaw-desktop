/**
 * BUG-20260621 / connector-delete
 *
 * 回归锁定「连接 · 数据连接器删除」功能（ConnectionsView 的 connectors tab）。
 * 正确行为：连接器实例卡上的「删除」按钮（.hc-conn-btn--danger）→ 弹 ConfirmDialog →
 * 点确认（.hc-dialog__btn--danger）→ confirmDeleteConnector() → useConnectorInstances().removeInstance(id)
 * 被以该实例 id 调用一次。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

// ── mock 数据连接器 store（模块级单例）：用 vi.hoisted 构造可在 mock 工厂里共享的假实现 ──
const { connectorList, addInstance, updateInstance, removeInstance } = vi.hoisted(() => {
  return {
    connectorList: { value: [] as unknown[] },
    addInstance: vi.fn(),
    updateInstance: vi.fn(),
    removeInstance: vi.fn(),
  }
})

vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({
    list: connectorList,
    addInstance,
    updateInstance,
    removeInstance,
  }),
}))

// 删除 mcp 连接器(mysql 等)现在会 best-effort 调 removeMcpServer 摘除后端 server。
// mock 网络出口，避免真实 apiDelete 在 jsdom 里跑网络/拖慢 microtask 致 removeInstance 漏调。
const { removeMcpServer, getMcpServerStatus } = vi.hoisted(() => ({
  removeMcpServer: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer: vi.fn(), removeMcpServer, getMcpServerStatus }))

// useToast：testConnector() 会调用 toast.info，提供哑实现避免真实 toast 依赖。
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}))

// 重组件 stub：连接器配置弹层 + 通道卡片流（后者会拉 IM API，与本用例无关）。
vi.mock('@/components/channels/ConnectorConfigModal.vue', () => ({
  default: { template: '<div class="connector-modal-stub" />' },
}))
vi.mock('@/components/channels/ConnectionChannelCards.vue', () => ({
  default: { template: '<div class="channel-cards-stub" />' },
}))

// lucide 图标统一 stub（与 ConnectionChannelCards.test.ts 约定一致）。
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import ConnectionsView from '../ConnectionsView.vue'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountView() {
  return mount(ConnectionsView, {
    global: {
      plugins: [createTestI18n()],
      // ConfirmDialog 用 <Teleport to="body">，需 stub teleport 让断言能命中。
      stubs: { teleport: true },
    },
  })
}

describe('BUG-20260621 connector-delete: 数据连接器删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
    // 单例 list 复位为含一个 enabled 实例。
    connectorList.value = [
      { id: 'c1', type: 'mysql', name: '生产库', config: { host: 'h' }, enabled: true },
    ]
  })

  async function switchToConnectorsTab(wrapper: ReturnType<typeof mountView>) {
    // 默认 channels tab：连接器卡不在 DOM 里。切到 connectors tab。
    const seg = wrapper
      .findAll('.hc-segmented__btn')
      .find((b) => b.text().includes(zhCN.connections.tabConnectors))
    expect(seg, 'SegmentedControl 应有「数据连接器」段').toBeDefined()
    await seg!.trigger('click')
    await flushPromises()
  }

  it('切到 connectors tab 后，连接器实例卡出现且带删除按钮', async () => {
    const wrapper = mountView()
    await flushPromises()

    // 切换前：连接器卡 / 删除按钮不存在（默认在 channels tab）。
    expect(wrapper.find('.hc-conn-card').exists()).toBe(false)

    await switchToConnectorsTab(wrapper)

    // 切换后：实例卡渲染，文案命中实例名，删除按钮存在。
    expect(wrapper.find('.hc-conn-card').exists()).toBe(true)
    expect(wrapper.text()).toContain('生产库')
    const dangerBtn = wrapper.find('.hc-conn-btn--danger')
    expect(dangerBtn.exists()).toBe(true)
    expect(dangerBtn.text()).toContain(zhCN.connections.channels.delete)
  })

  it('点删除 → ConfirmDialog 弹出 → 点确认 → removeInstance 以 c1 调用一次', async () => {
    const wrapper = mountView()
    await flushPromises()
    await switchToConnectorsTab(wrapper)

    // 弹层尚未出现。
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)

    // 点删除按钮（设置 deleteTarget → ConfirmDialog open）。
    await wrapper.find('.hc-conn-btn--danger').trigger('click')
    await flushPromises()

    // ConfirmDialog 出现，标题命中连接器删除文案。
    const dialog = wrapper.find('.hc-dialog')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain(zhCN.connections.connectors.deleteConfirmTitle)

    // 确认前 removeInstance 不应被调用。
    expect(removeInstance).not.toHaveBeenCalled()

    // 点确认（danger 主按钮）。
    const confirmBtn = wrapper.find('.hc-dialog__btn--danger')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    // removeInstance 被以实例 id 调用一次。
    expect(removeInstance).toHaveBeenCalledTimes(1)
    expect(removeInstance).toHaveBeenCalledWith('c1')

    // confirmDeleteConnector 把 deleteTarget 清空 → 弹层关闭。
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)
  })

  it('点删除后取消（点取消）→ removeInstance 不被调用，弹层关闭', async () => {
    const wrapper = mountView()
    await flushPromises()
    await switchToConnectorsTab(wrapper)

    await wrapper.find('.hc-conn-btn--danger').trigger('click')
    await flushPromises()
    expect(wrapper.find('.hc-dialog').exists()).toBe(true)

    const cancelBtn = wrapper.find('.hc-dialog .hc-btn-secondary')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    await flushPromises()

    expect(removeInstance).not.toHaveBeenCalled()
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)
  })
})
