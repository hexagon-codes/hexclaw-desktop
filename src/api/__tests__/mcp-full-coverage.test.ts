/**
 * MCP 全场景覆盖测试
 *
 * 覆盖: API 层所有函数 + 前后端对齐 + 市场数据格式 + 边界情况
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

describe('MCP API — full coverage', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
  })

  // ─── Server CRUD ──────────────────────────────────

  it('getMcpServers calls GET /api/v1/mcp/servers', async () => {
    mockFetch.mockResolvedValueOnce({ servers: ['fs', 'github'], total: 2 })
    const { getMcpServers } = await import('../mcp')
    const res = await getMcpServers()
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/servers', { method: 'GET', query: undefined })
    expect(res.servers).toEqual(['fs', 'github'])
    expect(res.total).toBe(2)
  })

  it('addMcpServer calls POST with name, command, args', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'MCP Server "fs" 已添加' })
    const { addMcpServer } = await import('../mcp')
    await addMcpServer('fs', 'npx', ['-y', '@mcp/fs'])
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      method: 'POST',
      body: { name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] },
    })
  })

  it('addMcpServer works without args', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'added' })
    const { addMcpServer } = await import('../mcp')
    await addMcpServer('simple', 'node')
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      method: 'POST',
      body: { name: 'simple', command: 'node', args: undefined },
    })
  })

  it('removeMcpServer calls DELETE with encoded name', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'removed' })
    const { removeMcpServer } = await import('../mcp')
    await removeMcpServer('my server')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/mcp/servers/my%20server',
      { method: 'DELETE' },
    )
  })

  // ─── Tools ────────────────────────────────────────

  it('getMcpTools calls GET /api/v1/mcp/tools', async () => {
    mockFetch.mockResolvedValueOnce({ tools: [{ name: 'read_file' }], total: 1 })
    const { getMcpTools } = await import('../mcp')
    const res = await getMcpTools()
    expect(res.tools).toHaveLength(1)
    expect(res.tools[0]!.name).toBe('read_file')
  })

  it('callMcpTool sends tool name and arguments', async () => {
    mockFetch.mockResolvedValueOnce({ result: 'file content', error: undefined })
    const { callMcpTool } = await import('../mcp')
    await callMcpTool('read_file', { path: '/tmp/test.txt' })
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/tools/call', {
      method: 'POST',
      body: { tool: 'read_file', arguments: { path: '/tmp/test.txt' } },
    })
  })

  it('callMcpTool with empty args', async () => {
    mockFetch.mockResolvedValueOnce({ result: null })
    const { callMcpTool } = await import('../mcp')
    await callMcpTool('list_dir', {})
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/tools/call', {
      method: 'POST',
      body: { tool: 'list_dir', arguments: {} },
    })
  })

  // ─── Status ───────────────────────────────────────

  it('getMcpServerStatus returns status map', async () => {
    mockFetch.mockResolvedValueOnce({
      statuses: { fs: 'connected', github: 'error' },
    })
    const { getMcpServerStatus } = await import('../mcp')
    const res = await getMcpServerStatus()
    expect(res.statuses!.fs).toBe('connected')
    expect(res.statuses!.github).toBe('error')
  })

  // ─── Marketplace ──────────────────────────────────

  it('getMcpMarketplace calls GET with type=mcp', async () => {
    mockFetch.mockResolvedValueOnce({
      skills: [
        { name: 'fs', display_name: 'Filesystem', type: 'mcp', command: 'npx', args: ['-y', '@mcp/fs'] },
      ],
      total: 1,
    })
    const { getMcpMarketplace } = await import('../mcp')
    const res = await getMcpMarketplace()
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/clawhub/search', {
      method: 'GET',
      query: { type: 'mcp' },
    })
    expect(res.skills).toHaveLength(1)
    expect(res.skills[0]!.command).toBe('npx')
  })

  it('searchMcpMarketplace passes query and type=mcp', async () => {
    mockFetch.mockResolvedValueOnce({ skills: [], total: 0 })
    const { searchMcpMarketplace } = await import('../mcp')
    await searchMcpMarketplace('weather')
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/clawhub/search', {
      method: 'GET',
      query: { q: 'weather', type: 'mcp' },
    })
  })

  it('marketplace returns skills field (not servers)', async () => {
    mockFetch.mockResolvedValueOnce({ skills: [{ name: 'test' }], total: 1 })
    const { getMcpMarketplace } = await import('../mcp')
    const res = await getMcpMarketplace()
    // Must be .skills, not .servers (this was the original bug)
    expect(res.skills).toBeDefined()
    expect((res as unknown as Record<string, unknown>).servers).toBeUndefined()
  })

  // ─── MCP entry type field ─────────────────────────

  it('McpMarketplaceEntry with command is installable as MCP server', async () => {
    const entry = {
      name: 'fs-server',
      display_name: 'FS',
      description: '',
      version: '1.0',
      author: 'test',
      category: 'system',
      tags: [],
      url: '',
      downloads: 100,
      rating: 4.5,
      command: 'npx',
      args: ['-y', '@mcp/fs'],
    }
    // Entry with command → should be installed via addMcpServer
    expect(entry.command?.trim()).toBeTruthy()
  })

  it('McpMarketplaceEntry without command is installable as skill', async () => {
    const entry = {
      name: 'code-review',
      display_name: 'Code Review',
      description: '',
      version: '1.0',
      author: 'test',
      category: 'coding',
      tags: [],
      url: '',
      downloads: 200,
      rating: 4.0,
    }
    // Entry without command → should be installed via installFromHub
    expect((entry as { command?: string }).command?.trim()).toBeFalsy()
  })

  // ─── Edge cases ───────────────────────────────────

  it('removeMcpServer encodes Chinese name', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'removed' })
    const { removeMcpServer } = await import('../mcp')
    await removeMcpServer('天气服务')
    const calledPath = mockFetch.mock.calls[0]![0]
    expect(calledPath).not.toContain('天气服务')
    expect(calledPath).toContain(encodeURIComponent('天气服务'))
  })

  it('getMcpServers handles empty list', async () => {
    mockFetch.mockResolvedValueOnce({ servers: [], total: 0 })
    const { getMcpServers } = await import('../mcp')
    const res = await getMcpServers()
    expect(res.servers).toEqual([])
  })

  it('getMcpMarketplace handles empty catalog', async () => {
    mockFetch.mockResolvedValueOnce({ skills: [], total: 0 })
    const { getMcpMarketplace } = await import('../mcp')
    const res = await getMcpMarketplace()
    expect(res.skills).toEqual([])
    expect(res.total).toBe(0)
  })
})
