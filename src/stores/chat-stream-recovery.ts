import type { Ref } from 'vue'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import { backendScopeKey } from '@/services/backend-context'
import { isCurrentStreamRequest, type SessionStreamState } from './chat-stream-helpers'

type ChatServiceModule = typeof import('@/services/chatService')
type LoggerModule = typeof import('@/utils/logger').logger

export function createChatStreamRecoveryController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
  chatSvc: ChatServiceModule
  logger: LoggerModule
  storePendingApproval: (request: import('@/api/websocket').ToolApprovalRequest) => void
  listActiveStreams: typeof import('@/api/chat').listActiveStreams
  isSessionCancelled: (sessionId: string) => boolean
  seedRecoveredStream: (
    sessionId: string,
    snapshot: Parameters<typeof import('./chat-stream-helpers').buildRecoveredStreamState>[1],
  ) => void
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string, runtimeFrame?: import('@/types').RuntimeWireFrame) => boolean
  finalizeAssistantMessage: (args: {
    content: string
    messageContent?: import('@/contracts/message-content').MessageContent
    renderManifest?: import('@/contracts/message-content').RenderManifest
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: import('@/types').ChatMessage['tool_calls']
    blocks?: import('@/types').ChatMessage['blocks']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
    terminalState?: 'completed' | 'failed' | 'cancelled'
  }) => import('@/types').ChatMessage
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
    streamState?: SessionStreamState,
  ) => void
}) {
  const {
    activeStreams,
    streamHandles,
    chatSvc,
    logger,
    storePendingApproval,
    listActiveStreams,
    isSessionCancelled,
    seedRecoveredStream,
    updateStreamChunk,
    finalizeAssistantMessage,
    resetSessionStream,
    handleSendError,
  } = params

  async function recoverActiveStreams(sending: Ref<boolean>, draftSending: Ref<boolean>) {
    const recoveryScope = backendScopeKey()
    try {
      const response = await listActiveStreams()
      if (backendScopeKey() !== recoveryScope) return
      for (const snapshot of response.streams || []) {
        if (backendScopeKey() !== recoveryScope) return
        if (!snapshot.request_id || !snapshot.session_id || snapshot.done) continue
        if (streamHandles.has(snapshot.session_id)) continue

        seedRecoveredStream(snapshot.session_id, snapshot)
        // 恢复服务可能同步回调 onSnapshot；用 holder 在初始化前提供可读句柄，避免 TDZ。
        const handleRef: { current?: import('@/services/chatService').WebSocketStreamHandle } = {}
        const ownsRequest = () => isCurrentStreamRequest({ streams: activeStreams.value, handles: streamHandles, sessionId: snapshot.session_id, requestId: snapshot.request_id, handle: handleRef.current, scope: recoveryScope })
        const recoveredReasoningRequest = activeStreams.value[snapshot.session_id]
          ?.reasoningReceipt?.reasoning_request ?? 'off'
        handleRef.current = snapshot.source === 'rest'
          ? chatSvc.resumeRestStream(snapshot.session_id, snapshot.request_id, (current) => {
              if (!ownsRequest()) return
              seedRecoveredStream(snapshot.session_id, current)
            })
          : chatSvc.resumeWebSocketStream(snapshot.session_id, snapshot.request_id, {
          onSnapshot: (current) => {
            if (!ownsRequest()) return
            seedRecoveredStream(snapshot.session_id, {
              ...snapshot,
              content: current.content,
              message_content: current.messageContent,
              render_manifest: current.renderManifest,
              reasoning: current.reasoning,
              blocks: current.blocks,
              tool_calls: current.toolCalls,
              done: !!current.done,
              metadata: current.metadata,
              ...current.metadata,
            })
          },
          onChunk: (content, reasoning, runtimeFrame) => {
            if (ownsRequest()) updateStreamChunk(snapshot.session_id, content, reasoning, runtimeFrame)
          },
          onApprovalRequest: (request) => {
            if (ownsRequest()) storePendingApproval(request)
          },
        }, recoveredReasoningRequest)
        const handle = handleRef.current!
        streamHandles.set(snapshot.session_id, handle)

        void handle.done
          .then((result) => {
            if (!ownsRequest()) return
            streamHandles.delete(snapshot.session_id)
            if (!result) {
              resetSessionStream(snapshot.session_id, sending, draftSending)
              return
            }
            if (isSessionCancelled(snapshot.session_id)) {
              resetSessionStream(snapshot.session_id, sending, draftSending)
              return
            }
            const finalState = activeStreams.value[snapshot.session_id]
            if (snapshot.source === 'rest' && result.terminalState === 'cancelled'
              && !result.content.trim() && !finalState?.reasoning.trim()
              && !result.toolCalls?.length && !result.blocks?.length && !result.messageContent) {
              resetSessionStream(snapshot.session_id, sending, draftSending)
              return
            }
            finalizeAssistantMessage({
              content: result.messageContent?.markdown ?? (result.content || finalState?.content || ''),
              messageContent: result.messageContent,
              renderManifest: result.renderManifest,
              sessionId: snapshot.session_id,
              metadata: result.metadata,
              toolCalls: result.toolCalls,
              blocks: result.blocks,
              agentName: result.agentName,
              reasoning: finalState?.reasoning || getAssistantReasoningFromMetadata(result.metadata),
              sending,
              draftSending,
              terminalState: result.terminalState,
            })
          })
          .catch((resumeError) => {
            if (!ownsRequest()) return
            streamHandles.delete(snapshot.session_id)
            if (isSessionCancelled(snapshot.session_id)) {
              resetSessionStream(snapshot.session_id, sending, draftSending)
              return
            }
            handleSendError(
              resumeError,
              snapshot.session_id,
              sending,
              draftSending,
              activeStreams.value[snapshot.session_id],
            )
          })
      }
    } catch (recoveryError) {
      logger.warn('恢复后台流式任务失败', recoveryError)
    }
  }

  return {
    recoverActiveStreams,
  }
}
