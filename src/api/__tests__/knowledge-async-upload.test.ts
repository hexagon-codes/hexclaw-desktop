import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))

vi.mock('../client', () => ({
  apiGet: vi.fn(),
  apiPost,
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

describe('Knowledge asynchronous document upload contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    expect(digest).toHaveBeenCalledTimes(1)
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
    apiPost.mockImplementationOnce(() => firstAccepted).mockResolvedValueOnce(uploadResponse('two'))
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
    await vi.waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    const second = uploadDocument(secondFile)

    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()
    expect(digest).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledTimes(1)

    acceptFirst(uploadResponse('one'))
    await first
    await second
    expect(digest).toHaveBeenCalledTimes(2)
    expect(apiPost).toHaveBeenCalledTimes(2)
  })

  it('posts a 57,313,616-byte PDF once to the owner-scoped documents endpoint', async () => {
    apiPost.mockResolvedValueOnce({
      document_id: 'doc-57m',
      job_id: 'job-57m',
      text_index_state: 'pending',
      vector_index_state: 'pending',
    })
    const { uploadDocument } = await import('../knowledge')
    const file = new File(['%PDF-1.7'], '六上.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: 57_313_616 })

    const result = await uploadDocument(file)

    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/documents?user_id=desktop-user',
      expect.any(FormData),
      {
        headers: { 'Idempotency-Key': expect.stringMatching(/^knowledge-upload:/) },
        timeout: false,
      },
    )
    const form = apiPost.mock.calls[0]?.[1] as FormData
    expect(form.get('corpus_id')).toBe('default')
    expect(form.get('file')).toBe(file)
    expect(result).toEqual({
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
      send() {
        setTimeout(() => this.listeners.error?.(), 100)
      }
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
    document_id: `doc-${id}`,
    job_id: `job-${id}`,
    text_index_state: 'pending' as const,
    vector_index_state: 'disabled' as const,
  }
}
