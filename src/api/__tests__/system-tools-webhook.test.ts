/**
 * System / Tools-Status / Webhook — 全场景覆盖
 *
 * 这些 API 模块之前完全没有测试，此文件补全覆盖
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

// ─── System ────────────────────────────────────────

import { getStats, getVersion } from '../system'

describe('System API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  describe('getStats', () => {
    it('calls GET /api/v1/stats', async () => {
      const stats = { sessions: 5, messages: 100, models: 3, agents: 2 }
      mockFetch.mockResolvedValue(stats)
      const result = await getStats()
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/stats', expect.objectContaining({ method: 'GET' }))
      expect(result).toEqual(stats)
    })

    it('propagates errors', async () => {
      mockFetch.mockRejectedValue(new Error('Service unavailable'))
      await expect(getStats()).rejects.toThrow('Service unavailable')
    })
  })

  describe('getVersion', () => {
    it('calls GET /api/v1/version', async () => {
      mockFetch.mockResolvedValue({ version: '0.2.6', engine: 'hexclaw' })
      const result = await getVersion()
      expect(result.version).toBe('0.2.6')
      expect(result.engine).toBe('hexclaw')
    })
  })
})

// ─── Tools Status ──────────────────────────────────

import { getBudgetStatus, getToolCacheStats, getToolMetrics, getToolPermissions } from '../tools-status'

describe('Tools Status API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  describe('getBudgetStatus', () => {
    it('calls GET /api/v1/budget/status', async () => {
      const budget = {
        tokens_used: 1000,
        tokens_max: 100000,
        tokens_remaining: 99000,
        cost_used: 0.01,
        cost_max: 10,
        cost_remaining: 9.99,
        duration_used: '1h',
        duration_max: '24h',
        duration_remaining: '23h',
        exhausted: false,
      }
      mockFetch.mockResolvedValue(budget)
      const result = await getBudgetStatus()
      expect(result.tokens_used).toBe(1000)
      expect(result.exhausted).toBe(false)
    })

    it('handles exhausted budget', async () => {
      mockFetch.mockResolvedValue({ tokens_used: 100000, tokens_max: 100000, tokens_remaining: 0, exhausted: true, cost_used: 10, cost_max: 10, cost_remaining: 0, duration_used: '24h', duration_max: '24h', duration_remaining: '0' })
      const result = await getBudgetStatus()
      expect(result.exhausted).toBe(true)
      expect(result.tokens_remaining).toBe(0)
    })
  })

  describe('getToolCacheStats', () => {
    it('calls GET /api/v1/tools/cache/stats', async () => {
      mockFetch.mockResolvedValue({ entries: 50, hits: 30, misses: 20, hit_rate: 0.6 })
      const result = await getToolCacheStats()
      expect(result.hit_rate).toBe(0.6)
    })

    it('handles empty cache', async () => {
      mockFetch.mockResolvedValue({ entries: 0, hits: 0, misses: 0, hit_rate: 0 })
      const result = await getToolCacheStats()
      expect(result.entries).toBe(0)
    })
  })

  describe('getToolMetrics', () => {
    it('calls GET /api/v1/tools/metrics', async () => {
      mockFetch.mockResolvedValue({
        tools: [{ tool: 'search', call_count: 10, success_rate: 0.9, avg_latency_ms: 200, cached_count: 3 }],
      })
      const result = await getToolMetrics()
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]!.success_rate).toBe(0.9)
    })
  })

  describe('getToolPermissions', () => {
    it('calls GET /api/v1/tools/permissions', async () => {
      mockFetch.mockResolvedValue({ rules: [{ pattern: 'shell_*', action: 'deny' }] })
      const result = await getToolPermissions()
      expect(result.rules).toHaveLength(1)
    })

    it('handles null rules', async () => {
      mockFetch.mockResolvedValue({ rules: null })
      const result = await getToolPermissions()
      expect(result.rules).toBeNull()
    })
  })
})

// ─── Webhook ───────────────────────────────────────

import { getWebhooks, createWebhook, deleteWebhook } from '../webhook'

describe('Webhook API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  describe('getWebhooks', () => {
    it('calls GET /api/v1/webhooks with user_id', async () => {
      mockFetch.mockResolvedValue({ webhooks: [], total: 0 })
      const result = await getWebhooks()
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/webhooks',
        expect.objectContaining({ method: 'GET', query: expect.objectContaining({ user_id: expect.any(String) }) }),
      )
      expect(result.webhooks).toEqual([])
    })

    it('returns webhook list', async () => {
      const hooks = [{ id: 'w1', name: 'test', type: 'custom', url: 'https://example.com', events: ['error'], secret: '', prompt: '', user_id: 'u1' }]
      mockFetch.mockResolvedValue({ webhooks: hooks, total: 1 })
      const result = await getWebhooks()
      expect(result.total).toBe(1)
    })
  })

  describe('createWebhook', () => {
    it('calls POST /api/v1/webhooks with data', async () => {
      mockFetch.mockResolvedValue({ id: 'w1', name: 'test', url: 'https://example.com' })
      await createWebhook({ name: 'test', type: 'custom', url: 'https://example.com', events: ['error'] })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/webhooks',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            name: 'test',
            type: 'custom',
            url: 'https://example.com',
            events: ['error'],
            prompt: '',
            secret: '',
          }),
        }),
      )
    })
  })

  describe('deleteWebhook', () => {
    it('calls DELETE /api/v1/webhooks/:name with URL encoding', async () => {
      mockFetch.mockResolvedValue({ message: 'deleted' })
      await deleteWebhook('test webhook')
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/webhooks/${encodeURIComponent('test webhook')}`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })
})
