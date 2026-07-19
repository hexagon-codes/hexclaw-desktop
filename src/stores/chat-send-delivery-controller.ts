import type { Ref } from 'vue'
import type { ChatAttachment, ChatDocumentRef, ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
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
  updateStreamChunk: (sessionId: string, content?: string, reasoning?: string) => boolean
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    messageContent?: MessageContent
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    blocks?: ChatMessage['blocks']
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

  function buildRequestMetadata(snapshot?: {
    agentRole: string
    chatParams: { provider?: string; model?: string; temperature?: number; maxTokens?: number }
    thinkingEnabled: boolean
  }): Record<string, string> | undefined {
    const settingsStore = getSettingsStore()
    const memoryEnabled = settingsStore.config?.memory?.enabled ?? true
    const agentMode = settingsStore.config?.llm?.agentMode ?? 'auto'
    // U4：优先用发送点击瞬间的快照——否则 Auto-RAG(≤1.2s) 期间用户切会话会改共享 ref，
    // 在途请求带上新会话的 agent/model/thinking（Agent 会话回答由默认助理/错误模型生成）。
    const cp = snapshot?.chatParams ?? chatParams.value
    const role = snapshot?.agentRole ?? agentRole.value
    const thinking = snapshot?.thinkingEnabled ?? thinkingEnabled.value
    const model = cp.model
    const modelCaps = model
      ? (settingsStore.availableModels ?? []).find((m) => m.modelId === model)?.capabilities ?? []
      : []
    // v0.4.0 9.5：把当前 i18n locale 透传给后端 system prompt
    const userLocale =
      (typeof localStorage !== 'undefined' && localStorage.getItem('hc-locale')) || 'zh-CN'
    return buildChatRequestMetadata({
      thinkingEnabled: thinking,
      memoryEnabled,
      imageGeneration: modelCaps.includes('image_generation'),
      videoGeneration: modelCaps.includes('video_generation'),
      temperature: cp.temperature,
      maxTokens: cp.maxTokens,
      agentMode,
      userLocale,
      // BUG-20260703：桌面聊天恒发锁定信号——收件人是显式契约，
      // 空 agentRole = 用户在跟默认助理对话，后端不得按内容改派。
      pinnedAgent: role,
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
    skillNames?: string[]
    documents?: ChatDocumentRef[]
    samplingSnapshot?: {
      agentRole: string
      chatParams: { provider?: string; model?: string; temperature?: number; maxTokens?: number }
      thinkingEnabled: boolean
    }
  }): Promise<ChatMessage | null> {
    const {
      backendText,
      sessionId,
      attachments,
      requestId,
      sending,
      draftSending,
      skillNames,
      documents,
    } = args

    // U3：先检查 pre-delivery 窗口（send-controller 的 Auto-RAG + 下方 WS 连接）内会话是否
    // 已被删除/取消——此前无条件 clearSessionCancelled 会抹掉删除时设的取消标记，导致
    // 回复照常 openWebSocketStream 投递到已删会话。仅未取消时才清（清的是陈旧标记）。
    if (isSessionCancelled(sessionId)) {
      resetSessionStream(sessionId, sending, draftSending)
      return null
    }
    clearSessionCancelled(sessionId)
    setSessionPending(sessionId, true, sending, draftSending)

    // bug#2 2026-06-23：显式挂载/召唤的技能经 metadata.skills 透传给后端（逗号分隔）。
    // 此前 skillNames 只进本地消息 metadata、从未发给后端 → 技能当轮不生效。
    // BUG-20260626：文档卡片 ref 经 metadata.documents（JSON）透传给后端持久化，
    // 否则切会话重载后文档退化成纯文本（卡片只在前端本地、不落库）。
    let requestMetadata = buildRequestMetadata(args.samplingSnapshot)
    if (skillNames && skillNames.length) {
      requestMetadata = { ...(requestMetadata ?? {}), skills: skillNames.join(',') }
    }
    if (documents && documents.length) {
      requestMetadata = { ...(requestMetadata ?? {}), documents: JSON.stringify(documents) }
    }
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
