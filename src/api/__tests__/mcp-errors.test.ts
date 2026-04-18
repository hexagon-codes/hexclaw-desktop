/**
 * MCP API Error Paths — 补全错误路径与边缘场景
 *
 * 覆盖：
 *  - 网络错误 / 4xx / 5xx
 *  - callMcpTool 的 error 字段（含空串/空白）
 *  - callMcpTool 对 malformed response 的防御
 *  - addMcpServer / removeMcpServer 生命周期（连接 → 断开）
 *  - getMcpServerStatus 双格式兼容的错误路径
 *  - marketplace 搜索错误
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import {
  getMcpTools,
  getMcpServers,
  callMcpTool,
  getMcpServerStatus,
  addMcpServer,
  removeMcpServer,
  searchMcpMarketplace,
  getMcpMarketplace,
} from '../mcp'

describe('MCP API Error Paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── getMcpTools / getMcpServers ────────────────

  describe('getMcpTools / getMcpServers', () => {
    it('getMcpTools propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('no mcp bridge'))
      await expect(getMcpTools()).rejects.toThrow('no mcp bridge')
    })

    it('getMcpServers propagates 500', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('server crashed'), { status: 500 }))
      await expect(getMcpServers()).rejects.toThrow('server crashed')
    })
  })

  // ─── callMcpTool error field / malformed ────────

  describe('callMcpTool — error handling', () => {
    it('throws when backend returns non-empty error field', async () => {
      mockFetch.mockResolvedValue({ result: null, error: 'tool execution failed' })
      await expect(callMcpTool('greet', {})).rejects.toThrow('tool execution failed')
    })

    it('trims whitespace from backend error before throwing', async () => {
      mockFetch.mockResolvedValue({ result: null, error: '  boom  ' })
      await expect(callMcpTool('greet', {})).rejects.toThrow('boom')
    })

    it('ignores empty-string error field', async () => {
      mockFetch.mockResolvedValue({ result: 'ok', error: '' })
      const r = await callMcpTool('greet', {})
      expect(r.result).toBe('ok')
    })

    it('fills result: null when backend omits both result and error', async () => {
      mockFetch.mockResolvedValue({})
      const r = await callMcpTool('greet', {})
      expect(r.result).toBeNull()
    })

    it('throws on malformed (non-object) response', async () => {
      mockFetch.mockResolvedValue('not-an-object' as unknown as object)
      await expect(callMcpTool('greet', {})).rejects.toThrow('malformed response')
    })

    it('throws on null response', async () => {
      mockFetch.mockResolvedValue(null as unknown as object)
      await expect(callMcpTool('greet', {})).rejects.toThrow('malformed response')
    })

    it('propagates network errors', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNRESET'))
      await expect(callMcpTool('greet', {})).rejects.toThrow('ECONNRESET')
    })
  })

  // ─── addMcpServer / removeMcpServer lifecycle ──

  describe('addMcpServer / removeMcpServer', () => {
    it('addMcpServer sends name / command / args', async () => {
      mockFetch.mockResolvedValue({ message: 'added' })
      await addMcpServer('fs', 'node', ['server.js'])
      const body = mockFetch.mock.calls[0]![1].body
      expect(body).toMatchObject({ name: 'fs', command: 'node', args: ['server.js'] })
    })

    it('addMcpServer propagates 409 when server name duplicates', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('server already exists'), { status: 409 }))
      await expect(addMcpServer('dup', 'npx', [])).rejects.toThrow('server already exists')
    })

    it('addMcpServer propagates 400 when command invalid', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('command not found'), { status: 400 }))
      await expect(addMcpServer('bad', '', [])).rejects.toThrow('command not found')
    })

    it('connect → disconnect lifecycle', async () => {
      mockFetch
        .mockResolvedValueOnce({ message: 'added' })
        .mockResolvedValueOnce({ message: 'removed' })
      await addMcpServer('fs', 'node', ['s.js'])
      await removeMcpServer('fs')
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/v1/mcp/servers',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        '/api/v1/mcp/servers/fs',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('removeMcpServer encodes special chars', async () => {
      mockFetch.mockResolvedValue({ message: 'removed' })
      await removeMcpServer('fs/server with spaces')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('fs%2Fserver%20with%20spaces')
    })

    it('removeMcpServer propagates 404', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
      await expect(removeMcpServer('ghost')).rejects.toThrow('not found')
    })
  })

  // ─── getMcpServerStatus ─────────────────────────

  describe('getMcpServerStatus', () => {
    it('propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'))
      await expect(getMcpServerStatus()).rejects.toThrow('offline')
    })

    it('returns statuses map when backend provides it', async () => {
      mockFetch.mockResolvedValue({ statuses: { fs: 'connected', gh: 'disconnected' } })
      const r = await getMcpServerStatus()
      expect(r.statuses).toMatchObject({ fs: 'connected', gh: 'disconnected' })
    })

    it('returns servers array when backend uses alternate format', async () => {
      mockFetch.mockResolvedValue({ servers: [{ name: 'fs', connected: true, tool_count: 3 }], total: 1 })
      const r = await getMcpServerStatus()
      expect(r.servers).toHaveLength(1)
      expect(r.total).toBe(1)
    })
  })

  // ─── Marketplace ────────────────────────────────

  describe('searchMcpMarketplace / getMcpMarketplace', () => {
    it('searchMcpMarketplace forwards query + type=mcp', async () => {
      mockFetch.mockResolvedValue({ skills: [], total: 0 })
      await searchMcpMarketplace('fs')
      const call = mockFetch.mock.calls[0]!
      expect(call[1].query).toMatchObject({ q: 'fs', type: 'mcp' })
    })

    it('searchMcpMarketplace propagates 5xx', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('hub offline'), { status: 503 }))
      await expect(searchMcpMarketplace('x')).rejects.toThrow('hub offline')
    })

    it('getMcpMarketplace forwards type=mcp with no query', async () => {
      mockFetch.mockResolvedValue({ skills: [], total: 0 })
      await getMcpMarketplace()
      const call = mockFetch.mock.calls[0]!
      expect(call[1].query).toMatchObject({ type: 'mcp' })
    })

    it('getMcpMarketplace propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('timeout'))
      await expect(getMcpMarketplace()).rejects.toThrow('timeout')
    })
  })
})
