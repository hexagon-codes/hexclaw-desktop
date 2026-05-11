/**
 * useContextRuntime — Runtime Context 响应式 Composable
 *
 * 提供组件级 Reactivity，包装 useRuntimeStore 的查询方法为 ComputedRef。
 * 组件通过此 composable 消费 Context 数据，无需直接引用 store。
 */

import { computed } from 'vue'
import { useRuntimeStore } from '@/stores/runtime'
import type { RuntimeContext, ContextSummary } from '@/types'

/** 响应式获取指定 Task 的 Context */
export function useActiveContext(taskId: string) {
  const store = useRuntimeStore()
  return computed<RuntimeContext | undefined>(() => store.getActiveContext(taskId))
}

/** 响应式获取所有活跃 Context 摘要列表 */
export function useContextSummaries() {
  const store = useRuntimeStore()
  return computed<ContextSummary[]>(() => store.contextSummaries)
}

/** 响应式获取指定 Task 的 Context 摘要 */
export function useContextSummary(taskId: string) {
  const store = useRuntimeStore()
  return computed<ContextSummary | undefined>(() => store.getContextSummary(taskId))
}
