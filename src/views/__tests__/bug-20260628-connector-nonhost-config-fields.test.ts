/**
 * bug-20260628：连接中心「数据连接器」MCP 连接器的「是否已配置」判据只认 host/path/url，
 * 漏判「靠其它字段配置」的类型（语雀=仅 token / 飞书文档=app_id+app_secret）。
 *
 * 根因：bug-20260627 修复引入 connectorTarget(host/path/url) 作为「已配置」判据，并接到「测试」按钮
 *   的未配置分流。但 MCP 连接器是**声明式 fields**（src/config/mcp-connectors.ts）——
 *   不同类型字段不同：mysql/pg/redis/mongo→host、sqlite→path、**yuque→token(机密)、
 *   feishuDoc→app_id+app_secret**，后两者全无 host/path/url。
 *   → 已配置的语雀/飞书文档连接器被误判为「未配置」：测试弹「请先配置」（明明配好了 token）、
 *     副标显「尚未配置」。
 *
 * 不变量：「已配置」判据须按该类型 spec 的字段是否被填，而非硬编码 host/path/url。
 *   - 已填 token 的语雀 / 已填 app_id 的飞书文档 → 视作已配置：测试走 MCP 状态分流（非「请先配置」）。
 *   - 字段全空 → 仍判未配置（弹「请先配置」）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { connectorList } = vi.hoisted(() => ({ connectorList: { value: [] as unknown[] } }))
vi.mock('@/composables/useConnectorInstances', () => ({
  useConnectorInstances: () => ({
    list: connectorList,
    addInstance: vi.fn(),
    updateInstance: vi.fn(),
    removeInstance: vi.fn(),
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

const { getMcpServerStatus, removeMcpServer } = vi.hoisted(() => ({
  getMcpServerStatus: vi.fn(),
  removeMcpServer: vi.fn(),
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
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
function mountView() {
  return mount(ConnectionsView, { global: { plugins: [createTestI18n()], stubs: { teleport: true } } })
}
async function switchToConnectors(wrapper: ReturnType<typeof mountView>) {
  const seg = wrapper.findAll('.hc-segmented__btn').find((b) => b.text().includes(zhCN.connections.tabConnectors))
  await seg!.trigger('click')
  await flushPromises()
}
async function clickTest(wrapper: ReturnType<typeof mountView>) {
  const btn = wrapper.findAll('.hc-conn-btn--ghost').find((b) => b.text().includes(zhCN.connections.channels.test))
  await btn!.trigger('click')
  await flushPromises()
}

describe('bug-20260628 非 host/path/url 字段的 MCP 连接器「已配置」判据', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] }) // 后端无 server 在线
  })

  it('已填 token 的语雀连接器测试 → 不得弹「请先配置」（它已配置，只是 MCP 未上线）', async () => {
    connectorList.value = [
      { id: 'y1', type: 'yuque', name: '我的语雀', config: { token: 'yq-secret-abc', mcp_server: '我的语雀' }, enabled: true },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await clickTest(wrapper)
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestNotConfigured)
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
  })

  it('已填 app_id 的飞书文档连接器测试 → 不得弹「请先配置」', async () => {
    connectorList.value = [
      {
        id: 'f1',
        type: 'feishuDoc',
        name: '飞书库',
        config: { app_id: 'cli_xxx', app_secret: 'sec', mcp_server: '飞书库' },
        enabled: true,
      },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await clickTest(wrapper)
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestNotConfigured)
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
  })

  it('字段全空的语雀连接器测试 → 仍判未配置（弹「请先配置」）', async () => {
    connectorList.value = [
      { id: 'y2', type: 'yuque', name: '空语雀', config: { mcp_server: '空语雀' }, enabled: true },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await clickTest(wrapper)
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestNotConfigured)
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
  })

  // ── 副标显示侧（与测试按钮同源，杜绝 badge/sub 漂移）──
  it('已配置（仅机密 token）的语雀副标显「已配置」而非「尚未配置」', async () => {
    connectorList.value = [
      { id: 'y3', type: 'yuque', name: '语雀X', config: { token: 'yq-xxx', mcp_server: '语雀X' }, enabled: true },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    const sub = wrapper.find('.hc-conn-card__desc')
    expect(sub.text()).toBe(zhCN.connections.channels.configured)
    expect(sub.text()).not.toBe(zhCN.connections.channels.notConfigured)
  })

  it('已填 app_id 的飞书文档副标显 app_id（非机密字段，非「尚未配置」）', async () => {
    connectorList.value = [
      {
        id: 'f2',
        type: 'feishuDoc',
        name: '飞书Y',
        config: { app_id: 'cli_show', app_secret: 'sec', mcp_server: '飞书Y' },
        enabled: true,
      },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    expect(wrapper.find('.hc-conn-card__desc').text()).toBe('cli_show')
  })

  it('字段全空的连接器副标仍显「尚未配置」', async () => {
    connectorList.value = [{ id: 'm0', type: 'mysql', name: '空库', config: { mcp_server: '空库' }, enabled: true }]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    expect(wrapper.find('.hc-conn-card__desc').text()).toBe(zhCN.connections.channels.notConfigured)
  })
})
