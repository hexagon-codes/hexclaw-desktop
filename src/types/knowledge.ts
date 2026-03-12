/** 知识库文档 */
export interface KnowledgeDoc {
  id: string
  filename: string
  content_type: string
  size: number
  chunk_count: number
  status: 'processing' | 'ready' | 'error'
  created_at: string
  error?: string
}

/** 知识库统计 */
export interface KnowledgeStats {
  total_docs: number
  total_chunks: number
  total_size: number
}
