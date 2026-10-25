import { api, apiPost } from './client'
import { env } from '@/config/env'
import { assertBackendActive, backendScopeKey } from '@/services/backend-context'

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
  const grantFromNative = nativeGrantFromFile(file)
  if (grantFromNative && grantFromNative.purpose !== 'attachment_upload') {
    throw new Error('Native document grant purpose is invalid')
  }
  if (isTauri()) {
    const grant = grantFromNative ?? await stageBlob(file, file.name, {
      purpose: 'attachment_upload',
      operationId: createNativeFileOperation('document-extract'),
    })
    if (!/^[0-9a-f]{64}$/.test(grant.sourceSha256 ?? '')) {
      throw new Error('Native document grant is missing its attested source digest')
    }
    const transfer = await uploadGrantedFile<ExtractedDocument>({
      grant,
      url: DOCUMENT_EXTRACT_PATH,
      idempotencyKey: `document-extract:${grant.sourceSha256}`,
      fieldName: 'file',
    })
    if (!transfer.body) throw new Error('Document extraction returned no response')
    return transfer.body
  }
  const form = new FormData()
  form.append('file', file)
  return apiPost<ExtractedDocument>(DOCUMENT_EXTRACT_PATH, form)
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
import { isTauri } from '@/utils/platform'
import {
  createNativeFileOperation,
  nativeGrantFromFile,
  stageBlob,
  uploadGrantedFile,
} from './native-files'

const DOCUMENT_EXTRACT_PATH = '/api/v1/documents/extract'

export interface RenderReq {
  content: string
  format: 'pdf' | 'docx' | 'html'
  title?: string
  /** PDF默认采用共享版式，仅当次明确请求可覆盖，不改变其他格式。 */
  options?: {
    Locale?: string
    pdf_header_footer?: boolean
    pdf_layout?: 'standard' | 'custom'
  }
}

/** 将Markdown发送到平台渲染服务；返回当前连接的真实文档字节，失败保留原错误。 */
export async function renderDocument(
  req: RenderReq,
  connectionScope = backendScopeKey(),
): Promise<Blob> {
  const blob = await api<Blob, 'blob'>('/api/v1/render', {
    method: 'POST',
    body: req,
    responseType: 'blob',
    timeout: 120_000,
    headers: { 'x-hexclaw-connection-scope': connectionScope },
  })
  assertBackendActive(connectionScope)
  await assertRenderedDocument(blob, req.format)
  return blob
}

/** 格式核验沿用原合同，防止错误正文被保存为文档。 */
async function assertRenderedDocument(blob: Blob, format: RenderReq['format']): Promise<void> {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error(`render 返回空的 ${format.toUpperCase()} 文件`)
  }
  const mime = blob.type.toLowerCase()
  if (mime.includes('json')) {
    throw new Error(`render 返回错误 JSON，不能保存为 ${format.toUpperCase()} 文件`)
  }
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  if (format === 'pdf') {
    const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2d]
    if (!pdfMagic.every((value, index) => bytes[index] === value)) {
      throw new Error('render 返回的 PDF 文件格式无效（缺少 %PDF- magic）')
    }
    return
  }
  if (format === 'docx') {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    if (!isZip) {
      throw new Error('render 返回的 DOCX 文件格式无效（缺少 ZIP magic）')
    }
    return
  }
  const prefix = new TextDecoder().decode(bytes).trimStart().toLowerCase()
  if (!prefix.startsWith('<!doctype') && !prefix.startsWith('<html')) {
    throw new Error('render 返回的 HTML 文件格式无效')
  }
}
