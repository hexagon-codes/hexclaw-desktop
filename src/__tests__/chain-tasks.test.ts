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
  it('E1: getCronJobs lists jobs via GET /api/v1/cron/jobs with user_id', async () => {
    const jobs = {
      jobs: [
        { id: 'job-1', name: 'Daily Report', schedule: '0 9 * * *', status: 'active' },
        { id: 'job-2', name: 'Weekly Backup', schedule: '0 0 * * 0', status: 'paused' },
      ],
      total: 2,
    }
    mockApiGet.mockResolvedValueOnce(jobs)

    const { getCronJobs } = await import('@/api/tasks')
    const result = await getCronJobs()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/cron/jobs', {
      user_id: 'desktop-user',
    })
    expect(result.jobs).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('E2: createCronJob sends POST /api/v1/cron/jobs with correct payload', async () => {
    mockApiPost.mockResolvedValueOnce({
      id: 'job-new',
      name: 'Check Email',
      next_run_at: '2026-01-02T09:00:00Z',
    })

    const { createCronJob } = await import('@/api/tasks')
    const result = await createCronJob({
      name: 'Check Email',
      schedule: '0 9 * * *',
      prompt: 'Check my inbox for important emails',
      type: 'cron',
    })

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs', {
      name: 'Check Email',
      schedule: '0 9 * * *',
      prompt: 'Check my inbox for important emails',
      type: 'cron',
      user_id: 'desktop-user',
    })
    expect(result.id).toBe('job-new')
    expect(result.name).toBe('Check Email')
  })

  it('E2b: createCronJob defaults type to "cron" when not specified', async () => {
    mockApiPost.mockResolvedValueOnce({
      id: 'job-2',
      name: 'Task',
      next_run_at: '2026-01-02T00:00:00Z',
    })

    const { createCronJob } = await import('@/api/tasks')
    await createCronJob({
      name: 'Task',
      schedule: '0 0 * * *',
      prompt: 'Do something',
    }) // type is optional in input

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs', expect.objectContaining({
      type: 'cron',
    }))
  })

  it('E3: deleteCronJob calls DELETE /api/v1/cron/jobs/:id', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteCronJob } = await import('@/api/tasks')
    const result = await deleteCronJob('job-1')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/cron/jobs/job-1')
    expect(result.message).toBe('deleted')
  })

  it('E4: pauseCronJob calls POST /api/v1/cron/jobs/:id/pause', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'paused' })

    const { pauseCronJob } = await import('@/api/tasks')
    const result = await pauseCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-1/pause')
    expect(result.message).toBe('paused')
  })

  it('E5: resumeCronJob calls POST /api/v1/cron/jobs/:id/resume', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'resumed' })

    const { resumeCronJob } = await import('@/api/tasks')
    const result = await resumeCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-1/resume')
    expect(result.message).toBe('resumed')
  })

  it('E6: triggerCronJob calls POST /api/v1/cron/jobs/:id/trigger', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'triggered', run_id: 'run-1' })

    const { triggerCronJob } = await import('@/api/tasks')
    const result = await triggerCronJob('job-1')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-1/trigger')
    expect(result.message).toBe('triggered')
    expect(result.run_id).toBe('run-1')
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

  it('E9: full lifecycle: create -> pause -> resume -> trigger -> delete', async () => {
    // Create
    mockApiPost.mockResolvedValueOnce({ id: 'job-lc', name: 'LC Job', next_run_at: '2026-01-02T00:00:00Z' })
    const { createCronJob, pauseCronJob, resumeCronJob, triggerCronJob, deleteCronJob } = await import('@/api/tasks')

    const job = await createCronJob({ name: 'LC Job', schedule: '0 0 * * *', prompt: 'test' })
    expect(job.id).toBe('job-lc')

    // Pause
    mockApiPost.mockResolvedValueOnce({ message: 'paused' })
    await pauseCronJob('job-lc')
    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-lc/pause')

    // Resume
    mockApiPost.mockResolvedValueOnce({ message: 'resumed' })
    await resumeCronJob('job-lc')
    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-lc/resume')

    // Trigger
    mockApiPost.mockResolvedValueOnce({ message: 'triggered' })
    await triggerCronJob('job-lc')
    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/cron/jobs/job-lc/trigger')

    // Delete
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })
    await deleteCronJob('job-lc')
    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/cron/jobs/job-lc')
  })
})
