import { apiGet, apiPost } from './client'
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

/** 搜索记忆 */
export function searchMemory(query: string) {
  return apiGet<{ results: string[]; total: number }>('/api/v1/memory/search', { q: query })
}
