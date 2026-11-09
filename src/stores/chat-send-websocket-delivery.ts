import type { Ref } from 'vue'
import { backendScopeKey } from '@/services/backend-context'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
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
  seedRecoveredStream: (sessionId: string, snapshot: import('@/api/chat').ActiveStreamSnapshot) => void
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string, runtimeFrame?: import('@/types').RuntimeWireFrame) => boolean
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    messageContent?: MessageContent
    renderManifest?: RenderManifest
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
    seedRecoveredStream,
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
        onSnapshot: (snapshot) => {
          if (!ownsRequest()) return
          seedRecoveredStream(sessionId, {
            ...snapshot.metadata,
            request_id: requestId,
            session_id: sessionId,
            source: 'websocket',
            content: snapshot.content,
            message_content: snapshot.messageContent,
            render_manifest: snapshot.renderManifest,
            reasoning: snapshot.reasoning,
            metadata: snapshot.metadata,
            blocks: snapshot.blocks,
            tool_calls: snapshot.toolCalls,
            done: !!snapshot.done,
          })
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
        content: result.messageContent?.markdown ?? (result.content || finalState?.content || ''),
        messageContent: result.messageContent,
        renderManifest: result.renderManifest,
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
      if (isSessionCancelled(sessionId)) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      if (wsError instanceof chatSvc.ChatRequestError && wsError.stopRequested) {
        // 未取得后台终态时保留原运行与部分预览，传输错误不能制造取消或失败终稿。
        return null
      }
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        handleSendError(wsError, sessionId, activeStreams.value[sessionId])
        return null
      }
      return CHAT_SEND_WEBSOCKET_FALLBACK
    }
  }

  return {
    deliverViaWebSocket,
  }
}
