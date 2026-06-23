/**
 * 增量3：ConnectionsView 对 mcp 数据连接器的「测试 / 删除 / 启停」真实接线。
 *   - 删除 mcp 实例 → removeMcpServer(config.mcp_server) 被调用（摘后端 server）
 *   - 「测试」按钮 → 查 getMcpServerStatus 真实在线状态（替代旧 testStub 占位）
 *   - mcp 注册即启用：卡片不显示启停开关（停用 = 删除）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { connectorList, removeInstance, updateInstance } = vi.hoisted(() => ({
  connectorList: { value: [] as unknown[] },
  removeInstance: vi.fn(),
  updateInstance: vi.fn(),
}))
vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({
    list: connectorList,
    addInstance: vi.fn(),
    updateInstance,
    removeInstance,
  }),
}))

const { toastSuccess, toastInfo, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, info: toastInfo, error: toastError, warning: vi.fn() }),
}))

const { removeMcpServer, getMcpServerStatus } = vi.hoisted(() => ({
  removeMcpServer: vi.fn(),
  getMcpServerStatus: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer: vi.fn(), removeMcpServer, getMcpServerStatus }))

vi.mock('@/components/channels/ConnectorConfigModal.vue', () => ({
  default: { template: '<div class="connector-modal-stub" />' },
}))
vi.mock('@/components/channels/ConnectionChannelCards.vue', () => ({
  default: { template: '<div class="channel-cards-stub" />' },
}))
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
    global: { plugins: [createTestI18n()], stubs: { teleport: true } },
  })
}

async function switchToConnectors(wrapper: ReturnType<typeof mountView>) {
  const seg = wrapper
    .findAll('.hc-segmented__btn')
    .find((b) => b.text().includes(zhCN.connections.tabConnectors))
  await seg!.trigger('click')
  await flushPromises()
}

describe('增量3 ConnectionsView mcp 连接器 测试/删除/启停', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
    connectorList.value = [
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h', mcp_server: '生产库' }, enabled: true },
    ]
  })

  it('删除 mcp 实例 → removeMcpServer 以 config.mcp_server 调用一次', async () => {
    const wrapper = mountView()
    await switchToConnectors(wrapper)

    await wrapper.find('.hc-conn-btn--danger').trigger('click')
    await flushPromises()
    await wrapper.find('.hc-dialog__btn--danger').trigger('click')
    await flushPromises()

    expect(removeMcpServer).toHaveBeenCalledTimes(1)
    expect(removeMcpServer).toHaveBeenCalledWith('生产库')
    expect(removeInstance).toHaveBeenCalledWith('m1')
  })

  it('点「测试」→ 查 getMcpServerStatus；server 在线 → toast.success', async () => {
    getMcpServerStatus.mockResolvedValue({ statuses: { 生产库: 'connected' }, servers: [] })
    const wrapper = mountView()
    await switchToConnectors(wrapper)

    const testBtn = wrapper
      .findAll('.hc-conn-btn--ghost')
      .find((b) => b.text().includes(zhCN.connections.channels.test))
    expect(testBtn, '应有「测试」按钮').toBeDefined()
    await testBtn!.trigger('click')
    await flushPromises()

    expect(getMcpServerStatus).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestConnected)
  })

  it('mcp 卡片不显示启停开关（注册即启用，停用=删除）', async () => {
    const wrapper = mountView()
    await switchToConnectors(wrapper)

    const labels = wrapper.findAll('.hc-conn-btn').map((b) => b.text())
    expect(labels.some((l) => l.includes(zhCN.connections.channels.disable))).toBe(false)
    expect(labels.some((l) => l.includes(zhCN.connections.channels.enable))).toBe(false)
    // 但有测试 / 编辑 / 删除
    expect(labels.some((l) => l.includes(zhCN.connections.channels.test))).toBe(true)
    expect(labels.some((l) => l.includes(zhCN.common.edit))).toBe(true)
    expect(labels.some((l) => l.includes(zhCN.connections.channels.delete))).toBe(true)
  })
})
