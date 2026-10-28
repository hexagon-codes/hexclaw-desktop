import { api } from '@/api/client'
import type { ChatMessage } from '@/types'

export interface MessagePdfAttachment {
  id: string
  filename: string
  url: string
  key: string
  read: (signal: AbortSignal) => Promise<Blob>
}

function artifactReferences(value: unknown): unknown[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value : []
}

function documentAttachmentReferences(value: unknown): unknown[] {
  return artifactReferences(value).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const attachment = value as Record<string, unknown>
    if (
      attachment.type !== 'file' ||
      attachment.mime !== 'application/pdf' ||
      typeof attachment.attachment_id !== 'string' ||
      !attachment.attachment_id.startsWith('document-')
    ) return []
    return [{
      ...attachment,
      kind: 'document_export',
      artifact_id: attachment.attachment_id,
    }]
  })
}

/** 只投影消息已经冻结的 PDF 引用，不按正文内容推断或另建报告。 */
export function messagePdfAttachments(message: ChatMessage): MessagePdfAttachment[] {
  if (message.role !== 'assistant') return []
  const refs = [
    ...artifactReferences(message.metadata?.print_artifacts),
    ...artifactReferences(message.metadata?.document_artifacts),
    ...artifactReferences(message.metadata?.artifacts),
    // 历史接口的正式附件投影自带持久文档身份，不要求公开内部存储元数据。
    ...documentAttachmentReferences(message.metadata?.attachments),
  ]
  const seen = new Set<string>()
  const result: MessagePdfAttachment[] = []
  for (const value of refs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const ref = value as Record<string, unknown>
    const isPrint = ref.kind === 'print_artifact'
    const isDocument = ref.kind === 'document_export' && ref.mime === 'application/pdf'
    if (
      (!isPrint && !isDocument) ||
      typeof ref.artifact_id !== 'string' ||
      typeof ref.name !== 'string' ||
      typeof ref.url !== 'string' ||
      !ref.artifact_id ||
      !ref.name ||
      !ref.url ||
      (isPrint && (typeof ref.agent_name !== 'string' || !ref.agent_name))
    )
      continue
    const identity = isPrint
      ? `${ref.agent_name}\u0000${ref.artifact_id}`
      : `document_export\u0000${ref.artifact_id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const url = ref.url
    result.push({
      id: ref.artifact_id,
      filename: ref.name,
      url,
      key: `${identity}\u0000${String(ref.byte_digest ?? '')}`,
      read: (signal) => api<Blob, 'blob'>(url, { method: 'GET', responseType: 'blob', signal }),
    })
  }
  return result
}
