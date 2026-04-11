import { i18n } from '@/i18n'

function locale(): string {
  return (i18n.global.locale as unknown as { value: string }).value || 'zh-CN'
}

function isZh(): boolean {
  return locale().startsWith('zh')
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isYesterday(d: Date, now: Date): boolean {
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  return isSameDay(d, y)
}

function isSameWeek(d: Date, now: Date): boolean {
  const day = now.getDay() || 7 // Monday=1
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - day + 1)
  weekStart.setHours(0, 0, 0, 0)
  return d >= weekStart && d < now
}

function weekdayLabel(d: Date): string {
  if (isZh()) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] ?? '周日'
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? 'Sun'
}

function monthDay(d: Date): string {
  if (isZh()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()] ?? 'Jan'} ${d.getDate()}`
}

/**
 * Progressive time display — adapts granularity to distance from now.
 *
 * compact=false (default): chat messages, task history
 *   Today → 14:30 | Yesterday → 昨天 14:30 | This week → 周三 14:30
 *   This year → 4月7日 14:30 | Older → 2025/4/7 14:30
 *
 * compact=true: session list, sidebar
 *   Today → 14:30 | Yesterday → 昨天 | This week → 周三
 *   This year → 4月7日 | Older → 2025/4/7
 */
export function formatTime(ts: string | undefined, compact = false): string {
  if (!ts) return '-'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const now = new Date()
  const time = compact ? '' : ` ${hhmm(d)}`

  if (isSameDay(d, now)) return hhmm(d)
  if (isYesterday(d, now)) return (isZh() ? '昨天' : 'Yesterday') + time
  if (isSameWeek(d, now)) return weekdayLabel(d) + time
  if (d.getFullYear() === now.getFullYear()) return monthDay(d) + time
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}` + time
}

/** Millisecond-precision absolute time for log entries */
export function formatLogTime(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${d.getMilliseconds().toString().padStart(3, '0')}`
}

/** Short relative time for streaming contexts: "3s ago", "2m ago" */
export function formatRelative(ts: string, now: number): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const diff = now - d.getTime()
  if (diff < 5000) return isZh() ? '刚刚' : 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
