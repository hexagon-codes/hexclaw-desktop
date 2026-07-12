import { apiGet, apiPost, apiPut, apiDelete } from './client'
import { fromHttpStatus, fromNativeError } from '@/utils/errors'
import { env } from '@/config/env'
import {
  KNOWLEDGE_DISABLED_MESSAGE,
  KNOWLEDGE_ENDPOINT_MISSING_KEYWORDS,
  KNOWLEDGE_UNSUPPORTED_FORMAT_KEYWORDS,
  KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE,
} from '@/config/knowledge-errors'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'

export type { KnowledgeDoc, KnowledgeSearchResult }

const KNOWLEDGE_UPLOAD_PATH = '/api/v1/knowledge/upload'

type UploadResponse = {
  id: string
  title: string
  chunk_count: number
  created_at: string
  source_type?: string
  warnings?: string[]
}

function createUploadFormData(file: File): FormData {
  const formData = new FormData()
  formData.append('file', file)
  return formData
}

function normalizeUploadError(status: number, responseText: string): Error {
  try {
    const body = JSON.parse(responseText) as { error?: string }
    if (body.error) return new Error(body.error)
  } catch {
    // ignore non-json responses
  }

  return new Error(fromHttpStatus(status).message)
}

function normalizeKnowledgeEndpointError(error: unknown): Error {
  const rawStatus =
    typeof error === 'object' && error !== null
      ? ((error as { status?: number; statusCode?: number }).status ??
        (error as { status?: number; statusCode?: number }).statusCode)
      : undefined

  if (rawStatus === 404 || rawStatus === 405) {
    return new Error(KNOWLEDGE_DISABLED_MESSAGE)
  }

  const normalized = fromNativeError(error)

  if (normalized.status === 404 || normalized.status === 405) {
    return new Error(KNOWLEDGE_DISABLED_MESSAGE)
  }

  return error instanceof Error ? error : new Error(normalized.message)
}

export function isKnowledgeUploadEndpointMissing(error: unknown): boolean {
  const rawStatus =
    typeof error === 'object' && error !== null
      ? ((error as { status?: number; statusCode?: number }).status ??
        (error as { status?: number; statusCode?: number }).statusCode)
      : undefined
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? ((error as { message?: string; error?: string }).message ??
          (error as { message?: string; error?: string }).error ?? '')
        : String(error)
  return (
    rawStatus === 404 ||
    rawStatus === 405 ||
    msg === fromHttpStatus(404).message ||
    msg === fromHttpStatus(405).message ||
    msg.includes('404') ||
    msg.includes('405') ||
    KNOWLEDGE_ENDPOINT_MISSING_KEYWORDS.some((keyword) => msg.includes(keyword))
  )
}

export function isKnowledgeUploadUnsupportedFormat(error: unknown): boolean {
  const rawStatus =
    typeof error === 'object' && error !== null
      ? ((error as { status?: number; statusCode?: number }).status ??
        (error as { status?: number; statusCode?: number }).statusCode)
      : undefined
  // 从 Error 实例或 plain object 提取消息文本
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? ((error as { message?: string; error?: string }).message ??
          (error as { message?: string; error?: string }).error ?? '')
        : String(error)
  const message = rawMessage.toLowerCase()

  // 415/422 一定是格式问题；400 需要结合消息内容判断（后端对 validation 错误也返回 400）
  const isFormatKeyword =
    message.includes('unsupported') ||
    message.includes('not supported') ||
    message.includes('invalid file type') ||
    message.includes('invalid mime') ||
    KNOWLEDGE_UNSUPPORTED_FORMAT_KEYWORDS.some((keyword) => message.includes(keyword))

  return (
    rawStatus === 415 ||
    rawStatus === 422 ||
    (rawStatus === 400 && isFormatKeyword) ||
    isFormatKeyword
  )
}

function uploadViaXhr(
  file: File,
  path: string,
  onProgress?: (pct: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${env.apiBase}${path}`)

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid response'))
        }
        return
      }

      reject(normalizeUploadError(xhr.status, xhr.responseText))
    })

    xhr.addEventListener('error', () => reject(new Error('Network error')))
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')))
    xhr.send(createUploadFormData(file))
  })
}

export interface KnowledgeSourceCount {
  source: string
  count: number
}

export interface KnowledgeDocumentListParams {
  source?: string
  limit?: number
  offset?: number
}

export interface KnowledgeDocumentListResponse {
  documents: KnowledgeDoc[]
  total: number
  limit?: number
  offset?: number
  sources?: KnowledgeSourceCount[]
}

/** 获取知识库文档列表；普通列表走服务端分页，省略 limit 时保留旧版全量语义。 */
export function getDocuments(params?: KnowledgeDocumentListParams) {
  if (!params) return apiGet<KnowledgeDocumentListResponse>('/api/v1/knowledge/documents')
  return apiGet<KnowledgeDocumentListResponse>('/api/v1/knowledge/documents', { ...params })
}

/** 获取单个知识文档详情（含正文内容） */
export async function getDocument(id: string): Promise<KnowledgeDoc> {
  return apiGet<KnowledgeDoc>(
    `/api/v1/knowledge/documents/${encodeURIComponent(id)}`,
  ).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}

/**
 * 获取文档内容：优先请求详情 API，回退到搜索文档标题拼接 chunk
 */
export async function getDocumentContent(doc: KnowledgeDoc): Promise<string> {
  // 尝试详情接口
  try {
    const detail = await getDocument(doc.id)
    if (detail.content?.trim()) return detail.content
  } catch {
    // 详情接口不存在或失败，回退到搜索
  }

  // 回退：通过知识库搜索获取该文档的 chunk 内容
  try {
    const { result } = await searchKnowledge(doc.title, doc.chunk_count || 5)
    const docChunks = result
      .filter((hit) => hit.doc_id === doc.id || hit.doc_title === doc.title)
      .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))
    if (docChunks.length > 0) {
      return docChunks.map((chunk) => chunk.content).join('\n\n')
    }
  } catch {
    // 搜索也失败
  }

  return ''
}

/** 添加文档到知识库 */
export function addDocument(title: string, content: string, source?: string) {
  return apiPost<{ id: string; title: string; chunk_count: number; created_at: string }>(
    '/api/v1/knowledge/documents',
    { title, content, source },
  ).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}

/** 上传文件到知识库（后端白名单见 handler_knowledge.go：文本/Office/PDF/图片格式） */
export async function uploadDocument(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResponse> {
  try {
    if (onProgress) {
      return await uploadViaXhr(file, KNOWLEDGE_UPLOAD_PATH, onProgress)
    }
    return await apiPost<UploadResponse>(KNOWLEDGE_UPLOAD_PATH, createUploadFormData(file))
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (isKnowledgeUploadEndpointMissing(normalized)) {
      throw new Error(KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE)
    }
    throw normalized
  }
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

/** 知识库检索的元数据过滤（可选）：维度间 AND、维度内 OR、留空=不过滤 */
export interface KnowledgeSearchFilter {
  sources?: string[] // 按文档来源精确匹配
  sourceTypes?: string[] // manual / upload / url / file / agent
  createdAfter?: string // 文档创建时间下界，RFC3339 或 YYYY-MM-DD
  createdBefore?: string // 文档创建时间上界，RFC3339 或 YYYY-MM-DD
}

/** 搜索知识库（可选元数据过滤：源 / 源类型 / 创建日期，留空则全量检索） */
export async function searchKnowledge(query: string, topK?: number, filter?: KnowledgeSearchFilter) {
  const body: Record<string, unknown> = { query, top_k: topK ?? 3 }
  if (filter) {
    if (filter.sources?.length) body.sources = filter.sources
    if (filter.sourceTypes?.length) body.source_types = filter.sourceTypes
    if (filter.createdAfter) body.created_after = filter.createdAfter
    if (filter.createdBefore) body.created_before = filter.createdBefore
  }

  // 防御性双兼容：后端 Fix 16 返回 "results"（复数），但保留对历史 "result"（单数）的兜底，
  // 既有回归锁断言两字段都要兼容（code-review-v8 / comprehensive-api-layer）。
  const response = await apiPost<{
    result?: KnowledgeSearchResult[] | string
    results?: KnowledgeSearchResult[] | string
  }>('/api/v1/knowledge/search', body).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })

  return {
    result: normalizeKnowledgeSearchResults(response.result ?? response.results),
  }
}

/**
 * 检索质量参数（检索参数面板）。即时生效：rerank/query_expand/contextual 开关、min_score、
 * candidate_k；rerank_model 换模型走「重启 sidecar 生效」（专用重排器在启动时注入）。
 */
export interface KnowledgeConfig {
  rerank: boolean
  rerank_model: string
  query_expand: boolean
  contextual: boolean
  min_score: number
  candidate_k: number
}

/** PUT 响应：在 KnowledgeConfig 基础上附带 rerank_model 是否变更需重启的标志。 */
export interface KnowledgeConfigPutResult extends KnowledgeConfig {
  rerank_model_restart_required?: boolean
}

/** 读取当前生效的检索质量参数 */
export function getKnowledgeConfig(): Promise<KnowledgeConfig> {
  return apiGet<KnowledgeConfig>('/api/v1/knowledge/config').catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}

/** 保存检索质量参数（全量替换；即时热生效 + 落盘持久化） */
export function putKnowledgeConfig(cfg: KnowledgeConfig): Promise<KnowledgeConfigPutResult> {
  return apiPut<KnowledgeConfigPutResult>('/api/v1/knowledge/config', { ...cfg }).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}

/** 触发单个知识文档重建索引 */
export function reindexDocument(id: string) {
  return apiPost<{ status?: string; message?: string; chunk_count?: number; updated_at?: string }>(
    `/api/v1/knowledge/documents/${encodeURIComponent(id)}/reindex`,
  ).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}

// ── 嵌入接线状态（BUG-20260712-B1 嵌入开箱保证）─────────────────────────────
// ready=false 时会话自动注入休眠（fail-closed）；local+未装 → 前端一键 pull `model` 激活。
export interface KnowledgeEmbeddingStatus {
  enabled: boolean
  configured: boolean
  provider?: string
  model?: string
  local: boolean
  ready: boolean
  pulling: boolean // 首启静默安装进行中（三态机制：此态前端零打扰仅轮询）
}

export function getKnowledgeEmbeddingStatus() {
  return apiGet<KnowledgeEmbeddingStatus>('/api/v1/knowledge/embedding-status')
}
