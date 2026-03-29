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
  it('C1: getMemory lists memories from backend via GET /api/v1/memory', async () => {
    const memoryData = {
      entries: ['Remember user prefers dark mode', 'User timezone is UTC+8'],
      total: 2,
    }
    mockApiGet.mockResolvedValueOnce(memoryData)

    const { getMemory } = await import('@/api/memory')
    const result = await getMemory()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory')
    expect(result).toEqual(memoryData)
  })

  it('C2: saveMemory calls POST /api/v1/memory with content and type', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'saved' })

    const { saveMemory } = await import('@/api/memory')
    const result = await saveMemory('User likes TypeScript', 'memory')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'User likes TypeScript',
      type: 'memory',
    })
    expect(result.message).toBe('saved')
  })

  it('C2b: saveMemory defaults type to "memory" when not specified', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'saved' })

    const { saveMemory } = await import('@/api/memory')
    await saveMemory('Some content')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'Some content',
      type: 'memory',
    })
  })

  it('C2c: saveMemory can use "daily" type', async () => {
    mockApiPost.mockResolvedValueOnce({ message: 'saved' })

    const { saveMemory } = await import('@/api/memory')
    await saveMemory('Daily summary', 'daily')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'Daily summary',
      type: 'daily',
    })
  })

  it('C3a: updateMemory calls PUT /api/v1/memory', async () => {
    mockApiPut.mockResolvedValueOnce({ message: 'updated' })

    const { updateMemory } = await import('@/api/memory')
    const result = await updateMemory('Updated memory content')

    expect(mockApiPut).toHaveBeenCalledWith('/api/v1/memory', {
      content: 'Updated memory content',
    })
    expect(result.message).toBe('updated')
  })

  it('C3b: deleteMemory calls DELETE /api/v1/memory/:id with correct ID', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteMemory } = await import('@/api/memory')
    const result = await deleteMemory('mem-123')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory/mem-123')
    expect(result.message).toBe('deleted')
  })

  it('C3c: deleteMemory URL-encodes special characters in ID', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteMemory } = await import('@/api/memory')
    await deleteMemory('mem/special&id')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory/mem%2Fspecial%26id')
  })

  it('C3d: clearAllMemory calls DELETE /api/v1/memory (no ID)', async () => {
    mockApiDelete.mockResolvedValueOnce({ message: 'cleared' })

    const { clearAllMemory } = await import('@/api/memory')
    const result = await clearAllMemory()

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/memory')
    expect(result.message).toBe('cleared')
  })

  it('C4: searchMemory sends query string via GET /api/v1/memory/search', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: ['dark mode preference'],
      vector_results: [{ content: 'User prefers dark mode', score: 0.95, source: 'chat' }],
      total: 1,
    })

    const { searchMemory } = await import('@/api/memory')
    const result = await searchMemory('dark mode')

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory/search', { q: 'dark mode' })
    expect(result.results).toHaveLength(1)
    expect(result.vector_results).toHaveLength(1)
    expect(result.vector_results![0]!.score).toBe(0.95)
    expect(result.total).toBe(1)
  })

  it('C4b: searchMemory handles empty results', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [],
      vector_results: null,
      total: 0,
    })

    const { searchMemory } = await import('@/api/memory')
    const result = await searchMemory('nonexistent')

    expect(result.results).toEqual([])
    expect(result.vector_results).toBeNull()
    expect(result.total).toBe(0)
  })

  it('C5: API failure propagates as error (does not crash)', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('Memory service unavailable'))

    const { getMemory } = await import('@/api/memory')

    await expect(getMemory()).rejects.toThrow('Memory service unavailable')
  })

  it('C5b: POST failure propagates as error', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('Failed to save'))

    const { saveMemory } = await import('@/api/memory')

    await expect(saveMemory('content')).rejects.toThrow('Failed to save')
  })
})
