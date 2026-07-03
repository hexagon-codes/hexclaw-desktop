/**
 * bug-20260626：连接中心「数据连接器」MCP 卡片状态徽章与「测试」结果矛盾。
 *
 * 复现场景（用户截图）：
 *   - MySQL 连接器卡片右上角徽章显示「已连接」（绿）。
 *   - 点「测试」却提示「未连接：MCP 服务尚未就绪（首次可能仍在后台下载组件，稍后再试）」。
 *
 * 根因：徽章绑定本地 `inst.enabled` 标志——MCP 类「注册即启用」恒为 true（无启停开关），
 * 故无论后端 stdio MCP server 是否真连上，徽章永远显示「已连接」；而「测试」按钮查的是
 * 后端真实在线状态（getMcpServerStatus），首次冷装组件仍在后台下载时返回「未就绪」。
 * 两套真值漂移 → 徽章与测试结果矛盾。
 *
 * 不变量：MCP 连接器的徽章必须反映**真实在线状态**，与「测试」按钮判定同源。
 *   - 后端 status 未连上 → 徽章不得显示「已连接」（应为「未就绪」）。
 *   - 后端 status 已连上 → 徽章显示「已连接」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { connectorList } = vi.hoisted(() => ({
  connectorList: { value: [] as unknown[] },
}))
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

const { addMcpServer, callMcpTool, getMcpServerStatus, getMcpTools, removeMcpServer } = vi.hoisted(() => ({
  addMcpServer: vi.fn(),
  callMcpTool: vi.fn(),
  getMcpServerStatus: vi.fn(),
  getMcpTools: vi.fn(),
  removeMcpServer: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer, callMcpTool, getMcpTools, removeMcpServer, getMcpServerStatus }))

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

describe('bug-20260626 MCP 连接器状态徽章 = 真实在线状态（不再恒绿）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addMcpServer.mockResolvedValue({ message: 'queued', connected: false })
    getMcpTools.mockResolvedValue({ tools: [], total: 0 })
    callMcpTool.mockResolvedValue({ result: 'ok' })
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    // 一个「注册即启用」(enabled=true) 的 MCP 连接器实例（对齐截图：MySQL「测试会话数据库」）。
    connectorList.value = [
      {
        id: 'm1',
        type: 'mysql',
        name: '测试会话数据库',
        config: { host: 'h', mcp_server: '测试会话数据库' },
        enabled: true,
      },
    ]
  })

  it('后端 MCP 未就绪 → 徽章不得显示「已连接」，应为「未就绪」', async () => {
    // 后端真实状态：server 尚未连上（首次冷装组件后台下载中）。
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()

    const pill = wrapper.find('.hc-conn-pill')
    expect(pill.exists()).toBe(true)
    // 核心不变量：未就绪时徽章不能谎报「已连接」。
    expect(pill.text()).not.toBe(zhCN.connections.legend.connected)
    expect(pill.text()).toBe(zhCN.connections.connectors.notReady)
    // 且不应带绿色修饰（绿 = 已连接）。
    expect(pill.classes()).not.toContain('hc-conn-pill--green')
  })

  it('后端 MCP 已连上 → 徽章显示「已连接」(绿)', async () => {
    getMcpServerStatus.mockResolvedValue({ statuses: { 测试会话数据库: 'connected' }, servers: [] })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()

    const pill = wrapper.find('.hc-conn-pill')
    expect(pill.text()).toBe(zhCN.connections.legend.connected)
    expect(pill.classes()).toContain('hc-conn-pill--green')
  })

  it('测试按钮在 MCP 未就绪时主动按当前配置重放注册，交给 sidecar best-effort 拉起', async () => {
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()

    // 徽章：未就绪
    expect(wrapper.find('.hc-conn-pill').text()).toBe(zhCN.connections.connectors.notReady)

    // 点测试：同样报未就绪（toast.info = mcpTestDisconnected），二者不矛盾
    const testBtn = wrapper
      .findAll('.hc-conn-btn--ghost')
      .find((b) => b.text().includes(zhCN.connections.channels.test))
    await testBtn!.trigger('click')
    await flushPromises()
    expect(addMcpServer).toHaveBeenCalledWith(
      '测试会话数据库',
      'npx',
      ['-y', '@benborla29/mcp-server-mysql'],
      {
        env: {
          MYSQL_HOST: 'h',
          MYSQL_PORT: '3306',
          MYSQL_USER: 'root',
        },
      },
    )
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpConnecting)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('MySQL MCP 拉起后执行真实 SQL 探测工具，而不是只看 status', async () => {
    getMcpServerStatus
      .mockResolvedValueOnce({ statuses: {}, servers: [] }) // mounted
      .mockResolvedValueOnce({ statuses: {}, servers: [] }) // test preflight
      .mockResolvedValueOnce({ statuses: { 测试会话数据库: 'connected' }, servers: [] }) // after add
    addMcpServer.mockResolvedValue({ message: 'ready', connected: true })
    getMcpTools.mockResolvedValue({
      tools: [
        // BUG-20260702：探针入参改由工具真实 input_schema 决定（不再硬猜 {sql}）；真实工具都带 schema。
        {
          name: 'mysql_query',
          description: 'Run SQL query',
          server_name: '测试会话数据库',
          input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
        },
      ],
      total: 1,
    })

    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()

    const testBtn = wrapper
      .findAll('.hc-conn-btn--ghost')
      .find((b) => b.text().includes(zhCN.connections.channels.test))
    await testBtn!.trigger('click')
    await flushPromises()

    expect(callMcpTool).toHaveBeenCalledWith('mysql_query', { sql: 'SELECT 1 AS ok' })
    expect(toastSuccess).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestConnected)
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
  })
})
