import { apiGet, apiPost, apiPut, apiDelete } from './client'
import { fromHttpStatus, fromNativeError } from '@/utils/errors'
import { env } from '@/config/env'
import { DESKTOP_USER_ID } from '@/constants'
import {
  KNOWLEDGE_DISABLED_MESSAGE,
  KNOWLEDGE_ENDPOINT_MISSING_KEYWORDS,
  KNOWLEDGE_UNSUPPORTED_FORMAT_KEYWORDS,
  KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE,
} from '@/config/knowledge-errors'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'

export type { KnowledgeDoc, KnowledgeSearchResult }

const KNOWLEDGE_UPLOAD_PATH = `/api/v1/knowledge/documents?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`

// A selection may contain several individually valid 200 MiB files. Keep the
// aggregate intent bounded as well so every upload entry point shares one
// explicit renderer-side memory/work budget.
export const MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES = 512 * 1024 * 1024

export type KnowledgeUploadResponse = {
  document_id: string
  job_id: string
  text_index_state: 'pending' | 'building' | 'ready' | 'failed'
  vector_index_state: 'disabled' | 'pending' | 'building' | 'ready' | 'failed'
}

function createUploadFormData(file: File): FormData {
  const formData = new FormData()
  formData.append('corpus_id', 'default')
  formData.append('file', file)
  return formData
}

let uploadIntentSequence = 0
const KNOWLEDGE_UPLOAD_INTENTS_STORAGE_KEY = 'hexclaw:knowledge-upload-intents:v2'
let retryIntentSequence = 0
const KNOWLEDGE_RETRY_INTENTS_STORAGE_KEY = 'hexclaw:knowledge-retry-intents:v1'

type PersistedKnowledgeUploadIntent = {
  fingerprint: string
  idempotencyKey: string
  sourceSha256: string
  createdAt: number
}

export type KnowledgeUploadIntent = {
  idempotencyKey: string
  sourceSha256: string
}

export interface KnowledgeUploadOptions {
  signal?: AbortSignal
}

type PersistedKnowledgeRetryIntent = {
  documentId: string
  idempotencyKey: string
  createdAt: number
}

let volatileUploadIntents: PersistedKnowledgeUploadIntent[] = []
let volatileRetryIntents: PersistedKnowledgeRetryIntent[] = []

function createUploadIdempotencyKey(): string {
  uploadIntentSequence += 1
  const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `knowledge-upload:${Date.now().toString(36)}:${uploadIntentSequence.toString(36)}:${randomPart}`
}

function createRetryIdempotencyKey(): string {
  retryIntentSequence += 1
  const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `knowledge-retry:${Date.now().toString(36)}:${retryIntentSequence.toString(36)}:${randomPart}`
}

function uploadIntentFingerprint(file: File, sourceSha256: string): string {
  return JSON.stringify([file.name, file.size, file.type, sourceSha256])
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Unable to read upload for content digest'))
    })
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read upload')),
    )
    reader.readAsArrayBuffer(blob)
  })
}

async function uploadSourceSha256(file: File): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('SHA-256 is unavailable in this runtime')
  const raw = await readBlobBytes(file)
  // A typed-array *view* normalizes WebView/host realm checks without copying
  // the underlying file bytes. Constructing a fresh array and `.set`-ing into
  // it would transiently double memory for large PDFs.
  const digest = await subtle.digest('SHA-256', new Uint8Array(raw))
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

// Hashing and transport deliberately share the same single-lane queue: letting
// upload #2 hash while upload #1 is still sending would keep two full source
// buffers resident even though the network requests themselves were serial.
let knowledgeUploadTail: Promise<void> = Promise.resolve()

function enqueueKnowledgeUpload<T>(operation: () => Promise<T>): Promise<T> {
  const result = knowledgeUploadTail.then(operation)
  knowledgeUploadTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function loadUploadIntents(): PersistedKnowledgeUploadIntent[] {
  try {
    const raw = globalThis.localStorage?.getItem(KNOWLEDGE_UPLOAD_INTENTS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): PersistedKnowledgeUploadIntent[] => {
      if (typeof value !== 'object' || value === null) return []
      const candidate = value as Partial<PersistedKnowledgeUploadIntent>
      if (
        typeof candidate.fingerprint !== 'string' ||
        typeof candidate.idempotencyKey !== 'string' ||
        !candidate.idempotencyKey.startsWith('knowledge-upload:') ||
        typeof candidate.sourceSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(candidate.sourceSha256) ||
        typeof candidate.createdAt !== 'number' ||
        !Number.isFinite(candidate.createdAt) ||
        candidate.createdAt <= 0
      ) {
        return []
      }
      return [candidate as PersistedKnowledgeUploadIntent]
    })
  } catch {
    return volatileUploadIntents
  }
}

function saveUploadIntents(intents: PersistedKnowledgeUploadIntent[]): void {
  volatileUploadIntents = intents
  try {
    if (intents.length === 0) {
      globalThis.localStorage?.removeItem(KNOWLEDGE_UPLOAD_INTENTS_STORAGE_KEY)
    } else {
      globalThis.localStorage?.setItem(
        KNOWLEDGE_UPLOAD_INTENTS_STORAGE_KEY,
        JSON.stringify(intents),
      )
    }
  } catch {
    // A volatile renderer fallback still keeps retries stable until reload.
  }
}

function retainUploadIntent(file: File, sourceSha256: string): PersistedKnowledgeUploadIntent {
  const fingerprint = uploadIntentFingerprint(file, sourceSha256)
  const intents = loadUploadIntents()
  const existing = intents.find((intent) => intent.fingerprint === fingerprint)
  if (existing) {
    saveUploadIntents(intents)
    return existing
  }
  const created = {
    fingerprint,
    idempotencyKey: createUploadIdempotencyKey(),
    sourceSha256,
    createdAt: Date.now(),
  }
  saveUploadIntents([...intents, created])
  return created
}

function releaseUploadIntent(intent: PersistedKnowledgeUploadIntent): void {
  saveUploadIntents(
    loadUploadIntents().filter(
      (candidate) =>
        candidate.fingerprint !== intent.fingerprint ||
        candidate.idempotencyKey !== intent.idempotencyKey,
    ),
  )
}

function loadRetryIntents(): PersistedKnowledgeRetryIntent[] {
  try {
    const raw = globalThis.localStorage?.getItem(KNOWLEDGE_RETRY_INTENTS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): PersistedKnowledgeRetryIntent[] => {
      if (typeof value !== 'object' || value === null) return []
      const candidate = value as Partial<PersistedKnowledgeRetryIntent>
      if (
        typeof candidate.documentId !== 'string' ||
        !candidate.documentId.trim() ||
        typeof candidate.idempotencyKey !== 'string' ||
        !candidate.idempotencyKey.startsWith('knowledge-retry:') ||
        typeof candidate.createdAt !== 'number' ||
        !Number.isFinite(candidate.createdAt) ||
        candidate.createdAt <= 0
      ) {
        return []
      }
      return [candidate as PersistedKnowledgeRetryIntent]
    })
  } catch {
    return volatileRetryIntents
  }
}

function saveRetryIntents(intents: PersistedKnowledgeRetryIntent[]): void {
  volatileRetryIntents = intents
  try {
    if (intents.length === 0) {
      globalThis.localStorage?.removeItem(KNOWLEDGE_RETRY_INTENTS_STORAGE_KEY)
    } else {
      globalThis.localStorage?.setItem(KNOWLEDGE_RETRY_INTENTS_STORAGE_KEY, JSON.stringify(intents))
    }
  } catch {
    // Keep the key stable for retries during this renderer lifetime.
  }
}

function retainRetryIntent(documentId: string): PersistedKnowledgeRetryIntent {
  const intents = loadRetryIntents()
  const existing = intents.find((intent) => intent.documentId === documentId)
  if (existing) {
    saveRetryIntents(intents)
    return existing
  }
  const created = {
    documentId,
    idempotencyKey: createRetryIdempotencyKey(),
    createdAt: Date.now(),
  }
  saveRetryIntents([...intents, created])
  return created
}

function releaseRetryIntent(intent: PersistedKnowledgeRetryIntent): void {
  saveRetryIntents(
    loadRetryIntents().filter(
      (candidate) =>
        candidate.documentId !== intent.documentId ||
        candidate.idempotencyKey !== intent.idempotencyKey,
    ),
  )
}

function normalizeUploadError(status: number, responseText: string): Error {
  let message: string | undefined
  try {
    const body = JSON.parse(responseText) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // ignore non-json responses
  }
  const error = new Error(message ?? fromHttpStatus(status).message) as Error & { status?: number }
  error.status = status
  return error
}

function isDefinitiveKnowledgeUploadRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status =
    (error as { status?: number; statusCode?: number }).status ??
    (error as { status?: number; statusCode?: number }).statusCode
  return (
    typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
  )
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
          (error as { message?: string; error?: string }).error ??
          '')
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
          (error as { message?: string; error?: string }).error ??
          '')
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
  idempotencyKey: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<KnowledgeUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const abortError = () => {
      const error = new Error('Upload aborted')
      error.name = 'AbortError'
      return error
    }
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onSignalAbort)
      complete()
    }
    const onSignalAbort = () => {
      xhr.abort()
      finish(() => reject(abortError()))
    }
    xhr.open('POST', `${env.apiBase}${path}`)
    xhr.setRequestHeader('Idempotency-Key', idempotencyKey)
    xhr.timeout = env.timeout

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
          const response = JSON.parse(xhr.responseText) as KnowledgeUploadResponse
          finish(() => resolve(response))
        } catch {
          finish(() => reject(new Error('Invalid response')))
        }
        return
      }

      finish(() => reject(normalizeUploadError(xhr.status, xhr.responseText)))
    })

    xhr.addEventListener('error', () => finish(() => reject(new Error('Network error'))))
    xhr.addEventListener('timeout', () => finish(() => reject(new Error('Network timeout'))))
    xhr.addEventListener('abort', () => finish(() => reject(abortError())))
    if (signal?.aborted) {
      finish(() => reject(abortError()))
      return
    }
    signal?.addEventListener('abort', onSignalAbort, { once: true })
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
  return apiGet<KnowledgeDoc>(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`).catch(
    (error) => {
      throw normalizeKnowledgeEndpointError(error)
    },
  )
}

/**
 * 获取文档内容：优先请求详情 API，回退到搜索文档标题拼接 chunk。
 *
 * BUG-20260718（§15）：detail/search 都失败时不再返回空串（那会把「取内容故障」
 * 伪装成「真实空文档」），而是抛错让 UI 区分。只有至少一条路径成功、但确实拿不到
 * 正文时才返回 ''（真实空文档）。
 */
export async function getDocumentContent(doc: KnowledgeDoc): Promise<string> {
  let detailError: unknown
  let searchError: unknown

  // 尝试详情接口
  try {
    const detail = await getDocument(doc.id)
    if (detail.content?.trim()) return detail.content
  } catch (e) {
    detailError = e // 详情接口不存在或失败，回退到搜索
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
  } catch (e) {
    searchError = e // 搜索也失败
  }

  // 两条取内容路径都因错误失败（而非确有空文档）→ 抛错，让 UI 显示「加载失败」而非空文档。
  if (detailError && searchError) {
    throw detailError instanceof Error ? detailError : new Error('Failed to load document content')
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
export function uploadDocument(
  file: File,
  onProgress?: (pct: number) => void,
  onIntent?: (intent: KnowledgeUploadIntent) => void,
  options: KnowledgeUploadOptions = {},
): Promise<KnowledgeUploadResponse> {
  return enqueueKnowledgeUpload(() =>
    uploadDocumentExclusive(file, onProgress, onIntent, options),
  )
}

async function uploadDocumentExclusive(
  file: File,
  onProgress?: (pct: number) => void,
  onIntent?: (intent: KnowledgeUploadIntent) => void,
  options: KnowledgeUploadOptions = {},
): Promise<KnowledgeUploadResponse> {
  // Persist before opening the socket. If the server commits but the renderer
  // loses the response, a refresh + reselect of the same immutable file intent
  // reuses this key and receives the original Document/Job instead of creating
  // a parallel generation. Acknowledged HTTP 202 releases the intent.
  if (options.signal?.aborted) {
    const error = new Error('Upload aborted')
    error.name = 'AbortError'
    throw error
  }
  const sourceSha256 = await uploadSourceSha256(file)
  if (options.signal?.aborted) {
    const error = new Error('Upload aborted')
    error.name = 'AbortError'
    throw error
  }
  const intent = retainUploadIntent(file, sourceSha256)
  onIntent?.({ idempotencyKey: intent.idempotencyKey, sourceSha256: intent.sourceSha256 })
  try {
    let accepted: KnowledgeUploadResponse
    if (onProgress) {
      accepted = await uploadViaXhr(
        file,
        KNOWLEDGE_UPLOAD_PATH,
        intent.idempotencyKey,
        onProgress,
        options.signal,
      )
    } else {
      accepted = await apiPost<KnowledgeUploadResponse>(
        KNOWLEDGE_UPLOAD_PATH,
        createUploadFormData(file),
        {
          headers: { 'Idempotency-Key': intent.idempotencyKey },
          timeout: false,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
    }
    releaseUploadIntent(intent)
    return accepted
  } catch (error) {
    if (isDefinitiveKnowledgeUploadRejection(error)) releaseUploadIntent(intent)
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (isKnowledgeUploadEndpointMissing(normalized)) {
      throw new Error(KNOWLEDGE_UPLOAD_UNAVAILABLE_MESSAGE)
    }
    throw normalized
  }
}

/**
 * Retry the durable failed generation. The key is persisted before opening
 * the request so a renderer refresh after an unknown response replays the
 * exact same backend job instead of starting another OCR/index pipeline.
 */
export async function retryKnowledgeDocument(id: string): Promise<KnowledgeUploadResponse> {
  const documentId = id.trim()
  if (!documentId) throw new Error('document_id is required')
  const intent = retainRetryIntent(documentId)
  try {
    const accepted = await apiPost<KnowledgeUploadResponse>(
      `/api/v1/knowledge/documents/${encodeURIComponent(documentId)}/retry`,
      undefined,
      { headers: { 'Idempotency-Key': intent.idempotencyKey } },
    )
    releaseRetryIntent(intent)
    return accepted
  } catch (error) {
    if (isDefinitiveKnowledgeUploadRejection(error)) releaseRetryIntent(intent)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** 删除知识库文档 */
export function deleteDocument(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`)
}

function normalizeKnowledgeSearchResults(payload: unknown): KnowledgeSearchResult[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
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
      })
      .filter((item) => item.content)
  }

  if (typeof payload === 'string' && payload.trim()) {
    return [
      {
        content: payload.trim(),
        score: 1,
        metadata: { legacy: true },
      },
    ]
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
export async function searchKnowledge(
  query: string,
  topK?: number,
  filter?: KnowledgeSearchFilter,
) {
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
