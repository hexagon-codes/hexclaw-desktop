import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import { k12ProvisionCron } from '../k12'
import * as tasksApi from '../tasks'
import type { CronJobUnifiedRequest } from '../tasks'

const DEFAULT_K12_JOBS = [
  { kind: 'weekly-sheet', name: '周复习', schedule: '0 19 * * 5', job_id: 'job-weekly' },
  { kind: 'return-reminder', name: '回传提醒', schedule: '0 20 * * *', job_id: 'job-return' },
  { kind: 'semester-spring', name: '春季学期确认', schedule: '0 9 1 3 *', job_id: 'job-spring' },
  { kind: 'semester-fall', name: '秋季学期确认', schedule: '0 9 1 9 *', job_id: 'job-fall' },
]

describe('K12 Task owner and Desktop API contract', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
    client.apiPost.mockResolvedValue({ ok: true })
  })

  it('keeps the Tasks runtime surface exact and exposes both timeout gates', () => {
    expect(Object.keys(tasksApi).sort()).toEqual([
      'CRON_CREATE_TIMEOUT_MS',
      'CRON_SSE_TIMEOUT_MS',
      'createCronJob',
      'createCronJobJSON',
      'createCronJobSSE',
      'cronjobAction',
      'deleteCronJob',
      'genIdempotencyKey',
      'getCronJobHistory',
      'getCronJobs',
      'parseCronText',
      'pauseCronJob',
      'resumeCronJob',
      'triggerCronJob',
    ].sort())
    expect(tasksApi.CRON_CREATE_TIMEOUT_MS).toBe(120_000)
    expect(tasksApi.CRON_SSE_TIMEOUT_MS).toBe(180_000)
  })

  it.each([
    ['create', { draft: { name: 'x', schedule: '0 19 * * 5', prompt: 'x' } }],
    ['update', { job_id: 'job-a' }],
    ['list', { include_paused: true }],
    ['pause', { job_id: 'job-a' }],
    ['resume', { job_id: 'job-a' }],
    ['remove', { job_id: 'job-a' }],
    ['run', { job_id: 'job-a' }],
  ] as const)('does not let %s body input override the trusted Desktop principal', async (action, rest) => {
    await tasksApi.cronjobAction({
      action,
      ...rest,
      user_id: 'attacker-owner',
    } as unknown as CronJobUnifiedRequest)

    expect(client.apiPost).toHaveBeenLastCalledWith(
      '/api/v1/cronjob',
      expect.objectContaining({ action, user_id: 'desktop-user' }),
    )
  })

  it('provisions K12 jobs under the same Desktop principal and rejects a non-four-job success envelope', async () => {
    client.apiPost.mockResolvedValueOnce({ provisioned: DEFAULT_K12_JOBS })

    const result = await k12ProvisionCron({
      agent: 'tutor-a',
      user_id: 'attacker-owner',
    } as Parameters<typeof k12ProvisionCron>[0])

    expect(result.provisioned.map((job) => job.kind)).toEqual(DEFAULT_K12_JOBS.map((job) => job.kind))
    expect(client.apiPost).toHaveBeenLastCalledWith('/api/k12/cron/provision', {
      agent: 'tutor-a',
      user_id: 'desktop-user',
    })

    client.apiPost.mockResolvedValueOnce({
      provisioned: [
        ...DEFAULT_K12_JOBS,
        { kind: 'daily-report', name: '已撤默认任务', schedule: '0 21 * * *', job_id: 'job-daily' },
      ],
    })

    await expect(k12ProvisionCron({ agent: 'tutor-a' })).rejects.toThrow(/4|默认|任务/)
  })

  it('preserves owner/workflow/object/receipt evidence returned by list and history', async () => {
    const job = {
      id: 'job-weekly',
      name: '周复习',
      type: 'cron',
      schedule: '0 19 * * 5',
      user_id: 'desktop-user',
      status: 'paused',
      last_run_at: '',
      next_run_at: '2026-07-24T11:00:00Z',
      run_count: 1,
      created_at: '2026-07-19T00:00:00Z',
      source_prompt: '周复习',
      spec: null,
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
      workflow_id: 'weekly-sheet',
      workflow_version: 'v1',
      object_id: 'basket-a',
      timezone: 'Asia/Shanghai',
    }
    client.apiPost.mockResolvedValueOnce({ jobs: [job], total: 1 })
    const listed = await tasksApi.getCronJobs()
    expect(listed.jobs[0]).toMatchObject({
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
      workflow_id: 'weekly-sheet',
      object_id: 'basket-a',
    })

    client.apiGet.mockResolvedValueOnce({
      history: [{
        id: 'run-1',
        job_id: 'job-weekly',
        status: 'success',
        run_at: '2026-07-19T11:00:00Z',
        execution_id: 'exec-1',
        trigger: 'scheduled',
        delivery_receipt_id: 'delivery-1',
      }],
    })
    const history = await tasksApi.getCronJobHistory('job/weekly', 10)
    expect(client.apiGet).toHaveBeenCalledWith('/api/v1/cron/jobs/job%2Fweekly/history', { limit: 10 })
    expect(history[0]).toMatchObject({
      started_at: '2026-07-19T11:00:00Z',
      execution_id: 'exec-1',
      delivery_receipt_id: 'delivery-1',
    })
  })
})
