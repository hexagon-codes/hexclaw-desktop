import type { Ref } from 'vue'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { ChatAttachment, ChatMessage } from '@/types'

type ChatServiceModule = typeof import('@/services/chatService')

export const CHAT_SEND_WEBSOCKET_FALLBACK = Symbol('chat-send-websocket-fallback')

export function createChatSendWebSocketDeliveryController(params: {
  chatParams: Ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>
  agentRole: Ref<string>
  activeStreams: Ref<Record<string, import('./chat-stream-helpers').SessionStreamState>>
  chatSvc: ChatServiceModule
  isSessionCancelled: (sessionId: string) => boolean
  setSessionPending: (sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  upsertStreamState: (sessionId: string, nextState: import('./chat-stream-helpers').SessionStreamState | null) => void
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string) => void
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
  }) => ChatMessage
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) => void
  storePendingApproval: (request: import('@/api/websocket').ToolApprovalRequest) => void
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
}) {
  const {
    chatParams,
    agentRole,
    activeStreams,
    chatSvc,
    isSessionCancelled,
    setSessionPending,
    upsertStreamState,
    updateStreamChunk,
    resetSessionStream,
    finalizeAssistantMessage,
    handleSendError,
    storePendingApproval,
    streamHandles,
  } = params

  async function deliverViaWebSocket(args: {
    backendText: string
    sessionId: string
    attachments?: ChatAttachment[]
    requestId: string
    requestMetadata?: Record<string, string>
    sending: Ref<boolean>
    draftSending: Ref<boolean>
  }): Promise<ChatMessage | null | typeof CHAT_SEND_WEBSOCKET_FALLBACK> {
    const {
      backendText,
      sessionId,
      attachments,
      requestId,
      requestMetadata,
      sending,
      draftSending,
    } = args

    upsertStreamState(sessionId, {
      sessionId,
      requestId,
      rawContent: '',
      content: '',
      explicitReasoning: '',
      reasoning: '',
      reasoningStartTime: 0,
      reasoningEndTime: 0,
    })
    setSessionPending(sessionId, false, sending, draftSending)

    let memorySavedContent: string | undefined
    const handle = chatSvc.openWebSocketStream(
      backendText,
      sessionId,
      chatParams.value,
      agentRole.value,
      attachments,
      {
        onChunk: (content, reasoning) => updateStreamChunk(sessionId, content, reasoning),
        onApprovalRequest: (request) => {
          storePendingApproval(request)
        },
        onMemorySaved: (content) => {
          memorySavedContent = content
        },
      },
      requestMetadata,
      requestId,
    )
    streamHandles.set(sessionId, handle)

    try {
      const result = await handle.done
      streamHandles.delete(sessionId)
      if (!result) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      if (isSessionCancelled(sessionId)) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      const finalState = activeStreams.value[sessionId]
      const metadata = { ...result.metadata }
      if (memorySavedContent && !metadata.memory_saved) {
        metadata.memory_saved = memorySavedContent
      }
      return finalizeAssistantMessage({
        content: result.content || finalState?.content || '',
        sessionId,
        metadata,
        toolCalls: result.toolCalls,
        agentName: result.agentName,
        reasoning: finalState?.reasoning || getAssistantReasoningFromMetadata(result.metadata),
        sending,
        draftSending,
      })
    } catch (wsError) {
      streamHandles.delete(sessionId)
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        handleSendError(wsError, sessionId, sending, draftSending)
        return null
      }
      resetSessionStream(sessionId, sending, draftSending)
      if (isSessionCancelled(sessionId)) {
        return null
      }
      return CHAT_SEND_WEBSOCKET_FALLBACK
    }
  }

  return {
    deliverViaWebSocket,
  }
}
