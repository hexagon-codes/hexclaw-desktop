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
  /** Navigation metadata — 非语义字段，仅供跨视图导航 */
  navigation?: {
    chatSessionId?: string
  }
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
    /** Navigation metadata — 非语义字段，仅供跨视图导航 */
    navigation?: {
      chatSessionId?: string
    }
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

// ─── Narrative Timeline ───────────────────────────

/**
 * Narrative Phase — 仅用于 storytelling grouping。
 *
 * 不是 RuntimeState。不承担：
 * - lifecycle authority
 * - transition authority
 * - execution semantics
 */
export type NarrativePhase =
  | 'creation'      // task.created + context.created
  | 'preparation'   // layer.* + skill.* + capability.*
  | 'execution'     // execution.*
  | 'completion'    // task.completed
  | 'failure'       // task.failed + execution.failed + skill.loadFailed
  | 'anomaly'       // budget.warning + recovery.* + asset.invalidated
  | 'maintenance'   // layer.unloaded + skill.unloaded + memory.updated + task.destroyed

/** 叙事权重 — 决定折叠/展开行为 */
export type NarrativeSignificance = 'milestone' | 'major' | 'minor'

/**
 * Timeline Narrative Group — 将多条 RuntimeEvent 聚合为叙事 beat。
 *
 * 不存 presentation formatting（duration 用 ms，UI 自行 format）。
 * title 必须 anchored to real RuntimeEvent，不得虚构 AI reasoning 叙事。
 */
export interface TimelineNarrativeGroup {
  /** 唯一标识 */
  id: string
  /** 叙事阶段 */
  phase: NarrativePhase
  /** 叙事权重 */
  significance: NarrativeSignificance

  /** 叙事标题 — anchored to RuntimeEvent (e.g. "任务完成", "开始执行") */
  title: string
  /** 叙事描述 — 来自 payload.summary */
  description?: string

  /** 组内时间范围 */
  startTime: string           // ISO 8601
  endTime: string             // ISO 8601
  /** 耗时（毫秒），UI 自行 format */
  durationMs?: number

  /** 组内原始事件数 */
  eventCount: number
  /** 默认折叠（minor 事件组默认折叠，milestone/failure 默认展开） */
  isCollapsed: boolean

  /** 子事件 — 展开可见 */
  children: TimelineItemProjection[]
}

// ─── Task Result 投影 ────────────────────────────

/**
 * Result 分组 — UX 分组，非 Runtime topology。
 *
 * 不按 toolName / execution step / AssetReference.type 分组。
 */
export type ResultGroup = 'primary' | 'generated_files' | 'supporting'

/** Result 种类 */
export type ResultKind = 'text' | 'code' | 'image' | 'audio' | 'video' | 'file' | 'tool_call'

/** 单个 Result 条目投影 */
export interface ResultItemProjection {
  id: string
  kind: ResultKind
  group: ResultGroup

  /** 可读标题 */
  title: string
  /** 简短描述（≤100 chars） */
  description?: string

  /** 溯源 */
  source: 'text' | 'asset' | 'artifact'

  /** 元数据（声明式传递，不做内容解析） */
  sizeBytes?: number
  mimeType?: string
  /** 文件路径 — 仅显示/copy，不 open external */
  path?: string
  dimensions?: { width: number; height: number }

  /** 健康状态 */
  status: 'valid' | 'invalid' | 'unknown'
}

/** Task 完成后的结果投影 — ContextDetailPanel Outputs section 消费 */
export interface TaskResultProjection {
  taskId: string
  /** 结果摘要（e.g. "1 个主结果 · 2 个生成文件"） */
  summary: string
  /** 结果条目列表 */
  items: ResultItemProjection[]
  totalItems: number
  hasError: boolean
  /** Navigation metadata */
  navigation?: {
    chatSessionId?: string
  }
}
