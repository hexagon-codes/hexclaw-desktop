/**
 * MCP 内容层回归。
 *
 * 这些用例固定原型 fixture 的可观察不变量：
 * - 服务器行显示后端提供的描述；
 * - 待授权行只显示授权与删除动作，不显示重启；
 * - 多个工具可同时展开，并在 schema 区域保留静态参数输入。
 *
 * 服务器旧响应仍可用 string[]；结构化响应、静态 schema/input 与测试表单的边界由本文件固定。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getMcpServers,
  getMcpTools,
  getMcpServerStatus,
  getMcpMarketplace,
  callMcpTool,
  addMcpServer,
  removeMcpServer,
  restartMcpServer,
} = vi.hoisted(() => ({
  getMcpServers: vi.fn(),
  getMcpTools: vi.fn(),
  getMcpServerStatus: vi.fn(),
  getMcpMarketplace: vi.fn(),
  callMcpTool: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  restartMcpServer: vi.fn(),
}))

vi.mock('@/api/mcp', () => ({
  getMcpServers,
  getMcpTools,
  getMcpServerStatus,
  getMcpMarketplace,
  callMcpTool,
  addMcpServer,
  removeMcpServer,
  restartMcpServer,
}))

vi.mock('@/api/skills', () => ({ installFromHub: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  return Object.fromEntries(Object.keys(original).map((key) => [key, stub]))
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountMcpView() {
  const McpView = (await import('../McpView.vue')).default
  return mount(McpView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        EmptyState: {
          props: ['title', 'description'],
          template: '<div class="empty-stub">{{ title }}</div>',
        },
        LoadingState: { template: '<div class="loading-stub">loading</div>' },
        Teleport: true,
      },
    },
  })
}

const serverList = ['filesystem', 'postgres-readonly']

function setBaseMocks() {
  getMcpServers.mockResolvedValue({ servers: serverList, total: serverList.length })
  getMcpTools.mockResolvedValue({ tools: [], total: 0 })
  getMcpServerStatus.mockResolvedValue({
    statuses: { filesystem: 'connected', 'postgres-readonly': 'pending_authorization' },
  })
  getMcpMarketplace.mockResolvedValue({ skills: [], total: 0 })
  callMcpTool.mockResolvedValue({ result: null })
  addMcpServer.mockResolvedValue({ message: 'ok' })
  removeMcpServer.mockResolvedValue({ message: 'ok' })
  restartMcpServer.mockResolvedValue({ message: 'ok' })
}

describe('BUG-20260723-009/010 MCP 内容层不变量', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setBaseMocks()
  })

  it('服务器行展示后端提供的 MCP 描述，而不是只展示名称', async () => {
    // 结构化 server 是内容层要消费的真实语义；当前 API/UI 仍只接受 string[]，此处故意取得 RED。
    getMcpServers.mockResolvedValue({
      servers: [
        {
          name: 'filesystem',
          description: 'stdio · npx -y @modelcontextprotocol/server-filesystem ~/Documents',
        },
        {
          name: 'postgres-readonly',
          description: 'stdio · 只读数据库工具 · 3 个工具',
        },
      ],
      total: 2,
    })

    const wrapper = await mountMcpView()
    await flushPromises()

    const descriptions = wrapper.findAll('[data-mcp-description]')
    expect(descriptions).toHaveLength(2)
    expect(descriptions.map((description) => description.text())).toEqual([
      'stdio · npx -y @modelcontextprotocol/server-filesystem ~/Documents',
      'stdio · 只读数据库工具 · 3 个工具',
    ])
  })

  it('待授权服务器只显示去设置授权和删除，不显示重启', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const pendingRow = wrapper
      .findAll('.hc-capability-installed-row--mcp')
      .find((row) => row.text().includes('postgres-readonly'))
    expect(pendingRow, '应找到 postgres-readonly 待授权行').toBeDefined()

    const actionTexts = pendingRow!.findAll('button').map((button) => button.text().trim())
    expect(actionTexts).toEqual(['去设置授权', '删除'])
  })

  it('两个 MCP 工具可同时展开，并在 schema 区域保留静态参数输入', async () => {
    getMcpTools.mockResolvedValue({
      tools: [
        {
          name: 'filesystem.read_file',
          description: '读取允许目录内的文件内容',
          input_schema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '绝对路径',
                example: '/Users/hexagon/Documents/report.md',
              },
            },
          },
        },
        {
          name: 'postgres.query',
          description: '执行只读 SQL 查询',
          input_schema: {
            type: 'object',
            properties: {
              sql: { type: 'string' },
              limit: { type: 'number', default: 100 },
            },
          },
        },
      ],
      total: 2,
    })

    const wrapper = await mountMcpView()
    await flushPromises()
    const vm = wrapper.vm as unknown as { activeTab: string }
    vm.activeTab = 'tools'
    await wrapper.vm.$nextTick()

    const toolRows = wrapper.findAll('.hc-capability-installed-row--tool')
    expect(toolRows).toHaveLength(2)
    await toolRows[0]!.find('.hc-capability-installed-main').trigger('click')
    await toolRows[1]!.find('.hc-capability-installed-main').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.hc-capability-installed-main .hc-capability-installed-schema')).toHaveLength(2)
    expect(wrapper.findAll('.hc-capability-installed-row--tool input')).toHaveLength(1)
  })
})
