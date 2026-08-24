/** 文本索引状态；保留未知字符串以兼容后端新增状态。 */
export type KnowledgeTextIndexState =
  | 'pending'
  | 'building'
  | 'ready'
  | 'failed'
  | (string & {})

/** 视觉模型冻结快照。 */
export interface KnowledgeFrozenVisionProjection {
  provider?: string | null
  model?: string | null
}

/** 视觉预检结果。 */
export interface KnowledgePreflightProjection {
  state?: string | null
  blocked?: boolean | null
}

/** 摄取阶段的结构化投影；字段缺失时由调用方保留现有状态。 */
export interface KnowledgeProjectionFields {
  text_index_state?: KnowledgeTextIndexState | null
  ingestion_state?: string | null
  failure_code?: string | null
  affected_pages?: number | number[] | null
  frozen_vision_provider?: string | null
  frozen_vision_model?: string | null
  preflight_state?: string | null
  model_calls?: number | null
  available_actions?: string[] | null
}

/** 文档与任务共用的结构化投影。 */
export interface KnowledgeStructuredProjection extends KnowledgeProjectionFields {
  ingestion?: (KnowledgeProjectionFields & {
    state?: string | null
    frozen_vision?: KnowledgeFrozenVisionProjection | null
    preflight?: KnowledgePreflightProjection | string | null
  }) | null
}

/** 兼容摄取/索引 Job 响应的结构化部分。 */
export type KnowledgeJobProjection = KnowledgeStructuredProjection

/** 知识库文档（后端返回） */
export interface KnowledgeDoc extends KnowledgeStructuredProjection {
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
  document_generation?: number
  revision_id?: string
  doc_title?: string
  source?: string
  chunk_id?: string
  chunk_index?: number
  chunk_count?: number
  page_start?: number
  page_end?: number
  source_digest?: string
  citation_digest?: string
  source_offset_start?: number
  source_offset_end?: number
  created_at?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeQueryEmbeddingReceipt {
  operation: string
  status: string
  provider_id: string
  provider_name?: string
  model: string
  profile_id: string
  profile_config_hash: string
  dimension: number
  revision_id: string
  query_digest: string
}
