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
  vector_index_state?:
    | 'disabled'
    | 'pending'
    | 'building'
    | 'retry_wait'
    | 'ready'
    | 'failed'
    | 'cancelled'
  vector_job_id?: string
  vector_job_state?: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled'
  vector_job_stage?: string
  vector_chunks_done?: number
  vector_chunks_total?: number
  vector_error?: string
  vector_outcome_unknown?: boolean
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
