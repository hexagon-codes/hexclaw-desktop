/** 记忆类型（rule = 砍薄版后 standing 迁入的硬规则，常驻保证带） */
export type MemoryType = 'identity' | 'preference' | 'fact' | 'instruction' | 'context' | 'rule'

/** 记忆来源（reflect_profile = 周期画像蒸馏产物，BUG-20260703 P2-2 画像卡按它过滤） */
export type MemorySource = 'manual' | 'chat_explicit' | 'chat_extract' | 'system' | 'reflect_profile'

/** 记忆状态 */
export type MemoryStatus = 'active' | 'archived'

/** 记忆列表视图 */
export type MemoryViewMode = MemoryStatus | 'all'

/** 单条记忆 */
export interface MemoryEntry {
  id: string
  content: string
  type: MemoryType
  source: MemorySource
  created_at: string
  updated_at: string
  hit_count: number
  last_hit_at?: string
  status?: MemoryStatus
  archived_at?: string
  /** 常驻置顶（逃生口）：true = 强制常驻、反思永不自动移动（U1）。 */
  pinned?: boolean
  /** 结构化主语（如「用户画像」）；后端 EntryMeta.Subject 透传 */
  subject?: string
}

/** 容量信息 */
export interface MemoryCapacity {
  used: number
  max: number
  archived?: number
}

/** GET /api/v1/memory 响应 */
export interface MemoryListResponse {
  entries: MemoryEntry[]
  summary: string
  capacity: MemoryCapacity
  legacy_mode?: boolean
  legacy_content?: string
  total?: number
  next_cursor?: string
  has_more?: boolean
}
