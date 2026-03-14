import { apiGet, apiPost, apiDelete } from './client'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'

export type { KnowledgeDoc, KnowledgeSearchResult }

/** 获取知识库文档列表 */
export function getDocuments() {
  return apiGet<{ documents: KnowledgeDoc[]; total: number }>('/api/v1/knowledge/documents')
}

/** 添加文档到知识库 */
export function addDocument(title: string, content: string, source?: string) {
  return apiPost<{ id: string; title: string; chunk_count: number; created_at: string }>(
    '/api/v1/knowledge/documents',
    { title, content, source },
  )
}

/** 删除知识库文档 */
export function deleteDocument(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`)
}

/** 搜索知识库 */
export function searchKnowledge(query: string, topK?: number) {
  return apiPost<{ result: KnowledgeSearchResult[] }>('/api/v1/knowledge/search', {
    query,
    top_k: topK ?? 3,
  })
}
