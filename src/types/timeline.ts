/**
 * Timeline — Runtime State History 类型定义
 *
 * Timeline 是 Runtime Nervous System，记录系统状态转换。
 * 不是 Event Bus / Telemetry Pipeline / Tool Trace。
 *
 * Timeline Event 只允许 Runtime State Transition。
 * 不允许演化为：telemetry stream、tool trace、browser action log、token log。
 *
 * @see docs/agents-OS/Timeline-Spec.md
 */

// ─── 常量 ──────────────────────────────────────────────

/** Timeline 最大事件数（超出后 runtimeLogger warn） */
export const MAX_TIMELINE_EVENTS = 1000

// ─── 事件类型 ──────────────────────────────────────────

/** Runtime 状态转换事件类型 */
export type RuntimeEventType =
  // ── Task ──
  | 'task.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.destroyed'

  // ── Context ──
  | 'context.created'

  // ── Layer ──
  | 'layer.loaded'
  | 'layer.unloaded'

  // ── Skill ──
  | 'skill.loaded'
  | 'skill.loadFailed'
  | 'skill.unloaded'
  | 'capability.validated'

  // ── Budget ──
  | 'budget.warning'

  // ── Execution ──
  | 'execution.prepared'
  | 'execution.started'
  | 'execution.completed'
  | 'execution.failed'

  // ── Memory ──
  | 'memory.updated'

  // ── Asset ──
  | 'asset.invalidated'

  // ── Recovery ──
  | 'recovery.assessed'
  | 'recovery.corruption_detected'

// ─── 事件载荷 ──────────────────────────────────────────

/**
 * 事件载荷 — 轻量 observability metadata。
 *
 * 约束：
 * - metadata 不允许 JSON string / serialized object / 大文本
 * - 只允许 lightweight observability metadata
 */
export interface RuntimeEventPayload {
  /** 人类可读的描述（纯文本，≤200 字符） */
  summary?: string
  /** 轻量元数据（仅标量值，禁止嵌套对象） */
  metadata?: Record<string, string | number | boolean>
}

// ─── 事件 ──────────────────────────────────────────────

/** Runtime 事件 — 不可变的一次状态转换记录 */
export interface RuntimeEvent {
  /** 唯一标识 */
  id: string
  /** 事件类型 */
  type: RuntimeEventType
  /** 所属 Task（可选） */
  taskId?: string
  /** 所属 Context Layer（可选） */
  layer?: string
  /** ISO 8601 时间戳 */
  timestamp: string
  /** 轻量载荷（可选） */
  payload?: RuntimeEventPayload
}

// ─── 查询 ──────────────────────────────────────────────

/** Timeline 查询过滤条件 */
export interface TimelineFilter {
  taskId?: string
  type?: RuntimeEventType
  layer?: string
  since?: string        // ISO，只返回该时间点之后
  until?: string        // ISO，只返回该时间点之前
  limit?: number
}
