/**
 * Recovery Runtime 类型定义
 *
 * Runtime Failure Semantics — assessment-only。
 * 不是：Retry Queue / Scheduler / Workflow Recovery / Auto Retry System。
 */

// ─── Failure Classification ────────────────────────────

/**
 * FailureType — 失败原因分类。
 *
 * 基于 error.code 模式匹配，不访问外部服务。
 * 不持久化 — restore 后重新 classifyFailure()。
 */
export type FailureType = 'transient' | 'permanent' | 'corruption' | 'unknown'

// ─── Assessment State ──────────────────────────────────

/**
 * RecoveryAssessmentState — 恢复可行性评估结果。
 * computed on-the-fly，不持久化。
 */
export type RecoveryAssessmentState = 'recoverable' | 'unrecoverable' | 'unknown'

// Note: 无 RecoveryResolutionState type。
// resolved / failed 属于 Execution Outcome Projection，
// 由 getResolutionState(ctx) computed helper 推断。

// ─── Failure Record ────────────────────────────────────

/**
 * FailureRecord — 失败记录（持久化）。
 *
 * 不持久化 FailureType — restore 后重新 classifyFailure(code)。
 * 避免 classification policy stale。
 */
export interface FailureRecord {
  /** 失败时间（ISO） */
  timestamp: string
  /** 错误码（来自 ExecutionLayer.error.code） */
  code: string
  /** 错误消息（来自 ExecutionLayer.error.message） */
  message: string
  /** 失败时的 execution state */
  executionStateAtFailure: string
  /** 失败时的 task status */
  taskStatusAtFailure: string
}

// ─── Recovery Layer ────────────────────────────────────

/**
 * RecoveryLayer — per-context 恢复数据。
 *
 * 仅持久化 failure + lastAssessment。
 * recoveryState 不持久化 — restore 后重新 assess。
 */
export interface RecoveryLayer {
  /** 最近一次失败记录 */
  failure: FailureRecord | null
  /** 最近一次评估时间（ISO） */
  lastAssessment: string
}

// ─── Recovery Assessment ──────────────────────────────

/**
 * RecoveryAssessment — 恢复可行性评估（computed，不持久化）。
 */
export interface RecoveryAssessment {
  /** 评估状态 */
  assessmentState: RecoveryAssessmentState
  /** 失败类型（从 failure.code 重新 classify） */
  failureType: FailureType
  /** 上下文结构是否完整 */
  contextIntact: boolean
  /** execution state 是否一致（非 illegal combination） */
  executionStateConsistent: boolean
  /** 是否检测到状态损坏 */
  corruptionDetected: boolean
  /** 建议操作 */
  suggestedAction: 'retry' | 'clean_restart' | 'manual_intervention' | 'ignore'
}

// ─── Corruption Report ────────────────────────────────

/**
 * CorruptionReport — Runtime 状态一致性校验（computed，不持久化）。
 *
 * detectCorruption 仅检查 ctx 自身一致性，
 * 不访问 ContextManager / RuntimeStore。
 */
export interface CorruptionReport {
  corrupted: boolean
  /** 检测项 */
  checks: {
    /** ctx 自身数据存在 */
    contextDataExists: boolean
    /** execution.state 不在 running/preparing（非 illegal combination） */
    executionStateConsistent: boolean
    /** task.status 与 execution.state 一致性 */
    statusConsistent: boolean
    /** system + task + execution 三层存在 */
    essentialLayersLoaded: boolean
  }
  /**
   * 损坏详情 — 仅进 runtimeLogger，不进 Timeline。
   * Timeline 不是 diagnostics stream。
   */
  details: string[]
}

// ─── Recovery Summary ──────────────────────────────────

/** RecoverySummary — UI 消费（动态 rebuild，不持久化） */
export interface RecoverySummary {
  taskId: string
  failureType: FailureType | null
  assessmentState: RecoveryAssessmentState
  /** resolved / failed / pending — 由 execution lifecycle outcome 推断 */
  resolution: 'pending' | 'resolved' | 'failed'
  lastFailure?: string
  lastAssessment?: string
}
