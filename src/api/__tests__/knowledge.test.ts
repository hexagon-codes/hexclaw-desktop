import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
}))

vi.mock('../client', () => ({ apiGet, apiPost, apiDelete }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))
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

  it('returns empty string when both fail', async () => {
    apiGet.mockRejectedValueOnce(new Error('404'))
    apiPost.mockRejectedValueOnce(new Error('500'))
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
