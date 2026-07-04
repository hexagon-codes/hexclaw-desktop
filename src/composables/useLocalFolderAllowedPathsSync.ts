import { watch } from 'vue'
import { getRuntimeConfig, updateConfig } from '@/api/settings'
import { logger } from '@/utils/logger'
import { useAppStore } from '@/stores/app'
import { useConnectorInstances, type ConnectorInstance } from './useConnectorInstances'

export function normalizeLocalFolderPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  if (/^\/+$/.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/, '')
}

export function getEnabledLocalFolderAllowedPaths(instances: ConnectorInstance[]): string[] {
  const set = new Set<string>()
  for (const inst of instances) {
    if (inst.type !== 'localFolder' || !inst.enabled) continue
    const path = normalizeLocalFolderPath(inst.config?.path ?? '')
    if (path) set.add(path)
  }
  return Array.from(set).sort()
}

let lastSyncedLocalFolderPaths = new Set<string>()

export async function syncLocalFolderAllowedPaths(paths: string[]): Promise<void> {
  const normalizedPaths = Array.from(new Set(paths.map(normalizeLocalFolderPath).filter(Boolean))).sort()
  const runtimeConfig = await getRuntimeConfig()
  const currentPaths = (runtimeConfig.sandbox?.allowed_paths ?? []).map(normalizeLocalFolderPath).filter(Boolean)
  const nextManaged = new Set(normalizedPaths)
  const merged = new Set<string>()

  for (const existing of currentPaths) {
    if (!lastSyncedLocalFolderPaths.has(existing) || nextManaged.has(existing)) {
      merged.add(existing)
    }
  }
  for (const path of normalizedPaths) merged.add(path)

  await updateConfig({ sandbox: { allowed_paths: Array.from(merged).sort() } })
  lastSyncedLocalFolderPaths = nextManaged
}

/** BUG-20260702：失败退避重试节奏（1s/3s/9s，共 3 次重试后放弃留痕）。 */
export const LOCAL_FOLDER_SYNC_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface LocalFolderAllowedPathsSyncOptions {
  /** 退避调度函数（默认 setTimeout；测试注入假时钟）。 */
  delay?: (ms: number) => Promise<void>
}

/**
 * 启动期把「启用的本地目录连接器」路径同步进后端 sandbox.allowed_paths。
 *
 * BUG-20260702（启动竞态 + 无重试）修复契约：
 *  ① 同步动作挂在工程既有的 sidecar 就绪门后（appStore.sidecarReady，与 AppLayout 启动期
 *     后端调用同一道门）：未就绪时变更只缓存，就绪后补发最新值——冷启动首帧不再打空炮。
 *  ② 失败按 1s/3s/9s 指数退避有限重试，全部失败才放弃并 logger.warn 留痕。
 *  ③ in-flight 串行化：同一时刻只有一个 updateConfig 在飞；在飞期间的多次变更合并为
 *     最新一次补发，防止快速启停两个连接器时完成序错乱互相覆盖。
 */
export function useLocalFolderAllowedPathsSync(options: LocalFolderAllowedPathsSyncOptions = {}): void {
  const delay = options.delay ?? defaultDelay
  const { list } = useConnectorInstances()
  const appStore = useAppStore()

  let firstSync = true
  /** 待同步的最新期望值（serialized）；null = 没有待发项。后到的变更直接覆盖（合并等待）。 */
  let pendingSerialized: string | null = null
  /** in-flight 闸：pump 主循环运行中则新变更只入队，不并发直发。 */
  let pumping = false

  async function syncWithRetry(paths: string[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await syncLocalFolderAllowedPaths(paths)
        return
      } catch (error) {
        if (attempt >= LOCAL_FOLDER_SYNC_RETRY_DELAYS_MS.length) {
          logger.warn('[localFolder] failed to sync HexClaw file access grants after retries', error)
          return
        }
        logger.warn(
          `[localFolder] sync attempt ${attempt + 1} failed, retrying in ${LOCAL_FOLDER_SYNC_RETRY_DELAYS_MS[attempt]}ms`,
          error,
        )
        await delay(LOCAL_FOLDER_SYNC_RETRY_DELAYS_MS[attempt]!)
        // 退避期间来了更新的期望值：放弃过期快照，交回 pump 主循环处理最新值。
        if (pendingSerialized !== null) return
      }
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (pendingSerialized !== null && appStore.sidecarReady) {
        const serialized = pendingSerialized
        pendingSerialized = null
        await syncWithRetry(JSON.parse(serialized) as string[])
      }
    } finally {
      pumping = false
    }
  }

  watch(
    () => JSON.stringify(getEnabledLocalFolderAllowedPaths(list.value)),
    (serializedPaths) => {
      const wasFirst = firstSync
      firstSync = false
      // 首帧无本地目录连接器时不下发空数组（避免清空他源 allowed_paths 配置）。
      if (wasFirst && serializedPaths === '[]') return
      pendingSerialized = serializedPaths
      if (appStore.sidecarReady) void pump()
    },
    { immediate: true },
  )

  watch(
    () => appStore.sidecarReady,
    (ready) => {
      if (ready) void pump()
    },
    { immediate: true },
  )
}
