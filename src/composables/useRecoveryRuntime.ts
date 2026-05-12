/**
 * useRecoveryRuntime — 恢复评估 composable
 *
 * 纯计算 + 返回 patches。部分方法接收 RuntimeContext 作为只读数据。
 * 不 mutation ctx 的任何字段。
 *
 * 红线：
 * - 不 import ContextManager / Pinia / TimelineStore
 * - 不 import RuntimeEvent / RuntimeEventType
 * - 不调用 writeTimelineEvent / revision.value++
 * - 不 mutation ctx 的任何属性（包括 resources）
 */

import { buildFailureRecord } from '@/services/runtime/recoveryClassifier'
import {
  assessRecovery as assessRecoveryFn,
  detectCorruption as detectCorruptionFn,
  getRecoverySummary as getRecoverySummaryFn,
  getResolutionState as getResolutionStateFn,
} from '@/services/runtime/recoveryService'
import type { RecoveryLayer, RecoveryAssessment, CorruptionReport, RecoverySummary } from '@/types/recovery'
import type { RuntimeContext } from '@/types'

export function useRecoveryRuntime() {
  /**
   * 构建失败记录 + RecoveryLayer patch — 纯计算。
   *
   * 输入：
   *   existingLayer — ctx.resources.recovery（由 RuntimeStore 获取）
   *   error — { code, message }
   *   executionState / taskStatus — 从 ctx 提取的 snapshot 字段
   *   ctx — 用于计算 prevAssessment + newAssessment（只读，不 mutation）
   *
   * 输出：
   *   patch — 新的 RecoveryLayer（由 RuntimeStore 应用到 ctx.resources.recovery）
   *   assessmentChanged / assessmentState / failureCode — 供 RuntimeStore 决定是否 append timeline
   */
  function buildFailureApplication(
    existingLayer: RecoveryLayer | undefined,
    error: { code: string; message: string },
    executionState: string,
    taskStatus: string,
    ctx: RuntimeContext,
  ): {
    patch: RecoveryLayer
    assessmentChanged: boolean
    assessmentState: string
    failureCode: string
  } {
    const record = buildFailureRecord(error.code, error.message, executionState, taskStatus)
    const patch: RecoveryLayer = {
      failure: record,
      lastAssessment: new Date().toISOString(),
    }

    // 基于现有 ctx 计算 prev assessment（patch 未应用前）
    const prevState = existingLayer?.failure
      ? assessRecoveryFn(ctx)?.assessmentState
      : undefined

    // 基于临时 ctx clone 计算 new assessment（patch 应用后）
    // shallow clone 足够 — assessRecoveryFn 只读 ctx 字段
    const tempCtx: RuntimeContext = {
      ...ctx,
      resources: {
        ...ctx.resources,
        recovery: patch,
      },
    }
    const newState = assessRecoveryFn(tempCtx)?.assessmentState

    return {
      patch,
      assessmentChanged: prevState !== newState,
      assessmentState: newState ?? 'unknown',
      failureCode: record.code,
    }
  }

  /**
   * 评估恢复可行性 — 纯计算（透传）。
   * 输入：RuntimeContext（只读）
   */
  function assess(ctx: RuntimeContext): RecoveryAssessment | null {
    return assessRecoveryFn(ctx)
  }

  /**
   * 检测状态损坏 — 纯计算（透传）。
   * 输入：RuntimeContext（只读）
   */
  function detect(ctx: RuntimeContext): CorruptionReport | null {
    // detectCorruptionFn always returns a CorruptionReport (not null)
    return detectCorruptionFn(ctx)
  }

  /**
   * 构建摘要 — 纯计算（透传）。
   * 输入：RuntimeContext（只读）
   */
  function getSummary(ctx: RuntimeContext): RecoverySummary | null {
    return getRecoverySummaryFn(ctx)
  }

  /**
   * 推断解决状态 — 纯计算（透传）。
   * 输入：RuntimeContext（只读）
   */
  function getResolution(ctx: RuntimeContext): 'pending' | 'resolved' | 'failed' {
    return getResolutionStateFn(ctx)
  }

  return {
    buildFailureApplication,
    assess,
    detect,
    getSummary,
    getResolution,
  }
}
