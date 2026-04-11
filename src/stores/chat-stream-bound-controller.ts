import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { createChatStreamController } from './chat-stream-controller'

export function createBoundChatStreamController(params: {
  streamController: ReturnType<typeof createChatStreamController>
  sending: Ref<boolean>
  draftSending: Ref<boolean>
}) {
  const { streamController, sending, draftSending } = params

  return {
    refreshSendingState() {
      streamController.refreshSendingState(sending, draftSending)
    },
    syncStreamingMirrors() {
      streamController.syncStreamingMirrors()
    },
    setSessionPending(sessionId: string, value: boolean) {
      streamController.setSessionPending(sessionId, value, sending, draftSending)
    },
    markSessionCancelled(sessionId: string) {
      streamController.markSessionCancelled(sessionId)
    },
    clearSessionCancelled(sessionId: string) {
      streamController.clearSessionCancelled(sessionId)
    },
    isSessionCancelled(sessionId: string) {
      return streamController.isSessionCancelled(sessionId)
    },
    isSessionStreaming(sessionId: string) {
      return streamController.isSessionStreaming(sessionId)
    },
    upsertStreamState(
      sessionId: string,
      nextState: import('./chat-stream-helpers').SessionStreamState | null,
    ) {
      streamController.upsertStreamState(sessionId, nextState)
    },
    resetSessionStream(sessionId?: string | null) {
      streamController.resetSessionStream(sessionId, sending, draftSending)
    },
    updateStreamChunk(sessionId: string, content?: string, reasoning?: string) {
      streamController.updateStreamChunk(sessionId, content, reasoning)
    },
    stopSessionStream(sessionId: string, preservePartial = true) {
      return streamController.stopSessionStream(sessionId, preservePartial, sending, draftSending)
    },
    finalizeAssistantMessage(params: {
      content: string
      sessionId: string
      metadata?: Record<string, unknown>
      toolCalls?: ChatMessage['tool_calls']
      agentName?: string
      reasoning?: string
    }) {
      return streamController.finalizeAssistantMessage({ ...params, sending, draftSending })
    },
    async recoverActiveStreams() {
      await streamController.recoverActiveStreams(sending, draftSending)
    },
    handleSendError(errorValue: unknown, sessionId?: string | null) {
      streamController.handleSendError(errorValue, sessionId, sending, draftSending)
    },
    stopStreaming(sessionId?: string) {
      streamController.stopStreaming(sessionId, sending, draftSending)
    },
    hasLegacyCurrentStream() {
      return streamController.hasLegacyCurrentStream()
    },
  }
}
