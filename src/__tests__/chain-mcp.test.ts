/**
 * Chain G: MCP -> Servers -> Tools
 *
 * Tests the MCP server and tool lifecycle: list servers, add/remove servers,
 * list tools, call tools, check server status.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────

const { mockApiGet, mockApiPost, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiDelete: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiDelete: mockApiDelete,
  api: {},
  apiSSE: vi.fn(),
  apiWebSocket: vi.fn(),
  fromNativeError: vi.fn(),
  createApiError: vi.fn(),
  isRetryable: vi.fn(),
  getErrorMessage: vi.fn(),
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain G: MCP -> Servers -> Tools', () => {
  it('G1: getMcpServers lists servers via GET /api/v1/mcp/servers', async () => {
    mockApiGet.mockResolvedValueOnce({
      servers: ['weather-server', 'filesystem-server', 'github-server'],
      total: 3,
    })

    const { getMcpServers } = await import('@/api/mcp')
    const result = await getMcpServers()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/mcp/servers')
    expect(result.servers).toHaveLength(3)
    expect(result.servers).toContain('weather-server')
    expect(result.total).toBe(3)
  })

  it('G2: addMcpServer sends correct config via POST /api/v1/mcp/servers', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'Server added successfully' })

    const { addMcpServer } = await import('@/api/mcp')
    const result = await addMcpServer('custom-server', '/usr/local/bin/mcp-server', ['--port', '9090', '--mode', 'stdio'])

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      name: 'custom-server',
      command: '/usr/local/bin/mcp-server',
      args: ['--port', '9090', '--mode', 'stdio'],
    })
    expect(result.message).toBe('Server added successfully')
  })

  it('G2b: addMcpServer works without args', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'added' })

    const { addMcpServer } = await import('@/api/mcp')
    await addMcpServer('simple-server', 'npx mcp-server')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      name: 'simple-server',
      command: 'npx mcp-server',
      args: undefined,
    })
  })

  it('G3: removeMcpServer calls DELETE /api/v1/mcp/servers/:name', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'Server removed' })

    const { removeMcpServer } = await import('@/api/mcp')
    const result = await removeMcpServer('old-server')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/mcp/servers/old-server')
    expect(result.message).toBe('Server removed')
  })

  it('G3b: removeMcpServer URL-encodes server name with special characters', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'removed' })

    const { removeMcpServer } = await import('@/api/mcp')
    await removeMcpServer('server with spaces')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/mcp/servers/server%20with%20spaces')
  })

  it('G4: getMcpTools returns tool list via GET /api/v1/mcp/tools', async () => {
    mockApiGet.mockResolvedValueOnce({
      tools: [
        { name: 'get_weather', description: 'Get current weather for a location' },
        { name: 'read_file', description: 'Read contents of a file' },
        { name: 'search_github', description: 'Search GitHub repositories' },
      ],
      total: 3,
    })

    const { getMcpTools } = await import('@/api/mcp')
    const result = await getMcpTools()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/mcp/tools')
    expect(result.tools).toHaveLength(3)
    expect(result.tools[0]!.name).toBe('get_weather')
    expect(result.tools[1]!.name).toBe('read_file')
    expect(result.total).toBe(3)
  })

  it('G5: callMcpTool sends tool call with arguments via POST /api/v1/mcp/tools/call', async () => {
    mockApiPost.mockResolvedValueOnce({
      result: { temperature: 22, unit: 'celsius', location: 'Tokyo' },
    })

    const { callMcpTool } = await import('@/api/mcp')
    const result = await callMcpTool('get_weather', { location: 'Tokyo', units: 'metric' })

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/mcp/tools/call', {
      name: 'get_weather',
      arguments: { location: 'Tokyo', units: 'metric' },
    })
    expect(result.result).toEqual({ temperature: 22, unit: 'celsius', location: 'Tokyo' })
  })

  it('G5b: callMcpTool throws on error response', async () => {
    mockApiPost.mockResolvedValueOnce({
      result: null,
      error: 'Tool execution failed: connection refused',
    })

    const { callMcpTool } = await import('@/api/mcp')
    await expect(callMcpTool('broken_tool', { arg: 'value' })).rejects.toThrow(
      'Tool execution failed: connection refused',
    )
  })

  it('G6: getMcpServerStatus returns status map via GET /api/v1/mcp/status', async () => {
    mockApiGet.mockResolvedValueOnce({
      statuses: {
        'weather-server': 'connected',
        'filesystem-server': 'connected',
        'broken-server': 'error',
      },
    })

    const { getMcpServerStatus } = await import('@/api/mcp')
    const result = await getMcpServerStatus()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/mcp/status')
    expect(result.statuses!['weather-server']).toBe('connected')
    expect(result.statuses!['broken-server']).toBe('error')
  })

  it('G7: searchMcpMarketplace searches via GET with type=mcp', async () => {
    mockApiGet.mockResolvedValueOnce({
      skills: [
        { name: 'weather-mcp', display_name: 'Weather MCP', description: 'Weather data', category: 'data', downloads: 5000, rating: 4.5 },
      ],
      total: 1,
    })

    const { searchMcpMarketplace } = await import('@/api/mcp')
    const result = await searchMcpMarketplace('weather')

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/clawhub/search', { q: 'weather', type: 'mcp' })
    expect(result.skills).toHaveLength(1)
  })

  it('G8: full lifecycle: add server -> list servers -> list tools -> call tool -> remove server', async () => {
    const { addMcpServer, getMcpServers, getMcpTools, callMcpTool, removeMcpServer } = await import('@/api/mcp')

    // Add
    mockApiPost.mockResolvedValueOnce({ message: 'added' })
    await addMcpServer('test-mcp', '/bin/test-mcp')

    // List servers
    mockApiGet.mockResolvedValueOnce({ servers: ['test-mcp'], total: 1 })
    const servers = await getMcpServers()
    expect(servers.servers).toContain('test-mcp')

    // List tools
    mockApiGet.mockResolvedValueOnce({
      tools: [{ name: 'test_tool', description: 'A test tool' }],
      total: 1,
    })
    const tools = await getMcpTools()
    expect(tools.tools[0]!.name).toBe('test_tool')

    // Call tool
    mockApiPost.mockResolvedValueOnce({ result: 'success' })
    const callResult = await callMcpTool('test_tool', { input: 'hello' })
    expect(callResult.result).toBe('success')

    // Remove
    mockApiDelete.mockResolvedValueOnce({ message: 'removed' })
    await removeMcpServer('test-mcp')
    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/mcp/servers/test-mcp')
  })

  it('G9: API failure does not crash - errors propagate', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('MCP service unavailable'))

    const { getMcpServers } = await import('@/api/mcp')
    await expect(getMcpServers()).rejects.toThrow('MCP service unavailable')
  })
})
