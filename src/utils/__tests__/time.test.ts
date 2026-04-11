import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock i18n before importing module under test
vi.mock('@/i18n', () => ({
  i18n: { global: { locale: { value: 'zh-CN' } } },
}))

import { formatTime, formatLogTime, formatRelative } from '../time'
import { i18n } from '@/i18n'

function setLocale(loc: string) {
  ;(i18n.global.locale as unknown as { value: string }).value = loc
}

/** Build an ISO string relative to "now" */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ─── formatTime (progressive display) ────────────────────────────

describe('formatTime', () => {
  beforeEach(() => setLocale('zh-CN'))

  it('returns "-" for undefined / empty', () => {
    expect(formatTime(undefined)).toBe('-')
    expect(formatTime('')).toBe('-')
  })

  it('returns raw string for invalid date', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date')
  })

  // ── Today ──────────────────────────────────────────────────────

  it('today → HH:mm (both compact & full)', () => {
    const ts = ago(5 * MINUTE)
    const result = formatTime(ts)
    // Should be HH:mm format
    expect(result).toMatch(/^\d{2}:\d{2}$/)
    // compact should be the same for today
    expect(formatTime(ts, true)).toBe(result)
  })

  // ── Yesterday ──────────────────────────────────────────────────

  describe('yesterday', () => {
    let fakeNow: Date

    beforeEach(() => {
      // Fix "now" to noon so yesterday is always valid
      fakeNow = new Date()
      fakeNow.setHours(12, 0, 0, 0)
      vi.useFakeTimers()
      vi.setSystemTime(fakeNow)
    })

    afterEach(() => vi.useRealTimers())

    it('zh-CN full → 昨天 HH:mm', () => {
      const yesterday = new Date(fakeNow)
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(9, 30, 0, 0)
      const result = formatTime(yesterday.toISOString())
      expect(result).toBe('昨天 09:30')
    })

    it('zh-CN compact → 昨天 (no time)', () => {
      const yesterday = new Date(fakeNow)
      yesterday.setDate(yesterday.getDate() - 1)
      expect(formatTime(yesterday.toISOString(), true)).toBe('昨天')
    })

    it('en full → Yesterday HH:mm', () => {
      setLocale('en')
      const yesterday = new Date(fakeNow)
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(14, 5, 0, 0)
      expect(formatTime(yesterday.toISOString())).toBe('Yesterday 14:05')
    })

    it('en compact → Yesterday', () => {
      setLocale('en')
      const yesterday = new Date(fakeNow)
      yesterday.setDate(yesterday.getDate() - 1)
      expect(formatTime(yesterday.toISOString(), true)).toBe('Yesterday')
    })
  })

  // ── This week ──────────────────────────────────────────────────

  describe('this week', () => {
    let wednesday: Date

    beforeEach(() => {
      // Fix "now" to a Friday noon so Wed is "this week"
      const friday = new Date('2026-04-10T12:00:00') // Friday
      vi.useFakeTimers()
      vi.setSystemTime(friday)
      wednesday = new Date('2026-04-08T16:45:00') // Wednesday
    })

    afterEach(() => vi.useRealTimers())

    it('zh-CN full → 周三 16:45', () => {
      expect(formatTime(wednesday.toISOString())).toBe('周三 16:45')
    })

    it('zh-CN compact → 周三', () => {
      expect(formatTime(wednesday.toISOString(), true)).toBe('周三')
    })

    it('en full → Wed 16:45', () => {
      setLocale('en')
      expect(formatTime(wednesday.toISOString())).toBe('Wed 16:45')
    })
  })

  // ── This year ──────────────────────────────────────────────────

  describe('this year (not this week)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-10T12:00:00'))
    })

    afterEach(() => vi.useRealTimers())

    it('zh-CN full → M月D日 HH:mm', () => {
      const ts = new Date('2026-02-14T08:30:00').toISOString()
      expect(formatTime(ts)).toBe('2月14日 08:30')
    })

    it('zh-CN compact → M月D日', () => {
      const ts = new Date('2026-02-14T08:30:00').toISOString()
      expect(formatTime(ts, true)).toBe('2月14日')
    })

    it('en full → Feb 14 08:30', () => {
      setLocale('en')
      const ts = new Date('2026-02-14T08:30:00').toISOString()
      expect(formatTime(ts)).toBe('Feb 14 08:30')
    })
  })

  // ── Older (different year) ─────────────────────────────────────

  describe('older / different year', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-10T12:00:00'))
    })

    afterEach(() => vi.useRealTimers())

    it('full → YYYY/MM/DD HH:mm', () => {
      const ts = new Date('2025-12-25T20:00:00').toISOString()
      expect(formatTime(ts)).toBe('2025/12/25 20:00')
    })

    it('compact → YYYY/MM/DD', () => {
      const ts = new Date('2025-12-25T20:00:00').toISOString()
      expect(formatTime(ts, true)).toBe('2025/12/25')
    })
  })
})

// ─── formatLogTime (millisecond precision) ───────────────────────

describe('formatLogTime', () => {
  it('formats to HH:mm:ss.SSS', () => {
    const d = new Date('2026-04-07T09:05:03.042Z')
    const result = formatLogTime(d.toISOString())
    // Local timezone — just check shape
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('preserves millisecond precision', () => {
    const d = new Date('2026-01-01T00:00:00.007Z')
    const result = formatLogTime(d.toISOString())
    expect(result).toMatch(/\.007$/)
  })

  it('returns raw string for invalid input', () => {
    expect(formatLogTime('bad')).toBe('bad')
  })
})

// ─── formatRelative (short relative time) ────────────────────────

describe('formatRelative', () => {
  const now = Date.now()

  beforeEach(() => setLocale('zh-CN'))

  it('< 5s → 刚刚', () => {
    expect(formatRelative(new Date(now - 2000).toISOString(), now)).toBe('刚刚')
  })

  it('< 5s en → just now', () => {
    setLocale('en')
    expect(formatRelative(new Date(now - 2000).toISOString(), now)).toBe('just now')
  })

  it('seconds → Ns ago', () => {
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe('30s ago')
  })

  it('minutes → Nm ago', () => {
    expect(formatRelative(new Date(now - 5 * MINUTE).toISOString(), now)).toBe('5m ago')
  })

  it('hours → Nh ago', () => {
    expect(formatRelative(new Date(now - 3 * HOUR).toISOString(), now)).toBe('3h ago')
  })

  it('days → Nd ago', () => {
    expect(formatRelative(new Date(now - 2 * DAY).toISOString(), now)).toBe('2d ago')
  })

  it('returns raw string for invalid input', () => {
    expect(formatRelative('bad', now)).toBe('bad')
  })
})
