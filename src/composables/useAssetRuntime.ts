/**
 * useAssetRuntime — 资产引用 composable
 *
 * 纯计算，返回 patches。所有方法接收 plain data，返回新对象。
 * 不接触 ContextManager / RuntimeContext。
 *
 * 红线：
 * - 不 import ContextManager / Pinia
 * - 不 mutation ctx 的任何属性（包括 resources）
 * - 不调用 writeTimelineEvent / revision.value++
 * - 所有输入为 plain data
 */

import {
  createAssetReference,
  markInvalidated,
  ensureAssetCollection,
  checkAssetHealth,
  buildAssetSummary,
} from '@/services/runtime/assetService'
import type { AssetReference, AssetMetadata, AssetCollection } from '@/types/asset'

export function useAssetRuntime() {
  /**
   * 构建注册操作 — 纯计算。
   * 输入：existing AssetCollection | undefined（由 RuntimeStore 从 ctx.resources.asset 获取）
   * 输出：ref + updated collection（由 RuntimeStore 应用到 ctx.resources.asset）
   */
  function buildRegistration(
    existing: AssetCollection | undefined,
    taskId: string,
    path: string,
    metadata: AssetMetadata,
  ): {
    ref: AssetReference
    updated: AssetCollection
  } {
    const ref = createAssetReference(taskId, path, metadata)
    const collection = ensureAssetCollection(existing)
    return {
      ref,
      updated: {
        refs: [...collection.refs, ref],
        lastUpdated: new Date().toISOString(),
      },
    }
  }

  /**
   * 构建废弃操作 — 纯计算。
   * 输入：AssetCollection
   * 输出：updated collection + assetType（供 timeline metadata）
   *       null = assetId 未找到
   */
  function buildInvalidation(
    collection: AssetCollection,
    assetId: string,
  ): {
    updated: AssetCollection
    assetType: string
  } | null {
    const index = collection.refs.findIndex(r => r.assetId === assetId)
    if (index === -1) return null

    const newRef = markInvalidated(collection.refs[index])
    const refs = [...collection.refs]
    refs[index] = newRef

    return {
      updated: { refs, lastUpdated: new Date().toISOString() },
      assetType: newRef.type,
    }
  }

  /**
   * 执行健康检查 — observation only。
   * 输入：AssetCollection
   * 输出：updated collection（status 已更新）+ changed flag
   */
  async function checkHealth(
    collection: AssetCollection,
  ): Promise<{
    updated: AssetCollection
    changed: boolean
  }> {
    const results = await Promise.allSettled(
      collection.refs.map(ref => checkAssetHealth(ref)),
    )

    let changed = false
    const refs = collection.refs.map((ref, i) => {
      const result = results[i]
      if (result.status === 'fulfilled' && ref.status !== result.value) {
        changed = true
        return { ...ref, status: result.value }
      }
      return ref
    })

    return {
      updated: { refs, lastUpdated: new Date().toISOString() },
      changed,
    }
  }

  /**
   * 构建摘要 — 纯计算。
   * 输入：AssetCollection | undefined
   * 输出：summary
   */
  function buildSummary(collection: AssetCollection | undefined) {
    const refs = collection?.refs ?? []
    return buildAssetSummary(refs)
  }

  return { buildRegistration, buildInvalidation, checkHealth, buildSummary }
}
