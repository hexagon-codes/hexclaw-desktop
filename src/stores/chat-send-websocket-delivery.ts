import type { Ref } from 'vue'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
import { buildSessionStreamState, type SessionStreamState } from './chat-stream-helpers'

type ChatServiceModule = typeof import('@/services/chatService')

export const CHAT_SEND_WEBSOCKET_FALLBACK = Symbol('chat-send-websocket-fallback')

export function createChatSendWebSocketDeliveryController(params: {
  chatParams: Ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>
  agentRole: Ref<string>
  activeStreams: Ref<Record<string, import('./chat-stream-helpers').SessionStreamState>>
  chatSvc: ChatServiceModule
  isSessionCancelled: (sessionId: string) => boolean
  setSessionPending: (sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  upsertStreamState: (sessionId: string, nextState: SessionStreamState | null) => void
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string, runtimeFrame?: import('@/types').RuntimeWireFrame) => boolean
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    messageContent?: MessageContent
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    blocks?: ChatMessage['blocks']
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
    streamState?: SessionStreamState,
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
    samplingSnapshot?: {
      agentRole: string
      chatParams: { provider?: string; model?: string; temperature?: number; maxTokens?: number }
      thinkingEnabled?: boolean
      agentDisplayName?: string
      recipientDisplayName?: string
    }
    sending: Ref<boolean>
    draftSending: Ref<boolean>
  }): Promise<ChatMessage | null | typeof CHAT_SEND_WEBSOCKET_FALLBACK> {
    const {
      backendText,
      sessionId,
      attachments,
      requestId,
      requestMetadata,
      samplingSnapshot,
      sending,
      draftSending,
    } = args

    if (!activeStreams.value[sessionId]) {
      upsertStreamState(sessionId, buildSessionStreamState({
        sessionId,
        requestId,
        thinkingEnabled: samplingSnapshot?.thinkingEnabled
          ?? requestMetadata?.thinking_enabled === 'true',
        agentDisplayName: samplingSnapshot?.agentDisplayName,
        recipientDisplayName: samplingSnapshot?.recipientDisplayName,
      }))
    }
    setSessionPending(sessionId, false, sending, draftSending)

    let memorySavedContent: string | undefined
    const handle = chatSvc.openWebSocketStream(
      backendText,
      sessionId,
      samplingSnapshot?.chatParams ?? chatParams.value,
      samplingSnapshot?.agentRole ?? agentRole.value,
      attachments,
      {
        onChunk: (content, reasoning, runtimeFrame) => {
          // 退化熔断：本次刚判失控复读 → 取消后端流，停止生成、省 token、立刻停转圈。
          if (updateStreamChunk(sessionId, content, reasoning, runtimeFrame)) {
            streamHandles.get(sessionId)?.cancel()
          }
        },
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
      const finalState = activeStreams.value[sessionId]
      // 退化熔断：用冻结的「裁剪+提示」内容定稿，绝不用后端整堵复读墙；也不当作取消/失败丢弃。
      if (finalState?.degenerated) {
        return finalizeAssistantMessage({
          content: finalState.content,
          sessionId,
          metadata: { ...result?.metadata },
          reasoning: finalState.reasoning,
          sending,
          draftSending,
        })
      }
      if (!result) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      if (isSessionCancelled(sessionId)) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      const metadata = { ...result.metadata }
      if (memorySavedContent && !metadata.memory_saved) {
        metadata.memory_saved = memorySavedContent
      }
      return finalizeAssistantMessage({
        content: result.content || finalState?.content || '',
        messageContent: result.messageContent,
        sessionId,
        metadata,
        toolCalls: result.toolCalls,
        blocks: result.blocks,
        agentName: result.agentName,
        reasoning: finalState?.reasoning || getAssistantReasoningFromMetadata(result.metadata),
        sending,
        draftSending,
      })
    } catch (wsError) {
      streamHandles.delete(sessionId)
      // 退化熔断触发的 cancel 若使 done reject，仍用冻结内容定稿，不当作错误。
      const degState = activeStreams.value[sessionId]
      if (degState?.degenerated) {
        return finalizeAssistantMessage({
          content: degState.content,
          sessionId,
          reasoning: degState.reasoning,
          sending,
          draftSending,
        })
      }
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        handleSendError(wsError, sessionId, sending, draftSending, activeStreams.value[sessionId])
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
