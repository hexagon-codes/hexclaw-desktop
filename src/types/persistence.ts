/**
 * Persistence Runtime 类型定义
 *
 * Runtime Snapshot Persistence — Context/Timeline/Memory 的 JSON 快照类型。
 * 不是 ORM / DB / Event Sourcing。
 *
 * @see .workflow/.scratchpad/persistence-runtime-skeleton-analyze.md
 */

import type { TaskType, SystemLayer, SkillLayer, TaskLayer, ExecutionLayer, MemoryLayer } from './context'
import type { RuntimeEvent } from './timeline'
import type { AssetCollection } from './asset'
import type { RecoveryLayer } from './recovery'

/** Context 快照 — RuntimeContext 的可持久化投影 */
export interface ContextSnapshot {
  formatVersion: '1.0'
  taskId: string
  taskType: TaskType
  system: SystemLayer | null
  skill: SkillLayer | null
  task: TaskLayer | null
  execution: ExecutionLayer | null
  memory: MemoryLayer | null
  /** Resource Reference（非 Semantic Layer） */
  asset: AssetCollection | null
  /** Recovery 数据（非 Semantic Layer） */
  recovery: RecoveryLayer | null
  updatedAt: string // ISO
}

/** Timeline 快照 — RuntimeEvent 数组的可持久化形式 */
export interface TimelineSnapshot {
  formatVersion: '1.0'
  updatedAt: string // ISO
  events: RuntimeEvent[]
}

/** 快照清单 — 标记当前活跃快照索引 */
export interface RuntimeManifest {
  formatVersion: '1.0'
  updatedAt: string // ISO
  contextIds: string[]
}
