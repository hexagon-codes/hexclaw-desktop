import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock i18n before importing module under test
vi.mock('@/i18n', () => ({
  i18n: { global: { locale: { value: 'zh-CN' } } },
}))

import {
  formatTime,
  formatClockTime,
  formatSessionDate,
  formatLogTime,
  formatRelative,
  formatElapsedSeconds,
  formatDurationMs,
} from '../time'
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
    // Pin "now" to noon so "5 minutes ago" never crosses the midnight
    // boundary into the previous day (which would render as 昨天 HH:mm).
    const fakeNow = new Date()
    fakeNow.setHours(12, 0, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(fakeNow)
    try {
      const ts = ago(5 * MINUTE)
      const result = formatTime(ts)
      // Should be HH:mm format
      expect(result).toMatch(/^\d{2}:\d{2}$/)
      // compact should be the same for today
      expect(formatTime(ts, true)).toBe(result)
    } finally {
      vi.useRealTimers()
    }
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

describe('message and session date formats', () => {
  beforeEach(() => {
    setLocale('zh-CN')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 20, 12, 0, 0))
  })

  afterEach(() => vi.useRealTimers())

  it('formats message timestamps as HH:mm without weekday or date', () => {
    expect(formatClockTime(new Date(2026, 7, 20, 9, 5, 0).toISOString())).toBe('09:05')
    expect(formatClockTime(new Date(2026, 7, 18, 16, 45, 0).toISOString())).toBe('16:45')
  })

  it('formats today as HH:mm, same-year dates as month/day, and cross-year dates with the year', () => {
    expect(formatSessionDate(new Date(2026, 7, 20, 9, 5, 0).toISOString())).toBe('09:05')
    expect(formatSessionDate(new Date(2026, 7, 19, 9, 5, 0).toISOString())).toBe('8月19日')
    expect(formatSessionDate(new Date(2026, 7, 1, 9, 5, 0).toISOString())).toBe('8月1日')
    expect(formatSessionDate(new Date(2025, 11, 31, 9, 5, 0).toISOString())).toBe('2025年12月31日')
    expect(formatSessionDate(new Date(2026, 7, 19, 9, 5, 0).toISOString())).not.toMatch(
      /今天|昨天|周[一二三四五六日天]/,
    )
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

  // beforeEach 设 zh-CN：相对时间应输出中文（不泄漏英文 "ago"，对齐 i18n 修复）。
  it('seconds → N 秒前 (zh)', () => {
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe('30 秒前')
  })
  it('seconds → Ns ago (en)', () => {
    setLocale('en')
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe('30s ago')
  })

  it('minutes → N 分钟前 (zh)', () => {
    expect(formatRelative(new Date(now - 5 * MINUTE).toISOString(), now)).toBe('5 分钟前')
  })

  it('hours → N 小时前 (zh)', () => {
    expect(formatRelative(new Date(now - 3 * HOUR).toISOString(), now)).toBe('3 小时前')
  })

  it('days → N 天前 (zh)', () => {
    expect(formatRelative(new Date(now - 2 * DAY).toISOString(), now)).toBe('2 天前')
  })

  it('returns raw string for invalid input', () => {
    expect(formatRelative('bad', now)).toBe('bad')
  })
})

// Review L4: running-progress elapsed labels read poorly as raw seconds
// ("183s") — switch to m:ss from one minute onward.
describe('formatElapsedSeconds', () => {
  it('renders raw seconds under a minute', () => {
    expect(formatElapsedSeconds(0)).toBe('0s')
    expect(formatElapsedSeconds(42)).toBe('42s')
    expect(formatElapsedSeconds(59)).toBe('59s')
  })

  it('renders m:ss with zero-padded seconds from 60s on', () => {
    expect(formatElapsedSeconds(60)).toBe('1:00')
    expect(formatElapsedSeconds(61)).toBe('1:01')
    expect(formatElapsedSeconds(183)).toBe('3:03')
    expect(formatElapsedSeconds(3599)).toBe('59:59')
    expect(formatElapsedSeconds(3600)).toBe('60:00')
  })

  it('clamps negatives and floors fractions', () => {
    expect(formatElapsedSeconds(-5)).toBe('0s')
    expect(formatElapsedSeconds(61.9)).toBe('1:01')
  })
})

// Task history durations: "17.1s" / "2.1min" read poorly — show whole
// seconds under a minute and m:ss from one minute on.
describe('formatDurationMs', () => {
  it('returns a dash for missing or invalid input', () => {
    expect(formatDurationMs(undefined)).toBe('-')
    expect(formatDurationMs(-100)).toBe('-')
  })

  it('0 is a valid duration → "0ms" (not a dash)', () => {
    expect(formatDurationMs(0)).toBe('0ms')
  })

  it('keeps millisecond precision below one second', () => {
    expect(formatDurationMs(300)).toBe('300ms')
    expect(formatDurationMs(999)).toBe('999ms')
  })

  it('renders whole seconds under a minute', () => {
    expect(formatDurationMs(1000)).toBe('1s')
    expect(formatDurationMs(17_100)).toBe('17s')
    expect(formatDurationMs(59_900)).toBe('59s')
  })

  it('renders m:ss from one minute on', () => {
    expect(formatDurationMs(60_000)).toBe('1:00')
    expect(formatDurationMs(126_000)).toBe('2:06')
    expect(formatDurationMs(6 * 60_000 + 5_000)).toBe('6:05')
  })
})
