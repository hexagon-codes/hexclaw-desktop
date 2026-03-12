/** 记忆条目 */
export interface MemoryEntry {
  id: string
  content: string
  type: string
  source: string
  importance: number
  created_at: string
  metadata?: Record<string, unknown>
}
