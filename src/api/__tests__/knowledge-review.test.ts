import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiDelete,
}))

describe('Knowledge API upload behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the documents upload endpoint when the legacy path returns 404', async () => {
    apiPost
      .mockRejectedValueOnce(new Error('请求的资源不存在'))
      .mockResolvedValueOnce({
        id: 'doc-1',
        title: 'alpha.pdf',
        chunk_count: 2,
        created_at: '2026-01-01T00:00:00Z',
      })

    const { uploadDocument } = await import('../knowledge')
    const file = new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })
    const result = await uploadDocument(file)

    expect(apiPost).toHaveBeenNthCalledWith(1, '/api/v1/knowledge/upload', expect.any(FormData))
    expect(apiPost).toHaveBeenNthCalledWith(2, '/api/v1/knowledge/documents/upload', expect.any(FormData))
    expect(result.id).toBe('doc-1')
  })

  it('retries xhr uploads on the alternate endpoint after a 404', async () => {
    const progress = vi.fn()
    const requests: string[] = []

    class MockXHR {
      status = 0
      responseText = ''
      url = ''
      upload = {
        addEventListener: vi.fn((event: string, cb: (e: ProgressEvent<EventTarget>) => void) => {
          if (event === 'progress') {
            this.onProgress = cb
          }
        }),
      }

      private onLoad: (() => void) | null = null
      private onError: (() => void) | null = null
      private onAbort: (() => void) | null = null
      private onProgress: ((e: ProgressEvent<EventTarget>) => void) | null = null

      open(_method: string, url: string) {
        this.url = url
        requests.push(url)
      }

      addEventListener(event: string, cb: () => void) {
        if (event === 'load') this.onLoad = cb
        if (event === 'error') this.onError = cb
        if (event === 'abort') this.onAbort = cb
      }

      send() {
        if (this.url.endsWith('/api/v1/knowledge/upload')) {
          this.status = 404
          this.responseText = ''
          this.onLoad?.()
          return
        }

        this.status = 200
        this.responseText = JSON.stringify({
          id: 'doc-2',
          title: 'beta.pdf',
          chunk_count: 1,
          created_at: '2026-01-02T00:00:00Z',
        })
        this.onProgress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent<EventTarget>)
        this.onLoad?.()
      }
    }

    vi.stubGlobal('XMLHttpRequest', MockXHR)

    const { uploadDocument } = await import('../knowledge')
    const file = new File(['beta'], 'beta.pdf', { type: 'application/pdf' })
    const result = await uploadDocument(file, progress)

    expect(requests).toEqual([
      'http://localhost:16060/api/v1/knowledge/upload',
      'http://localhost:16060/api/v1/knowledge/documents/upload',
    ])
    expect(progress).toHaveBeenCalledWith(100)
    expect(result.id).toBe('doc-2')
  })

  it('turns add document 405 errors into a knowledge-disabled hint', async () => {
    apiPost.mockRejectedValueOnce({ status: 405, message: 'Method Not Allowed' })

    const { addDocument } = await import('../knowledge')

    await expect(addDocument('Spec', 'content')).rejects.toThrow('知识库暂不可用')
  })

  it('detects backend unsupported-format responses so the UI can fall back to local parsing', async () => {
    const { isKnowledgeUploadUnsupportedFormat } = await import('../knowledge')

    expect(isKnowledgeUploadUnsupportedFormat({ status: 415, message: 'Unsupported Media Type' })).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('不支持的文件格式'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('网络错误'))).toBe(false)
  })
})
