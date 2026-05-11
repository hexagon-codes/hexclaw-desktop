/**
 * TimelineStore — Runtime State History 存储
 *
 * Append-only 事件流，纯内存。
 * 不是 Event Bus / Telemetry Pipeline。
 *
 * 性能约束：
 * - append() 必须保持 O(1)：不 deep clone、不 recursive normalize、
 *   不 projection rebuild、不复杂 validation
 * - getAll()/query() 返回数组副本，不暴露内部引用
 *
 * @see docs/agents-OS/Timeline-Spec.md
 */

import type { RuntimeEvent, RuntimeEventType, TimelineFilter } from '@/types/timeline'
import { MAX_TIMELINE_EVENTS } from '@/types/timeline'
import { getRuntimeLogger } from '@/services/runtime/runtimeLogger'

let _nextId = 0
function generateId(): string {
  _nextId++
  return `evt-${Date.now()}-${_nextId}`
}

export class TimelineStore {
  private events: RuntimeEvent[] = []

  // ── 写入 ─────────────────────────────────────────────

  /**
   * Append 一个事件。
   * O(1) — 不 deep clone、不 recursive normalize、不 projection rebuild、不复杂 validation。
   * 超限仅 runtimeLogger.warn，不自动 prune。
   */
  append(event: Omit<RuntimeEvent, 'id' | 'timestamp'>): void {
    const full: RuntimeEvent = {
      ...event,
      id: generateId(),
      timestamp: new Date().toISOString(),
    }
    this.events.push(full)

    if (this.events.length > MAX_TIMELINE_EVENTS) {
      getRuntimeLogger().warn(
        `TimelineStore 超出上限: ${this.events.length} > ${MAX_TIMELINE_EVENTS}，请手动 prune()`,
      )
    }
  }

  // ── 查询（均返回副本） ──────────────────────────────

  /** 按条件过滤（返回副本） */
  query(filter: TimelineFilter): RuntimeEvent[] {
    let result = this.events

    if (filter.taskId) {
      result = result.filter(e => e.taskId === filter.taskId)
    }
    if (filter.type) {
      result = result.filter(e => e.type === filter.type)
    }
    if (filter.layer) {
      result = result.filter(e => e.layer === filter.layer)
    }
    if (filter.since) {
      result = result.filter(e => e.timestamp >= filter.since!)
    }
    if (filter.until) {
      result = result.filter(e => e.timestamp <= filter.until!)
    }
    if (filter.limit && filter.limit > 0) {
      result = result.slice(-filter.limit)
    }

    return [...result]
  }

  /** 获取指定 Task 的事件列表（按时间正序，返回副本） */
  getByTaskId(taskId: string): RuntimeEvent[] {
    return this.events.filter(e => e.taskId === taskId)
  }

  /** 按类型过滤（返回副本） */
  getByType(type: RuntimeEventType): RuntimeEvent[] {
    return this.events.filter(e => e.type === type)
  }

  /** 获取全部事件（返回副本） */
  getAll(): RuntimeEvent[] {
    return [...this.events]
  }

  // ── 生命周期 ─────────────────────────────────────────

  /**
   * 手动裁剪，保留最近 keep 条。
   * @returns 被删除的事件数
   */
  prune(keep: number): number {
    if (keep >= this.events.length) return 0
    const removed = this.events.length - keep
    this.events = this.events.slice(-keep)
    return removed
  }

  /** 清空所有事件 */
  clear(): void {
    this.events = []
  }

  /** 当前事件数 */
  get size(): number {
    return this.events.length
  }

  /** 最后一条事件（用于调试） */
  get lastEvent(): RuntimeEvent | undefined {
    return this.events[this.events.length - 1]
  }
}
