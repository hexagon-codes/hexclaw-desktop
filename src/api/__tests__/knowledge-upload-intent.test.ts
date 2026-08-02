import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

function uploadResult(id: string) {
  return {
    operation_id: `operation-${id}`,
    document_id: `doc-${id}`,
    job_id: `job-${id}`,
    text_index_state: 'pending',
    vector_index_state: 'disabled',
  }
}

function uploadCalls(): unknown[][] {
  return apiPost.mock.calls.filter((call) =>
    String(call[0]).startsWith('/api/v1/knowledge/documents'),
  )
}

function acknowledgementCalls(): unknown[][] {
  return apiPost.mock.calls.filter((call) => String(call[0]).includes('/knowledge/operations/'))
}

function requestKey(call: unknown[]): string {
  const options = call[2] as { headers: Record<string, string> }
  const key = options.headers['Idempotency-Key']
  if (!key) throw new Error('missing Idempotency-Key')
  return key
}

function file(bytes = 'durable upload bytes'): File {
  return new File([bytes], 'lesson.txt', {
    type: 'text/plain',
    lastModified: 1_726_531_200_000,
  })
}

describe('Knowledge upload content-addressed idempotency', () => {
  beforeEach(() => {
    apiGet.mockReset()
    apiPost.mockReset()
    localStorage.clear()
    vi.resetModules()
  })

  it('recomputes the same key after a network-unknown renderer restart', async () => {
    apiPost.mockRejectedValueOnce(new Error('Network error'))
    const firstModule = await import('../knowledge')
    await expect(firstModule.uploadDocument(file())).rejects.toThrow('Network error')
    const firstKey = requestKey(uploadCalls()[0]!)

    vi.resetModules()
    apiPost.mockResolvedValueOnce(uploadResult('recovered'))
    const restartedModule = await import('../knowledge')
    await restartedModule.uploadDocument(file())

    expect(requestKey(uploadCalls()[1]!)).toBe(firstKey)
    expect(firstKey).toMatch(/^knowledge-upload:v3:[0-9a-f]{64}$/)
    expect(localStorage.length).toBe(0)
  })

  it('uses the same immutable source identity after acknowledgement', async () => {
    const uploads = [uploadResult('first'), uploadResult('second')]
    apiPost.mockImplementation((path: string) =>
      path.startsWith('/api/v1/knowledge/documents') ? uploads.shift() : undefined,
    )
    const { uploadDocument } = await import('../knowledge')

    await uploadDocument(file())
    await uploadDocument(file())

    expect(requestKey(uploadCalls()[1]!)).toBe(requestKey(uploadCalls()[0]!))
  })

  it('does not alias different bytes with identical metadata', async () => {
    apiPost
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(uploadResult('different-content'))
    const { uploadDocument } = await import('../knowledge')

    await expect(uploadDocument(file('alpha'))).rejects.toThrow('Network error')
    await uploadDocument(file('bravo'))

    expect(requestKey(uploadCalls()[1]!)).not.toBe(requestKey(uploadCalls()[0]!))
  })

  it('exposes the source digest to the runtime projection without persisting it', async () => {
    apiPost.mockResolvedValueOnce(uploadResult('accepted'))
    const onIntent = vi.fn()
    const { uploadDocument } = await import('../knowledge')

    await uploadDocument(file(), undefined, onIntent)

    expect(onIntent).toHaveBeenCalledWith({
      idempotencyKey: expect.stringMatching(/^knowledge-upload:v3:[0-9a-f]{64}$/),
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(localStorage.length).toBe(0)
  })

  it('acknowledges only after the accepted response reaches the client boundary', async () => {
    apiPost.mockResolvedValueOnce(uploadResult('delivered')).mockResolvedValueOnce(undefined)
    const { uploadDocument } = await import('../knowledge')

    await expect(uploadDocument(file())).resolves.toMatchObject({
      operation_id: 'operation-delivered',
      document_id: 'doc-delivered',
    })

    expect(acknowledgementCalls()).toEqual([
      ['/api/v1/knowledge/operations/operation-delivered/ack?corpus_id=default'],
    ])
  })

  it('keeps an accepted upload successful when its best-effort acknowledgement is unknown', async () => {
    apiPost
      .mockResolvedValueOnce(uploadResult('ack-unknown'))
      .mockRejectedValueOnce(new Error('ack transport unknown'))
    const { uploadDocument } = await import('../knowledge')

    await expect(uploadDocument(file())).resolves.toMatchObject({
      operation_id: 'operation-ack-unknown',
      job_id: 'job-ack-unknown',
    })
  })

  it('re-acknowledges pending-response recovery projections without mutating the read result', async () => {
    const pending = {
      ...uploadResult('pending'),
      title: 'lesson.txt',
      display_name: 'lesson.txt',
      content_digest: 'a'.repeat(64),
      state: 'pending_response',
      stage: 'pending_response',
      terminal: false,
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
    }
    const queued = { ...pending, operation_id: 'operation-queued', state: 'queued' }
    apiGet.mockResolvedValueOnce({ operations: [pending, queued] })
    apiPost.mockRejectedValueOnce(new Error('ack transport unknown'))
    const { listKnowledgeOperations } = await import('../knowledge')

    await expect(listKnowledgeOperations()).resolves.toEqual([pending, queued])
    expect(acknowledgementCalls()).toEqual([
      ['/api/v1/knowledge/operations/operation-pending/ack?corpus_id=default'],
    ])
  })
})
