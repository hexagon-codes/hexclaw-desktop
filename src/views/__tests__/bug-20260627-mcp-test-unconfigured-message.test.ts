/**
 * bug-20260627：连接中心「数据连接器」MCP 连接器点「测试」对「尚未配置」状态误报。
 *
 * 复现场景（用户截图）：
 *   - MySQL 连接器「测试会话数据库」副标为「尚未配置」（config 无 host/path/url），后端 0 个 MCP server。
 *   - 点「测试」弹「未连接：MCP 服务尚未就绪（首次可能仍在后台下载组件，稍后再试）」。
 *
 * 根因：testConnector 的 MCP 分支只按 isMcpServerOnline 二分（在线=成功 / 否则=mcpTestDisconnected），
 *   把两种语义完全不同的离线子态混成一句：
 *     (a) 已配置但 MCP server 仍在后台下载/启动 → 「稍后再试」合理（短暂过渡态）。
 *     (b) 连接器从未配置（config 空）→ 等多久都没用，应提示去「编辑填写连接信息」。
 *   对 (b) 弹 (a) 的文案 = 误导用户白等。
 *
 * 不变量：
 *   - 未配置的 MCP 连接器测试时**不得**弹 mcpTestDisconnected（「下载中稍后再试」），应弹「尚未配置」提示。
 *   - 已配置但离线的 MCP 连接器测试时**仍**弹 mcpTestDisconnected（保留合理的首次下载提示，不被本修复误伤）。
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

async function clickTest(wrapper: ReturnType<typeof mountView>) {
  const testBtn = wrapper
    .findAll('.hc-conn-btn--ghost')
    .find((b) => b.text().includes(zhCN.connections.channels.test))
  await testBtn!.trigger('click')
  await flushPromises()
}

describe('bug-20260627 MCP 连接器测试：未配置 vs 离线 文案分流', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    // 后端真实状态：无任何 MCP server 在线（对齐截图 servers:[]）。
    getMcpServerStatus.mockResolvedValue({ statuses: {}, servers: [] })
  })

  it('未配置(config 空)的 MCP 连接器点测试 → 弹「尚未配置」提示，不得弹「下载中稍后再试」', async () => {
    // 对齐截图：MySQL「测试会话数据库」无 host/path/url → 副标「尚未配置」。
    connectorList.value = [
      {
        id: 'm1',
        type: 'mysql',
        name: '测试会话数据库',
        config: { mcp_server: '测试会话数据库' }, // 无 host → 未配置
        enabled: true,
      },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()
    await clickTest(wrapper)

    // 核心不变量：未配置不得弹「下载中稍后再试」（误导用户白等）。
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
    // 应弹「尚未配置，请先编辑配置」提示。
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestNotConfigured)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('已配置但离线的 MCP 连接器点测试 → 仍弹「下载中稍后再试」(本修复不误伤合理过渡态)', async () => {
    connectorList.value = [
      {
        id: 'm2',
        type: 'mysql',
        name: '会话库',
        config: { host: '127.0.0.1', mcp_server: '会话库' }, // 有 host → 已配置
        enabled: true,
      },
    ]
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    await flushPromises()
    await clickTest(wrapper)

    // 已配置但 server 未上线 = 合理的首次下载/启动过渡态，保留原文案。
    expect(toastInfo).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestDisconnected)
    expect(toastInfo).not.toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestNotConfigured)
  })
})
