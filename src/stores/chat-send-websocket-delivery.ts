import type { Ref } from 'vue'
import { backendScopeKey } from '@/services/backend-context'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
import type { ChatPayloadLimitError } from '@/services/chatService'
import {
  buildSessionStreamState,
  isCurrentStreamRequest,
  type ChatSendErrorHandler,
  type SessionStreamState,
} from './chat-stream-helpers'

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
    terminalState?: 'completed' | 'failed' | 'cancelled'
  }) => ChatMessage
  handleSendError: ChatSendErrorHandler
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
    onPayloadRejected?: (error: ChatPayloadLimitError) => void
    samplingSnapshot?: {
      agentRole: string
      chatParams: { provider?: string; model?: string; temperature?: number; maxTokens?: number }
      thinkingEnabled?: boolean
      reasoningSupport?: import('@/types').ModelReasoningSupport
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
          ?? (requestMetadata?.thinking === 'on'
            || requestMetadata?.thinking_enabled === 'true'),
        reasoningSupport: samplingSnapshot?.reasoningSupport,
        requestRoute: samplingSnapshot?.chatParams ?? chatParams.value,
        agentDisplayName: samplingSnapshot?.agentDisplayName,
        recipientDisplayName: samplingSnapshot?.recipientDisplayName,
      }))
    }
    setSessionPending(sessionId, false, sending, draftSending)

    const deliveryScope = backendScopeKey()
    // 流服务可能在 openWebSocketStream 返回前同步回调 onChunk（缓存/重放/测试桩）；
    // 用 holder 在初始化前提供可读句柄，避免 TDZ，同时保持句柄本身不可重分配。
    const handleRef: { current?: ReturnType<ChatServiceModule['openWebSocketStream']> } = {}
    const ownsRequest = () => isCurrentStreamRequest({ streams: activeStreams.value, handles: streamHandles, sessionId, requestId, handle: handleRef.current, scope: deliveryScope })
    let memorySavedContent: string | undefined
    handleRef.current = chatSvc.openWebSocketStream(
      backendText,
      sessionId,
      samplingSnapshot?.chatParams ?? chatParams.value,
      samplingSnapshot?.agentRole ?? agentRole.value,
      attachments,
      {
        onPayloadRejected: args.onPayloadRejected,
        onChunk: (content, reasoning, runtimeFrame) => {
          if (ownsRequest()) updateStreamChunk(sessionId, content, reasoning, runtimeFrame)
        },
        onApprovalRequest: (request) => {
          if (ownsRequest()) storePendingApproval(request)
        },
        onMemorySaved: (content) => {
          if (ownsRequest()) memorySavedContent = content
        },
      },
      requestMetadata,
      requestId,
    )
    const handle = handleRef.current!
    streamHandles.set(sessionId, handle)

    try {
      const result = await handle.done
      if (!ownsRequest()) return null
      streamHandles.delete(sessionId)
      const finalState = activeStreams.value[sessionId]
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
        terminalState: result.terminalState,
      })
    } catch (wsError) {
      if (!ownsRequest()) return null
      streamHandles.delete(sessionId)
      if (wsError instanceof chatSvc.ChatRequestError && wsError.stopRequested) {
        // 停止已获本地接纳但后台终态尚未取得：保留已有部分内容，按取消收口本地展示；
        // 不能把传输中断写成业务 failed，也不能因此转发新的业务请求。
        const streamState = activeStreams.value[sessionId]
        if (streamState && (
          streamState.content.trim()
          || streamState.reasoning.trim()
          || streamState.toolCalls?.length
          || streamState.blocks?.length
        )) {
          finalizeAssistantMessage({
            content: streamState.content,
            sessionId,
            toolCalls: streamState.toolCalls,
            blocks: streamState.blocks,
            reasoning: streamState.reasoning,
            sending,
            draftSending,
            terminalState: 'cancelled',
          })
        } else {
          resetSessionStream(sessionId, sending, draftSending)
        }
        return null
      }
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        handleSendError(wsError, sessionId, activeStreams.value[sessionId])
        return null
      }
      if (isSessionCancelled(sessionId)) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      return CHAT_SEND_WEBSOCKET_FALLBACK
    }
  }

  return {
    deliverViaWebSocket,
  }
}
