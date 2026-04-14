import type { Ref } from 'vue'
import type { ChatAttachment, ChatMessage } from '@/types'
import { buildChatRequestMetadata } from './chat-request-metadata'
import { createChatSendBackendDeliveryController } from './chat-send-backend-delivery'
import {
  CHAT_SEND_WEBSOCKET_FALLBACK,
  createChatSendWebSocketDeliveryController,
} from './chat-send-websocket-delivery'

type ChatServiceModule = typeof import('@/services/chatService')
type SettingsStoreFactory = typeof import('./settings').useSettingsStore

export function createChatSendDeliveryController(params: {
  chatParams: Ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>
  agentRole: Ref<string>
  thinkingEnabled: Ref<boolean>
  activeStreams: Ref<Record<string, import('./chat-stream-helpers').SessionStreamState>>
  chatSvc: ChatServiceModule
  getSettingsStore: SettingsStoreFactory
  clearSessionCancelled: (sessionId: string) => void
  isSessionCancelled: (sessionId: string) => boolean
  setSessionPending: (sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) => void
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
}) {
  const {
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
  } = params

  function buildRequestMetadata(): Record<string, string> | undefined {
    const settingsStore = getSettingsStore()
    const memoryEnabled = settingsStore.config?.memory?.enabled ?? true
    const model = chatParams.value.model
    const modelCaps = model
      ? settingsStore.availableModels.find((m) => m.modelId === model)?.capabilities ?? []
      : []
    return buildChatRequestMetadata({
      thinkingEnabled: thinkingEnabled.value,
      memoryEnabled,
      imageGeneration: modelCaps.includes('image_generation'),
      videoGeneration: modelCaps.includes('video_generation'),
    })
  }

  const backendDelivery = createChatSendBackendDeliveryController({
    chatParams,
    agentRole,
    chatSvc,
    isSessionCancelled,
    resetSessionStream,
    finalizeAssistantMessage,
    handleSendError,
  })

  const websocketDelivery = createChatSendWebSocketDeliveryController({
    chatParams,
    agentRole,
    activeStreams,
    chatSvc,
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

  async function deliverMessage(args: {
    backendText: string
    sessionId: string
    attachments?: ChatAttachment[]
    requestId: string
    sending: Ref<boolean>
    draftSending: Ref<boolean>
  }): Promise<ChatMessage | null> {
    const {
      backendText,
      sessionId,
      attachments,
      requestId,
      sending,
      draftSending,
    } = args

    clearSessionCancelled(sessionId)
    setSessionPending(sessionId, true, sending, draftSending)

    const requestMetadata = buildRequestMetadata()
    const wsConnected = await chatSvc.ensureWebSocketConnected()

    if (isSessionCancelled(sessionId)) {
      resetSessionStream(sessionId, sending, draftSending)
      return null
    }

    if (!wsConnected) {
      return backendDelivery.deliverViaBackend({
        backendText,
        sessionId,
        attachments,
        requestId,
        requestMetadata,
        sending,
        draftSending,
      })
    }

    const websocketResult = await websocketDelivery.deliverViaWebSocket({
      backendText,
      sessionId,
      attachments,
      requestId,
      requestMetadata,
      sending,
      draftSending,
    })
    if (websocketResult !== CHAT_SEND_WEBSOCKET_FALLBACK) {
      return websocketResult
    }

    setSessionPending(sessionId, true, sending, draftSending)
    return backendDelivery.deliverViaBackend({
      backendText,
      sessionId,
      attachments,
      requestId,
      requestMetadata,
      sending,
      draftSending,
    })
  }

  return {
    buildRequestMetadata,
    deliverMessage,
  }
}
