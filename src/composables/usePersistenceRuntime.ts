/**
 * usePersistenceRuntime — 持久化 composable
 *
 * 仅负责 disk IO + serialization 协调。
 * 不接触 ContextManager / TimelineStore。
 * 不负责 runtime reconstruction（属于 RuntimeStore）。
 *
 * 红线：
 * - 不 import ContextManager / TimelineStore / Pinia
 * - 不 mutation ctx
 * - 不调用 writeTimelineEvent / revision.value++
 */

import {
  saveContext as persistContext,
  saveAll as persistAll,
  loadAll as loadAllFromDisk,
} from '@/services/runtime/persistenceRuntime'
import type { RuntimeContext } from '@/types'
import type { RuntimeEvent } from '@/types/timeline'

export function usePersistenceRuntime() {
  /**
   * 保存单个 Context 到磁盘。
   * 输入：已获取的 RuntimeContext（由 RuntimeStore 传入）
   * 返回：boolean（成功/失败）
   */
  async function saveContext(ctx: RuntimeContext): Promise<boolean> {
    try {
      await persistContext(ctx)
      return true
    } catch {
      return false
    }
  }

  /**
   * 批量保存到磁盘。
   * 输入：contexts + events（由 RuntimeStore 传入）
   * 返回：boolean
   */
  async function saveAll(
    contexts: RuntimeContext[],
    events: RuntimeEvent[],
  ): Promise<boolean> {
    return persistAll(contexts, events)
  }

  /**
   * 从磁盘加载所有快照。
   * 不做 RuntimeContext 重建（仅反序列化到 RuntimeContext）。
   * 返回原始数据，由 RuntimeStore 负责 reconstruction。
   */
  async function loadAll(): Promise<{
    contexts: RuntimeContext[]
    events: RuntimeEvent[]
  }> {
    return loadAllFromDisk()
  }

  return { saveContext, saveAll, loadAll }
}
