/**
 * 回归测试 — MCP transport（2026-06-22 hex-test 审计 C6）：
 * addMcpServer 此前只发 {name,command,args}，无法创建 SSE/streamable MCP server
 * （后端 handler_misc.go 支持 transport+endpoint）。修复后支持 opts 透传，
 * 且不传 opts 时 body 与旧版完全一致（向后兼容）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: { create: () => mockFetch } }))

describe('MCP addMcpServer transport 契约', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
  })

  it('SSE：透传 transport + endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'ok' })
    const { addMcpServer } = await import('../mcp')
    await addMcpServer('remote', '', undefined, { transport: 'sse', endpoint: 'https://e/mcp' })
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      method: 'POST',
      body: { name: 'remote', command: '', args: undefined, transport: 'sse', endpoint: 'https://e/mcp' },
    })
  })

  it('向后兼容：不传 opts 时 body 不含 transport/endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'ok' })
    const { addMcpServer } = await import('../mcp')
    await addMcpServer('fs', 'npx', ['-y', '@mcp/fs'])
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/mcp/servers', {
      method: 'POST',
      body: { name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] },
    })
  })
})
