/**
 * AssetService — 资产引用服务
 *
 * 纯工厂 + observation，不持有状态，不 mutation collection.refs。
 * RuntimeStore 负责 mutation authority。
 *
 * 不是 AssetRuntime — 不包含 Runtime Semantic Layer 语义。
 */

import { exists } from '@tauri-apps/plugin-fs'
import { validatePath } from './assetValidator'
import type { AssetReference, AssetMetadata, AssetHandle, AssetStatus, AssetType, AssetCollection } from '@/types/asset'

// ─── MIME → AssetType mapping ──────────────────────────

function inferAssetType(mimeType: string): AssetType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (
    mimeType.startsWith('application/pdf') ||
    mimeType.startsWith('application/msword') ||
    mimeType.startsWith('application/vnd.') ||
    mimeType.startsWith('text/')
  ) return 'document'
  return 'other'
}

// ─── Factory ────────────────────────────────────────────

/**
 * 创建 AssetReference（纯工厂）。
 *
 * - 校验 path（validatePath）
 * - 生成 assetId（UUID）
 * - status 默认为 'registered'
 * - 不 mutation collection.refs
 */
export function createAssetReference(
  taskId: string,
  path: string,
  metadata: AssetMetadata,
): AssetReference {
  const validation = validatePath(path)
  if (!validation.valid) {
    throw new Error(`Asset path 校验失败: ${validation.error}`)
  }

  return {
    assetId: crypto.randomUUID(),
    type: inferAssetType(metadata.mimeType),
    path: validation.normalizedPath!,
    metadata: { ...metadata },
    status: 'registered',
    taskId,
    createdAt: new Date().toISOString(),
  }
}

// ─── Handle ─────────────────────────────────────────────

/**
 * 解析资产句柄。
 * 返回最小 AssetHandle（仅 exists()）。
 */
export function resolveAsset(ref: AssetReference): AssetHandle {
  return {
    ref,
    exists: async () => {
      try {
        return await exists(ref.path)
      } catch {
        return false
      }
    },
  }
}

// ─── Observation ────────────────────────────────────────

/**
 * 检查资产健康状态 — observation only。
 *
 * 返回 actual status，不修改 ref.status。
 * 调用方（RuntimeStore）决定是否写入。
 */
export async function checkAssetHealth(ref: AssetReference): Promise<AssetStatus> {
  try {
    const fileExists = await exists(ref.path)
    return fileExists ? 'active' : 'orphaned'
  } catch {
    return 'orphaned'
  }
}

// ─── Mutation (pure) ────────────────────────────────────

/**
 * 标记资产为 invalidated — 纯函数。
 *
 * 返回新 AssetReference（status='invalidated'），不修改入参。
 */
export function markInvalidated(ref: AssetReference): AssetReference {
  return {
    ...ref,
    status: 'invalidated',
  }
}

// ─── Collection Helpers ─────────────────────────────────

/**
 * 确保 AssetCollection 存在（惰性初始化）。
 * 不修改入参 ctx。
 */
export function ensureAssetCollection(existing: AssetCollection | undefined): AssetCollection {
  if (existing) return existing
  return {
    refs: [],
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * 动态 rebuild summary（不持久化）。
 */
export function buildAssetSummary(refs: AssetReference[]) {
  const byType: Record<string, number> = {}
  for (const ref of refs) {
    byType[ref.type] = (byType[ref.type] || 0) + 1
  }
  return {
    total: refs.length,
    byType: byType as Record<AssetType, number>,
  }
}
