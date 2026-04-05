/**
 * MCP Edge Cases — 补全 MCP API 覆盖
 *
 * 覆盖 callMcpTool 输入验证、getMcpServerStatus 双格式兼容、
 *        addMcpServer / removeMcpServer / marketplace
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import {
  callMcpTool,
  getMcpServerStatus,
  addMcpServer,
  removeMcpServer,
  searchMcpMarketplace,
  getMcpMarketplace,
} from '../mcp'

describe('MCP Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── callMcpTool input validation ────────────────

  describe('callMcpTool input validation', () => {
    it('throws on empty toolName', async () => {
      await expect(callMcpTool('', {})).rejects.toThrow('toolName must be a non-empty string')
    })

    it('throws on whitespace-only toolName', async () => {
      await expect(callMcpTool('   ', {})).rejects.toThrow('toolName must be a non-empty string')
    })

    it('trims toolName before sending', async () => {
      mockFetch.mockResolvedValue({ result: 'ok' })
      await callMcpTool('  read_file  ', { path: '/tmp' })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/mcp/tools/call',
        expect.objectContaining({
          body: expect.objectContaining({ name: 'read_file' }),
        }),
      )
    })

    it('throws on malformed response (null)', async () => {
      mockFetch.mockResolvedValue(null)
      await expect(callMcpTool('test', {})).rejects.toThrow('malformed response')
    })

    it('throws when response contains non-empty error string', async () => {
      mockFetch.mockResolvedValue({ result: null, error: 'Permission denied' })
      await expect(callMcpTool('test', {})).rejects.toThrow('Permission denied')
    })

    it('returns null result when result is undefined and no error', async () => {
      mockFetch.mockResolvedValue({ result: undefined })
      const result = await callMcpTool('test', {})
      expect(result.result).toBeNull()
    })

    it('passes through valid result', async () => {
      mockFetch.mockResolvedValue({ result: { data: [1, 2, 3] } })
      const result = await callMcpTool('test', {})
      expect(result.result).toEqual({ data: [1, 2, 3] })
    })

    it('ignores empty error string', async () => {
      mockFetch.mockResolvedValue({ result: 'ok', error: '' })
      const result = await callMcpTool('test', {})
      expect(result.result).toBe('ok')
    })

    it('ignores whitespace-only error string', async () => {
      mockFetch.mockResolvedValue({ result: 'ok', error: '  ' })
      const result = await callMcpTool('test', {})
      expect(result.result).toBe('ok')
    })
  })

  // ─── getMcpServerStatus ──────────────────────────

  describe('getMcpServerStatus', () => {
    it('returns status map format', async () => {
      mockFetch.mockResolvedValue({ statuses: { fs: 'connected', gh: 'disconnected' } })
      const result = await getMcpServerStatus()
      expect(result.statuses).toBeDefined()
      expect(result.statuses!['fs']).toBe('connected')
    })

    it('returns servers array format', async () => {
      mockFetch.mockResolvedValue({
        servers: [
          { name: 'fs', connected: true, tool_count: 5 },
          { name: 'gh', connected: false, tool_count: 3 },
        ],
      })
      const result = await getMcpServerStatus()
      expect(result.servers).toHaveLength(2)
    })
  })

  // ─── addMcpServer ────────────────────────────────

  describe('addMcpServer', () => {
    it('sends name, command, and args', async () => {
      mockFetch.mockResolvedValue({ message: 'added' })
      await addMcpServer('test-server', 'npx', ['-y', '@test/server'])
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/mcp/servers',
        expect.objectContaining({
          method: 'POST',
          body: { name: 'test-server', command: 'npx', args: ['-y', '@test/server'] },
        }),
      )
    })

    it('sends undefined args when not provided', async () => {
      mockFetch.mockResolvedValue({ message: 'added' })
      await addMcpServer('simple', '/usr/bin/mcp')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/mcp/servers',
        expect.objectContaining({
          body: { name: 'simple', command: '/usr/bin/mcp', args: undefined },
        }),
      )
    })
  })

  // ─── removeMcpServer ─────────────────────────────

  describe('removeMcpServer', () => {
    it('calls DELETE with URL-encoded name', async () => {
      mockFetch.mockResolvedValue({ message: 'removed' })
      await removeMcpServer('test/server')
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/mcp/servers/${encodeURIComponent('test/server')}`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  // ─── Marketplace ─────────────────────────────────

  describe('searchMcpMarketplace', () => {
    it('sends query with type=mcp', async () => {
      mockFetch.mockResolvedValue({ skills: [], total: 0 })
      await searchMcpMarketplace('filesystem')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/clawhub/search',
        expect.objectContaining({
          method: 'GET',
          query: { q: 'filesystem', type: 'mcp' },
        }),
      )
    })
  })

  describe('getMcpMarketplace', () => {
    it('sends type=mcp without query', async () => {
      mockFetch.mockResolvedValue({ skills: [], total: 0 })
      await getMcpMarketplace()
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/clawhub/search',
        expect.objectContaining({
          method: 'GET',
          query: { type: 'mcp' },
        }),
      )
    })
  })
})
