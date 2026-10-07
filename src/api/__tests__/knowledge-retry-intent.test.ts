import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

const accepted = {
  operation_id: 'operation-retry',
  document_id: 'doc-failed',
  job_id: 'job-retry',
  text_index_state: 'pending',
  vector_index_state: 'disabled',
}

function failedOperation(documentId: string, jobId: string) {
  return {
    operation_id: jobId,
    job_id: jobId,
    document_id: documentId,
    title: `${documentId}.pdf`,
    display_name: `${documentId}.pdf`,
    content_digest: 'a'.repeat(64),
    state: 'failed',
    stage: 'embedding',
    terminal: true,
    error: 'provider unavailable',
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
  }
}

function retryKey(call: unknown[]): string {
  const options = call[2] as { headers: Record<string, string> }
  const key = options.headers['Idempotency-Key']
  if (!key) throw new Error('missing retry Idempotency-Key')
  return key
}

describe('Knowledge failed-document Sidecar retry identity', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({
      operations: [failedOperation('doc-failed', 'job-failed-generation-7')],
    })
    apiPost.mockReset()
    localStorage.clear()
    vi.resetModules()
  })

  it('derives the same retry key from the durable failed Job after restart', async () => {
    apiPost.mockRejectedValueOnce(new Error('Network error'))
    const firstModule = await import('../knowledge')
    await expect(firstModule.retryKnowledgeDocument('doc-failed')).rejects.toThrow('Network error')

    vi.resetModules()
    apiPost.mockResolvedValueOnce(accepted)
    const restartedModule = await import('../knowledge')
    await restartedModule.retryKnowledgeDocument('doc-failed')

    expect(retryKey(apiPost.mock.calls[0]!)).toBe('knowledge-retry:v2:job-failed-generation-7')
    expect(retryKey(apiPost.mock.calls[1]!)).toBe(retryKey(apiPost.mock.calls[0]!))
    expect(localStorage.length).toBe(0)
  })

  it('keeps concurrent retries on one failed generation idempotent', async () => {
    apiPost.mockResolvedValue(accepted)
    const { retryKnowledgeDocument } = await import('../knowledge')

    await Promise.all([retryKnowledgeDocument('doc-failed'), retryKnowledgeDocument('doc-failed')])

    expect(retryKey(apiPost.mock.calls[0]!)).toBe(retryKey(apiPost.mock.calls[1]!))
  })

  it('uses distinct keys for distinct durable failed generations', async () => {
    apiGet.mockResolvedValue({
      operations: [failedOperation('doc-a', 'job-a'), failedOperation('doc-b', 'job-b')],
    })
    apiPost.mockResolvedValue(accepted)
    const { retryKnowledgeDocument } = await import('../knowledge')

    await retryKnowledgeDocument('doc-a')
    await retryKnowledgeDocument('doc-b')

    expect(retryKey(apiPost.mock.calls[0]!)).toBe('knowledge-retry:v2:job-a')
    expect(retryKey(apiPost.mock.calls[1]!)).toBe('knowledge-retry:v2:job-b')
  })

  it('fails closed when Sidecar has no failed generation for the document', async () => {
    apiGet.mockResolvedValue({ operations: [] })
    const { retryKnowledgeDocument } = await import('../knowledge')

    await expect(retryKnowledgeDocument('doc-missing')).rejects.toThrow(
      'failed knowledge operation is unavailable',
    )
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('contains no renderer retry ledger', async () => {
    const sourceCode = await import('../knowledge?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).not.toContain('knowledge-retry-intents')
    expect(raw).not.toContain('retainRetryIntent')
    expect(raw).not.toContain('localStorage')
  })

  it('retries the failed vector child when the upload operation already succeeded, including after restart', async () => {
    const document = {
      id: 'doc-vector', status: 'indexed', text_index_state: 'ready',
      vector_index_state: 'failed', vector_job_state: 'failed',
      vector_job_id: 'job-vector-failed', vector_outcome_unknown: false,
    }
    apiGet.mockImplementation(async (path: string) =>
      path.includes('/operations')
        ? { operations: [{ ...failedOperation('doc-vector', 'job-ingest'), state: 'succeeded', stage: 'text_indexing' }] }
        : document,
    )
    apiPost.mockResolvedValue({ ...accepted, document_id: 'doc-vector', text_index_state: 'ready', vector_index_state: 'pending' })
    const first = await import('../knowledge')
    await first.retryKnowledgeDocument('doc-vector')
    vi.resetModules()
    const restarted = await import('../knowledge')
    await restarted.retryKnowledgeDocument('doc-vector')

    expect(apiGet).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc-vector')
    expect(apiPost.mock.calls[0]?.[0]).toBe('/api/v1/knowledge/documents/doc-vector/retry')
    expect(apiPost.mock.calls[0]?.[1]).toBeUndefined()
    expect(retryKey(apiPost.mock.calls[0]!)).toBe('knowledge-retry:v2:job-vector-failed')
    expect(retryKey(apiPost.mock.calls[1]!)).toBe(retryKey(apiPost.mock.calls[0]!))
    expect(apiPost.mock.calls.every((call) => !String(call[0]).includes('/reindex'))).toBe(true)
    expect(localStorage.length).toBe(0)
  })

  it('uses the new failed vector identity after a later failure', async () => {
    let jobId = 'job-vector-first-failure'
    apiGet.mockImplementation(async (path: string) =>
      path.includes('/operations') ? { operations: [] } : {
        id: 'doc-vector', status: 'indexed', text_index_state: 'ready',
        vector_index_state: 'failed', vector_job_state: 'failed', vector_job_id: jobId,
      },
    )
    apiPost.mockResolvedValue(accepted)
    const { retryKnowledgeDocument } = await import('../knowledge')
    await retryKnowledgeDocument('doc-vector')
    jobId = 'job-vector-second-failure'
    await retryKnowledgeDocument('doc-vector')
    expect(retryKey(apiPost.mock.calls[0]!)).toBe('knowledge-retry:v2:job-vector-first-failure')
    expect(retryKey(apiPost.mock.calls[1]!)).toBe('knowledge-retry:v2:job-vector-second-failure')
  })

  it.each([
    { state: 'queued', outcomeUnknown: false },
    { state: 'running', outcomeUnknown: false },
    { state: 'retry_wait', outcomeUnknown: false },
    { state: 'failed', outcomeUnknown: true },
  ])('does not resend vector state $state, unknown=$outcomeUnknown', async ({ state, outcomeUnknown }) => {
    apiGet.mockImplementation(async (path: string) =>
      path.includes('/operations') ? { operations: [] } : {
        id: 'doc-vector', status: 'indexed', text_index_state: 'ready',
        vector_index_state: 'failed', vector_job_state: state,
        vector_job_id: 'job-vector', vector_outcome_unknown: outcomeUnknown,
      },
    )
    const { retryKnowledgeDocument } = await import('../knowledge')
    await expect(retryKnowledgeDocument('doc-vector')).rejects.toThrow('failed knowledge operation is unavailable')
    expect(apiPost).not.toHaveBeenCalled()
  })
})
