/**
 * RecoveryService — 恢复评估服务
 *
 * assessment-only。不 mutation semantic state。
 * 无状态，不持有 Map。
 * 不访问 ContextManager / TimelineStore / RuntimeStore。
 *
 * 不是 RecoveryRuntime — resolved/failed 来自 Execution Lifecycle。
 */

import { classifyFailure } from './recoveryClassifier'
import type {
  RecoveryAssessment,
  RecoveryAssessmentState,
  CorruptionReport,
  RecoverySummary,
  FailureType,
} from '@/types/recovery'
import type { RuntimeContext } from '@/types'

// ─── Corruption Detection ─────────────────────────────

/**
 * 检测 Runtime 状态损坏 — ctx self-consistency only。
 *
 * 仅检查 ctx 自身一致性：
 * 1. contextDataExists
 * 2. executionStateConsistent（非 running/preparing — illegal combination）
 * 3. statusConsistent（task ↔ execution）
 * 4. essentialLayersLoaded（system + task + execution）
 *
 * 不访问 ContextManager.hasContext()。
 * 不做 N minutes timeout heuristic。
 */
export function detectCorruption(ctx: RuntimeContext): CorruptionReport {
  const details: string[] = []

  const contextDataExists = ctx !== undefined && ctx !== null
  if (!contextDataExists) {
    details.push('context data is undefined/null')
  }

  const executionStateConsistent = ctx?.execution
    ? !(ctx.execution.state === 'running' || ctx.execution.state === 'preparing')
    : true
  if (!executionStateConsistent) {
    details.push(`execution.state=${ctx?.execution?.state} is non-terminal (illegal combination)`)
  }

  let statusConsistent = true
  if (ctx?.task && ctx?.execution) {
    const taskStatus = ctx.task.status
    const execState = ctx.execution.state
    if (taskStatus === 'running' && execState !== 'running') {
      statusConsistent = false
      details.push(`status mismatch: task=${taskStatus} but execution=${execState}`)
    }
    if ((taskStatus === 'completed' || taskStatus === 'failed') && execState === 'running') {
      statusConsistent = false
      details.push(`status mismatch: task=${taskStatus} but execution=${execState}`)
    }
  }

  const essentialLayersLoaded = !!(
    ctx?.system &&
    ctx?.task &&
    ctx?.execution
  )
  if (!essentialLayersLoaded) {
    const missing: string[] = []
    if (!ctx?.system) missing.push('system')
    if (!ctx?.task) missing.push('task')
    if (!ctx?.execution) missing.push('execution')
    details.push(`essential layers missing: ${missing.join(', ')}`)
  }

  return {
    corrupted: !(contextDataExists && executionStateConsistent && statusConsistent && essentialLayersLoaded),
    checks: {
      contextDataExists,
      executionStateConsistent,
      statusConsistent,
      essentialLayersLoaded,
    },
    details,
  }
}

// ─── Recovery Assessment ──────────────────────────────

/**
 * 评估恢复可行性 — computed，不持久化。
 *
 * 1. detectCorruption → corruptionDetected
 * 2. classifyFailure(code) → failureType
 * 3. assess → assessmentState + suggestedAction
 */
export function assessRecovery(ctx: RuntimeContext): RecoveryAssessment | null {
  const failure = ctx.resources?.recovery?.failure
  if (!failure) return null

  const corruption = detectCorruption(ctx)
  const failureType: FailureType = corruption.corrupted
    ? 'corruption'
    : classifyFailure(failure.code)

  const contextIntact = !!(
    ctx.system &&
    ctx.task &&
    ctx.execution &&
    ctx.layerStates
  )

  const executionTerminal = ctx.execution
    ? !(ctx.execution.state === 'running' || ctx.execution.state === 'preparing')
    : false

  let assessmentState: RecoveryAssessmentState
  let suggestedAction: RecoveryAssessment['suggestedAction']

  if (corruption.corrupted) {
    assessmentState = 'unrecoverable'
    suggestedAction = 'clean_restart'
  } else if (failureType === 'permanent') {
    assessmentState = 'unrecoverable'
    suggestedAction = 'ignore'
  } else if (!contextIntact || !executionTerminal) {
    assessmentState = 'unrecoverable'
    suggestedAction = 'manual_intervention'
  } else if (failureType === 'transient') {
    assessmentState = 'recoverable'
    suggestedAction = 'retry'
  } else {
    assessmentState = 'unknown'
    suggestedAction = 'manual_intervention'
  }

  return {
    assessmentState,
    failureType,
    contextIntact,
    executionStateConsistent: executionTerminal,
    corruptionDetected: corruption.corrupted,
    suggestedAction,
  }
}

// ─── Resolution State ─────────────────────────────────

/**
 * 推断恢复解决状态 — 来自 Execution Lifecycle Outcome。
 *
 * 不是 Recovery Domain 的 type。
 * computed from task.status + execution.state。
 */
export function getResolutionState(ctx: RuntimeContext): 'pending' | 'resolved' | 'failed' {
  const hasFailure = !!ctx.resources?.recovery?.failure
  if (!hasFailure) return 'pending'

  const taskStatus = ctx.task?.status
  const execState = ctx.execution?.state

  // 新 execution 成功 → resolved
  if (taskStatus === 'completed' && execState === 'completed') return 'resolved'

  // 新 execution 失败（但 failure record 不同）→ failed
  // 简单判断：如果有 failure record 且 task 仍是 failed
  if (taskStatus === 'failed' && execState === 'failed') return 'failed'

  return 'pending'
}

// ─── Summary ──────────────────────────────────────────

/**
 * 动态 rebuild Recovery Summary（不持久化）。
 */
export function getRecoverySummary(ctx: RuntimeContext): RecoverySummary | null {
  const failure = ctx.resources?.recovery?.failure
  const assessment = assessRecovery(ctx)

  if (!failure && !assessment) return null

  const failureType = failure ? classifyFailure(failure.code) : null

  return {
    taskId: ctx.taskId,
    failureType,
    assessmentState: assessment?.assessmentState ?? 'unknown',
    resolution: getResolutionState(ctx),
    lastFailure: failure?.timestamp,
    lastAssessment: ctx.resources?.recovery?.lastAssessment,
  }
}
