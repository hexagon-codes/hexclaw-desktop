import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet: vi.fn(),
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

function uploadResult(id: string) {
  return {
    document_id: `doc-${id}`,
    job_id: `job-${id}`,
    text_index_state: 'pending',
    vector_index_state: 'disabled',
  }
}

function requestKey(call: unknown[]): string {
  const options = call[2] as { headers: Record<string, string> }
  const key = options.headers['Idempotency-Key']
  if (!key) throw new Error('missing Idempotency-Key')
  return key
}

function sameReselectedFile(): File {
  return new File(['durable upload bytes'], 'lesson.txt', {
    type: 'text/plain',
    lastModified: 1_726_531_200_000,
  })
}

describe('Knowledge upload intent idempotency', () => {
  beforeEach(() => {
    apiPost.mockReset()
    localStorage.clear()
    vi.resetModules()
  })

  it('persists the key before sending and reuses it after a network-unknown response', async () => {
    let persistedDuringRequest = ''
    apiPost.mockImplementationOnce((_path, _body, options) => {
      const key = (options as { headers: Record<string, string> }).headers['Idempotency-Key']
      persistedDuringRequest = localStorage.getItem('hexclaw:knowledge-upload-intents:v2') || ''
      expect(persistedDuringRequest).toContain(key)
      expect(persistedDuringRequest).toMatch(/[0-9a-f]{64}/)
      return Promise.reject(new Error('Network error'))
    })
    const firstModule = await import('../knowledge')
    await expect(firstModule.uploadDocument(sameReselectedFile())).rejects.toThrow('Network error')
    const firstKey = requestKey(apiPost.mock.calls[0]!)

    // Simulate a renderer refresh: module memory is gone, durable browser
    // storage remains, and the user reselects the same immutable file intent.
    vi.resetModules()
    apiPost.mockResolvedValueOnce(uploadResult('recovered'))
    const refreshedModule = await import('../knowledge')
    await refreshedModule.uploadDocument(sameReselectedFile())
    const recoveredKey = requestKey(apiPost.mock.calls[1]!)

    expect(recoveredKey).toBe(firstKey)
    expect(localStorage.getItem('hexclaw:knowledge-upload-intents:v2')).toBeNull()
  })

  it('releases an acknowledged intent so an explicit later upload gets a new generation key', async () => {
    apiPost
      .mockResolvedValueOnce(uploadResult('first'))
      .mockResolvedValueOnce(uploadResult('second'))
    const { uploadDocument } = await import('../knowledge')

    await uploadDocument(sameReselectedFile())
    await uploadDocument(sameReselectedFile())

    expect(requestKey(apiPost.mock.calls[1]!)).not.toBe(requestKey(apiPost.mock.calls[0]!))
  })

  it('releases a definitively rejected conflict but retains transport-unknown failures', async () => {
    const conflict = Object.assign(new Error('idempotency conflict'), { status: 409 })
    apiPost.mockRejectedValueOnce(conflict)
    const { uploadDocument } = await import('../knowledge')

    await expect(uploadDocument(sameReselectedFile())).rejects.toThrow('idempotency conflict')

    expect(localStorage.getItem('hexclaw:knowledge-upload-intents:v2')).toBeNull()
  })

  it('does not reuse an unknown-response key for different bytes with identical file metadata', async () => {
    apiPost
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(uploadResult('different-content'))
    const { uploadDocument } = await import('../knowledge')
    const metadata = {
      type: 'text/plain',
      lastModified: 1_726_531_200_000,
    }

    await expect(uploadDocument(new File(['alpha'], 'same.txt', metadata))).rejects.toThrow(
      'Network error',
    )
    await uploadDocument(new File(['bravo'], 'same.txt', metadata))

    expect(requestKey(apiPost.mock.calls[1]!)).not.toBe(requestKey(apiPost.mock.calls[0]!))
  })
})
