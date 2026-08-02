import { sendViaBackend, type WebSocketCompatResponse } from '@/services/chat-service-compat'
import type { ChatAttachment } from '@/types'

export type BackendChatResponse = WebSocketCompatResponse

export interface CompatChatRequest {
  message: string
  sessionId?: string
  session_id?: string
  provider?: string
  provider_id?: string
  model?: string
  role?: string
  temperature?: number
  maxTokens?: number
  max_tokens?: number
  attachments?: Array<ChatAttachment | { type: string; name: string; mime: string; data?: string }>
  metadata?: Record<string, string>
  requestId?: string
  request_id?: string
}

/** @deprecated WebSocket-only compatibility wrapper. */
export function sendChatViaBackend(
  text: string,
  options: Omit<CompatChatRequest, 'message'> = {},
): Promise<BackendChatResponse> {
  return sendViaBackend(
    text,
    options.sessionId ?? options.session_id ?? crypto.randomUUID(),
    {
      provider: options.provider ?? options.provider_id,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens ?? options.max_tokens,
    },
    options.role ?? '',
    options.attachments as ChatAttachment[] | undefined,
    options.metadata,
    options.requestId ?? options.request_id,
  )
}

/** @deprecated WebSocket-only compatibility wrapper used by Quick Chat. */
export function sendChat(request: CompatChatRequest): Promise<BackendChatResponse> {
  return sendChatViaBackend(request.message, request)
}
