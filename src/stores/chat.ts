/**
 * 聊天状态 Store
 *
 * 对外只保留统一的 façade：
 * - 响应式状态 / computed
 * - 少量本地消息更新
 * - controller 装配
 *
 * 复杂流程（会话、流式、发送、审批、artifact）下沉到独立 controller。
 */

import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import * as chatApi from '@/api/chat'
import { hexclawWS } from '@/api/websocket'
import { logger } from '@/utils/logger'
import * as msgSvc from '@/services/messageService'
import * as chatSvc from '@/services/chatService'
import { createChatApprovalController } from './chat-approval-controller'
import { createChatArtifactController } from './chat-artifact-controller'
import { createChatMessageController } from './chat-message-controller'
import { createChatFacadeActions } from './chat-facade-actions'
import { createChatSendController } from './chat-send-controller'
import { createChatSessionController } from './chat-session-controller'
import { createChatStoreRuntime, createChatStoreState } from './chat-store-state'
import { createChatStoreSelectors } from './chat-store-selectors'
import { createBoundChatStreamController } from './chat-stream-bound-controller'
import { createChatStreamController } from './chat-stream-controller'
import { createChatThinkingTimerController } from './chat-thinking-timer'
import { useSettingsStore } from './settings'

export const useChatStore = defineStore('chat', () => {
  const state = createChatStoreState()
  const runtime = createChatStoreRuntime()

  const {
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoning,
    streamingReasoningStartTime,
    streamingReasoningEndTime,
    error,
    activeStreams,
    pendingSessionIds,
    draftSending,
    chatMode,
    execMode,
    agentRole,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    chatParams,
    thinkingEnabled,
    sending,
    pendingApprovals,
    pendingSessionTitle,
    hasCustomTitle,
    pendingSuggestedTitleExpectation,
    streamingThinkingElapsed,
  } = state

  const artifactController = createChatArtifactController({
    artifacts,
    selectedArtifactId,
    showArtifacts,
    currentSessionId,
    msgSvc,
    logger,
    createId: () => nanoid(8),
  })

  const messageController = createChatMessageController({
    currentSessionId,
    messages,
    msgSvc,
    chatApi,
    logger,
  })

  const approvalController = createChatApprovalController({
    pendingApprovals,
    approvalCleanup: runtime.approvalCleanup,
    ws: hexclawWS,
  })

  let loadSessionsAction: () => Promise<void> = async () => {}
  let setLocalSessionTitleAction: (sessionId: string, title: string) => void = () => {}
  let setPendingSuggestedTitleExpectationAction: (sessionId: string, expectedTitle: string | null) => void = () => {}
  let bumpLocalSessionAction: (sessionId: string) => void = () => {}

  const streamController = createChatStreamController({
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
    error,
    pendingSuggestedTitleExpectation,
    streamHandles: runtime.streamHandles,
    pendingAutoTitleSync: runtime.pendingAutoTitleSync,
    cancelledSessions: runtime.cancelledSessions,
    msgSvc,
    chatSvc,
    logger,
    createId: nanoid,
    loadSessions: () => loadSessionsAction(),
    setLocalSessionTitle: (sessionId, title) => setLocalSessionTitleAction(sessionId, title),
    setPendingSuggestedTitleExpectation: (sessionId, expectedTitle) =>
      setPendingSuggestedTitleExpectationAction(sessionId, expectedTitle),
    bumpLocalSession: (sessionId) => bumpLocalSessionAction(sessionId),
    extractArtifacts: artifactController.extractArtifacts,
    storePendingApproval: approvalController.storePendingApproval,
    listActiveStreams: async () => {
      if (typeof chatApi.listActiveStreams === 'function') {
        return chatApi.listActiveStreams()
      }
      return { streams: [], total: 0 }
    },
    sendCancel: (sessionId) => hexclawWS.sendRaw({ type: 'cancel', session_id: sessionId }),
    clearSocketCallbacks: () => chatSvc.clearWebSocketCallbacks(),
    triggerSocketError: (message) => hexclawWS.triggerError(message),
  })

  const boundStreamController = createBoundChatStreamController({
    streamController,
    sending,
    draftSending,
  })

  const selectors = createChatStoreSelectors({
    activeStreams,
    currentSessionId,
    streamingContent,
    streamingReasoning,
    pendingApprovals,
    hasLegacyCurrentStream: () => boundStreamController.hasLegacyCurrentStream(),
    getPendingApprovalForSession: approvalController.getPendingApprovalForSession,
  })

  const thinkingTimerController = createChatThinkingTimerController({
    streamingReasoningStartTime,
    streamingReasoningEndTime,
    streamingThinkingElapsed,
    thinkingTimer: runtime.thinkingTimer,
  })

  const sessionController = createChatSessionController({
    sessions,
    currentSessionId,
    messages,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    error,
    chatMode,
    agentRole,
    hasCustomTitle,
    pendingSessionTitle,
    pendingSessionIds,
    pendingSuggestedTitleExpectation,
    sessionSelectionGen: runtime.sessionSelectionGen,
    ensureSessionPromise: runtime.ensureSessionPromise,
    cancelledSessions: runtime.cancelledSessions,
    msgSvc,
    logger,
    createId: () => nanoid(12),
    syncStreamingMirrors: boundStreamController.syncStreamingMirrors,
    isSessionStreaming: boundStreamController.isSessionStreaming,
    stopSessionStream: boundStreamController.stopSessionStream,
    resetSessionStream: boundStreamController.resetSessionStream,
    clearSessionCancelled: boundStreamController.clearSessionCancelled,
    markSessionCancelled: boundStreamController.markSessionCancelled,
    extractArtifacts: artifactController.extractArtifacts,
  })

  loadSessionsAction = sessionController.loadSessions
  setLocalSessionTitleAction = sessionController.setLocalSessionTitle
  setPendingSuggestedTitleExpectationAction = sessionController.setPendingSuggestedTitleExpectation
  bumpLocalSessionAction = sessionController.bumpLocalSession

  const sendController = createChatSendController({
    currentSessionId,
    messages,
    pendingSessionIds,
    draftSending,
    activeStreams,
    chatParams,
    agentRole,
    thinkingEnabled,
    hasCustomTitle,
    sessions,
    msgSvc,
    chatSvc,
    createId: nanoid,
    getSettingsStore: useSettingsStore,
    ensureSession: sessionController.ensureSession,
    clearSessionCancelled: boundStreamController.clearSessionCancelled,
    isSessionCancelled: boundStreamController.isSessionCancelled,
    isSessionStreaming: boundStreamController.isSessionStreaming,
    setSessionPending: boundStreamController.setSessionPending,
    refreshSendingState: boundStreamController.refreshSendingState,
    setLocalSessionTitle: sessionController.setLocalSessionTitle,
    setPendingSuggestedTitleExpectation: sessionController.setPendingSuggestedTitleExpectation,
    pendingAutoTitleSync: runtime.pendingAutoTitleSync,
    persistMessage: msgSvc.persistMessage,
    upsertStreamState: boundStreamController.upsertStreamState,
    updateStreamChunk: boundStreamController.updateStreamChunk,
    resetSessionStream: boundStreamController.resetSessionStream,
    finalizeAssistantMessage: boundStreamController.finalizeAssistantMessage,
    handleSendError: boundStreamController.handleSendError,
    storePendingApproval: approvalController.storePendingApproval,
    streamHandles: runtime.streamHandles,
    sending,
  })

  const facadeActions = createChatFacadeActions({
    error,
    sessionController,
    sendController,
    boundStreamController,
    thinkingTimerController,
  })

  thinkingTimerController.bindThinkingTimer()

  // WebSocket 重连成功后自动恢复活跃流，避免 UI 流状态悬挂
  hexclawWS.onReconnect?.(() => {
    boundStreamController.recoverActiveStreams().catch((e) => {
      logger.warn('重连后恢复活跃流失败', e)
    })
  })

  return {
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoningStartTime,
    streamingReasoningEndTime,
    isCurrentStreaming: selectors.isCurrentStreaming,
    isCurrentStreamingContent: selectors.isCurrentStreamingContent,
    isCurrentStreamingReasoning: selectors.isCurrentStreamingReasoning,
    streamingThinkingElapsed,
    error,
    chatMode,
    execMode,
    agentRole,
    chatParams,
    thinkingEnabled,
    sending,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    pendingApproval: selectors.pendingApproval,
    pendingApprovals,
    hasCustomTitle,
    ...facadeActions,
    updateMessage: messageController.updateMessage,
    setMessageFeedback: messageController.setMessageFeedback,
    isSessionStreaming: boundStreamController.isSessionStreaming,
    hasSessionPendingApproval: approvalController.hasSessionPendingApproval,
    recoverActiveStreams: boundStreamController.recoverActiveStreams,
    addArtifact: artifactController.addArtifact,
    selectArtifact: artifactController.selectArtifact,
    extractArtifacts: artifactController.extractArtifacts,
    initApprovalListener: approvalController.initApprovalListener,
    respondApproval: approvalController.respondApproval,
  }
})
