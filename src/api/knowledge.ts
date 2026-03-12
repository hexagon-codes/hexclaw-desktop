import { apiGet, apiPost, apiDelete } from './client'
import type { KnowledgeDoc, KnowledgeStats } from '@/types'

export type { KnowledgeDoc, KnowledgeStats }

/** 获取知识库文档列表 */
export function getDocuments() {
  return apiGet<{ documents: KnowledgeDoc[]; stats: KnowledgeStats }>('/api/v1/knowledge')
}

/** 上传文档 */
export function uploadDocument(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return apiPost<KnowledgeDoc>('/api/v1/knowledge/upload', formData)
}

/** 删除文档 */
export function deleteDocument(id: string) {
  return apiDelete(`/api/v1/knowledge/${id}`)
}
