import type { Ref } from 'vue'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { SessionStreamState } from './chat-stream-helpers'

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
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string) => void
  finalizeAssistantMessage: (args: {
    content: string
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: import('@/types').ChatMessage['tool_calls']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
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
        if (existing?.requestId === snapshot.request_id || streamHandles.has(snapshot.session_id)) continue

        seedRecoveredStream(snapshot.session_id, snapshot)
        const handle = chatSvc.resumeWebSocketStream(snapshot.session_id, snapshot.request_id, {
          onSnapshot: (current) => {
            seedRecoveredStream(snapshot.session_id, {
              ...snapshot,
              content: current.content,
              reasoning: current.reasoning,
              done: !!current.done,
            })
          },
          onChunk: (content, reasoning) => updateStreamChunk(snapshot.session_id, content, reasoning),
          onApprovalRequest: (request) => {
            storePendingApproval(request)
          },
        })
        streamHandles.set(snapshot.session_id, handle)

        void handle.done
          .then((result) => {
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
            finalizeAssistantMessage({
              content: result.content || finalState?.content || '',
              sessionId: snapshot.session_id,
              metadata: result.metadata,
              toolCalls: result.toolCalls,
              agentName: result.agentName,
              reasoning: finalState?.reasoning || getAssistantReasoningFromMetadata(result.metadata),
              sending,
              draftSending,
            })
          })
          .catch((resumeError) => {
            streamHandles.delete(snapshot.session_id)
            handleSendError(resumeError, snapshot.session_id, sending, draftSending)
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
