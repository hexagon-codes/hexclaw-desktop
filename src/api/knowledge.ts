import { apiGet, apiPost, apiDelete } from './client'
import { fromHttpStatus, fromNativeError } from '@/utils/errors'
import { env } from '@/config/env'
import type { KnowledgeDoc, KnowledgeSearchResult } from '@/types'

export type { KnowledgeDoc, KnowledgeSearchResult }

const KNOWLEDGE_UPLOAD_PATH = '/api/v1/knowledge/upload'
const KNOWLEDGE_DISABLED_MESSAGE =
  '知识库暂不可用，请重启应用后重试'

type UploadResponse = { id: string; title: string; chunk_count: number; created_at: string }

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
    msg.includes('未提供知识库上传接口') ||
    msg.includes('未启用知识库')
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
    message.includes('不支持') ||
    message.includes('格式错误') ||
    message.includes('文件类型错误') ||
    message.includes('文件格式错误')

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

/** 获取知识库文档列表 */
export function getDocuments() {
  return apiGet<{ documents: KnowledgeDoc[]; total: number }>('/api/v1/knowledge/documents')
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

/** 上传文件到知识库（支持 PDF/TXT/MD/DOCX） */
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
      throw new Error('当前后端未提供知识库上传接口，请检查 HexClaw 后端版本')
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

/** 搜索知识库 */
export async function searchKnowledge(query: string, topK?: number) {
  const response = await apiPost<{
    result?: KnowledgeSearchResult[] | string
    results?: KnowledgeSearchResult[] | string
  }>('/api/v1/knowledge/search', {
    query,
    top_k: topK ?? 3,
  }).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })

  return {
    result: normalizeKnowledgeSearchResults(response.result ?? response.results),
  }
}

/** 触发单个知识文档重建索引 */
export function reindexDocument(id: string) {
  return apiPost<{ status?: string; message?: string }>(
    `/api/v1/knowledge/documents/${encodeURIComponent(id)}/reindex`,
  ).catch((error) => {
    throw normalizeKnowledgeEndpointError(error)
  })
}
