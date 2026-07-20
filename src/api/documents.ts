import { apiPost } from './client'
import { env } from '@/config/env'

export interface ExtractedDocument {
  text: string
  file_name: string
  page_count?: number
}

/**
 * 上传文档到后端解析为纯文本。
 *
 * PDF 在桌面 WKWebView 前端解析不可靠（无法从 tauri:// 自定义协议创建 Web Worker），
 * 故下沉到后端（复用 hexagon rag/loader）。docx/xlsx 等纯 JS 库仍在前端解析。
 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const form = new FormData()
  form.append('file', file)
  return apiPost<ExtractedDocument>('/api/v1/documents/extract', form)
}

/** 暂存原文件到 sidecar，返回预览 token。 */
export async function uploadDocumentPreview(file: File): Promise<{ token: string }> {
  const form = new FormData()
  form.append('file', file)
  return apiPost<{ token: string }>('/api/v1/documents/preview', form)
}

/**
 * 原文件的 http://localhost 直链（供 shell open 渲染/下载）。
 * 必须是绝对 localhost 地址：shell:allow-open 仅放行 http://localhost:*。
 *
 * BUG-20260718（§15）：改用运行时 env.apiBase（本身即绝对 localhost 地址，端口随
 * sidecar 动态分配变化），不再硬编码 localhost:16060——否则动态端口下预览失效/串实例。
 */
export function documentPreviewUrl(token: string, download = false): string {
  return `${env.apiBase}/api/v1/documents/preview/${encodeURIComponent(token)}${download ? '?dl=1' : ''}`
}
