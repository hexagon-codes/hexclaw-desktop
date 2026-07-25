import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import * as k12 from '../k12'

describe('K12 accumulation current HTTP contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.api.mockResolvedValue({})
    client.apiGet.mockResolvedValue({ items: [] })
    client.apiPost.mockResolvedValue({})
  })

  it('creates an accumulation with content as the only request field', async () => {
    await k12.k12AddAccumulation(
      'mingming',
      {
        content: 'a piece of cake',
        agent: 'legacy-agent',
        subject: '英语',
        entry_type: '词汇积累',
        source: 'legacy-source',
      } as never,
      'desktop-accum-create:key-1',
    )

    expect(client.api).toHaveBeenCalledWith('/api/k12/accumulation', {
      method: 'POST',
      query: { agent: 'mingming' },
      body: { content: 'a piece of cake' },
      headers: { 'Idempotency-Key': 'desktop-accum-create:key-1' },
    })
    expect(client.apiPost).not.toHaveBeenCalled()
  })

  it('posts dictation commands through the typed API and returns the durable generation summary', async () => {
    expect(typeof k12.k12GenerateAccumulationDictation).toBe('function')
    client.apiPost.mockResolvedValueOnce({
      dictation_generation: {
        generation_id: 'generation-1',
        status: 'queued',
        attempt: 1,
        updated_at: 100,
      },
    })

    const response = await k12.k12GenerateAccumulationDictation('mingming', 'accum/1')

    expect(client.apiPost).toHaveBeenCalledWith(
      '/api/k12/accumulation/accum%2F1/dictation-to-basket',
      { agent: 'mingming' },
    )
    expect(response.dictation_generation).toEqual({
      generation_id: 'generation-1',
      status: 'queued',
      attempt: 1,
      updated_at: 100,
    })
  })

  it('deletes with row version and one idempotency key in headers', async () => {
    expect(typeof k12.k12DeleteAccumulation).toBe('function')
    client.api.mockResolvedValueOnce({
      accumulation_id: 'accum/1',
      deleted: true,
      version: 5,
    })

    await k12.k12DeleteAccumulation('mingming', 'accum/1', 4, 'desktop-accum-delete:key-1')

    expect(client.api).toHaveBeenCalledWith('/api/k12/accumulation/accum%2F1', {
      method: 'DELETE',
      query: { agent: 'mingming' },
      headers: {
        'If-Match': '4',
        'Idempotency-Key': 'desktop-accum-delete:key-1',
      },
    })
  })
})
