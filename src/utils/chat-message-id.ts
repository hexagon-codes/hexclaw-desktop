import type { ChatMessage } from '@/types'

export function backendDeletableMessageId(message: ChatMessage): string {
  const backendId = message.metadata?.backend_message_id
  return typeof backendId === 'string' && backendId.trim() ? backendId.trim() : message.id
}
