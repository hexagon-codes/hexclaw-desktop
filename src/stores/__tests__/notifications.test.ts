import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotificationsStore } from '../notifications'
import type { NotificationInput } from '@/types/ui'

function make(over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    kind: 'system',
    level: 'info',
    title: 'hello',
    ...over,
  }
}

describe('useNotificationsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('pushes newest-first and assigns id/timestamp/read=false', () => {
    const store = useNotificationsStore()
    const a = store.push(make({ title: 'A' }))
    const b = store.push(make({ title: 'B' }))

    expect(store.items.map((n) => n.title)).toEqual(['B', 'A'])
    expect(a.id).toBeTruthy()
    expect(b.id).not.toBe(a.id)
    expect(b.read).toBe(false)
    expect(typeof b.timestamp).toBe('number')
  })

  it('counts unread and clears it via markRead / markAllRead', () => {
    const store = useNotificationsStore()
    const a = store.push(make({ title: 'A' }))
    store.push(make({ title: 'B' }))
    expect(store.unreadCount).toBe(2)
    expect(store.hasUnread).toBe(true)

    store.markRead(a.id)
    expect(store.unreadCount).toBe(1)

    store.markAllRead()
    expect(store.unreadCount).toBe(0)
    expect(store.hasUnread).toBe(false)
  })

  it('merges by dedupeKey instead of stacking (refresh to top + re-unread)', () => {
    const store = useNotificationsStore()
    const first = store.push(make({ title: 'Engine stopped', dedupeKey: 'engine:status', level: 'warning' }))
    store.markRead(first.id)
    expect(store.unreadCount).toBe(0)

    store.push(make({ title: 'Other' }))
    // same dedupeKey → replaces the existing row, keeps id, re-marks unread, moves to top
    const merged = store.push(make({ title: 'Engine recovered', dedupeKey: 'engine:status', level: 'success' }))

    expect(merged.id).toBe(first.id)
    expect(store.items.filter((n) => n.dedupeKey === 'engine:status')).toHaveLength(1)
    expect(store.items[0]!.title).toBe('Engine recovered')
    expect(store.items[0]!.level).toBe('success')
    expect(store.items[0]!.read).toBe(false)
  })

  it('caps the buffer at 100 items, dropping the oldest', () => {
    const store = useNotificationsStore()
    for (let i = 0; i < 130; i++) store.push(make({ title: `n${i}` }))
    expect(store.items).toHaveLength(100)
    expect(store.items[0]!.title).toBe('n129')
    expect(store.items[99]!.title).toBe('n30')
  })

  it('flags urgent unread (approval / warning / error) for badge severity', () => {
    const store = useNotificationsStore()

    store.push(make({ level: 'info', kind: 'memory' }))
    expect(store.hasUrgentUnread).toBe(false) // 纯 info 未读 → 不报警

    const warn = store.push(make({ level: 'warning', kind: 'engine' }))
    expect(store.hasUrgentUnread).toBe(true)

    store.markRead(warn.id)
    expect(store.hasUrgentUnread).toBe(false) // 警告已读 → 退红

    // approval kind 即使 info 级也算紧急
    store.push(make({ level: 'info', kind: 'approval' }))
    expect(store.hasUrgentUnread).toBe(true)
  })

  it('removes a single item and clears all', () => {
    const store = useNotificationsStore()
    const a = store.push(make({ title: 'A' }))
    store.push(make({ title: 'B' }))

    store.remove(a.id)
    expect(store.items.map((n) => n.title)).toEqual(['B'])

    store.clearAll()
    expect(store.items).toHaveLength(0)
    expect(store.unreadCount).toBe(0)
  })
})
