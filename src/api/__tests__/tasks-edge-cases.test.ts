/**
 * Tasks (Cron) API Edge Cases — 补全覆盖
 *
 * getCronJobHistory 的字段兼容（run_at → started_at）
 * createCronJob type 默认值
 * 错误传播
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import { getCronJobs, createCronJob, deleteCronJob, pauseCronJob, resumeCronJob, triggerCronJob, getCronJobHistory } from '../tasks'

describe('Tasks (Cron) Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── getCronJobs ─────────────────────────────────

  describe('getCronJobs', () => {
    it('calls GET /api/v1/cron/jobs with user_id', async () => {
      mockFetch.mockResolvedValue({ jobs: [], total: 0 })
      await getCronJobs()
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cron/jobs',
        expect.objectContaining({ method: 'GET', query: expect.objectContaining({ user_id: expect.any(String) }) }),
      )
    })
  })

  // ─── createCronJob ───────────────────────────────

  describe('createCronJob', () => {
    it('defaults type to "cron" when not provided', async () => {
      mockFetch.mockResolvedValue({ id: 'j1', name: 'test', next_run_at: '2024-01-01' })
      await createCronJob({ name: 'test', schedule: '0 * * * *', prompt: 'do something' })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cron/jobs',
        expect.objectContaining({
          body: expect.objectContaining({ type: 'cron' }),
        }),
      )
    })

    it('uses provided type', async () => {
      mockFetch.mockResolvedValue({ id: 'j1', name: 'test', next_run_at: '2024-01-01' })
      await createCronJob({ name: 'test', schedule: '0 * * * *', prompt: 'do', type: 'once' })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cron/jobs',
        expect.objectContaining({
          body: expect.objectContaining({ type: 'once' }),
        }),
      )
    })
  })

  // ─── deleteCronJob ───────────────────────────────

  describe('deleteCronJob', () => {
    it('calls DELETE /api/v1/cron/jobs/:id', async () => {
      mockFetch.mockResolvedValue({ message: 'deleted' })
      await deleteCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/cron/jobs/j1', expect.objectContaining({ method: 'DELETE' }))
    })
  })

  // ─── pauseCronJob / resumeCronJob ────────────────

  describe('pauseCronJob', () => {
    it('calls POST /api/v1/cron/jobs/:id/pause', async () => {
      mockFetch.mockResolvedValue({ message: 'paused' })
      await pauseCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/cron/jobs/j1/pause', expect.objectContaining({ method: 'POST' }))
    })
  })

  describe('resumeCronJob', () => {
    it('calls POST /api/v1/cron/jobs/:id/resume', async () => {
      mockFetch.mockResolvedValue({ message: 'resumed' })
      await resumeCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/cron/jobs/j1/resume', expect.objectContaining({ method: 'POST' }))
    })
  })

  // ─── triggerCronJob ──────────────────────────────

  describe('triggerCronJob', () => {
    it('calls POST /api/v1/cron/jobs/:id/trigger', async () => {
      mockFetch.mockResolvedValue({ message: 'triggered', run_id: 'run-1' })
      const result = await triggerCronJob('j1')
      expect(result.run_id).toBe('run-1')
    })
  })

  // ─── getCronJobHistory ───────────────────────────

  describe('getCronJobHistory', () => {
    it('prefers history array', async () => {
      mockFetch.mockResolvedValue({
        history: [{ id: 'r1', job_id: 'j1', status: 'success', started_at: '2024-01-01' }],
      })
      const result = await getCronJobHistory('j1')
      expect(result).toHaveLength(1)
      expect(result[0]!.started_at).toBe('2024-01-01')
    })

    it('falls back to runs array', async () => {
      mockFetch.mockResolvedValue({
        runs: [{ id: 'r1', job_id: 'j1', status: 'failed', started_at: '2024-01-02' }],
      })
      const result = await getCronJobHistory('j1')
      expect(result[0]!.status).toBe('failed')
    })

    it('normalizes run_at → started_at', async () => {
      mockFetch.mockResolvedValue({
        history: [{ id: 'r1', job_id: 'j1', status: 'success', run_at: '2024-01-03', started_at: '' }],
      })
      const result = await getCronJobHistory('j1')
      expect(result[0]!.started_at).toBe('2024-01-03')
    })

    it('handles both missing → empty started_at', async () => {
      mockFetch.mockResolvedValue({
        history: [{ id: 'r1', job_id: 'j1', status: 'running' }],
      })
      const result = await getCronJobHistory('j1')
      expect(result[0]!.started_at).toBe('')
    })

    it('passes limit parameter', async () => {
      mockFetch.mockResolvedValue({ history: [] })
      await getCronJobHistory('j1', 20)
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cron/jobs/j1/history',
        expect.objectContaining({ query: { limit: 20 } }),
      )
    })

    it('defaults limit to 5', async () => {
      mockFetch.mockResolvedValue({ history: [] })
      await getCronJobHistory('j1')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cron/jobs/j1/history',
        expect.objectContaining({ query: { limit: 5 } }),
      )
    })

    it('handles empty response', async () => {
      mockFetch.mockResolvedValue({})
      const result = await getCronJobHistory('j1')
      expect(result).toEqual([])
    })
  })
})
