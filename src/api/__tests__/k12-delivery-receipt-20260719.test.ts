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
  k12GetDeliveryReceipt,
  k12QueryDeliveryReceipt,
  k12RetryDeliveryReceipt,
  k12SendTutoringTips,
  k12SendWorkFeedback,
} from '../k12'

describe('DD-024 durable DeliveryReceipt API', () => {
  beforeEach(() => {
    h.apiGet.mockReset().mockResolvedValue({})
    h.apiPost.mockReset().mockResolvedValue({})
  })

  it('作品与辅导要点发送都返回后端 Receipt，不走剪贴板替代', async () => {
    await k12SendWorkFeedback('ming', 'work-1', 'feedback')
    await k12SendTutoringTips('ming', '【辅导要点】\n正文')
    expect(h.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/creative-works/work-1/send-feedback', {
      agent: 'ming',
      kind: 'feedback',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(2, '/api/k12/tutoring-tips/send', {
      agent: 'ming',
      content: '【辅导要点】\n正文',
    })
  })

  it('GET/retry/query 都带 owner；query 与 retry 是不同命令', async () => {
    await k12GetDeliveryReceipt('ming ming', 'delivery-1')
    await k12RetryDeliveryReceipt('ming', 'delivery-1')
    await k12QueryDeliveryReceipt('ming', 'delivery-1')
    expect(h.apiGet).toHaveBeenCalledWith('/api/k12/delivery-receipts/delivery-1', {
      agent: 'ming ming',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/delivery-receipts/delivery-1/retry', {
      agent: 'ming',
    })
    expect(h.apiPost).toHaveBeenNthCalledWith(2, '/api/k12/delivery-receipts/delivery-1/query', {
      agent: 'ming',
    })
  })
})
