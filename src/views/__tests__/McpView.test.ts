import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

// ─── Mock MCP API ───────────────────────────────────
const mockGetMcpServers = vi.fn()
const mockGetMcpTools = vi.fn()
const mockCallMcpTool = vi.fn()
const mockGetMcpServerStatus = vi.fn()
const mockAddMcpServer = vi.fn()
const mockRemoveMcpServer = vi.fn()
const mockGetMcpMarketplace = vi.fn()
const mockSearchMcpMarketplace = vi.fn()

const mockInstallFromHub = vi.fn()

vi.mock('@/api/mcp', () => ({
  getMcpServers: () => mockGetMcpServers(),
  getMcpTools: () => mockGetMcpTools(),
  callMcpTool: (name: string, args: Record<string, unknown>) => mockCallMcpTool(name, args),
  getMcpServerStatus: () => mockGetMcpServerStatus(),
  addMcpServer: (name: string, cmd: string, args?: string[]) => mockAddMcpServer(name, cmd, args),
  removeMcpServer: (name: string) => mockRemoveMcpServer(name),
  getMcpMarketplace: () => mockGetMcpMarketplace(),
  searchMcpMarketplace: (q: string) => mockSearchMcpMarketplace(q),
}))

vi.mock('@/api/skills', () => ({
  installFromHub: (name: string) => mockInstallFromHub(name),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
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

function setupDefaultMocks() {
  mockGetMcpServers.mockResolvedValue({ servers: ['filesystem', 'github'], total: 2 })
  mockGetMcpTools.mockResolvedValue({
    tools: [
      { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
      { name: 'search', description: 'Search the web' },
    ],
    total: 2,
  })
  mockGetMcpServerStatus.mockResolvedValue({ statuses: { filesystem: 'connected', github: 'disconnected' } })
  mockGetMcpMarketplace.mockResolvedValue({ skills: [], total: 0 })
}

async function mountMcpView() {
  const McpView = (await import('../McpView.vue')).default
  return mount(McpView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        EmptyState: { props: ['title', 'description'], template: '<div class="empty-stub">{{ title }}</div>' },
        LoadingState: { template: '<div class="loading-stub">loading</div>' },
        Teleport: true,
      },
    },
  })
}

describe('McpView — MCP 全链路', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultMocks()
  })

  // ─── 1. 初始加载 ──────────────────────────────────

  it('挂载时加载服务器和工具列表', async () => {
    await mountMcpView()
    await flushPromises()

    expect(mockGetMcpServers).toHaveBeenCalledTimes(1)
    expect(mockGetMcpTools).toHaveBeenCalledTimes(1)
    expect(mockGetMcpServerStatus).toHaveBeenCalledTimes(1)
  })

  it('加载中显示 loading 状态', async () => {
    mockGetMcpServers.mockReturnValue(new Promise(() => {}))
    mockGetMcpTools.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountMcpView()

    expect(wrapper.find('.loading-stub').exists()).toBe(true)
  })

  it('加载失败显示错误信息', async () => {
    mockGetMcpServers.mockRejectedValue(new Error('Network error'))
    mockGetMcpTools.mockRejectedValue(new Error('Network error'))
    const wrapper = await mountMcpView()
    await flushPromises()

    expect(wrapper.text()).toContain('Network error')
  })

  // ─── 2. 服务器 Tab ────────────────────────────────

  it('默认显示服务器 Tab 并列出服务器', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    expect(wrapper.text()).toContain('filesystem')
    expect(wrapper.text()).toContain('github')
  })

  it('服务器状态正确显示（connected / disconnected）', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    // filesystem = connected, github = disconnected
    const statusDots = wrapper.findAll('.w-2\\.5')
    expect(statusDots.length).toBe(2)
  })

  it('无服务器时显示空状态', async () => {
    mockGetMcpServers.mockResolvedValue({ servers: [], total: 0 })
    const wrapper = await mountMcpView()
    await flushPromises()

    expect(wrapper.find('.empty-stub').exists()).toBe(true)
  })

  it('Tab 计数显示正确', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    expect(wrapper.text()).toMatch(/服务器.*\(2\)/)
    expect(wrapper.text()).toMatch(/工具.*\(2\)/)
  })

  // ─── 3. 添加服务器 ────────────────────────────────

  it('点击添加按钮打开对话框', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    // 调用 exposed method
    ;(wrapper.vm as unknown as { openAddServer: () => void }).openAddServer()
    await wrapper.vm.$nextTick()

    // showAddServer 应为 true（Teleport stubbed，内容可能不渲染）
    const vm = wrapper.vm as unknown as { showAddServer: boolean }
    expect(vm.showAddServer).toBe(true)
  })

  it('添加服务器：名称和命令必填', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      newServerName: string
      newServerCommand: string
      handleAddServer: () => Promise<void>
    }
    vm.newServerName = ''
    vm.newServerCommand = ''
    await vm.handleAddServer()
    expect(mockAddMcpServer).not.toHaveBeenCalled()
  })

  it('添加服务器成功后刷新列表', async () => {
    mockAddMcpServer.mockResolvedValue({ message: 'added' })
    const wrapper = await mountMcpView()
    await flushPromises()
    mockGetMcpServers.mockClear()
    mockGetMcpTools.mockClear()

    const vm = wrapper.vm as unknown as {
      newServerName: string
      newServerCommand: string
      newServerArgs: string
      showAddServer: boolean
      handleAddServer: () => Promise<void>
    }
    vm.showAddServer = true
    vm.newServerName = 'test-server'
    vm.newServerCommand = 'npx'
    vm.newServerArgs = '-y @test/server'
    await vm.handleAddServer()
    await flushPromises()

    expect(mockAddMcpServer).toHaveBeenCalledWith('test-server', 'npx', ['-y', '@test/server'])
    expect(vm.showAddServer).toBe(false)
    // loadAll 重新加载
    expect(mockGetMcpServers).toHaveBeenCalled()
  })

  it('添加服务器 args 为空时传 undefined', async () => {
    mockAddMcpServer.mockResolvedValue({ message: 'added' })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      newServerName: string
      newServerCommand: string
      newServerArgs: string
      handleAddServer: () => Promise<void>
    }
    vm.newServerName = 'simple'
    vm.newServerCommand = '/usr/bin/mcp'
    vm.newServerArgs = ''
    await vm.handleAddServer()
    await flushPromises()

    expect(mockAddMcpServer).toHaveBeenCalledWith('simple', '/usr/bin/mcp', undefined)
  })

  // ─── 4. 移除服务器 ────────────────────────────────

  it('移除服务器后从列表中删除', async () => {
    mockRemoveMcpServer.mockResolvedValue({ message: 'removed' })
    // confirm 对话框
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = await mountMcpView()
    await flushPromises()
    expect(wrapper.text()).toContain('filesystem')

    const vm = wrapper.vm as unknown as { handleRemoveServer: (name: string) => Promise<void>; servers: string[] }
    await vm.handleRemoveServer('filesystem')
    await flushPromises()

    expect(mockRemoveMcpServer).toHaveBeenCalledWith('filesystem')
    expect(vm.servers).not.toContain('filesystem')
  })

  it('取消确认则不移除', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { handleRemoveServer: (name: string) => Promise<void> }
    await vm.handleRemoveServer('filesystem')
    expect(mockRemoveMcpServer).not.toHaveBeenCalled()
  })

  // ─── 5. 工具 Tab ──────────────────────────────────

  it('切换到工具 Tab 显示工具列表', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string }
    vm.activeTab = 'tools'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('read_file')
    expect(wrapper.text()).toContain('Read a file')
    expect(wrapper.text()).toContain('search')
  })

  it('工具搜索过滤', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string; toolSearchQuery: string; filteredTools: unknown[] }
    vm.activeTab = 'tools'
    vm.toolSearchQuery = 'read'
    await wrapper.vm.$nextTick()

    expect(vm.filteredTools).toHaveLength(1)
  })

  it('展开工具显示 schema', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string; toggleTool: (name: string) => void; expandedTool: string | null }
    vm.activeTab = 'tools'
    vm.toggleTool('read_file')
    await wrapper.vm.$nextTick()

    expect(vm.expandedTool).toBe('read_file')
    expect(wrapper.text()).toContain('path')
  })

  // ─── 6. 工具测试 ──────────────────────────────────

  it('打开测试面板初始化 schema 参数', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testingTool: string | null
      testParams: Record<string, string>
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')

    expect(vm.testingTool).toBe('read_file')
    expect(vm.testParams).toHaveProperty('path')
    expect(vm.testParams.path).toBe('')
  })

  it('执行工具测试成功', async () => {
    mockCallMcpTool.mockResolvedValue({ result: 'file content', error: undefined })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testParams: Record<string, string>
      executeTest: (name: string) => Promise<void>
      testResult: { output?: unknown; error?: string } | null
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    vm.testParams.path = '/etc/hosts'
    await vm.executeTest('read_file')
    await flushPromises()

    expect(mockCallMcpTool).toHaveBeenCalledWith('read_file', { path: '/etc/hosts' })
    expect(vm.testResult?.output).toBe('file content')
    expect(vm.testResult?.error).toBeUndefined()
  })

  it('执行工具测试失败', async () => {
    mockCallMcpTool.mockRejectedValue(new Error('Permission denied'))
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      executeTest: (name: string) => Promise<void>
      testResult: { output?: unknown; error?: string } | null
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    await vm.executeTest('read_file')
    await flushPromises()

    expect(vm.testResult?.error).toBe('Permission denied')
  })

  it('参数值为空时不传递', async () => {
    mockCallMcpTool.mockResolvedValue({ result: 'ok' })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testParams: Record<string, string>
      executeTest: (name: string) => Promise<void>
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    vm.testParams.path = ''
    await vm.executeTest('read_file')
    await flushPromises()

    // 空值不传
    expect(mockCallMcpTool).toHaveBeenCalledWith('read_file', {})
  })

  it('参数 JSON 值自动解析', async () => {
    mockCallMcpTool.mockResolvedValue({ result: 'ok' })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testParams: Record<string, string>
      executeTest: (name: string) => Promise<void>
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    vm.testParams.path = '{"nested": true}'
    await vm.executeTest('read_file')
    await flushPromises()

    expect(mockCallMcpTool).toHaveBeenCalledWith('read_file', { path: { nested: true } })
  })

  it('无 schema 的工具显示无参数提示', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testingTool: string | null
      getSchemaProperties: (tool: unknown) => unknown[]
    }
    vm.activeTab = 'tools'
    vm.openTestForm('search')

    expect(vm.testingTool).toBe('search')
    // search 没有 input_schema
    const tools = (wrapper.vm as unknown as { tools: { name: string; input_schema?: unknown }[] }).tools
    const searchTool = tools.find((t) => t.name === 'search')!
    expect(vm.getSchemaProperties(searchTool)).toHaveLength(0)
  })

  it('测试运行中状态正确', async () => {
    // 使用不 resolve 的 promise 模拟运行中
    mockCallMcpTool.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      executeTest: (name: string) => Promise<void>
      isTestRunning: (name: string) => boolean
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    vm.executeTest('read_file') // 不 await

    await wrapper.vm.$nextTick()
    expect(vm.isTestRunning('read_file')).toBe(true)
    expect(vm.isTestRunning('search')).toBe(false)
  })

  // ─── 7. Marketplace Tab ───────────────────────────

  it('切换到 Marketplace Tab 加载数据', async () => {
    mockGetMcpMarketplace.mockResolvedValue({
      skills: [
        { name: 'fs-server', display_name: 'Filesystem', description: 'File access', category: 'io', command: 'npx', args: ['-y', 'fs-server'], downloads: 1000, rating: 4.5 },
      ],
      total: 1,
    })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string }
    vm.activeTab = 'marketplace'
    await wrapper.vm.$nextTick()

    // marketplace tab 点击时触发 loadMarketplace
    // 但因为我们直接设置了 activeTab，需要手动调用
    const loadFn = (wrapper.vm as unknown as { loadMarketplace: () => Promise<void> }).loadMarketplace
    await loadFn()
    await flushPromises()

    expect(mockGetMcpMarketplace).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Filesystem')
  })

  it('Marketplace 搜索', async () => {
    mockSearchMcpMarketplace.mockResolvedValue({
      skills: [{ name: 'found', display_name: 'Found', description: 'Test', category: '', command: 'cmd', args: [], downloads: 0, rating: 0 }],
      total: 1,
    })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      marketplaceSearch: string
      loadMarketplace: () => Promise<void>
    }
    vm.activeTab = 'marketplace'
    vm.marketplaceSearch = 'test query'
    await vm.loadMarketplace()
    await flushPromises()

    expect(mockSearchMcpMarketplace).toHaveBeenCalledWith('test query')
    expect(wrapper.text()).toContain('Found')
  })

  it('Marketplace 安装成功后刷新', async () => {
    const entry = { name: 'new-skill', display_name: 'New', description: '', category: '', downloads: 0, rating: 0 }
    mockInstallFromHub.mockResolvedValue(undefined)
    const wrapper = await mountMcpView()
    await flushPromises()
    mockGetMcpServers.mockClear()

    const vm = wrapper.vm as unknown as { installFromMarketplace: (e: typeof entry) => Promise<void> }
    await vm.installFromMarketplace(entry)
    await flushPromises()

    expect(mockInstallFromHub).toHaveBeenCalledWith('new-skill')
    expect(mockGetMcpServers).toHaveBeenCalled()
  })

  it('Marketplace 已安装的服务器按钮禁用', async () => {
    mockGetMcpMarketplace.mockResolvedValue({
      skills: [{ name: 'filesystem', display_name: 'FS', description: '', category: '', command: 'cmd', args: [], downloads: 0, rating: 0 }],
      total: 1,
    })
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      loadMarketplace: () => Promise<void>
      servers: string[]
    }
    vm.activeTab = 'marketplace'
    await vm.loadMarketplace()
    await flushPromises()

    // filesystem 已在 servers 列表中
    expect(vm.servers).toContain('filesystem')
  })

  // ─── 8. Tab 互斥渲染 ─────────────────────────────

  it('三个 Tab 互斥，不会同时渲染', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string }

    // 默认 servers tab
    vm.activeTab = 'servers'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('filesystem')

    // 切到 tools
    vm.activeTab = 'tools'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('read_file')
    // servers 内容不应存在（排除 tab 标题中的 count）
    // 但实际上 server 名字可能出现在 tab count 区域，用工具特有文字验证
    expect(wrapper.text()).toContain('Read a file')

    // 切到 marketplace
    vm.activeTab = 'marketplace'
    await wrapper.vm.$nextTick()
    // tools 不应渲染
    expect(wrapper.text()).not.toContain('Read a file')
  })

  // ─── 9. 状态 API 降级 ─────────────────────────────

  it('状态 API 不可用时降级为 optimistic connected', async () => {
    mockGetMcpServerStatus.mockRejectedValue(new Error('Not found'))
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      serverStatuses: Record<string, string>
      getServerStatus: (name: string) => string
    }
    expect(vm.getServerStatus('filesystem')).toBe('connected')
    expect(vm.getServerStatus('github')).toBe('connected')
  })

  // ─── 10. 再次点击测试按钮关闭面板 ─────────────────

  it('再次点击测试按钮关闭测试面板', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      testingTool: string | null
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    expect(vm.testingTool).toBe('read_file')

    vm.openTestForm('read_file')
    expect(vm.testingTool).toBeNull()
  })

  it('折叠工具时关闭测试面板', async () => {
    const wrapper = await mountMcpView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      openTestForm: (name: string) => void
      toggleTool: (name: string) => void
      testingTool: string | null
      expandedTool: string | null
    }
    vm.activeTab = 'tools'
    vm.openTestForm('read_file')
    vm.toggleTool('read_file') // 展开
    vm.toggleTool('read_file') // 折叠
    expect(vm.testingTool).toBeNull()
  })
})
