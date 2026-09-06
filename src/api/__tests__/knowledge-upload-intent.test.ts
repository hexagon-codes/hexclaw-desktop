import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

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

function cancelledOperation(id: string, updatedAt = '2026-09-01T00:00:00Z') {
  return {
    ...uploadResult(id),
    title: 'lesson.txt',
    display_name: 'lesson.txt',
    content_digest: createHash('sha256').update('durable upload bytes').digest('hex'),
    state: 'cancelled',
    stage: 'extracting',
    terminal: true,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

describe('Knowledge upload content-addressed idempotency', () => {
  beforeEach(() => {
    apiGet.mockReset()
    apiGet.mockResolvedValue({ operations: [] })
    apiPost.mockReset()
    localStorage.clear()
    vi.resetModules()
  })

  it('recomputes the same key after a network-unknown renderer restart', async () => {
    const cancelled = cancelledOperation('cancelled')
    apiGet.mockResolvedValue({ operations: [cancelled] })
    apiPost.mockRejectedValueOnce(new Error('Network error'))
    const firstModule = await import('../knowledge')
    await expect(firstModule.uploadDocument(file())).rejects.toThrow('Network error')
    const firstKey = requestKey(uploadCalls()[0]!)

    vi.resetModules()
    apiGet.mockResolvedValue({
      operations: [
        {
          ...cancelled,
          operation_id: 'operation-recovering',
          job_id: 'job-recovering',
          state: 'running',
          terminal: false,
          updated_at: '2026-09-02T00:00:00Z',
        },
        cancelled,
      ],
    })
    apiPost.mockResolvedValueOnce(uploadResult('recovered'))
    const restartedModule = await import('../knowledge')
    await restartedModule.uploadDocument(file())

    expect(requestKey(uploadCalls()[1]!)).toBe(firstKey)
    expect(firstKey).toMatch(/^knowledge-upload:v3:[0-9a-f]{64}$/)
    expect(localStorage.length).toBe(0)
  })

  it('uses the same immutable source identity after acknowledgement', async () => {
    apiPost.mockImplementation((path: string) =>
      path.startsWith('/api/v1/knowledge/documents') ? uploadResult('accepted') : undefined,
    )
    const { uploadDocument } = await import('../knowledge')

    await uploadDocument(file())
    await uploadDocument(file())

    expect(requestKey(uploadCalls()[1]!)).toBe(requestKey(uploadCalls()[0]!))
    const originalKey = requestKey(uploadCalls()[0]!)
    const source = file()
    const digest = createHash('sha256').update('durable upload bytes').digest('hex')
    expect(originalKey).toBe(
      `knowledge-upload:v3:${createHash('sha256')
        .update(JSON.stringify([source.name, source.size, source.type, digest]))
        .digest('hex')}`,
    )

    const cancelled = cancelledOperation('latest-cancelled', '2026-09-02T00:00:00Z')
    const history = [
      {
        ...cancelledOperation('older-cancelled'),
        updated_at: '2026-09-06T00:00:00Z',
      },
      { ...cancelled, job_id: 'other-name', display_name: 'other.txt' },
      { ...cancelled, job_id: 'other-bytes', content_digest: 'a'.repeat(64) },
      cancelled,
    ]
    apiGet.mockResolvedValue({ operations: history })
    await uploadDocument(file())
    const revivedKey = requestKey(uploadCalls()[2]!)
    expect(revivedKey).not.toBe(originalKey)

    apiGet.mockResolvedValue({
      operations: [
        {
          ...cancelled,
          operation_id: 'operation-revived',
          job_id: 'job-revived',
          state: 'succeeded',
          updated_at: '2026-09-03T00:00:00Z',
        },
        ...[...history].reverse(),
      ],
    })
    vi.resetModules()
    const restartedModule = await import('../knowledge')
    await restartedModule.uploadDocument(file())
    expect(requestKey(uploadCalls()[3]!)).toBe(revivedKey)

    apiGet.mockResolvedValue({
      operations: [...history, cancelledOperation('revived', '2026-09-04T00:00:00Z')],
    })
    await restartedModule.uploadDocument(file())
    expect(requestKey(uploadCalls()[4]!)).not.toBe(revivedKey)
    expect(localStorage.length).toBe(0)
  })

  it('does not alias different bytes with identical metadata', async () => {
    apiGet.mockResolvedValue({
      operations: [
        {
          ...cancelledOperation('alpha-cancelled'),
          content_digest: createHash('sha256').update('alpha').digest('hex'),
        },
      ],
    })
    apiPost
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(uploadResult('different-content'))
    const { uploadDocument } = await import('../knowledge')

    await expect(uploadDocument(file('alpha'))).rejects.toThrow('Network error')
    await uploadDocument(file('bravo'))

    expect(requestKey(uploadCalls()[1]!)).not.toBe(requestKey(uploadCalls()[0]!))
    const bravo = file('bravo')
    expect(requestKey(uploadCalls()[1]!)).toBe(
      `knowledge-upload:v3:${createHash('sha256')
        .update(
          JSON.stringify([
            bravo.name,
            bravo.size,
            bravo.type,
            createHash('sha256').update('bravo').digest('hex'),
          ]),
        )
        .digest('hex')}`,
    )
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
