/**
 * BUG-20260702（分层缺陷收紧·行为层）：ConnectionsView「测试连接」MCP 探针的两处静默错误。
 *
 * (b) 探针入参此前硬编码 `{ sql }`，是**猜测**的工具契约；工具靠「名称/描述含 query|sql」启发式挑出，
 *     挑中一个入参键不叫 sql（如 `query`）的工具就把 SQL 塞进错误的键，后端静默失败/误判。
 *     收紧：读工具 input_schema.properties 决定真实入参键；拿不到 schema 或无 SQL 字段则明确报错（不静默）。
 *
 * (c) pickMcpProbeTool 旧回退分支「无 server_name 的任意 SQL-like 工具」，在旧后端不回 server_name 时
 *     可能探到**别的 server** 的工具。收紧：只按 server_name 精确匹配当前被测 connector；无法归属时
 *     明确态「无法确定探针工具」，不盲选。
 *
 * 本文件在 view 层驱动真实「测试」按钮点击链，断言可观测行为。修复前 RED、修复后 GREEN。
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

const { addMcpServer, callMcpTool, removeMcpServer, getMcpServerStatus, getMcpTools } = vi.hoisted(() => ({
  addMcpServer: vi.fn(),
  callMcpTool: vi.fn(),
  removeMcpServer: vi.fn(),
  getMcpServerStatus: vi.fn(),
  getMcpTools: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ addMcpServer, callMcpTool, removeMcpServer, getMcpServerStatus, getMcpTools }))

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

describe('BUG-20260702 MCP 探针：schema 驱动入参 + server_name 精确归属', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addMcpServer.mockResolvedValue({ message: 'queued', connected: false })
    callMcpTool.mockResolvedValue({ result: 'ok' })
    removeMcpServer.mockResolvedValue({ message: 'ok' })
    // server 在线，直接进探针路径（不触发 addMcpServer）。
    getMcpServerStatus.mockResolvedValue({ statuses: { 生产库: 'connected' }, servers: [] })
    connectorList.value = [
      { id: 'm1', type: 'mysql', name: '生产库', config: { host: 'h', mcp_server: '生产库' }, enabled: true },
    ]
  })

  it('(b) 工具入参键为 query（非 sql）时，探针按 input_schema 用 query 键，而非硬塞 sql', async () => {
    getMcpTools.mockResolvedValue({
      tools: [
        {
          name: 'run_sql',
          description: 'Run a SQL query',
          server_name: '生产库',
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
      total: 1,
    })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    getMcpServerStatus.mockClear()
    await clickTest(wrapper)

    // RED：旧代码无视 input_schema，硬调 callMcpTool('run_sql', { sql: ... }) → 键错
    expect(callMcpTool).toHaveBeenCalledWith('run_sql', { query: 'SELECT 1 AS ok' })
    expect(toastSuccess).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestConnected)
  })

  it('(b) 工具无 input_schema 时，探针明确报错（不静默硬塞 sql）', async () => {
    getMcpTools.mockResolvedValue({
      tools: [{ name: 'mysql_query', description: 'Run SQL query', server_name: '生产库' }],
      total: 1,
    })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    getMcpServerStatus.mockClear()
    await clickTest(wrapper)

    // RED：旧代码硬调 callMcpTool('mysql_query', { sql: ... }) 并 toast.success（静默猜测）
    expect(callMcpTool).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('(c) 工具无 server_name（旧后端）时不盲选，明确报「无法确定探针工具」而非探错 server', async () => {
    getMcpTools.mockResolvedValue({
      tools: [
        // 无 server_name：可能属于别的 server，不能盲选
        { name: 'other_query', description: 'query something', input_schema: { properties: { sql: {} } } },
      ],
      total: 1,
    })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    getMcpServerStatus.mockClear()
    await clickTest(wrapper)

    // RED：旧回退分支盲选无 server_name 的 SQL-like 工具 → callMcpTool + toast.success
    expect(callMcpTool).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('(c) 同名 server 的 SQL 工具存在时正常探针（精确归属命中）', async () => {
    getMcpTools.mockResolvedValue({
      tools: [
        { name: 'other_srv_query', description: 'query', server_name: '别的库', input_schema: { properties: { sql: {} } } },
        { name: 'mine_query', description: 'run query', server_name: '生产库', input_schema: { properties: { sql: {} } } },
      ],
      total: 2,
    })
    const wrapper = mountView()
    await switchToConnectors(wrapper)
    getMcpServerStatus.mockClear()
    await clickTest(wrapper)

    expect(callMcpTool).toHaveBeenCalledWith('mine_query', { sql: 'SELECT 1 AS ok' })
    expect(toastSuccess).toHaveBeenCalledWith(zhCN.connections.connectors.mcpTestConnected)
  })
})
