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

import { k12ArchiveMistake, k12RestoreMistake } from '../k12'

describe('K12 mistake controlled archive API', () => {
  beforeEach(() => client.apiPost.mockReset().mockResolvedValue({ record_id: 'm1', version: 4 }))

  it('archives with owner, CAS version, and durable intent identity', async () => {
    await k12ArchiveMistake('child-a', 'm/1', 3, 'archive-command-1')

    expect(client.apiPost).toHaveBeenCalledExactlyOnceWith('/api/k12/mistakes/m%2F1/archive', {
      agent: 'child-a',
      version: 3,
      idempotency_key: 'archive-command-1',
    })
  })

  it('restores through the same controlled command contract', async () => {
    await k12RestoreMistake('child-a', 'm/1', 4, 'restore-command-1')

    expect(client.apiPost).toHaveBeenCalledExactlyOnceWith('/api/k12/mistakes/m%2F1/restore', {
      agent: 'child-a',
      version: 4,
      idempotency_key: 'restore-command-1',
    })
  })
})
