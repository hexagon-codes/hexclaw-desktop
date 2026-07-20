import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet: vi.fn(),
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

const accepted = {
  document_id: 'doc-failed',
  job_id: 'job-retry',
  text_index_state: 'pending',
  vector_index_state: 'disabled',
}

function retryKey(call: unknown[]): string {
  const options = call[2] as { headers: Record<string, string> }
  const key = options.headers['Idempotency-Key']
  if (!key) throw new Error('missing retry Idempotency-Key')
  return key
}

describe('Knowledge failed-document retry intent', () => {
  beforeEach(() => {
    apiPost.mockReset()
    localStorage.clear()
    vi.resetModules()
  })

  it('persists before send and reuses the key after a response-unknown refresh', async () => {
    apiPost.mockImplementationOnce((_path, _body, options) => {
      const key = (options as { headers: Record<string, string> }).headers['Idempotency-Key']
      expect(localStorage.getItem('hexclaw:knowledge-retry-intents:v1')).toContain(key)
      return Promise.reject(new Error('Network error'))
    })
    const firstModule = await import('../knowledge')
    await expect(firstModule.retryKnowledgeDocument('doc-failed')).rejects.toThrow('Network error')
    const firstKey = retryKey(apiPost.mock.calls[0]!)

    vi.resetModules()
    apiPost.mockResolvedValueOnce(accepted)
    const refreshedModule = await import('../knowledge')
    await refreshedModule.retryKnowledgeDocument('doc-failed')

    expect(apiPost.mock.calls[1]?.[0]).toBe('/api/v1/knowledge/documents/doc-failed/retry')
    expect(retryKey(apiPost.mock.calls[1]!)).toBe(firstKey)
    expect(localStorage.getItem('hexclaw:knowledge-retry-intents:v1')).toBeNull()
  })

  it('uses one persisted key for concurrent double-clicks and releases after acknowledgement', async () => {
    let resolveFirst!: (value: typeof accepted) => void
    apiPost
      .mockImplementationOnce(
        () => new Promise<typeof accepted>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(accepted)
    const { retryKnowledgeDocument } = await import('../knowledge')

    const first = retryKnowledgeDocument('doc-failed')
    const second = retryKnowledgeDocument('doc-failed')
    await second
    resolveFirst(accepted)
    await first

    expect(retryKey(apiPost.mock.calls[0]!)).toBe(retryKey(apiPost.mock.calls[1]!))
    expect(localStorage.getItem('hexclaw:knowledge-retry-intents:v1')).toBeNull()
  })

  it.each([404, 409])('releases the intent after definitive HTTP %s', async (status) => {
    apiPost.mockRejectedValueOnce(
      Object.assign(new Error('definitive retry rejection'), { status }),
    )
    const { retryKnowledgeDocument } = await import('../knowledge')

    await expect(retryKnowledgeDocument('doc-failed')).rejects.toThrow('definitive retry rejection')

    expect(localStorage.getItem('hexclaw:knowledge-retry-intents:v1')).toBeNull()
  })

  it('keeps independent intents for different failed documents', async () => {
    apiPost.mockRejectedValue(new Error('Network error'))
    const { retryKnowledgeDocument } = await import('../knowledge')

    await expect(retryKnowledgeDocument('doc-a')).rejects.toThrow('Network error')
    await expect(retryKnowledgeDocument('doc-b')).rejects.toThrow('Network error')

    expect(retryKey(apiPost.mock.calls[0]!)).not.toBe(retryKey(apiPost.mock.calls[1]!))
  })
})
