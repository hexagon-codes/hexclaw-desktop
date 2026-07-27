import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  apiPost: vi.fn(),
}))

vi.mock('../client', () => ({
  apiGet: vi.fn(),
  apiPost: client.apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

import { k12RestoreMistakeReview, k12SuppressMistake } from '../k12'

describe('K12 mistake controlled review-state API', () => {
  beforeEach(() => client.apiPost.mockReset().mockResolvedValue({ record_id: 'm1', version: 4 }))

  it('suppresses with owner, CAS version, and durable intent identity', async () => {
    await k12SuppressMistake('child-a', 'm/1', 3, 'suppress-command-1')

    expect(client.apiPost).toHaveBeenCalledExactlyOnceWith('/api/k12/mistakes/m%2F1/suppress', {
      agent: 'child-a',
      version: 3,
      idempotency_key: 'suppress-command-1',
    })
  })

  it('restores review through the same controlled command contract', async () => {
    await k12RestoreMistakeReview('child-a', 'm/1', 4, 'restore-review-command-1')

    expect(client.apiPost).toHaveBeenCalledExactlyOnceWith(
      '/api/k12/mistakes/m%2F1/restore-review',
      {
      agent: 'child-a',
      version: 4,
        idempotency_key: 'restore-review-command-1',
      },
    )
  })
})
