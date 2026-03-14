/** 知识库文档（后端返回） */
export interface KnowledgeDoc {
  id: string
  title: string
  content?: string
  source?: string
  chunk_count: number
  created_at: string
}

/** 知识库搜索结果 */
export interface KnowledgeSearchResult {
  content: string
  score: number
  metadata?: Record<string, unknown>
}
