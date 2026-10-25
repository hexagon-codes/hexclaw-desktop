import { api } from '@/api/client'
import type { ChatMessage } from '@/types'

export interface MessagePdfAttachment {
  id: string
  filename: string
  url: string
  key: string
  read: (signal: AbortSignal) => Promise<Blob>
}

/** 只投影消息已经冻结的报告引用，不按正文内容推断或另建报告。 */
export function messagePdfAttachments(message: ChatMessage): MessagePdfAttachment[] {
  if (message.role !== 'assistant') return []
  let refs: unknown = message.metadata?.print_artifacts
  if (typeof refs === 'string') {
    try {
      refs = JSON.parse(refs)
    } catch {
      return []
    }
  }
  if (!Array.isArray(refs)) return []
  const seen = new Set<string>()
  const result: MessagePdfAttachment[] = []
  for (const value of refs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const ref = value as Record<string, unknown>
    if (
      ref.kind !== 'print_artifact' ||
      typeof ref.artifact_id !== 'string' ||
      typeof ref.agent_name !== 'string' ||
      typeof ref.name !== 'string' ||
      typeof ref.url !== 'string' ||
      !ref.artifact_id ||
      !ref.agent_name ||
      !ref.name
    )
      continue
    const identity = `${ref.agent_name}\u0000${ref.artifact_id}`
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
