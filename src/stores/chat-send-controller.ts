import type { Ref } from 'vue'
import { DEFAULT_SESSION_TITLE } from '@/constants'
import type { ChatAttachment, ChatMessage } from '@/types'
import { createChatSendAutoTitleController } from './chat-send-auto-title'
import { createChatSendDeliveryController } from './chat-send-delivery-controller'
import { shouldBlockChatSend, shouldSeedChatAutoTitle } from './chat-send-guards'

type ChatServiceModule = typeof import('@/services/chatService')
type MessageServiceModule = typeof import('@/services/messageService')
type SettingsStoreFactory = typeof import('./settings').useSettingsStore

export function createChatSendController(params: {
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  pendingSessionIds: Ref<Record<string, boolean>>
  draftSending: Ref<boolean>
  activeStreams: Ref<Record<string, import('./chat-stream-helpers').SessionStreamState>>
  chatParams: Ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>
  agentRole: Ref<string>
  thinkingEnabled: Ref<boolean>
  hasCustomTitle: Ref<boolean>
  sessions: Ref<import('@/types').ChatSession[]>
  msgSvc: MessageServiceModule
  chatSvc: ChatServiceModule
  createId: () => string
  defaultSessionTitle?: string
  getSettingsStore: SettingsStoreFactory
  ensureSession: () => Promise<string>
  clearSessionCancelled: (sessionId: string) => void
  isSessionCancelled: (sessionId: string) => boolean
  isSessionStreaming: (sessionId: string) => boolean
  setSessionPending: (sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  refreshSendingState: (sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  pendingAutoTitleSync: Map<string, Promise<void>>
  persistMessage: (message: ChatMessage, sessionId: string) => Promise<boolean>
  upsertStreamState: (sessionId: string, nextState: import('./chat-stream-helpers').SessionStreamState | null) => void
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string) => void
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
  }) => ChatMessage
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) => void
  storePendingApproval: (request: import('@/api/websocket').ToolApprovalRequest) => void
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
  sending: Ref<boolean>
}) {
  const {
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
    createId,
    defaultSessionTitle = DEFAULT_SESSION_TITLE,
    getSettingsStore,
    ensureSession,
    clearSessionCancelled,
    isSessionCancelled,
    isSessionStreaming,
    setSessionPending,
    refreshSendingState,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    pendingAutoTitleSync,
    persistMessage,
    upsertStreamState,
    updateStreamChunk,
    resetSessionStream,
    finalizeAssistantMessage,
    handleSendError,
    storePendingApproval,
    streamHandles,
    sending,
  } = params

  const deliveryController = createChatSendDeliveryController({
    chatParams,
    agentRole,
    thinkingEnabled,
    activeStreams,
    chatSvc,
    getSettingsStore,
    clearSessionCancelled,
    isSessionCancelled,
    setSessionPending,
    upsertStreamState,
    updateStreamChunk,
    resetSessionStream,
    finalizeAssistantMessage,
    handleSendError,
    storePendingApproval,
    streamHandles,
  })

  const autoTitleController = createChatSendAutoTitleController({
    msgSvc,
    pendingAutoTitleSync,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    defaultSessionTitle,
  })

  async function sendMessage(
    text: string,
    attachments?: ChatAttachment[],
    options?: { backendText?: string },
  ): Promise<ChatMessage | null> {
    const initialSessionId = currentSessionId.value
    const shouldSeedAutoTitle = shouldSeedChatAutoTitle({
      hasCustomTitle: hasCustomTitle.value,
      initialSessionId,
      messages: messages.value,
      sessions: sessions.value,
      defaultSessionTitle,
    })
    if (shouldBlockChatSend({
      initialSessionId,
      pendingSessionIds: pendingSessionIds.value,
      draftSending: draftSending.value,
      isSessionStreaming,
    })) {
      return null
    }
    draftSending.value = !initialSessionId
    refreshSendingState(sending, draftSending)
    try {
      const backendText = options?.backendText ?? text
      const requestId = createId()
      const userMessage: ChatMessage = {
        id: requestId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        metadata: attachments?.length ? { attachments } : undefined,
      }
      messages.value.push(userMessage)
      const sessionId = await ensureSession()
      // ensureSession 完成后立即释放 draftSending，不再阻塞后续发送
      draftSending.value = false
      refreshSendingState(sending, draftSending)
      if (pendingSessionIds.value[sessionId] || isSessionStreaming(sessionId)) {
        return null
      }

      if (shouldSeedAutoTitle) {
        autoTitleController.seedAutoTitle(sessionId, text)
      }

      void persistMessage(userMessage, sessionId)
      return deliveryController.deliverMessage({
        backendText,
        sessionId,
        attachments,
        requestId,
        sending,
        draftSending,
      })
    } finally {
      draftSending.value = false
      refreshSendingState(sending, draftSending)
    }
  }

  return {
    buildRequestMetadata: deliveryController.buildRequestMetadata,
    sendMessage,
  }
}
