export const CRON_SCHEDULE_PRESETS = [
  { labelKey: 'tasks.presetDaily9', value: '0 9 * * *' },
  { labelKey: 'tasks.presetHourly', value: '@every 1h' },
  { labelKey: 'tasks.preset30min', value: '@every 30m' },
  { labelKey: 'tasks.preset5min', value: '@every 5m' },
  { labelKey: 'tasks.presetMon9', value: '0 9 * * 1' },
  { labelKey: 'tasks.presetNoon', value: '0 12 * * *' },
  { labelKey: 'tasks.presetEvening', value: '0 18 * * *' },
  { labelKey: 'tasks.presetDaily', value: '@daily' },
] as const

export type SimpleCronSchedule =
  | { kind: 'daily' | 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }

export type CronSchedulePattern = SimpleCronSchedule | { kind: 'custom' }

// 只解释可由常用控件无损表达的规则，别名和其余 Cron 保留原始输入。
export function parseCronSchedule(schedule: string): CronSchedulePattern {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-6])$/.exec(schedule.trim())
  if (!match) return { kind: 'custom' }
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (minute > 59 || hour > 23) return { kind: 'custom' }
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (match[3] === '*') return { kind: 'daily', time }
  if (match[3] === '1-5') return { kind: 'weekdays', time }
  return { kind: 'weekly', time, weekday: Number(match[3]) }
}

export function formatCronSchedule(pattern: SimpleCronSchedule): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(pattern.time)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  if (pattern.kind === 'weekly') {
    if (!Number.isInteger(pattern.weekday) || pattern.weekday < 0 || pattern.weekday > 6) return null
    return `${minute} ${hour} * * ${pattern.weekday}`
  }
  return `${minute} ${hour} * * ${pattern.kind === 'weekdays' ? '1-5' : '*'}`
}
