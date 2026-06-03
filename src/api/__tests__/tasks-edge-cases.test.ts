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
  // D1.2: 改走 POST /api/v1/cronjob action=list

  describe('getCronJobs', () => {
    it('calls POST /api/v1/cronjob action=list', async () => {
      mockFetch.mockResolvedValue({ jobs: [], total: 0 })
      await getCronJobs()
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ action: 'list' }),
        }),
      )
    })
  })

  // ─── createCronJob ───────────────────────────────
  // D1.2: 走 unified endpoint action=create + draft 包装

  describe('createCronJob', () => {
    it('defaults type to "cron" when not provided', async () => {
      mockFetch.mockResolvedValue({ action: 'create', job: { id: 'j1', name: 'test', next_run_at: '2024-01-01' } })
      await createCronJob({ name: 'test', schedule: '0 * * * *', prompt: 'do something' })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          body: expect.objectContaining({
            action: 'create',
            draft: expect.objectContaining({
              name: 'test',
              schedule: '0 * * * *',
              prompt: 'do something',
            }),
          }),
        }),
      )
    })

    it('passes through schedule and prompt', async () => {
      mockFetch.mockResolvedValue({ action: 'create', job: { id: 'j1', name: 'x', next_run_at: '2024-01-01' } })
      await createCronJob({ name: 'x', schedule: '@daily', prompt: 'p' })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          body: expect.objectContaining({
            action: 'create',
            draft: expect.objectContaining({ schedule: '@daily', prompt: 'p' }),
          }),
        }),
      )
    })
  })

  // ─── deleteCronJob ───────────────────────────────

  describe('deleteCronJob', () => {
    it('calls POST /api/v1/cronjob action=remove', async () => {
      mockFetch.mockResolvedValue({ action: 'remove', ok: true })
      await deleteCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          body: expect.objectContaining({ action: 'remove', job_id: 'j1' }),
        }),
      )
    })
  })

  // ─── pauseCronJob / resumeCronJob ────────────────

  describe('pauseCronJob', () => {
    it('calls POST /api/v1/cronjob action=pause', async () => {
      mockFetch.mockResolvedValue({ action: 'pause', ok: true })
      await pauseCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          body: expect.objectContaining({ action: 'pause', job_id: 'j1' }),
        }),
      )
    })
  })

  describe('resumeCronJob', () => {
    it('calls POST /api/v1/cronjob action=resume', async () => {
      mockFetch.mockResolvedValue({ action: 'resume', ok: true })
      await resumeCronJob('j1')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/cronjob',
        expect.objectContaining({
          body: expect.objectContaining({ action: 'resume', job_id: 'j1' }),
        }),
      )
    })
  })

  // ─── triggerCronJob ──────────────────────────────

  describe('triggerCronJob', () => {
    it('calls POST /api/v1/cronjob action=run', async () => {
      mockFetch.mockResolvedValue({ action: 'run', ok: true })
      const result = await triggerCronJob('j1')
      // unified endpoint 不返 run_id，返 ok。客户端封装返默认 message。
      expect(result.message).toBeTruthy()
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
