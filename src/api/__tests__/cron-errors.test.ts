/**
 * Cron / Webhook Error Paths — 补全错误路径与边缘场景
 *
 * 覆盖：
 *  - 网络错误传播
 *  - 4xx/5xx 响应错误
 *  - 字段验证（空 prompt / 非法 cron 表达式 / 特殊字符 id）
 *  - 状态转换（pause → resume / trigger 重复）
 *  - Webhook 创建/删除/错误路径
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import {
  getCronJobs,
  createCronJob,
  deleteCronJob,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  getCronJobHistory,
} from '../tasks'
import { getWebhooks, createWebhook, deleteWebhook } from '../webhook'

describe('Cron + Webhook Error Paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── Cron network / 5xx errors ───────────────────

  describe('getCronJobs — error propagation', () => {
    it('propagates network rejection', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      await expect(getCronJobs()).rejects.toThrow('ECONNREFUSED')
    })

    it('propagates 500 server error', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('Internal Server Error'), { status: 500 }))
      await expect(getCronJobs()).rejects.toThrow('Internal Server Error')
    })
  })

  describe('createCronJob — validation / errors', () => {
    it('propagates 400 Bad Request for invalid schedule expression', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('invalid cron expression'), { status: 400 }))
      await expect(
        createCronJob({ name: 'bad', schedule: 'not a cron', prompt: 'do' }),
      ).rejects.toThrow('invalid cron expression')
    })

    it('still sends empty prompt to backend (backend validates)', async () => {
      mockFetch.mockResolvedValue({ id: 'j1', name: 'x', next_run_at: '' })
      await createCronJob({ name: 'x', schedule: '* * * * *', prompt: '' })
      const body = mockFetch.mock.calls[0]![1].body
      expect(body.prompt).toBe('')
      expect(body.user_id).toBeDefined()
    })

    it('propagates 409 Conflict when duplicate job name', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('duplicate job name'), { status: 409 }))
      await expect(
        createCronJob({ name: 'dup', schedule: '0 0 * * *', prompt: 'p' }),
      ).rejects.toThrow('duplicate job name')
    })
  })

  // ─── State transitions ──────────────────────────

  describe('pause → resume transition', () => {
    it('sends pause then resume in sequence', async () => {
      mockFetch
        .mockResolvedValueOnce({ message: 'paused' })
        .mockResolvedValueOnce({ message: 'resumed' })
      const paused = await pauseCronJob('j1')
      const resumed = await resumeCronJob('j1')
      expect(paused.message).toBe('paused')
      expect(resumed.message).toBe('resumed')
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/v1/cron/jobs/j1/pause',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        '/api/v1/cron/jobs/j1/resume',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('idempotent pause — second call returns same message without throwing', async () => {
      mockFetch.mockResolvedValue({ message: 'already paused' })
      const a = await pauseCronJob('j1')
      const b = await pauseCronJob('j1')
      expect(a.message).toBe('already paused')
      expect(b.message).toBe('already paused')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('pause propagates 404 when job does not exist', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('job not found'), { status: 404 }))
      await expect(pauseCronJob('missing')).rejects.toThrow('job not found')
    })
  })

  describe('triggerCronJob — errors', () => {
    it('propagates 409 when job already running', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('job already running'), { status: 409 }))
      await expect(triggerCronJob('j1')).rejects.toThrow('job already running')
    })

    it('encodes special characters in job id for trigger', async () => {
      mockFetch.mockResolvedValue({ message: 'triggered' })
      await triggerCronJob('job with spaces')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('job%20with%20spaces')
    })
  })

  describe('deleteCronJob — special ids', () => {
    it('encodes slash and unicode characters in id', async () => {
      mockFetch.mockResolvedValue({ message: 'deleted' })
      await deleteCronJob('jobs/中文/id')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('%2F')
      expect(url).toContain('%E4%B8%AD')
    })

    it('propagates 404 when deleting missing job', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
      await expect(deleteCronJob('ghost')).rejects.toThrow('not found')
    })
  })

  describe('getCronJobHistory — edge cases', () => {
    it('returns empty array when neither history nor runs present', async () => {
      mockFetch.mockResolvedValue({})
      const result = await getCronJobHistory('j1')
      expect(result).toEqual([])
    })

    it('passes limit query param', async () => {
      mockFetch.mockResolvedValue({ history: [] })
      await getCronJobHistory('j1', 100)
      const call = mockFetch.mock.calls[0]!
      expect(call[1].query).toMatchObject({ limit: 100 })
    })

    it('propagates 500 when history endpoint fails', async () => {
      mockFetch.mockRejectedValue(new Error('db error'))
      await expect(getCronJobHistory('j1')).rejects.toThrow('db error')
    })
  })

  // ─── Webhook error paths ────────────────────────

  describe('Webhook API', () => {
    it('getWebhooks propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('network down'))
      await expect(getWebhooks()).rejects.toThrow('network down')
    })

    it('createWebhook sends fixed empty prompt/secret', async () => {
      mockFetch.mockResolvedValue({ id: 'w1', name: 'n', url: 'https://example.com' })
      await createWebhook({ name: 'n', type: 'feishu', url: 'https://example.com', events: ['task_complete'] })
      const body = mockFetch.mock.calls[0]![1].body
      expect(body).toMatchObject({
        name: 'n',
        type: 'feishu',
        url: 'https://example.com',
        events: ['task_complete'],
        prompt: '',
        secret: '',
      })
      expect(body.user_id).toBeDefined()
    })

    it('createWebhook propagates 400 when URL invalid', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('invalid URL'), { status: 400 }))
      await expect(
        createWebhook({ name: 'bad', type: 'custom', url: 'ftp://nope', events: [] }),
      ).rejects.toThrow('invalid URL')
    })

    it('deleteWebhook encodes special chars in id', async () => {
      mockFetch.mockResolvedValue({ message: 'deleted' })
      await deleteWebhook('wh/1 with space')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('wh%2F1%20with%20space')
    })

    it('deleteWebhook propagates 404', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
      await expect(deleteWebhook('missing')).rejects.toThrow('not found')
    })
  })
})
