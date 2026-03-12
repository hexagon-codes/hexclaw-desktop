/**
 * Pinia 持久化插件
 *
 * 将指定 store 的状态自动同步到 localStorage。
 * 支持版本迁移、部分字段持久化、过期清理。
 */

import type { PiniaPluginContext } from 'pinia'
import { watch } from 'vue'
import { logger } from '@/utils/logger'

/** 持久化配置 (在 store 的 $persist 选项中设置) */
export interface PersistOptions {
  /** localStorage key (默认 "hc-store-{storeId}") */
  key?: string
  /** 仅持久化的字段路径 (默认全部) */
  pick?: string[]
  /** 版本号 (升级时自动丢弃旧数据) */
  version?: number
}

interface PersistedData {
  v: number
  d: Record<string, unknown>
}

const STORAGE_PREFIX = 'hc-store-'

/** 从 state 中提取指定字段 */
function pickFields(state: Record<string, unknown>, paths?: string[]): Record<string, unknown> {
  if (!paths) return { ...state }
  const result: Record<string, unknown> = {}
  for (const key of paths) {
    if (key in state) result[key] = state[key]
  }
  return result
}

/** Pinia 持久化插件 */
export function createPersistPlugin() {
  return ({ store, options }: PiniaPluginContext) => {
    const persist = (options as unknown as { persist?: PersistOptions | boolean }).persist
    if (!persist) return

    const opts: PersistOptions = typeof persist === 'boolean' ? {} : persist
    const key = opts.key ?? `${STORAGE_PREFIX}${store.$id}`
    const version = opts.version ?? 1

    // 恢复状态
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const persisted = JSON.parse(raw) as PersistedData
        if (persisted.v === version && persisted.d) {
          store.$patch(persisted.d as Record<string, unknown> as any)
          logger.debug(`恢复 store [${store.$id}] 状态`)
        } else {
          // 版本不匹配，清理旧数据
          localStorage.removeItem(key)
          logger.debug(`store [${store.$id}] 版本不匹配，已清理旧数据`)
        }
      }
    } catch (e) {
      logger.warn(`恢复 store [${store.$id}] 状态失败`, e)
      localStorage.removeItem(key)
    }

    // 监听变更并持久化
    store.$subscribe(
      () => {
        try {
          const data = pickFields(store.$state, opts.pick)
          const persisted: PersistedData = { v: version, d: data }
          localStorage.setItem(key, JSON.stringify(persisted))
        } catch (e) {
          logger.warn(`持久化 store [${store.$id}] 失败`, e)
        }
      },
      { detached: true, flush: 'sync' },
    )
  }
}
