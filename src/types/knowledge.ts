/** 知识库文档（后端返回） */
export interface KnowledgeDoc {
  id: string
  title: string
  content?: string
  source?: string
  chunk_count: number
  created_at: string
  updated_at?: string
  status?: 'processing' | 'indexed' | 'failed'
  error_message?: string
  source_type?: string
}

/** 知识库搜索结果 */
export interface KnowledgeSearchResult {
  content: string
  score: number
  doc_id?: string
  doc_title?: string
  source?: string
  chunk_id?: string
  chunk_index?: number
  chunk_count?: number
  created_at?: string
  metadata?: Record<string, unknown>
}
