/**
 * Chain C: Memory -> Search -> Display
 *
 * Tests the memory CRUD chain: list, create, update, delete, search.
 * Verifies correct API endpoint paths and HTTP methods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────

const { mockApiGet, mockApiPost, mockApiPut, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPut: vi.fn(),
  mockApiDelete: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
  api: {},
  apiSSE: vi.fn(),
  apiWebSocket: vi.fn(),
  fromNativeError: vi.fn(),
  createApiError: vi.fn(),
  isRetryable: vi.fn(),
  getErrorMessage: vi.fn(),
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain C: Memory -> Search -> Display', () => {
  it('C1: getMemoryEntries lists structured entries from GET /api/v1/memory', async () => {
    const response = {
      entries: [{ id: 'm1', content: 'User prefers dark mode', type: 'preference', source: 'manual', created_at: '2026-04-07T12:00:00Z', updated_at: '2026-04-07T12:00:00Z', hit_count: 3 }],
      summary: 'User works with TypeScript',
      capacity: { used: 1, max: 50 },
    }
    mockApiGet.mockResolvedValueOnce(response)

    const { getMemoryEntries } = await import('@/api/memory')
    const result = await getMemoryEntries()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.id).toBe('m1')
    expect(result.capacity.max).toBe(50)
  })

  it('C1b: getMemoryEntries forwards view and cursor pagination params', async () => {
    mockApiGet.mockResolvedValueOnce({ entries: [], summary: '', capacity: { used: 0, max: 50 }, has_more: false })

    const { getMemoryEntries } = await import('@/api/memory')
    await getMemoryEntries({ view: 'archived', limit: 25, cursor: '50', type: 'preference', source: 'manual' })

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory', {
      view: 'archived',
      limit: 25,
      cursor: '50',
      type: 'preference',
      source: 'manual',
    })
  })

  it('C1c: getMemoryEntries normalizes the legacy sidecar memory payload', async () => {
    mockApiGet.mockResolvedValueOnce({
      content: '- [11:20] 用户偏好中文回复\n\n- [15:18] 用户偏好使用 Rust 和 Go 开发',
      context: '## 长期记忆\n\n- [11:20] 用户偏好中文回复',
    })

    const { getMemoryEntries } = await import('@/api/memory')
    const result = await getMemoryEntries()

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.content).toBe('用户偏好中文回复')
    expect(result.entries[1]!.content).toBe('用户偏好使用 Rust 和 Go 开发')
    expect(result.summary).toContain('长期记忆')
    expect(result.capacity.used).toBe(2)
    expect(result.legacy_mode).toBe(true)
    expect(result.legacy_content).toContain('用户偏好中文回复')
    expect(result.has_more).toBe(false)
  })

  it('C1d: getMemoryEntries splits adjacent timestamped legacy memories into separate cards', async () => {
    mockApiGet.mockResolvedValueOnce({
      content: '- [11:20] 之前的记忆\n- [11:21] 新加的记忆',
      context: '## 长期记忆\n\n- [11:20] 之前的记忆\n- [11:21] 新加的记忆',
    })

    const { getMemoryEntries } = await import('@/api/memory')
    const result = await getMemoryEntries()

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.content).toBe('之前的记忆')
    expect(result.entries[1]!.content).toBe('新加的记忆')
  })

  it('C1e: getMemoryEntries strips legacy type/source metadata from memory content', async () => {
    mockApiGet.mockResolvedValueOnce({
      content: '- [11:20] [preference:manual] 用户偏好中文回复\n- [11:21] [fact:chat_extract] 新加的事实',
    })

    const { getMemoryEntries } = await import('@/api/memory')
    const result = await getMemoryEntries()

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({
      content: '用户偏好中文回复',
      type: 'preference',
      source: 'manual',
    })
    expect(result.entries[1]).toMatchObject({
      content: '新加的事实',
      type: 'fact',
      source: 'chat_extract',
    })
  })

  it('C2: createMemoryEntry calls POST /api/v1/memory with content, type, source', async () => {
    mockApiPost.mockResolvedValueOnce({ id: 'm2', content: 'User likes TypeScript', type: 'preference', source: 'manual' })

    const { createMemoryEntry } = await import('@/api/memory')
    const result = await createMemoryEntry('User likes TypeScript', 'preference', 'manual')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'User likes TypeScript',
      type: 'preference',
      source: 'manual',
    })
    expect(result.id).toBe('m2')
  })

  it('C2b: createMemoryEntry defaults type to "fact" and source to "manual"', async () => {
    mockApiPost.mockResolvedValueOnce({ id: 'm3', content: 'Some fact' })

    const { createMemoryEntry } = await import('@/api/memory')
    await createMemoryEntry('Some fact')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'Some fact',
      type: 'fact',
      source: 'manual',
    })
  })

  it('C3a: updateMemoryEntry calls PUT /api/v1/memory/:id', async () => {
    mockApiPut.mockResolvedValueOnce({ id: 'm1', content: 'Updated content' })

    const { updateMemoryEntry } = await import('@/api/memory')
    const result = await updateMemoryEntry('m1', 'Updated content')

    expect(mockApiPut).toHaveBeenCalledWith('/api/v1/memory/m1', { content: 'Updated content' })
    expect(result.content).toBe('Updated content')
  })

  it('C3b: deleteMemoryEntry calls DELETE /api/v1/memory/:id', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteMemoryEntry } = await import('@/api/memory')
    const result = await deleteMemoryEntry('mem-123')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory/mem-123')
    expect(result.message).toBe('deleted')
  })

  it('C3c: deleteMemoryEntry URL-encodes special characters in ID', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteMemoryEntry } = await import('@/api/memory')
    await deleteMemoryEntry('mem/special&id')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory/mem%2Fspecial%26id')
  })

  it('C3c1: updateLegacyMemoryEntry rewrites legacy memory via PUT /api/v1/memory', async () => {
    mockApiPut.mockResolvedValueOnce({ message: 'updated' })

    const { updateLegacyMemoryEntry } = await import('@/api/memory')
    await updateLegacyMemoryEntry('legacy-2', '更新后的第二条', '- [11:20] 第一条\n\n- [11:21] 第二条')

    expect(mockApiPut).toHaveBeenCalledWith('/api/v1/memory', {
      content: '- [11:20] 第一条\n\n- [11:21] 更新后的第二条',
    })
  })

  it('C3c2: deleteLegacyMemoryEntry rewrites legacy memory via PUT /api/v1/memory', async () => {
    mockApiPut.mockResolvedValueOnce({ message: 'updated' })

    const { deleteLegacyMemoryEntry } = await import('@/api/memory')
    await deleteLegacyMemoryEntry('legacy-2', '- [11:20] 第一条\n\n- [11:21] 第二条')

    expect(mockApiPut).toHaveBeenCalledWith('/api/v1/memory', {
      content: '- [11:20] 第一条',
    })
  })

  it('C3d: clearAllMemory calls DELETE /api/v1/memory (no ID)', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'cleared' })

    const { clearAllMemory } = await import('@/api/memory')
    const result = await clearAllMemory()

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory')
    expect(result.message).toBe('cleared')
  })

  it('C3e: archiveMemoryEntry calls POST /api/v1/memory/:id/archive', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'archived' })

    const { archiveMemoryEntry } = await import('@/api/memory')
    const result = await archiveMemoryEntry('m-1')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory/m-1/archive')
    expect(result.message).toBe('archived')
  })

  it('C3f: restoreMemoryEntry calls POST /api/v1/memory/:id/restore', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'restored' })

    const { restoreMemoryEntry } = await import('@/api/memory')
    const result = await restoreMemoryEntry('a-0')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory/a-0/restore')
    expect(result.message).toBe('restored')
  })

  it('C4: searchMemory sends query via GET /api/v1/memory/search', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [{ id: 's1', content: 'dark mode preference', type: 'preference' }],
      vector_results: [{ content: 'User prefers dark mode', score: 0.95, source: 'chat' }],
      total: 1,
    })

    const { searchMemory } = await import('@/api/memory')
    const result = await searchMemory('dark mode')

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory/search', { q: 'dark mode' })
    expect(result.results).toHaveLength(1)
    expect(result.vector_results).toHaveLength(1)
    expect(result.vector_results![0]!.score).toBe(0.95)
  })

  it('C4b: searchMemory handles empty results', async () => {
    mockApiGet.mockResolvedValueOnce({ results: [], vector_results: null, total: 0 })

    const { searchMemory } = await import('@/api/memory')
    const result = await searchMemory('nonexistent')

    expect(result.results).toEqual([])
    expect(result.vector_results).toBeNull()
    expect(result.total).toBe(0)
  })

  it('C5: API failure propagates as error', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('Memory service unavailable'))

    const { getMemoryEntries } = await import('@/api/memory')

    await expect(getMemoryEntries()).rejects.toThrow('Memory service unavailable')
  })

  it('C5b: POST failure propagates as error', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('Failed to save'))

    const { createMemoryEntry } = await import('@/api/memory')

    await expect(createMemoryEntry('content')).rejects.toThrow('Failed to save')
  })
})
