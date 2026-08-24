import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
}))

vi.mock('../client', () => ({ apiGet, apiPost, apiDelete }))
vi.mock('@/config/env', () => ({ OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@/utils/errors', () => ({
  fromHttpStatus: vi.fn((s: number) => ({ message: `HTTP ${s}` })),
  fromNativeError: vi.fn((e: unknown) => ({ status: 500, message: String(e) })),
}))

import {
  getDocuments, getDocument, getDocumentContent, addDocument, deleteDocument,
  searchKnowledge, reindexDocument, isKnowledgeUploadEndpointMissing, isKnowledgeUploadUnsupportedFormat,
} from '../knowledge'

describe('knowledge API', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── getDocuments ───
  it('calls apiGet with correct path', async () => {
    apiGet.mockResolvedValueOnce({ documents: [], total: 0 })
    await getDocuments()
    expect(apiGet).toHaveBeenCalledWith('/api/v1/knowledge/documents')
  })

  // ─── getDocument ───
  it('calls apiGet with encoded document ID', async () => {
    apiGet.mockResolvedValueOnce({ id: 'd1', title: 'Test', content: 'body' })
    await getDocument('doc/with spaces')
    expect(apiGet).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc%2Fwith%20spaces')
  })

  // ─── getDocumentContent ───
  it('returns content from getDocument when available', async () => {
    apiGet.mockResolvedValueOnce({ id: 'd1', title: 'Test', content: 'full content', chunk_count: 2 })
    const content = await getDocumentContent({ id: 'd1', title: 'Test', chunk_count: 2, created_at: '' })
    expect(content).toBe('full content')
  })

  it('falls back to search when getDocument fails', async () => {
    apiGet.mockRejectedValueOnce(new Error('404'))
    apiPost.mockResolvedValueOnce({
      result: [
        { content: 'chunk1', doc_id: 'd1', chunk_index: 0, score: 0.9 },
        { content: 'chunk2', doc_id: 'd1', chunk_index: 1, score: 0.8 },
      ],
    })
    const content = await getDocumentContent({ id: 'd1', title: 'Test', chunk_count: 2, created_at: '' })
    expect(content).toBe('chunk1\n\nchunk2')
  })

  // BUG-20260718（§15）：detail 与 search 都失败时抛错，不再把故障伪装成空串。
  it('throws when both detail and search fail (fault, not empty doc)', async () => {
    apiGet.mockRejectedValueOnce(new Error('404'))
    apiPost.mockRejectedValueOnce(new Error('500'))
    await expect(
      getDocumentContent({ id: 'd1', title: 'Test', chunk_count: 1, created_at: '' }),
    ).rejects.toThrow()
  })

  it('returns empty string for a genuinely empty document (both paths succeed, no content)', async () => {
    apiGet.mockResolvedValueOnce({ id: 'd1', title: 'Test', content: '' })
    apiPost.mockResolvedValueOnce({ result: [] })
    const content = await getDocumentContent({ id: 'd1', title: 'Test', chunk_count: 1, created_at: '' })
    expect(content).toBe('')
  })

  // ─── addDocument ───
  it('calls apiPost with title, content, source', async () => {
    apiPost.mockResolvedValueOnce({ id: 'd1', title: 'T', chunk_count: 1, created_at: '' })
    await addDocument('Title', 'Body', 'chat')
    expect(apiPost).toHaveBeenCalledWith('/api/v1/knowledge/documents', { title: 'Title', content: 'Body', source: 'chat' })
  })

  // ─── deleteDocument ───
  it('calls apiDelete with encoded ID', async () => {
    await deleteDocument('doc-123')
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc-123')
  })

  // ─── searchKnowledge ───
  it('normalizes array results', async () => {
    apiPost.mockResolvedValueOnce({
      result: [{ content: 'hit1', score: 0.9 }, { content: 'hit2', score: 0.7 }],
    })
    const { result } = await searchKnowledge('query', 5)
    expect(result).toHaveLength(2)
    expect(result[0]!.content).toBe('hit1')
  })

  it('preserves textbook lineage fields and query embedding receipts', async () => {
    apiPost.mockResolvedValueOnce({
      results: [
        {
          content: '5 m 红绸带平均分给 6 名女生',
          score: 0.98,
          doc_id: 'document-math-1',
          document_generation: 3,
          revision_id: 'revision-math-1',
          doc_title: '义务教育教科书·数学五年级下册',
          source: 'upload',
          chunk_id: 'chunk-math-1',
          chunk_index: 8,
          chunk_count: 120,
          page_start: 54,
          page_end: 57,
          source_digest: '5'.repeat(64),
          citation_digest: '6'.repeat(64),
          source_offset_start: 1024,
          source_offset_end: 1096,
        },
      ],
      query_receipts: [
        {
          operation: 'query_embedding',
          status: 'succeeded',
          provider_id: 'ollama',
          provider_name: 'Ollama',
          model: 'qwen3-embedding',
          profile_id: 'embedding-local-1',
          profile_config_hash: '7'.repeat(64),
          dimension: 1024,
          revision_id: 'revision-math-1',
          query_digest: `sha256:${'8'.repeat(64)}`,
        },
      ],
    })

    const response = await searchKnowledge('红绸带平均分', 3)

    expect(response.result[0]).toMatchObject({
      document_generation: 3,
      revision_id: 'revision-math-1',
      page_start: 54,
      page_end: 57,
      source_digest: '5'.repeat(64),
      citation_digest: '6'.repeat(64),
      source_offset_start: 1024,
      source_offset_end: 1096,
    })
    expect(response.query_receipts).toEqual([
      expect.objectContaining({
        operation: 'query_embedding',
        profile_config_hash: '7'.repeat(64),
        revision_id: 'revision-math-1',
      }),
    ])
  })

  it('keeps legacy search responses compatible with an empty receipt exact-set', async () => {
    apiPost.mockResolvedValueOnce({ results: [{ content: 'legacy hit', score: 0.5 }] })

    await expect(searchKnowledge('legacy query')).resolves.toMatchObject({
      result: [{ content: 'legacy hit', score: 0.5 }],
      query_receipts: [],
    })
  })

  it('normalizes string result into single-item array', async () => {
    apiPost.mockResolvedValueOnce({ result: 'plain text result' })
    const { result } = await searchKnowledge('query')
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('plain text result')
    expect(result[0]!.score).toBe(1)
  })

  it('returns empty array for undefined payload', async () => {
    apiPost.mockResolvedValueOnce({})
    const { result } = await searchKnowledge('query')
    expect(result).toEqual([])
  })

  it('omits filter fields when no filter given (backward compatible body)', async () => {
    apiPost.mockResolvedValueOnce({ results: [] })
    await searchKnowledge('query', 5)
    expect(apiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', { query: 'query', top_k: 5 })
  })

  it('passes metadata filter through to the request body', async () => {
    apiPost.mockResolvedValueOnce({ results: [] })
    await searchKnowledge('query', 5, {
      sourceTypes: ['agent', 'upload'],
      sources: ['https://x'],
      createdAfter: '2026-06-15',
      createdBefore: '2026-06-25',
    })
    expect(apiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', {
      query: 'query',
      top_k: 5,
      source_types: ['agent', 'upload'],
      sources: ['https://x'],
      created_after: '2026-06-15',
      created_before: '2026-06-25',
    })
  })

  it('drops empty filter arrays/strings (no spurious filter keys)', async () => {
    apiPost.mockResolvedValueOnce({ results: [] })
    await searchKnowledge('query', 3, { sourceTypes: [], createdAfter: '' })
    expect(apiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', { query: 'query', top_k: 3 })
  })

  // ─── reindexDocument ───
  it('calls apiPost with correct path', async () => {
    apiPost.mockResolvedValueOnce({ status: 'ok' })
    await reindexDocument('doc-123')
    expect(apiPost).toHaveBeenCalledWith('/api/v1/knowledge/documents/doc-123/reindex')
  })

  // ─── Error detection helpers ───
  it('isKnowledgeUploadEndpointMissing detects 404', () => {
    expect(isKnowledgeUploadEndpointMissing({ status: 404 })).toBe(true)
    expect(isKnowledgeUploadEndpointMissing({ status: 405 })).toBe(true)
    expect(isKnowledgeUploadEndpointMissing({ status: 200 })).toBe(false)
  })

  it('isKnowledgeUploadUnsupportedFormat detects 415', () => {
    expect(isKnowledgeUploadUnsupportedFormat({ status: 415 })).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat({ status: 422 })).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('unsupported format'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat({ status: 200 })).toBe(false)
  })
})
