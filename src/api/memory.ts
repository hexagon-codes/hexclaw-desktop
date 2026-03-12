import { apiGet, apiPost, apiDelete } from './client'
import type { MemoryEntry } from '@/types'

export type { MemoryEntry }

/** 获取记忆列表 */
export function getMemories(query?: { type?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (query?.type) params.set('type', query.type)
  if (query?.limit) params.set('limit', String(query.limit))
  const qs = params.toString()
  return apiGet<{ memories: MemoryEntry[]; total: number }>(`/api/v1/memory${qs ? '?' + qs : ''}`)
}

/** 搜索记忆 */
export function searchMemory(query: string, limit?: number) {
  return apiPost<{ memories: MemoryEntry[] }>('/api/v1/memory/search', { query, limit })
}

/** 删除记忆 */
export function deleteMemory(id: string) {
  return apiDelete(`/api/v1/memory/${id}`)
}

/** 清空全部记忆 */
export function clearMemory() {
  return apiDelete('/api/v1/memory')
}
