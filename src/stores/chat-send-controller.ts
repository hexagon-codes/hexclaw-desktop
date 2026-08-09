import type { Ref } from 'vue'
import { DEFAULT_SESSION_TITLE } from '@/constants'
import type { ChatAttachment, ChatDocumentRef, ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
import { createChatSendAutoTitleController } from './chat-send-auto-title'
import { createChatSendDeliveryController } from './chat-send-delivery-controller'
import { shouldBlockChatSend, shouldSeedChatAutoTitle } from './chat-send-guards'
import {
  resolveChatRouteSnapshot,
  type ChatRouteSnapshot,
} from './chat-route-snapshot'
import { buildSessionStreamState, type ChatSendErrorHandler } from './chat-stream-helpers'

type ChatServiceModule = typeof import('@/services/chatService')
type MessageServiceModule = typeof import('@/services/messageService')
type SettingsStoreFactory = typeof import('./settings').useSettingsStore

export interface ChatSendOptions {
  // backendText 支持惰性 thunk：含慢的上下文解析时，由 sendMessage 在用户气泡进入其
  // 所属会话后再解析，避免阻塞普通 composer 的乐观上屏。
  backendText?: string | (() => Promise<string | undefined>)
  skillNames?: string[]
  documents?: ChatDocumentRef[]
  /**
   * 内部定向提交目标。用于“编辑即新版本”事务：分支被接受前仍展示源会话，
   * 因而不能从全局 currentSessionId 推断写入目标。
   */
  targetSessionId?: string
  /** 编辑确认时冻结的源会话路由；存在时不得重新读取可变全局模型状态。 */
  routeSnapshot?: ChatRouteSnapshot
}

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
  isSessionExecuting: (sessionId: string) => boolean
  setSessionPending: (sessionId: string, value: boolean, sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  refreshSendingState: (sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  pendingAutoTitleSync: Map<string, Promise<void>>
  persistMessage: (message: ChatMessage, sessionId: string) => Promise<boolean>
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
  handleSendError: ChatSendErrorHandler
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
    isSessionExecuting,
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
    options?: ChatSendOptions,
  ): Promise<ChatMessage | null> {
    const directedSessionId = options?.targetSessionId?.trim() || null
    const initialSessionId = directedSessionId ?? currentSessionId.value
    const projectsIntoCurrentSession = !directedSessionId
      || directedSessionId === currentSessionId.value
    const shouldSeedAutoTitle = !directedSessionId && shouldSeedChatAutoTitle({
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
      isSessionExecuting,
    })) {
      return null
    }
    draftSending.value = !initialSessionId
    refreshSendingState(sending, draftSending)
    try {
      const requestId = createId()
      const samplingSnapshot = resolveChatRouteSnapshot(options?.routeSnapshot, {
        agentRole: agentRole.value,
        chatParams: { ...chatParams.value },
        thinkingEnabled: thinkingEnabled.value,
      })
      const skillNames = options?.skillNames ?? []
      const userMeta: Record<string, unknown> = {}
      if (attachments?.length) userMeta.attachments = attachments
      if (skillNames.length) userMeta.skills = skillNames
      // 文档卡片仅展示，不入 attachments、不发后端（正文已在 backendText）。
      if (options?.documents?.length) userMeta.documents = options.documents
      const userMessage: ChatMessage = {
        id: requestId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        metadata: Object.keys(userMeta).length ? userMeta : undefined,
      }
      // 普通 composer 保持乐观上屏；定向编辑在分支被接受前必须保持 source 可见，
      // 因而只投递到显式目标，不污染当前会话的消息数组。
      if (projectsIntoCurrentSession) messages.value.push(userMessage)
      const sessionId = directedSessionId ?? await ensureSession()
      // ensureSession 完成后立即释放 draftSending，不再阻塞后续发送
      draftSending.value = false
      refreshSendingState(sending, draftSending)
      if (
        pendingSessionIds.value[sessionId] ||
        isSessionStreaming(sessionId) ||
        isSessionExecuting(sessionId)
      ) {
        return null
      }

      if (shouldSeedAutoTitle) {
        autoTitleController.seedAutoTitle(sessionId, text)
      }

      // 持久化与发送并行，失败不阻塞（persistMessage 内部已有日志）
      void persistMessage(userMessage, sessionId).catch(() => {})
      // BUG-20260704：在 await Auto-RAG 之前就把本会话置为 pending，让 assistant 挂起气泡
      // （ChatView showAssistantPending 依赖 sending）随用户气泡即时上屏；否则用户要等
      // Auto-RAG(≤AUTO_RAG_BUDGET_MS 1.2s)+WS 连接完成、deliverMessage 才置 pending，
      // 小蟹和回答气泡延迟 1-2s 才出现。deliverMessage 内会幂等再置 pending，流式起来后
      // upsertStreamState 交棒给 isCurrentStreaming，pending 由收尾逻辑清除，无双清风险。
      // U4：点击瞬间快照采样参数——buildRequestMetadata 在下方 Auto-RAG 之后才读，期间用户
      // 切会话会改共享 ref，快照保证在途请求带的是本次发送时的 agent/model/thinking。
      upsertStreamState(sessionId, buildSessionStreamState({
        sessionId,
        requestId,
        thinkingEnabled: samplingSnapshot.thinkingEnabled,
        agentDisplayName: samplingSnapshot.agentDisplayName,
        recipientDisplayName: samplingSnapshot.recipientDisplayName,
      }))
      setSessionPending(sessionId, true, sending, draftSending)
      // backendText 惰性解析：气泡已上屏，此处再 await 跑 Auto-RAG（BUG-20260628）；string 形态直用。
      const backendText =
        (typeof options?.backendText === 'function'
          ? await options.backendText()
          : options?.backendText) ?? text
      return deliveryController.deliverMessage({
        backendText,
        sessionId,
        attachments,
        requestId,
        sending,
        draftSending,
        skillNames, // bug#2 2026-06-23：透传挂载技能给后端（此前在此被丢弃）
        documents: options?.documents, // BUG-20260626：透传文档卡片给后端持久化（否则重载丢失退化纯文本）
        samplingSnapshot, // U4：点击瞬间快照，防 Auto-RAG 期间切会话带错 agent/model/thinking
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
