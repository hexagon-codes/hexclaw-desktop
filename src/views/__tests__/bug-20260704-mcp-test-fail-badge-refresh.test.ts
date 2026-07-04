/**
 * BUG-20260704（配套 hexclaw mcp/bug_20260704_dead_server_status_selfheal_test.go）：
 * MCP 连接器「测试」探针失败后，卡片徽章仍谎报「已连接」。
 *
 * 真机现象（用户截图）：MySQL 卡徽章「已连接」，点「测试」弹
 * 「连接失败: 工具 "mysql_query" 执行失败: MCP 服务进程已退出…」——同屏自相矛盾。
 * 后端根修：CallTool 识别进程退出即翻转 server 断连（30s 自动重连自愈）。
 * 桌面配套：探针失败后必须重新拉取 MCP 状态真值，让徽章立即反映后端已翻转的
 * 断连态（「已连接」→「未就绪」），恢复「测试按钮与徽章共用单一真值」的设计承诺。
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

function mountView() {
  return mount(ConnectionsView, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
      stubs: { teleport: true },
    },
  })
}

describe('bug-20260704 MCP 测试失败后徽章刷新（不与测试结果自相矛盾）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectorList.value = [
      {
        id: 'm1',
        type: 'mysql',
        name: '测试会话数据库',
        config: { host: '127.0.0.1', mcp_server: '测试会话数据库' },
        enabled: true,
      },
    ]
    // 后端状态：server 在线（对齐截图「已连接」徽章）。
    getMcpServerStatus.mockResolvedValue({
      statuses: { 测试会话数据库: 'connected' },
      servers: [{ name: '测试会话数据库', connected: true }],
    })
    getMcpTools.mockResolvedValue({
      tools: [
        {
          name: 'mysql_query',
          server_name: '测试会话数据库',
          description: 'Run a read-only SQL query',
          input_schema: { properties: { sql: { type: 'string' } } },
        },
      ],
      total: 1,
    })
    // 探针撞上死进程（后端 CallTool 已翻转该 server 断连并回友好错误）。
    callMcpTool.mockRejectedValue(
      new Error('工具 "mysql_query" 执行失败: MCP 服务进程已退出，请检查数据库连接配置（主机/端口/账号/密码）后重试'),
    )
    addMcpServer.mockResolvedValue({ message: 'queued', connected: false })
    removeMcpServer.mockResolvedValue({ message: 'ok' })
  })

  it('探针失败 → 弹错误 toast 且必须重新拉取 MCP 状态真值（徽章翻转依据）', async () => {
    const wrapper = mountView()
    const seg = wrapper
      .findAll('.hc-segmented__btn')
      .find((b) => b.text().includes(zhCN.connections.tabConnectors))
    await seg!.trigger('click')
    await flushPromises()

    getMcpServerStatus.mockClear() // 只统计点「测试」之后的状态拉取

    const testBtn = wrapper
      .findAll('.hc-conn-btn--ghost')
      .find((b) => b.text().includes(zhCN.connections.channels.test))
    await testBtn!.trigger('click')
    await flushPromises()

    // 控制断言：错误确实弹出（既有行为）。
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('MCP 服务进程已退出'))
    // 核心不变量：失败后必须再拉一次状态（ensure 的 1 次 + 失败后的 1 次 ≥ 2）；
    // 只有 ensure 的 1 次 = 失败后没刷新 → 徽章继续谎报「已连接」。
    expect(
      getMcpServerStatus.mock.calls.length,
      '探针失败后未重新拉取 MCP 状态，徽章与测试结果自相矛盾',
    ).toBeGreaterThanOrEqual(2)
  })
})
