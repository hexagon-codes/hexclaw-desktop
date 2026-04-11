import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import {
  buildRecoveredStreamState,
  buildStreamingMirrorState,
  mergeStreamChunkState,
  type SessionStreamState,
} from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatStreamStateController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSessionIds: Ref<Record<string, boolean>>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  streaming: Ref<boolean>
  streamingSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  streamingReasoningStartTime: Ref<number>
  msgSvc: MessageServiceModule
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
}) {
  const {
    activeStreams,
    pendingSessionIds,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoning,
    streamingReasoningStartTime,
    msgSvc,
    streamHandles,
  } = params

  function refreshSendingState(sending: Ref<boolean>, draftSending: Ref<boolean>) {
    sending.value = draftSending.value || Object.values(pendingSessionIds.value).some(Boolean)
  }

  function syncStreamingMirrors() {
    const next = buildStreamingMirrorState(activeStreams.value, currentSessionId.value)
    streaming.value = next.streaming
    streamingSessionId.value = next.streamingSessionId
    streamingContent.value = next.streamingContent
    streamingReasoning.value = next.streamingReasoning
    streamingReasoningStartTime.value = next.streamingReasoningStartTime
  }

  function setSessionPending(sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) {
    const next = { ...pendingSessionIds.value }
    if (value) next[sessionId] = true
    else delete next[sessionId]
    pendingSessionIds.value = next
    refreshSendingState(sending, draftSending)
  }

  function isSessionStreaming(sessionId: string) {
    return !!activeStreams.value[sessionId]
      || (streaming.value && streamingSessionId.value === sessionId)
  }

  function upsertStreamState(sessionId: string, nextState: SessionStreamState | null) {
    const next = { ...activeStreams.value }
    if (nextState) next[sessionId] = nextState
    else delete next[sessionId]
    activeStreams.value = next
    syncStreamingMirrors()
  }

  function resetSessionStream(sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) {
    if (sessionId) {
      streamHandles.delete(sessionId)
      if (sending && draftSending) {
        setSessionPending(sessionId, false, sending, draftSending)
      } else {
        const nextPending = { ...pendingSessionIds.value }
        delete nextPending[sessionId]
        pendingSessionIds.value = nextPending
      }
      upsertStreamState(sessionId, null)
      return
    }
    streamHandles.clear()
    activeStreams.value = {}
    pendingSessionIds.value = {}
    syncStreamingMirrors()
    if (sending && draftSending) refreshSendingState(sending, draftSending)
  }

  function appendMessageToSession(sessionId: string, message: ChatMessage) {
    if (currentSessionId.value === sessionId) {
      messages.value.push(message)
    }
    msgSvc.persistMessage(message, sessionId)
  }

  function updateStreamChunk(sessionId: string, content?: string, reasoning?: string) {
    const current = activeStreams.value[sessionId]
    if (!current) return
    upsertStreamState(sessionId, mergeStreamChunkState(current, content, reasoning))
  }

  function seedRecoveredStream(
    sessionId: string,
    snapshot: Parameters<typeof buildRecoveredStreamState>[1],
  ) {
    upsertStreamState(sessionId, buildRecoveredStreamState(sessionId, snapshot))
  }

  return {
    refreshSendingState,
    syncStreamingMirrors,
    setSessionPending,
    isSessionStreaming,
    upsertStreamState,
    resetSessionStream,
    appendMessageToSession,
    updateStreamChunk,
    seedRecoveredStream,
  }
}
