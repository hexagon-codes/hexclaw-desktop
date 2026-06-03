/**
 * Chain E: Tasks/Cron -> Backend
 *
 * Tests the task/cron job lifecycle: create, list, delete, pause, resume,
 * trigger, and history retrieval.
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

vi.mock('@/constants', () => ({
  DESKTOP_USER_ID: 'desktop-user',
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain E: Tasks/Cron -> Backend', () => {
  // ── D1.2: 所有 cron CRUD 都走 POST /api/v1/cronjob unified endpoint ──

  it('E1: getCronJobs lists jobs via POST /api/v1/cronjob action=list', async () => {
    mockApiPost.mockResolvedValueOnce({
      action: 'list',
      jobs: [
        { id: 'job-1', name: 'Daily Report', schedule: '0 9 * * *', status: 'active' },
        { id: 'job-2', name: 'Weekly Backup', schedule: '0 0 * * 0', status: 'paused' },
      ],
      total: 2,
    })

    const { getCronJobs } = await import('@/api/tasks')
    const result = await getCronJobs()

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'list', user_id: 'desktop-user' }),
    )
    expect(result.jobs).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('E2: createCronJob sends POST /api/v1/cronjob action=create with draft', async () => {
    mockApiPost.mockResolvedValueOnce({
      action: 'create',
      job: { id: 'job-new', name: 'Check Email', next_run_at: '2026-01-02T09:00:00Z' },
    })

    const { createCronJob } = await import('@/api/tasks')
    const result = await createCronJob({
      name: 'Check Email',
      schedule: '0 9 * * *',
      prompt: 'Check my inbox for important emails',
      type: 'cron',
    })

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({
        action: 'create',
        user_id: 'desktop-user',
        draft: expect.objectContaining({
          name: 'Check Email',
          schedule: '0 9 * * *',
          prompt: 'Check my inbox for important emails',
        }),
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
    expect(result.job.id).toBe('job-new')
    expect(result.job.name).toBe('Check Email')
  })

  it('E2b: createCronJob always wraps draft regardless of input type field', async () => {
    mockApiPost.mockResolvedValueOnce({
      action: 'create',
      job: { id: 'job-2', name: 'Task', next_run_at: '2026-01-02T00:00:00Z' },
    })

    const { createCronJob } = await import('@/api/tasks')
    await createCronJob({
      name: 'Task',
      schedule: '0 0 * * *',
      prompt: 'Do something',
    })

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({
        action: 'create',
        draft: expect.objectContaining({ name: 'Task' }),
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('E3: deleteCronJob calls POST /api/v1/cronjob action=remove', async () => {
    mockApiPost.mockResolvedValueOnce({ action: 'remove', ok: true })

    const { deleteCronJob } = await import('@/api/tasks')
    const result = await deleteCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'remove', job_id: 'job-1' }),
    )
    expect(result.message).toBe('任务已删除')
  })

  it('E4: pauseCronJob calls POST /api/v1/cronjob action=pause', async () => {
    mockApiPost.mockResolvedValueOnce({ action: 'pause', ok: true })

    const { pauseCronJob } = await import('@/api/tasks')
    const result = await pauseCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'pause', job_id: 'job-1' }),
    )
    expect(result.message).toBe('任务已暂停')
  })

  it('E5: resumeCronJob calls POST /api/v1/cronjob action=resume', async () => {
    mockApiPost.mockResolvedValueOnce({ action: 'resume', ok: true })

    const { resumeCronJob } = await import('@/api/tasks')
    const result = await resumeCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'resume', job_id: 'job-1' }),
    )
    expect(result.message).toBe('任务已恢复')
  })

  it('E6: triggerCronJob calls POST /api/v1/cronjob action=run', async () => {
    mockApiPost.mockResolvedValueOnce({ action: 'run', ok: true })

    const { triggerCronJob } = await import('@/api/tasks')
    const result = await triggerCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'run', job_id: 'job-1' }),
    )
    expect(result.message).toBe('已触发')
  })

  it('E7: getCronJobHistory retrieves job run history via GET', async () => {
    mockApiGet.mockResolvedValueOnce({
      history: [
        { id: 'run-1', job_id: 'job-1', status: 'success', started_at: '2026-01-01T09:00:00Z', finished_at: '2026-01-01T09:00:05Z', duration_ms: 5000 },
        { id: 'run-2', job_id: 'job-1', status: 'failed', started_at: '2025-12-31T09:00:00Z', error: 'Timeout' },
      ],
    })

    const { getCronJobHistory } = await import('@/api/tasks')
    const history = await getCronJobHistory('job-1', 10)

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/cron/jobs/job-1/history', { limit: 10 })
    expect(history).toHaveLength(2)
    expect(history[0]!.status).toBe('success')
    expect(history[1]!.status).toBe('failed')
    expect(history[1]!.error).toBe('Timeout')
  })

  it('E7b: getCronJobHistory normalizes run_at field to started_at', async () => {
    mockApiGet.mockResolvedValueOnce({
      runs: [
        { id: 'run-1', job_id: 'job-1', status: 'success', run_at: '2026-01-01T09:00:00Z' },
      ],
    })

    const { getCronJobHistory } = await import('@/api/tasks')
    const history = await getCronJobHistory('job-1')

    expect(history[0]!.started_at).toBe('2026-01-01T09:00:00Z')
  })

  it('E8: API failure on create propagates as error', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('Rate limit exceeded'))

    const { createCronJob } = await import('@/api/tasks')

    await expect(createCronJob({
      name: 'Failing Job',
      schedule: '0 0 * * *',
      prompt: 'test',
    })).rejects.toThrow('Rate limit exceeded')
  })

  it('E9: full lifecycle: create -> pause -> resume -> trigger -> delete (D1.2 unified)', async () => {
    mockApiPost.mockResolvedValueOnce({
      action: 'create',
      job: { id: 'job-lc', name: 'LC Job', next_run_at: '2026-01-02T00:00:00Z' },
    })
    const { createCronJob, pauseCronJob, resumeCronJob, triggerCronJob, deleteCronJob } = await import('@/api/tasks')

    const result = await createCronJob({ name: 'LC Job', schedule: '0 0 * * *', prompt: 'test' })
    expect(result.job.id).toBe('job-lc')

    mockApiPost.mockResolvedValueOnce({ action: 'pause', ok: true })
    await pauseCronJob('job-lc')
    expect(mockApiPost).toHaveBeenLastCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'pause', job_id: 'job-lc' }),
    )

    mockApiPost.mockResolvedValueOnce({ action: 'resume', ok: true })
    await resumeCronJob('job-lc')
    expect(mockApiPost).toHaveBeenLastCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'resume', job_id: 'job-lc' }),
    )

    mockApiPost.mockResolvedValueOnce({ action: 'run', ok: true })
    await triggerCronJob('job-lc')
    expect(mockApiPost).toHaveBeenLastCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'run', job_id: 'job-lc' }),
    )

    mockApiPost.mockResolvedValueOnce({ action: 'remove', ok: true })
    await deleteCronJob('job-lc')
    expect(mockApiPost).toHaveBeenLastCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action: 'remove', job_id: 'job-lc' }),
    )
  })
})
