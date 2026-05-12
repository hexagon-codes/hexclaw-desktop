/**
 * Recovery Classifier — 失败分类 + 记录构建
 *
 * 纯函数，无状态。
 * 不访问外部服务。不访问 ContextManager。
 */

import type { FailureType, FailureRecord } from '@/types/recovery'

// ─── Classification ────────────────────────────────────

const PERMANENT_CODES = new Set([
  'INVALID_INPUT',
  'AUTH_FAILED',
  'CAPABILITY_DENIED',
  'TASK_CANCELLED',
  'BUDGET_EXCEEDED',
])

const TRANSIENT_CODES = new Set([
  'NETWORK_TIMEOUT',
  'RATE_LIMITED',
  'RESOURCE_UNAVAILABLE',
  'SIDECAR_UNREACHABLE',
  'EXECUTION_TIMEOUT',
])

/**
 * 分类失败原因。
 *
 * 基于 error.code 模式匹配，不访问外部服务。
 * 优先级：permanent → transient → unknown
 * （corruption 由 detectCorruption 单独检测，不在此分类）
 */
export function classifyFailure(errorCode: string): FailureType {
  if (PERMANENT_CODES.has(errorCode)) return 'permanent'
  if (TRANSIENT_CODES.has(errorCode)) return 'transient'
  return 'unknown'
}

// ─── Record Builder ────────────────────────────────────

/**
 * 构建 FailureRecord。
 *
 * 不包含 FailureType — restore 后重新 classifyFailure(code)。
 * 避免 classification policy stale。
 */
export function buildFailureRecord(
  code: string,
  message: string,
  executionState: string,
  taskStatus: string,
): FailureRecord {
  return {
    timestamp: new Date().toISOString(),
    code,
    message,
    executionStateAtFailure: executionState,
    taskStatusAtFailure: taskStatus,
  }
}
