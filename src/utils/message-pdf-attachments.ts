import { api } from '@/api/client'
import type { ChatMessage } from '@/types'
import { chatAttachmentSource } from '@/utils/chat-compose'
import { fileTypeInfo } from '@/utils/file-type-icon'

export interface MessagePdfAttachment {
  id: string
  filename: string
  url: string
  key: string
  mime?: string
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

/** 只投影消息已有文件引用，不按正文内容推断或另建报告。 */
export function messageFileAttachments(message: ChatMessage): MessagePdfAttachment[] {
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
    const isDocument = ref.kind === 'document_export'
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
      mime: isPrint ? 'application/pdf' : typeof ref.mime === 'string' ? ref.mime : undefined,
      read: (signal) => api<Blob, 'blob'>(url, { method: 'GET', responseType: 'blob', signal }),
    })
  }
  for (const value of artifactReferences(message.metadata?.attachments)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const attachment = value as Record<string, unknown>
    if (attachment.type !== 'file' || typeof attachment.name !== 'string') continue
    if (typeof attachment.mime === 'string' && /^(image|audio|video)\//i.test(attachment.mime)) continue
    const url = chatAttachmentSource(attachment)
    if (!url || result.some((item) => item.url === url || item.id === attachment.attachment_id)) continue
    const identity = typeof attachment.attachment_id === 'string' ? attachment.attachment_id : url
    result.push({
      id: identity, filename: attachment.name, url,
      key: `${identity}\u0000${String(attachment.byte_digest ?? '')}`,
      mime: typeof attachment.mime === 'string' ? attachment.mime : undefined,
      read: async (signal) => {
        if (signal.aborted) throw new DOMException('File read aborted', 'AbortError')
        if (url.startsWith('data:')) return (await fetch(url, { signal })).blob()
        if (attachment.data === url && !/^(?:https?:|\/)/i.test(url)) {
          const bytes = Uint8Array.from(atob(url), (value) => value.charCodeAt(0))
          return new Blob([bytes], { type: typeof attachment.mime === 'string' ? attachment.mime : '' })
        }
        return api<Blob, 'blob'>(url, { method: 'GET', responseType: 'blob', signal })
      },
    })
  }
  return result
}

export function messagePdfAttachments(message: ChatMessage): MessagePdfAttachment[] {
  return messageFileAttachments(message).filter((file) => fileTypeInfo(file.filename, file.mime).isPdf)
}
