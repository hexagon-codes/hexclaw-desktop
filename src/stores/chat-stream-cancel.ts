import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import type { SessionStreamState } from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatStreamCancelController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  streaming: Ref<boolean>
  streamingSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  streamingReasoningStartTime: Ref<number>
  streamingReasoningEndTime: Ref<number>
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
  msgSvc: MessageServiceModule
  createId: () => string
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
  sendCancel: (sessionId: string | null) => void
  clearSocketCallbacks: () => void
  triggerSocketError: (message: string) => void
}) {
  const {
    activeStreams,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoning,
    streamingReasoningStartTime,
    streamingReasoningEndTime,
    streamHandles,
    msgSvc,
    createId,
    appendMessageToSession,
    resetSessionStream,
    sendCancel,
    clearSocketCallbacks,
    triggerSocketError,
  } = params

  function stopSessionStream(
    sessionId: string,
    preservePartial = true,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) {
    const current = activeStreams.value[sessionId]
    if (!current) return false

    if (preservePartial && (current.content.trim() || current.reasoning.trim())) {
      const normalizedReasoning = current.reasoning
        ? normalizeAssistantReasoning(current.reasoning) || undefined
        : undefined
      const partialMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: getAssistantDisplayContent(current.content, normalizedReasoning),
        timestamp: new Date().toISOString(),
        reasoning: normalizedReasoning,
      }
      appendMessageToSession(sessionId, partialMessage)
    }

    streamHandles.get(sessionId)?.cancel()
    resetSessionStream(sessionId, sending, draftSending)
    return true
  }

  function hasLegacyCurrentStream() {
    if (!streaming.value) return false
    if (currentSessionId.value) {
      return !streamingSessionId.value || streamingSessionId.value === currentSessionId.value
    }
    return !streamingSessionId.value
  }

  function stopStreaming(
    sessionId: string | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) {
    const targetSessionId = sessionId ?? currentSessionId.value ?? streamingSessionId.value
    if (targetSessionId && stopSessionStream(targetSessionId, true, sending, draftSending)) {
      return
    }

    if (streamingContent.value.trim() || streamingReasoning.value.trim()) {
      const reasoning = streamingReasoning.value
        ? normalizeAssistantReasoning(streamingReasoning.value) || undefined
        : undefined
      const partialMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: getAssistantDisplayContent(streamingContent.value, reasoning),
        timestamp: new Date().toISOString(),
        reasoning,
      }
      messages.value.push(partialMessage)
      if (currentSessionId.value) msgSvc.persistMessage(partialMessage, currentSessionId.value)
    }

    sendCancel(streamingSessionId.value)
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    streamingReasoning.value = ''
    streamingReasoningStartTime.value = 0
    streamingReasoningEndTime.value = 0
    triggerSocketError('用户取消')
    clearSocketCallbacks()
  }

  return {
    stopSessionStream,
    hasLegacyCurrentStream,
    stopStreaming,
  }
}
