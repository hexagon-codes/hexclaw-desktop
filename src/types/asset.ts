/**
 * Asset Runtime 类型定义
 *
 * Runtime Resource Reference — 非 Semantic Layer。
 * Asset Reference 是 Context 中的轻量资产指针。
 *
 * 不是：File Manager / Media Library / Object Storage / Upload Center。
 */

// ─── Asset 类型 ─────────────────────────────────────────

/** Asset 类型 — 严格有限枚举 */
export type AssetType = 'image' | 'video' | 'audio' | 'document' | 'other'

// ─── Asset 状态 ─────────────────────────────────────────

/**
 * Asset 生命周期 — 4 态。
 *
 * registered → active → orphaned → invalidated
 *
 * registerAsset() 默认 status = 'registered'。
 * checkAssetHealth() 仅 observation，不修改 status。
 */
export type AssetStatus = 'registered' | 'active' | 'orphaned' | 'invalidated'

// ─── AssetReference ────────────────────────────────────

/**
 * AssetReference — Context 中存储的轻量资产指针。
 *
 * assetId = Runtime identity（authoritative）
 * path    = external filesystem pointer（非 authoritative）
 *
 * 约束：
 * - 不包含文件内容 / base64 / blob
 * - metadata 不可变（创建时固化）
 * - 多个 AssetReference 可以指向同一 path（不做 dedupe）
 */
export interface AssetReference {
  /** Runtime identity（UUID） */
  assetId: string
  /** 资产类型 */
  type: AssetType
  /** 文件绝对路径（external pointer，非 identity） */
  path: string
  /** 不可变元数据 */
  metadata: AssetMetadata
  /** 生命周期状态 */
  status: AssetStatus
  /** 所属 Task */
  taskId: string
  /** 创建时间（ISO） */
  createdAt: string
}

// ─── AssetMetadata ─────────────────────────────────────

/**
 * AssetMetadata — 声明式元数据。
 *
 * 创建时固化，不保证与真实文件一致。
 * Phase 9 不做：mime sniffing / media parsing / content validation。
 */
export interface AssetMetadata {
  /** 原始文件名 */
  originalName: string
  /** MIME type（声明式，非 sniffing 结果） */
  mimeType: string
  /** 文件大小 bytes（声明式） */
  sizeBytes: number
  /** 生成来源（如 'image_generation'） */
  source: string
  /** 可选：图片尺寸 */
  dimensions?: { width: number; height: number }
  /** 可选：音视频时长（秒） */
  durationSeconds?: number
}

// ─── AssetHandle ───────────────────────────────────────

/**
 * AssetHandle — 最小运行时句柄。
 * Phase 9 仅允许 exists()。
 */
export interface AssetHandle {
  readonly ref: AssetReference
  exists(): Promise<boolean>
}

// ─── AssetCollection ───────────────────────────────────

/**
 * AssetCollection — per-context 资产集合。
 *
 * 不做 auto dedupe。多 ref 可指向同一 path。
 * summary 不持久化，动态 rebuild。
 * lastUpdated 仅 observability metadata，不保证与文件系统同步。
 */
export interface AssetCollection {
  /** 资产引用列表 */
  refs: AssetReference[]
  /**
   * 最后修改时间（ISO）。
   * observability metadata only — 不保证与真实 filesystem 同步。
   */
  lastUpdated: string
}
