import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useLogsStore } from '../logs'

vi.mock('@/api/logs', () => ({
  connectLogStream: vi.fn().mockReturnValue({
    onopen: null,
    onclose: null,
    close: vi.fn(),
  }),
  getLogStats: vi.fn().mockResolvedValue({
    total: 100,
    by_level: { info: 60, warn: 25, error: 15 },
    requests_per_minute: 5.2,
  }),
}))

describe('useLogsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has empty initial state', () => {
    const store = useLogsStore()
    expect(store.entries).toEqual([])
    expect(store.connected).toBe(false)
    expect(store.filter).toEqual({})
    expect(store.stats).toBeNull()
  })

  it('filters entries by level', () => {
    const store = useLogsStore()
    store.entries = [
      { id: '1', level: 'info', message: 'hello', source: 'app', timestamp: '2026-01-01' },
      { id: '2', level: 'error', message: 'fail', source: 'app', timestamp: '2026-01-01' },
      { id: '3', level: 'info', message: 'world', source: 'api', timestamp: '2026-01-01' },
    ]
    store.setFilter({ level: 'error' })
    expect(store.filteredEntries).toHaveLength(1)
    expect(store.filteredEntries[0]!.message).toBe('fail')
  })

  it('filters entries by keyword', () => {
    const store = useLogsStore()
    store.entries = [
      { id: '1', level: 'info', message: 'hello world', source: 'app', timestamp: '2026-01-01' },
      { id: '2', level: 'info', message: 'goodbye', source: 'app', timestamp: '2026-01-01' },
    ]
    store.setFilter({ keyword: 'hello' })
    expect(store.filteredEntries).toHaveLength(1)
  })

  it('filters entries by source', () => {
    const store = useLogsStore()
    store.entries = [
      { id: '1', level: 'info', message: 'a', source: 'app', timestamp: '2026-01-01' },
      { id: '2', level: 'info', message: 'b', source: 'api', timestamp: '2026-01-01' },
    ]
    store.setFilter({ source: 'api' })
    expect(store.filteredEntries).toHaveLength(1)
    expect(store.filteredEntries[0]!.source).toBe('api')
  })

  it('clears entries', () => {
    const store = useLogsStore()
    store.entries = [
      { id: '1', level: 'info', message: 'test', source: 'app', timestamp: '2026-01-01' },
    ]
    store.clear()
    expect(store.entries).toHaveLength(0)
  })

  it('loads stats', async () => {
    const store = useLogsStore()
    await store.loadStats()
    expect(store.stats).not.toBeNull()
    expect(store.stats!.total).toBe(100)
    expect(store.stats!.by_level?.info).toBe(60)
  })

  it('combines multiple filters', () => {
    const store = useLogsStore()
    store.entries = [
      { id: '1', level: 'info', message: 'hello', source: 'app', timestamp: '2026-01-01' },
      { id: '2', level: 'error', message: 'hello error', source: 'app', timestamp: '2026-01-01' },
      { id: '3', level: 'info', message: 'world', source: 'api', timestamp: '2026-01-01' },
    ]
    store.setFilter({ level: 'info', keyword: 'hello' })
    expect(store.filteredEntries).toHaveLength(1)
    expect(store.filteredEntries[0]!.id).toBe('1')
  })
})
