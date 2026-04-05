import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { MemoryData } from '@/types'

export type { MemoryData }

/** 获取记忆内容 */
export function getMemory() {
  return apiGet<MemoryData>('/api/v1/memory')
}

/** 保存记忆 */
export function saveMemory(content: string, type?: 'memory' | 'daily') {
  return apiPost<{ message: string }>('/api/v1/memory', { content, type: type ?? 'memory' })
}

/** 更新记忆内容 */
export function updateMemory(content: string, type?: 'memory' | 'daily') {
  return apiPut<{ message: string }>('/api/v1/memory', { content, type: type ?? 'memory' })
}

/** 删除单条记忆 */
export function deleteMemory(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}`)
}

/** 清空所有记忆 */
export function clearAllMemory() {
  return apiDelete<{ message: string }>('/api/v1/memory')
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  content: string
  score: number
  source: string
}

/** 搜索记忆 (关键词 + 语义) */
export function searchMemory(query: string) {
  return apiGet<{
    results: string[]
    vector_results: VectorSearchResult[] | null
    total: number
  }>('/api/v1/memory/search', { q: query })
}
