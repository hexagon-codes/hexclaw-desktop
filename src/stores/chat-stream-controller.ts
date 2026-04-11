import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { type SessionStreamState } from './chat-stream-helpers'
import { createChatStreamCompletionController } from './chat-stream-completion'
import { createChatStreamCancelController } from './chat-stream-cancel'
import { createChatStreamErrorController } from './chat-stream-error'
import { createChatStreamRecoveryController } from './chat-stream-recovery'
import { createChatStreamStateController } from './chat-stream-state'

type MessageServiceModule = typeof import('@/services/messageService')
type ChatServiceModule = typeof import('@/services/chatService')
type LoggerModule = typeof import('@/utils/logger').logger

export function createChatStreamController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSessionIds: Ref<Record<string, boolean>>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  streaming: Ref<boolean>
  streamingSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  streamingReasoningStartTime: Ref<number>
  error: Ref<import('@/types').ApiError | null>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
  pendingAutoTitleSync: Map<string, Promise<void>>
  cancelledSessions: Set<string>
  msgSvc: MessageServiceModule
  chatSvc: ChatServiceModule
  logger: LoggerModule
  createId: () => string
  loadSessions: () => Promise<void>
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  bumpLocalSession: (sessionId: string) => void
  extractArtifacts: (content: string, messageId: string) => void
  storePendingApproval: (request: import('@/api/websocket').ToolApprovalRequest) => void
  listActiveStreams: typeof import('@/api/chat').listActiveStreams
  sendCancel: (sessionId: string | null) => void
  clearSocketCallbacks: () => void
  triggerSocketError: (message: string) => void
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
    error,
    pendingSuggestedTitleExpectation,
    streamHandles,
    pendingAutoTitleSync,
    cancelledSessions,
    msgSvc,
    chatSvc,
    logger,
    createId,
    loadSessions,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    bumpLocalSession,
    extractArtifacts,
    storePendingApproval,
    listActiveStreams,
    sendCancel,
    clearSocketCallbacks,
    triggerSocketError,
  } = params

  const stateController = createChatStreamStateController({
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
  })

  function markSessionCancelled(sessionId: string) {
    cancelledSessions.add(sessionId)
  }

  function clearSessionCancelled(sessionId: string) {
    cancelledSessions.delete(sessionId)
  }

  function isSessionCancelled(sessionId: string) {
    return cancelledSessions.has(sessionId)
  }

  const completionController = createChatStreamCompletionController({
    activeStreams,
    pendingSuggestedTitleExpectation,
    pendingAutoTitleSync,
    currentSessionId,
    msgSvc,
    createId,
    loadSessions,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    bumpLocalSession,
    extractArtifacts,
    appendMessageToSession: stateController.appendMessageToSession,
    resetSessionStream: stateController.resetSessionStream,
  })

  const cancelController = createChatStreamCancelController({
    activeStreams,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoning,
    streamingReasoningStartTime,
    streamHandles,
    msgSvc,
    createId,
    appendMessageToSession: stateController.appendMessageToSession,
    resetSessionStream: stateController.resetSessionStream,
    sendCancel,
    clearSocketCallbacks,
    triggerSocketError,
  })

  const errorController = createChatStreamErrorController({
    error,
    currentSessionId,
    streamingSessionId,
    logger,
    createId,
    appendMessageToSession: stateController.appendMessageToSession,
    resetSessionStream: stateController.resetSessionStream,
    loadSessions,
  })

  const recoveryController = createChatStreamRecoveryController({
    activeStreams,
    streamHandles,
    chatSvc,
    logger,
    storePendingApproval,
    listActiveStreams,
    isSessionCancelled,
    seedRecoveredStream: stateController.seedRecoveredStream,
    updateStreamChunk: stateController.updateStreamChunk,
    finalizeAssistantMessage: completionController.finalizeAssistantMessage,
    resetSessionStream: stateController.resetSessionStream,
    handleSendError: errorController.handleSendError,
  })

  return {
    refreshSendingState: stateController.refreshSendingState,
    syncStreamingMirrors: stateController.syncStreamingMirrors,
    setSessionPending: stateController.setSessionPending,
    markSessionCancelled,
    clearSessionCancelled,
    isSessionCancelled,
    isSessionStreaming: stateController.isSessionStreaming,
    upsertStreamState: stateController.upsertStreamState,
    resetSessionStream: stateController.resetSessionStream,
    appendMessageToSession: stateController.appendMessageToSession,
    updateStreamChunk: stateController.updateStreamChunk,
    stopSessionStream: cancelController.stopSessionStream,
    finalizeAssistantMessage: completionController.finalizeAssistantMessage,
    seedRecoveredStream: stateController.seedRecoveredStream,
    recoverActiveStreams: recoveryController.recoverActiveStreams,
    handleSendError: errorController.handleSendError,
    hasLegacyCurrentStream: cancelController.hasLegacyCurrentStream,
    stopStreaming: cancelController.stopStreaming,
  }
}
