/**
 * Chain D: Knowledge Base -> Upload -> Search
 *
 * Tests the knowledge base document lifecycle: list, upload, search, delete,
 * content retrieval with fallback, and error detection helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────

const { mockApiGet, mockApiPost, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiDelete: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiDelete: mockApiDelete,
  api: {},
  apiSSE: vi.fn(),
  apiWebSocket: vi.fn(),
  fromNativeError: vi.fn(),
  createApiError: vi.fn(),
  isRetryable: vi.fn(),
  getErrorMessage: vi.fn(),
}))

vi.mock('@/utils/errors', () => ({
  fromHttpStatus: vi.fn((status: number) => ({
    code: 'SERVER_ERROR',
    message: `HTTP ${status} Error`,
    status,
  })),
  fromNativeError: vi.fn((e: unknown) => ({
    code: 'UNKNOWN',
    message: e instanceof Error ? e.message : String(e),
    status: typeof e === 'object' && e !== null ? (e as Record<string, unknown>).status : undefined,
  })),
}))

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:9870' },
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain D: Knowledge Base -> Upload -> Search', () => {
  it('D1: getDocuments returns document list via GET /api/v1/knowledge/documents', async () => {
    const docs = {
      documents: [
        { id: 'doc-1', title: 'API Guide', chunk_count: 5, created_at: '2026-01-01' },
        { id: 'doc-2', title: 'Tutorial', chunk_count: 3, created_at: '2026-01-02' },
      ],
      total: 2,
    }
    mockApiGet.mockResolvedValueOnce(docs)

    const { getDocuments } = await import('@/api/knowledge')
    const result = await getDocuments()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/knowledge/documents')
    expect(result.documents).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.documents[0]!.title).toBe('API Guide')
  })

  it('D2: uploadDocument posts to /api/v1/knowledge/upload (single path, no fallback)', async () => {
    // For uploadDocument without onProgress, it uses apiPost
    mockApiPost.mockResolvedValueOnce({
      id: 'doc-new',
      title: 'uploaded.pdf',
      chunk_count: 10,
      created_at: '2026-01-01',
    })

    const { uploadDocument } = await import('@/api/knowledge')
    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const result = await uploadDocument(file)

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/upload',
      expect.any(FormData),
    )
    expect(result.id).toBe('doc-new')
    expect(result.chunk_count).toBe(10)
  })

  it('D3: searchKnowledge sends query and returns results via POST /api/v1/knowledge/search', async () => {
    mockApiPost.mockResolvedValueOnce({
      result: [
        { content: 'API key setup', score: 0.92, doc_id: 'doc-1', doc_title: 'API Guide', chunk_index: 0 },
        { content: 'Bearer token auth', score: 0.85, doc_id: 'doc-1', doc_title: 'API Guide', chunk_index: 1 },
      ],
    })

    const { searchKnowledge } = await import('@/api/knowledge')
    const result = await searchKnowledge('API authentication', 5)

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', {
      query: 'API authentication',
      top_k: 5,
    })
    expect(result.result).toHaveLength(2)
    expect(result.result[0]!.content).toBe('API key setup')
    expect(result.result[0]!.score).toBe(0.92)
  })

  it('D3b: searchKnowledge normalizes "results" key to "result"', async () => {
    // Some backends return "results" instead of "result"
    mockApiPost.mockResolvedValueOnce({
      results: [
        { content: 'Chunk data', score: 0.8 },
      ],
    })

    const { searchKnowledge } = await import('@/api/knowledge')
    const result = await searchKnowledge('test')

    expect(result.result).toHaveLength(1)
    expect(result.result[0]!.content).toBe('Chunk data')
  })

  it('D3c: searchKnowledge defaults top_k to 3', async () => {
    mockApiPost.mockResolvedValueOnce({ result: [] })

    const { searchKnowledge } = await import('@/api/knowledge')
    await searchKnowledge('query')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', {
      query: 'query',
      top_k: 3,
    })
  })

  it('D4: deleteDocument calls DELETE with correct ID', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteDocument } = await import('@/api/knowledge')
    const result = await deleteDocument('doc-123')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc-123')
    expect(result.message).toBe('deleted')
  })

  it('D4b: deleteDocument URL-encodes special characters in ID', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteDocument } = await import('@/api/knowledge')
    await deleteDocument('doc/special&id')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc%2Fspecial%26id')
  })

  it('D5: getDocumentContent tries detail API first, falls back to search', async () => {
    // First call: getDocument (detail API) fails
    mockApiGet.mockRejectedValueOnce(new Error('Not found'))

    // Second call: searchKnowledge fallback
    mockApiPost.mockResolvedValueOnce({
      result: [
        { content: 'Chunk 1', score: 0.9, doc_id: 'doc-1', doc_title: 'Test Doc', chunk_index: 0 },
        { content: 'Chunk 2', score: 0.8, doc_id: 'doc-1', doc_title: 'Test Doc', chunk_index: 1 },
      ],
    })

    const { getDocumentContent } = await import('@/api/knowledge')
    const content = await getDocumentContent({
      id: 'doc-1',
      title: 'Test Doc',
      chunk_count: 2,
      created_at: '2026-01-01',
    })

    // Should have assembled content from chunks
    expect(content).toContain('Chunk 1')
    expect(content).toContain('Chunk 2')
  })

  it('D5b: getDocumentContent returns detail content when available', async () => {
    mockApiGet.mockResolvedValueOnce({
      id: 'doc-1',
      title: 'Test Doc',
      content: 'Full document content here',
      chunk_count: 2,
      created_at: '2026-01-01',
    })

    const { getDocumentContent } = await import('@/api/knowledge')
    const content = await getDocumentContent({
      id: 'doc-1',
      title: 'Test Doc',
      chunk_count: 2,
      created_at: '2026-01-01',
    })

    expect(content).toBe('Full document content here')
    // Should NOT fall back to search
    expect(mockApiPost).not.toHaveBeenCalled()
  })

  it('D6: isKnowledgeUploadEndpointMissing detects 404/405 correctly', async () => {
    const { isKnowledgeUploadEndpointMissing } = await import('@/api/knowledge')

    // 404 status
    expect(isKnowledgeUploadEndpointMissing({ status: 404, message: 'Not found' })).toBe(true)
    // 405 status
    expect(isKnowledgeUploadEndpointMissing({ status: 405, message: 'Method not allowed' })).toBe(true)
    // statusCode alias
    expect(isKnowledgeUploadEndpointMissing({ statusCode: 404 })).toBe(true)
    // Error instance with 404 in message
    expect(isKnowledgeUploadEndpointMissing(new Error('HTTP 404 Error'))).toBe(true)
    // Message containing known Chinese text
    expect(isKnowledgeUploadEndpointMissing(new Error('未提供知识库上传接口'))).toBe(true)
    expect(isKnowledgeUploadEndpointMissing(new Error('未启用知识库'))).toBe(true)
    // Normal error should NOT be flagged
    expect(isKnowledgeUploadEndpointMissing(new Error('Network timeout'))).toBe(false)
    // 200 status should NOT be flagged
    expect(isKnowledgeUploadEndpointMissing({ status: 200, message: 'OK' })).toBe(false)
  })

  it('D7: isKnowledgeUploadUnsupportedFormat detects 415/422 correctly', async () => {
    const { isKnowledgeUploadUnsupportedFormat } = await import('@/api/knowledge')

    // 415 Unsupported Media Type
    expect(isKnowledgeUploadUnsupportedFormat({ status: 415, message: 'Unsupported' })).toBe(true)
    // 422 Unprocessable Entity
    expect(isKnowledgeUploadUnsupportedFormat({ status: 422, message: 'Bad format' })).toBe(true)
    // Error with keyword
    expect(isKnowledgeUploadUnsupportedFormat(new Error('Unsupported file type'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('不支持该格式'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('文件格式错误'))).toBe(true)
    // 400 with format keyword
    expect(isKnowledgeUploadUnsupportedFormat({ status: 400, message: 'Invalid file type' })).toBe(true)
    // 400 without format keyword should NOT be flagged
    expect(isKnowledgeUploadUnsupportedFormat({ status: 400, message: 'Bad request' })).toBe(false)
    // Normal error should NOT be flagged
    expect(isKnowledgeUploadUnsupportedFormat(new Error('Server error'))).toBe(false)
  })

  it('D8: addDocument posts to /api/v1/knowledge/documents', async () => {
    mockApiPost.mockResolvedValueOnce({
      id: 'doc-new',
      title: 'Manual Entry',
      chunk_count: 2,
      created_at: '2026-01-01',
    })

    const { addDocument } = await import('@/api/knowledge')
    const result = await addDocument('Manual Entry', 'Some content text', 'manual')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/documents', {
      title: 'Manual Entry',
      content: 'Some content text',
      source: 'manual',
    })
    expect(result.id).toBe('doc-new')
  })

  it('D9: reindexDocument triggers reindex via POST', async () => {
    mockApiPost.mockResolvedValueOnce({ status: 'ok' })

    const { reindexDocument } = await import('@/api/knowledge')
    const result = await reindexDocument('doc-1')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc-1/reindex')
    expect(result.status).toBe('ok')
  })
})
