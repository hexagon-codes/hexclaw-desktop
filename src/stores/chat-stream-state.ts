import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import {
  buildRecoveredStreamState,
  buildStreamingMirrorState,
  mergeStreamChunkState,
  type SessionStreamState,
} from './chat-stream-helpers'
import { isDegenerateTail, trimDegenerateTail, DEGENERATION_NOTICE } from '@/utils/degeneration'

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
  streamingReasoningEndTime: Ref<number>
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
    streamingReasoningEndTime,
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
    streamingReasoningEndTime.value = next.streamingReasoningEndTime
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

  /**
   * 累积一个流式 chunk。返回值 = 本次是否「刚触发退化熔断」，调用方据此 cancel 后端流以省 token。
   */
  function updateStreamChunk(
    sessionId: string,
    content?: string,
    reasoning?: string,
    runtimeFrame?: import('@/types').RuntimeWireFrame,
  ): boolean {
    const current = activeStreams.value[sessionId]
    if (!current) return false
    // 退化熔断：已判失控复读 → 冻结，丢弃后续复读 chunk，墙不再长（BUG-20260625 模型塌缩）。
    if (current.degenerated) return false
    const merged = mergeStreamChunkState(
      current,
      content,
      reasoning,
      runtimeFrame,
      current.requestRoute,
    )
    // 在原始流（含 reasoning）上检测；命中即裁掉复读尾、追加提示、置熔断位。
    const probe = merged.content || merged.rawContent
    if (isDegenerateTail(probe)) {
      upsertStreamState(sessionId, {
        ...merged,
        content: trimDegenerateTail(probe) + DEGENERATION_NOTICE,
        degenerated: true,
      })
      return true
    }
    upsertStreamState(sessionId, merged)
    return false
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
