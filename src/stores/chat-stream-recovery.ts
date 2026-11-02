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
    try {
      const response = await listActiveStreams()
      for (const snapshot of response.streams || []) {
        if (!snapshot.request_id || !snapshot.session_id || snapshot.done) continue
        const existing = activeStreams.value[snapshot.session_id]
        if (streamHandles.has(snapshot.session_id)
          || (existing?.requestId === snapshot.request_id && snapshot.source !== 'rest')) continue

        seedRecoveredStream(snapshot.session_id, snapshot)
        const recoveryScope = backendScopeKey()
        const ownsRequest = () => isCurrentStreamRequest({ streams: activeStreams.value, handles: streamHandles, sessionId: snapshot.session_id, requestId: snapshot.request_id, handle, scope: recoveryScope })
        const recoveredReasoningRequest = activeStreams.value[snapshot.session_id]
          ?.reasoningReceipt?.reasoning_request ?? 'off'
        const handle: import('@/services/chatService').WebSocketStreamHandle = snapshot.source === 'rest'
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
              reasoning: current.reasoning,
              blocks: current.blocks,
              tool_calls: current.toolCalls,
              done: !!current.done,
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
            if (snapshot.source === 'rest' && result.terminalState === 'failed') {
              handleSendError(
                new Error(typeof result.metadata?.error === 'string' ? result.metadata.error : 'REST stream failed'),
                snapshot.session_id, sending, draftSending, finalState,
              )
              return
            }
            if (snapshot.source === 'rest' && result.terminalState === 'cancelled'
              && !result.content.trim() && !finalState?.reasoning.trim()
              && !result.toolCalls?.length && !result.blocks?.length && !result.messageContent) {
              resetSessionStream(snapshot.session_id, sending, draftSending)
              return
            }
            finalizeAssistantMessage({
              content: result.content || finalState?.content || '',
              messageContent: result.messageContent,
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
