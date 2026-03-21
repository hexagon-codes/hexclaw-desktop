import { apiGet, apiPost, apiDelete } from './client'
import { fromHttpStatus } from '@/utils/errors'
import { env } from '@/config/env'
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

/** 上传文件到知识库（支持 PDF/TXT/MD/DOCX） */
export async function uploadDocument(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ id: string; title: string; chunk_count: number; created_at: string }> {
  const formData = new FormData()
  formData.append('file', file)

  if (onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${env.apiBase}/api/v1/knowledge/upload`)

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText))
          } catch {
            reject(new Error('Invalid response'))
          }
        } else {
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string }
            reject(new Error(body.error || fromHttpStatus(xhr.status).message))
          } catch {
            reject(new Error(fromHttpStatus(xhr.status).message))
          }
        }
      })

      xhr.addEventListener('error', () => reject(new Error('Network error')))
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')))
      xhr.send(formData)
    })
  }

  return apiPost<{ id: string; title: string; chunk_count: number; created_at: string }>(
    '/api/v1/knowledge/upload',
    formData,
  )
}

/** 删除知识库文档 */
export function deleteDocument(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`)
}

function normalizeKnowledgeSearchResults(payload: unknown): KnowledgeSearchResult[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => {
      const result = item as Partial<KnowledgeSearchResult>
      return {
        content: typeof result.content === 'string' ? result.content : '',
        score: typeof result.score === 'number' ? result.score : 0,
        doc_id: typeof result.doc_id === 'string' ? result.doc_id : undefined,
        doc_title: typeof result.doc_title === 'string' ? result.doc_title : undefined,
        source: typeof result.source === 'string' ? result.source : undefined,
        chunk_id: typeof result.chunk_id === 'string' ? result.chunk_id : undefined,
        chunk_index: typeof result.chunk_index === 'number' ? result.chunk_index : undefined,
        chunk_count: typeof result.chunk_count === 'number' ? result.chunk_count : undefined,
        created_at: typeof result.created_at === 'string' ? result.created_at : undefined,
        metadata: result.metadata,
      }
    }).filter((item) => item.content)
  }

  if (typeof payload === 'string' && payload.trim()) {
    return [{
      content: payload.trim(),
      score: 1,
      metadata: { legacy: true },
    }]
  }

  return []
}

/** 搜索知识库 */
export async function searchKnowledge(query: string, topK?: number) {
  const response = await apiPost<{ result?: KnowledgeSearchResult[] | string; results?: KnowledgeSearchResult[] | string }>(
    '/api/v1/knowledge/search',
    {
      query,
      top_k: topK ?? 3,
    },
  )

  return {
    result: normalizeKnowledgeSearchResults(response.result ?? response.results),
  }
}

/** 触发单个知识文档重建索引 */
export function reindexDocument(id: string) {
  return apiPost<{ status?: string; message?: string }>(`/api/v1/knowledge/documents/${encodeURIComponent(id)}/reindex`)
}
