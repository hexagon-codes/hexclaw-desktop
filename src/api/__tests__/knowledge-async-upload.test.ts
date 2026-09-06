import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

describe('Knowledge asynchronous document upload contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGet.mockResolvedValue({ operations: [] })
    localStorage.clear()
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('publishes one 512 MiB batch budget for every upload entry point', async () => {
    const { MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES } = await import('../knowledge')

    expect(MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES).toBe(512 * 1024 * 1024)
  })

  it('hashes the browser ArrayBuffer without allocating a second full-file Uint8Array', async () => {
    apiPost.mockResolvedValueOnce({
      operation_id: 'operation-zero-copy',
      document_id: 'doc-zero-copy',
      job_id: 'job-zero-copy',
      text_index_state: 'pending',
      vector_index_state: 'disabled',
    })
    const sourceBuffer = new ArrayBuffer(1024)
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).buffer)
    vi.stubGlobal('crypto', {
      subtle: { digest },
      randomUUID: () => 'zero-copy',
    })
    const file = new File(['placeholder'], 'zero-copy.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: vi.fn().mockResolvedValue(sourceBuffer),
    })
    const { uploadDocument } = await import('../knowledge')

    await uploadDocument(file)

    // One digest attests the immutable source and one derives the semantic
    // idempotency identity from that digest plus filename/media metadata.
    expect(digest).toHaveBeenCalledTimes(2)
    const digestInput = digest.mock.calls[0]?.[1] as ArrayBufferView
    expect(ArrayBuffer.isView(digestInput)).toBe(true)
    expect(digestInput.buffer).toBe(sourceBuffer)
    expect(digestInput.byteOffset).toBe(0)
    expect(digestInput.byteLength).toBe(sourceBuffer.byteLength)
  })

  it('serializes hashing and upload so only one full source is resident at a time', async () => {
    let acceptFirst!: (value: ReturnType<typeof uploadResponse>) => void
    const firstAccepted = new Promise<ReturnType<typeof uploadResponse>>((resolve) => {
      acceptFirst = resolve
    })
    let uploadCalls = 0
    apiPost.mockImplementation((path: string) => {
      if (path.includes('/knowledge/operations/')) return undefined
      uploadCalls += 1
      return uploadCalls === 1 ? firstAccepted : uploadResponse('two')
    })
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).buffer)
    vi.stubGlobal('crypto', {
      subtle: { digest },
      randomUUID: () => Math.random().toString(36),
    })
    const { uploadDocument } = await import('../knowledge')

    const firstFile = new File(['first'], 'first.txt', { type: 'text/plain' })
    const secondFile = new File(['second'], 'second.txt', { type: 'text/plain' })
    const firstRead = vi.fn(() => Promise.resolve(new ArrayBuffer(5)))
    const secondRead = vi.fn(() => Promise.resolve(new ArrayBuffer(6)))
    Object.defineProperty(firstFile, 'arrayBuffer', {
      configurable: true,
      value: firstRead,
    })
    Object.defineProperty(secondFile, 'arrayBuffer', {
      configurable: true,
      value: secondRead,
    })

    const first = uploadDocument(firstFile)
    await vi.waitFor(() => expect(uploadCalls).toBe(1))
    const second = uploadDocument(secondFile)

    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()
    expect(digest).toHaveBeenCalledTimes(2)
    expect(uploadCalls).toBe(1)

    acceptFirst(uploadResponse('one'))
    await first
    await second
    expect(digest).toHaveBeenCalledTimes(4)
    expect(uploadCalls).toBe(2)
  })

  it('posts a 57,313,616-byte PDF once to the owner-scoped documents endpoint', async () => {
    apiPost.mockResolvedValueOnce({
      operation_id: 'operation-57m',
      document_id: 'doc-57m',
      job_id: 'job-57m',
      text_index_state: 'pending',
      vector_index_state: 'pending',
    })
    const { uploadDocument } = await import('../knowledge')
    const file = new File(['%PDF-1.7'], '六上.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: 57_313_616 })

    const result = await uploadDocument(file)

    const documentCalls = apiPost.mock.calls.filter((call) =>
      String(call[0]).startsWith('/api/v1/knowledge/documents'),
    )
    expect(documentCalls).toHaveLength(1)
    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents?user_id=desktop-user',
      expect.any(FormData),
      {
        headers: { 'Idempotency-Key': expect.stringMatching(/^knowledge-upload:/) },
        timeout: false,
        expectedStatus: 202,
      },
    )
    const form = documentCalls[0]?.[1] as FormData
    expect(form.get('corpus_id')).toBe('default')
    expect(form.get('file')).toBe(file)
    expect(result).toEqual({
      operation_id: 'operation-57m',
      document_id: 'doc-57m',
      job_id: 'job-57m',
      text_index_state: 'pending',
      vector_index_state: 'pending',
    })
  })

  it('sends the same asynchronous contract and Idempotency-Key on the progress/XHR path', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body?: FormData }> = []
    class FakeXMLHttpRequest {
      status = 202
      responseText = JSON.stringify({
        operation_id: 'operation-xhr',
        document_id: 'doc-xhr',
        job_id: 'job-xhr',
        text_index_state: 'pending',
        vector_index_state: 'disabled',
      })
      private url = ''
      private headers: Record<string, string> = {}
      private listeners: Record<string, () => void> = {}
      upload = { addEventListener: vi.fn() }
      open(_method: string, url: string) {
        this.url = url
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value
      }
      addEventListener(name: string, listener: () => void) {
        this.listeners[name] = listener
      }
      send(body: FormData) {
        requests.push({ url: this.url, headers: this.headers, body })
        this.listeners.load?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
    const { uploadDocument } = await import('../knowledge')
    const file = new File(['%PDF-'], 'progress.pdf', { type: 'application/pdf' })

    const result = await uploadDocument(file, vi.fn())

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/api/v1/knowledge/documents?user_id=desktop-user')
    expect(requests[0]?.headers['Idempotency-Key']).toMatch(/^knowledge-upload:/)
    expect(requests[0]?.body?.get('corpus_id')).toBe('default')
    expect(requests[0]?.body?.get('file')).toBe(file)
    expect(result.job_id).toBe('job-xhr')
  })

  it('[bug] aborts the progress XHR through the public uploadDocument call chain', async () => {
    let constructed = 0
    let abortCalls = 0
    class FakeAbortableXMLHttpRequest {
      status = 0
      responseText = ''
      timeout = 0
      private listeners: Record<string, () => void> = {}
      upload = { addEventListener: vi.fn() }
      constructor() {
        constructed += 1
      }
      open() {}
      setRequestHeader() {}
      addEventListener(name: string, listener: () => void) {
        this.listeners[name] = listener
      }
      send() {}
      abort() {
        abortCalls += 1
        this.listeners.abort?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeAbortableXMLHttpRequest)
    const { uploadDocument } = await import('../knowledge')
    const controller = new AbortController()
    const pending = uploadDocument(
      new File(['cancel me'], 'cancel.pdf', { type: 'application/pdf' }),
      vi.fn(),
      undefined,
      { signal: controller.signal },
    )

    await vi.waitFor(() => expect(constructed).toBe(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(abortCalls).toBe(1)
  })
})

function uploadResponse(id: string) {
  return {
    operation_id: `operation-${id}`,
    document_id: `doc-${id}`,
    job_id: `job-${id}`,
    text_index_state: 'pending' as const,
    vector_index_state: 'disabled' as const,
  }
}
