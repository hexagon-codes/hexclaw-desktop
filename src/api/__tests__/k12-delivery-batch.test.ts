import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
vi.mock('../client', () => ({
  api: vi.fn(),
  apiGet: (...args: unknown[]) => h.apiGet(...args),
  apiPost: (...args: unknown[]) => h.apiPost(...args),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

import {
  k12FinalizePracticeSet,
  k12GetDeliveryBatch,
  k12QueryDeliveryBatch,
  k12RetryDeliveryBatch,
  k12SendAccumulation,
  k12SendGradingFinalArtifact,
} from '../k12'

describe('K12 全绑定 DeliveryBatch API', () => {
  beforeEach(() => {
    h.apiGet.mockReset().mockResolvedValue({})
    h.apiPost.mockReset().mockResolvedValue({})
  })

  it('三个批准入口都只提交业务对象，不传平台、接收人或发送目标', async () => {
    await k12SendGradingFinalArtifact('ming', 'grading-final-1', 'sha256:grading-final-1')
    await k12SendAccumulation('ming', 'accum-1')
    await k12FinalizePracticeSet('ming', 'set-1', 'send')

    expect(h.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/tutoring-tips/send', {
      agent: 'ming',
      final_artifact_id: 'grading-final-1',
      final_artifact_digest: 'sha256:grading-final-1',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(2, '/api/k12/accumulation/accum-1/send', {
      agent: 'ming',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(3, '/api/k12/practice-sets/set-1/finalize', {
      agent: 'ming',
      via: 'send',
    })
  })

  it('批次恢复、失败重试和未知查询只携带 owner 与 batch id', async () => {
    await k12GetDeliveryBatch('ming ming', 'batch-1')
    await k12RetryDeliveryBatch('ming', 'batch-1')
    await k12QueryDeliveryBatch('ming', 'batch-1')

    expect(h.apiGet).toHaveBeenCalledWith('/api/k12/delivery-batches/batch-1', {
      agent: 'ming ming',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/delivery-batches/batch-1/retry', {
      agent: 'ming',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(2, '/api/k12/delivery-batches/batch-1/query', {
      agent: 'ming',
    })
  })
})
