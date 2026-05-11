/**
 * PersistenceRuntime — Runtime Snapshot Persistence
 *
 * 将 RuntimeContext[] + RuntimeEvent[] 持久化到本地磁盘 JSON 文件。
 * 不是 ORM / DB / Event Sourcing / Reactive Sync / Auto-save。
 *
 * 关键约束：
 * - 不直接访问 ContextManager、TimelineStore、RuntimeStore
 * - 只接收外部传入的 RuntimeContext[] 和 RuntimeEvent[]
 * - saveAll 返回 Promise<boolean>，不允许 silent partial failure
 *
 * @see .workflow/.scratchpad/persistence-runtime-skeleton-analyze.md
 */

import { writeTextFile, readTextFile, mkdir, exists, rename } from '@tauri-apps/plugin-fs'
import { appLocalDataDir } from '@tauri-apps/api/path'
import { serializeContext, deserializeContext } from './contextSerializer'
import { serializeTimeline, deserializeTimeline } from './timelineSerializer'
import { getRuntimeLogger } from './runtimeLogger'
import type { RuntimeContext } from '@/types'
import type { RuntimeEvent } from '@/types/timeline'
import type { RuntimeManifest } from '@/types/persistence'

// ─── Constants ───────────────────────────────────────────

const RUNTIME_DIR = '.hexclaw/runtime'
const CONTEXTS_DIR = 'contexts'
const TIMELINE_FILE = 'timeline.json'
const MANIFEST_FILE = 'manifest.json'
const TIMELINE_WARN_THRESHOLD = 5000

// ─── Path Helpers ────────────────────────────────────────

async function getRuntimeDir(): Promise<string> {
  const appData = await appLocalDataDir()
  return `${appData}${RUNTIME_DIR}`
}

/** 原子写入：先写 .tmp 再 rename，防止写入中断导致快照损坏 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp`
  await writeTextFile(tmp, content)
  // rename 在目标已存在时覆盖（POSIX atomic rename）
  await rename(tmp, target)
}

// ─── PersistenceRuntime ─────────────────────────────────

/**
 * 保存单个 Context 快照到磁盘。
 * 文件：contexts/{taskId}.json
 */
export async function saveContext(context: RuntimeContext): Promise<void> {
  const base = await getRuntimeDir()
  const contextsDir = `${base}/${CONTEXTS_DIR}`
  await mkdir(contextsDir, { recursive: true })

  const snapshot = serializeContext(context)
  const json = JSON.stringify(snapshot, null, 2)
  const target = `${contextsDir}/${context.taskId}.json`

  await atomicWrite(target, json)
}

/**
 * 批量保存所有活跃 Context + Timeline + Manifest。
 *
 * - Timeline 事件数 > TIMELINE_WARN_THRESHOLD 时 warn-only
 * - 任何写入失败 → runtimeLogger.error + return false
 *
 * @returns true 表示全部保存成功，false 表示有失败
 */
export async function saveAll(
  contexts: RuntimeContext[],
  events: RuntimeEvent[],
): Promise<boolean> {
  const logger = getRuntimeLogger()

  // ── Timeline observability: warn if oversized ──
  if (events.length > TIMELINE_WARN_THRESHOLD) {
    logger.warn(
      `Timeline 事件数超限: ${events.length} > ${TIMELINE_WARN_THRESHOLD}，建议 prune`,
    )
  }

  try {
    const base = await getRuntimeDir()
    const contextsDir = `${base}/${CONTEXTS_DIR}`
    await mkdir(contextsDir, { recursive: true })

    // 1. 保存所有 Context
    for (const ctx of contexts) {
      const snapshot = serializeContext(ctx)
      const json = JSON.stringify(snapshot, null, 2)
      const target = `${contextsDir}/${ctx.taskId}.json`
      await atomicWrite(target, json)
    }

    // 2. 保存 Timeline
    const timelineSnapshot = serializeTimeline(events)
    const timelineJson = JSON.stringify(timelineSnapshot, null, 2)
    const timelineTarget = `${base}/${TIMELINE_FILE}`
    await atomicWrite(timelineTarget, timelineJson)

    // 3. 保存 Manifest
    const manifest: RuntimeManifest = {
      formatVersion: '1.0',
      updatedAt: new Date().toISOString(),
      contextIds: contexts.map(c => c.taskId),
    }
    const manifestJson = JSON.stringify(manifest, null, 2)
    const manifestTarget = `${base}/${MANIFEST_FILE}`
    await atomicWrite(manifestTarget, manifestJson)

    return true
  } catch (e) {
    logger.error(`saveAll 持久化失败: ${(e as Error).message}`)
    return false
  }
}

/**
 * 从磁盘恢复所有 Context + Timeline。
 *
 * 不直接接触 ContextManager / TimelineStore — 返回纯数据，
 * 由 RuntimeStore.restoreRuntime() 负责注入。
 *
 * @returns { contexts, events } 或空数组（无快照/读取失败时）
 */
export async function loadAll(): Promise<{
  contexts: RuntimeContext[]
  events: RuntimeEvent[]
}> {
  const base = await getRuntimeDir()
  const manifestTarget = `${base}/${MANIFEST_FILE}`

  // ── 读取 Manifest ──
  let manifest: RuntimeManifest
  try {
    if (!(await exists(manifestTarget))) {
      return { contexts: [], events: [] }
    }
    const manifestJson = await readTextFile(manifestTarget)
    manifest = JSON.parse(manifestJson) as RuntimeManifest
  } catch {
    return { contexts: [], events: [] }
  }

  // ── 读取 Contexts ──
  const contexts: RuntimeContext[] = []
  const contextsDir = `${base}/${CONTEXTS_DIR}`
  for (const taskId of manifest.contextIds) {
    try {
      const ctxTarget = `${contextsDir}/${taskId}.json`
      if (!(await exists(ctxTarget))) continue
      const ctxJson = await readTextFile(ctxTarget)
      const snapshot = JSON.parse(ctxJson)
      const ctx = deserializeContext(snapshot)
      contexts.push(ctx)
    } catch {
      // 跳过单个 Context 读取失败
    }
  }

  // ── 读取 Timeline ──
  let events: RuntimeEvent[] = []
  const timelineTarget = `${base}/${TIMELINE_FILE}`
  try {
    if (await exists(timelineTarget)) {
      const timelineJson = await readTextFile(timelineTarget)
      const timelineSnapshot = JSON.parse(timelineJson)
      events = deserializeTimeline(timelineSnapshot)
    }
  } catch {
    events = []
  }

  return { contexts, events }
}
