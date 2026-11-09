import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import {
  buildRecoveredStreamState,
  buildStreamingMirrorState,
  mergeStreamChunkState,
  projectStreamingPreview,
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
      streamHandles.get(sessionId)?.dispose?.()
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
    for (const handle of streamHandles.values()) handle.dispose?.()
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
   * 累积流式展示；重复尾部保护只冻结投影，不取消后台或决定业务终稿。
   */
  function updateStreamChunk(
    sessionId: string,
    content?: string,
    reasoning?: string,
    runtimeFrame?: import('@/types').RuntimeWireFrame,
  ): boolean {
    const current = activeStreams.value[sessionId]
    if (!current) return false
    const merged = mergeStreamChunkState(
      current,
      content,
      reasoning,
      runtimeFrame,
      current.requestRoute,
    )
    upsertStreamState(sessionId, projectStreamingPreview(merged, current))
    return false
  }

  function seedRecoveredStream(
    sessionId: string,
    snapshot: Parameters<typeof buildRecoveredStreamState>[1],
  ) {
    const current = activeStreams.value[sessionId]
    const recovered = buildRecoveredStreamState(sessionId, snapshot)
    if (current?.requestId === recovered.requestId) {
      if (recovered.lastSequence < current.lastSequence) return
      // 完整快照更新数据，不改变同一运行的前端身份、冻结路由及起始时间。
      recovered.assistantMessageId = current.assistantMessageId ?? recovered.assistantMessageId
      recovered.assistantMessageAliases = Array.from(new Set([
        ...current.assistantMessageAliases,
        ...recovered.assistantMessageAliases,
      ]))
      recovered.requestRoute = current.requestRoute
      recovered.startedAt = current.startedAt ?? recovered.startedAt
      recovered.thinkingEnabled = current.thinkingEnabled ?? recovered.thinkingEnabled
      recovered.agentDisplayName ??= current.agentDisplayName
      recovered.recipientDisplayName ??= current.recipientDisplayName
      recovered.reasoningStartTime = current.reasoningStartTime || recovered.reasoningStartTime
      recovered.reasoningEndTime = current.reasoningEndTime || recovered.reasoningEndTime
    }
    upsertStreamState(sessionId, projectStreamingPreview(recovered, current))
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
