/**
 * Workspace Projection DTOs — UI 层唯一消费的类型。
 *
 * 这些类型与 Runtime Kernel 类型（RuntimeContext, RuntimeEvent）彻底解耦。
 * UI 组件只 import 此文件，不 import @/types/context 或 @/types/timeline。
 *
 * 设计原则：
 * - UX taxonomy，非 Runtime topology
 * - 不含 semantic layer / AssetCollection / RecoveryLayer 等 Runtime 术语
 * - 不含 UI theme 语义（如 dotColor）
 * - progress 保持 observational / non-authoritative
 */

import type { TaskType, TaskStatus } from '@/types'

// ─── Task List 投影 ─────────────────────────────────

/** Task List 卡片数据 */
export interface WorkspaceTaskProjection {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  goal?: string            // ≤60 chars
  skillName?: string
  elapsed: string          // "12s" / "3m" / "1h"
  progress?: number        // 0–100，observational only
  activityState?: string   // 当无真实 progress 时使用："executing" / "waiting" / "finalizing"
  hasError: boolean
  hasOutputs: boolean
}

// ─── Context Detail 投影 ────────────────────────────

/** 选中 Task 的完整可观测投影 */
export interface WorkspaceContextProjection {
  taskId: string
  taskType: string

  /** UX section — 任务目标与结果 */
  task: {
    goal?: string
    status: string
    progress?: number
    inputSummary?: string     // ≤100 chars
    outputSummary?: string    // ≤100 chars
    errorCode?: string
    errorMessage?: string
  }

  /** UX section — 注入的经验包 */
  skill?: {
    skillId: string
    version: string
    loadedSections: {
      markdown: boolean       // true = 已加载可用
      references: boolean     // true = 已加载可用
    }
    status: string            // 'loading' | 'loaded' | 'error'
  }

  /** UX section — 执行进度 */
  execution?: {
    state: string             // 'idle' | 'preparing' | 'running' | 'completed' | 'failed'
    stage: string             // 'preparing' | 'executing' | 'finalizing'
    stepCount: number
    elapsed: string
  }

  /** UX section — 任务产物 */
  outputs?: {
    generatedAssets: number
    hasInvalidAssets: boolean
  }

  /** UX section — 健康状态（默认折叠，health.hasIssues 时自动展开） */
  health?: {
    hasIssues: boolean
    severity?: 'warning' | 'critical'
  }
}

// ─── Timeline 投影 ──────────────────────────────────

/**
 * UX 事件类别（20 种 RuntimeEventType → 5 种 UX category）。
 * 内部 RuntimeEventType 保持不变，此映射仅在 projector 中完成。
 */
export type TimelineCategory =
  | 'task'     // task.* + execution.* + context.created
  | 'skill'    // skill.* + capability.validated
  | 'system'   // layer.* + memory.updated
  | 'warning'  // budget.warning + recovery.*
  | 'output'   // asset.invalidated

/** Timeline 条目投影 — 与 RuntimeEvent 完全解耦 */
export interface TimelineItemProjection {
  time: string             // "12:03:45"
  typeCategory: TimelineCategory
  typeLabel: string        // i18n key，由 UI 层 translate
  summary: string          // ≤200 chars
}
