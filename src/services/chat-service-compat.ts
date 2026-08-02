import type { ChatAttachment, ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
import { openWebSocketStream } from './chatService'

export interface WebSocketCompatResponse {
  reply: string
  session_id?: string
  message_content?: MessageContent
  metadata?: Record<string, unknown>
  tool_calls?: ChatMessage['tool_calls']
  blocks?: ChatMessage['blocks']
  usage?: {
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    [key: string]: unknown
  }
}

/** @deprecated Use openWebSocketStream. This adapter does not use HTTP/SSE. */
export function sendViaBackend(
  text: string,
  sessionId: string,
  chatParams: { model?: string; provider?: string; temperature?: number; maxTokens?: number },
  agentRole: string,
  attachments?: ChatAttachment[],
  metadata?: Record<string, string>,
  requestId?: string,
): Promise<WebSocketCompatResponse> {
  const handle = openWebSocketStream(
    text,
    sessionId,
    chatParams,
    agentRole,
    attachments,
    undefined,
    metadata,
    requestId,
  )
  return handle.done.then((result) => {
    if (result === null) throw new Error('WebSocket request ended without a reply')
    return {
      reply: result.content,
      session_id: sessionId,
      message_content: result.messageContent,
      metadata: {
        ...result.metadata,
        ...(result.agentName ? { agent_name: result.agentName } : {}),
      },
      tool_calls: result.toolCalls,
      blocks: result.blocks,
    }
  })
}
