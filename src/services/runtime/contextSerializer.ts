/**
 * ContextSerializer — RuntimeContext ↔ ContextSnapshot 序列化
 *
 * 仅负责 serialization boundary，不做 runtime normalization。
 * null → undefined 转换留给 RuntimeStore.restoreRuntime()。
 *
 * 红线：
 * - 不修改 ContextManager
 * - 不修改 RuntimeContext 类型
 */

import type { RuntimeContext } from '@/types'
import type { ContextSnapshot } from '@/types/persistence'

/**
 * 序列化 RuntimeContext → ContextSnapshot。
 * 深拷贝 5 层数据 + AssetCollection。
 * 剥离不可序列化字段（estimateSize、revision 等不在 Context 中）。
 */
export function serializeContext(ctx: RuntimeContext): ContextSnapshot {
  return {
    formatVersion: '1.0',
    taskId: ctx.taskId,
    taskType: ctx.taskType,
    system: ctx.system ?? null,
    skill: ctx.skill ?? null,
    task: ctx.task ?? null,
    execution: ctx.execution ?? null,
    memory: ctx.memory ?? null,
    asset: ctx.resources?.asset ?? null,
    recovery: ctx.resources?.recovery ?? null,
    updatedAt: ctx.updatedAt,
  }
}

/**
 * 反序列化 ContextSnapshot → RuntimeContext（部分字段）。
 *
 * 不做 null → undefined normalization — 调用方负责 runtime normalization。
 * 不恢复 layerStates / totalEstimatedSize — 由 ContextManager.recalcSize 重建。
 */
export function deserializeContext(snapshot: ContextSnapshot): RuntimeContext {
  const now = new Date().toISOString()
  return {
    taskId: snapshot.taskId,
    taskType: snapshot.taskType,
    system: snapshot.system ?? undefined,
    skill: snapshot.skill ?? undefined,
    task: snapshot.task ?? undefined,
    execution: snapshot.execution ?? undefined,
    memory: snapshot.memory ?? undefined,
    layerStates: {
      system: snapshot.system ? ('loaded' as const) : ('unloaded' as const),
      skill: snapshot.skill ? ('loaded' as const) : ('unloaded' as const),
      task: snapshot.task ? ('loaded' as const) : ('unloaded' as const),
      execution: snapshot.execution ? ('loaded' as const) : ('unloaded' as const),
      memory: snapshot.memory ? ('loaded' as const) : ('unloaded' as const),
    },
    resources: (snapshot.asset || snapshot.recovery)
      ? {
          asset: snapshot.asset ?? undefined,
          recovery: snapshot.recovery ?? undefined,
        }
      : undefined,
    createdAt: now,
    updatedAt: snapshot.updatedAt ?? now,
    totalEstimatedSize: 0, // 恢复后由 manager.recalcSize() 重新计算
  }
}
