/**
 * TimelineProjection — Timeline 只读查询工具函数
 *
 * 纯 read-model utilities，无状态，无动态注册。
 * 不是 Event Bus / Plugin System。
 *
 * @see docs/agents-OS/Timeline-Spec.md
 */

import type { RuntimeEvent, RuntimeEventType } from '@/types/timeline'

/** 按时间排序的某 Task 事件列表 */
export function taskTimeline(events: RuntimeEvent[], taskId: string): RuntimeEvent[] {
  return events
    .filter(e => e.taskId === taskId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

/** 最近 N 个事件（按时间倒序） */
export function recentEvents(events: RuntimeEvent[], count: number): RuntimeEvent[] {
  return [...events]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, count)
}

/** 按类型过滤 */
export function eventsByType(events: RuntimeEvent[], type: RuntimeEventType): RuntimeEvent[] {
  return events.filter(e => e.type === type)
}

/** 时间范围过滤 */
export function eventsInRange(
  events: RuntimeEvent[],
  since?: string,
  until?: string,
): RuntimeEvent[] {
  let result = events
  if (since) result = result.filter(e => e.timestamp >= since)
  if (until) result = result.filter(e => e.timestamp <= until)
  return result
}
