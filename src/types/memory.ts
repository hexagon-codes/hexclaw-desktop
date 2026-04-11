/** 记忆类型 */
export type MemoryType = 'identity' | 'preference' | 'fact' | 'instruction' | 'context'

/** 记忆来源 */
export type MemorySource = 'manual' | 'chat_explicit' | 'chat_extract' | 'system'

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
