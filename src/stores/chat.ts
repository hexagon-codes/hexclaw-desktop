/**
 * 聊天状态 Store（纯响应式状态 + 薄动作）
 *
 * 职责：管理响应式状态，委托 services 处理业务逻辑。
 * - 会话/消息状态 → 响应式 ref
 * - 持久化 → messageService
 * - 发送编排 → chatService
 */

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { updateMessageFeedback as updateBackendMessageFeedback, type UserFeedback } from '@/api/messages'
import { fromNativeError } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, ChatAttachment, Artifact, ChatMode, ExecMode, ApiError } from '@/types'

import * as msgSvc from '@/services/messageService'
import * as chatSvc from '@/services/chatService'

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
    tool_calls: message.tool_calls ? [...message.tool_calls] : undefined,
  }
}

export const useChatStore = defineStore('chat', () => {
  // ─── 响应式状态 ──────────────────────────────────

  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const streamingSessionId = ref<string | null>(null)
  const streamingContent = ref('')
  const error = ref<ApiError | null>(null)

  const chatMode = ref<ChatMode>('chat')
  const execMode = ref<ExecMode>('craft')
  const agentRole = ref<string>('')

  const artifacts = ref<Artifact[]>([])
  const selectedArtifactId = ref<string | null>(null)
  const showArtifacts = ref(false)

  const chatParams = ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>({})

  // ─── 会话管理 ──────────────────────────────────

  async function loadSessions() {
    try {
      sessions.value = await msgSvc.loadAllSessions()
      if (!currentSessionId.value && sessions.value.length > 0) {
        try {
          const lastId = await msgSvc.getLastSessionId()
          if (lastId && sessions.value.some((s) => s.id === lastId)) {
            await selectSession(lastId)
          }
        } catch { /* 首次运行 */ }
      }
      chatSvc.retryPendingOutbox()
      chatSvc.cleanupOutbox()
    } catch (e) {
      logger.warn('加载会话列表失败（可能非 Tauri 环境）', e)
    }
  }

  async function selectSession(sessionId: string) {
    currentSessionId.value = sessionId
    msgSvc.setLastSessionId(sessionId).catch(() => {})
    try {
      messages.value = await msgSvc.loadMessages(sessionId)
    } catch (e) {
      logger.warn('加载消息历史失败', e)
      messages.value = []
    }
    try {
      artifacts.value = await msgSvc.loadArtifacts(sessionId)
    } catch {
      artifacts.value = []
    }
    selectedArtifactId.value = null
    showArtifacts.value = false
    error.value = null
  }

  const pendingSessionTitle = ref<string | null>(null)
  const hasCustomTitle = ref(false)

  function newSession(title?: string) {
    currentSessionId.value = null
    messages.value = []
    artifacts.value = []
    selectedArtifactId.value = null
    showArtifacts.value = false
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    chatSvc.clearWebSocketCallbacks()
    error.value = null
    pendingSessionTitle.value = title ?? null
    hasCustomTitle.value = !!title
  }

  let _ensureSessionPromise: Promise<string> | null = null
  async function ensureSession(): Promise<string> {
    if (currentSessionId.value) return currentSessionId.value
    if (_ensureSessionPromise) return _ensureSessionPromise
    _ensureSessionPromise = (async () => {
      const id = nanoid(12)
      try {
        await msgSvc.createSession(id, pendingSessionTitle.value || '新对话')
        pendingSessionTitle.value = null
      } catch (e) {
        logger.warn('创建会话失败', e)
      }
      currentSessionId.value = id
      return id
    })()
    try { return await _ensureSessionPromise } finally { _ensureSessionPromise = null }
  }

  // ─── 消息持久化 ──────────────────────────────────

  async function persistMessage(msg: ChatMessage, sessionId: string) {
    await msgSvc.persistMessage(msg, sessionId)
  }

  async function updateMessage(
    messageId: string,
    updater: Partial<ChatMessage> | ((current: ChatMessage) => ChatMessage),
  ): Promise<ChatMessage | null> {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return null
    const current = messages.value[idx]!
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
    messages.value[idx] = next
    const sessionId = currentSessionId.value
    if (sessionId) {
      await persistMessage(next, sessionId)
      msgSvc.touchSession(sessionId).catch(() => {})
    }
    return next
  }

  async function setMessageFeedback(
    messageId: string,
    feedback: Exclude<UserFeedback, ''> | null,
  ): Promise<ChatMessage | null> {
    const current = messages.value.find((m) => m.id === messageId)
    if (!current || current.role !== 'assistant') return null
    const previous = cloneMessage(current)
    const next = await updateMessage(messageId, (message) => {
      const metadata = { ...(message.metadata ?? {}) }
      if (feedback) metadata.user_feedback = feedback
      else delete metadata.user_feedback
      return { ...message, metadata: Object.keys(metadata).length > 0 ? metadata : undefined }
    })
    const backendMessageId = typeof previous.metadata?.backend_message_id === 'string' ? previous.metadata.backend_message_id : null
    if (!backendMessageId) {
      logger.warn('消息缺少 backend_message_id，反馈仅保存在本地', { messageId })
      return next
    }
    try {
      await updateBackendMessageFeedback(backendMessageId, feedback ?? '')
      return next
    } catch (syncError) {
      await updateMessage(messageId, previous)
      throw syncError
    }
  }

  // ─── Artifacts ──────────────────────────────────

  function extractArtifacts(content: string, messageId: string) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'text'
      const code = match[2]!.trim()
      if (code.length < 5) continue
      const existingIdx = artifacts.value.findIndex((a) => a.messageId === messageId && a.language === language)
      const artifact: Artifact = {
        id: existingIdx >= 0 ? artifacts.value[existingIdx]!.id : nanoid(8),
        type: language === 'html' ? 'html' : 'code',
        title: `${language} snippet`,
        language,
        content: code,
        previousContent: existingIdx >= 0 ? artifacts.value[existingIdx]!.content : undefined,
        messageId,
        createdAt: new Date().toISOString(),
      }
      if (existingIdx >= 0) { artifacts.value[existingIdx] = artifact } else { artifacts.value.push(artifact) }
      if (currentSessionId.value) {
        msgSvc.saveArtifact(currentSessionId.value, artifact).catch((e) => logger.warn('持久化 artifact 失败', e))
      }
    }
  }

  function addArtifact(artifact: Omit<Artifact, 'id' | 'createdAt'>) {
    const full: Artifact = { ...artifact, id: nanoid(8), createdAt: new Date().toISOString() }
    artifacts.value.push(full)
    if (currentSessionId.value) {
      msgSvc.saveArtifact(currentSessionId.value, full).catch((e) => logger.warn('持久化 artifact 失败', e))
    }
  }

  function selectArtifact(id: string) {
    selectedArtifactId.value = id
    showArtifacts.value = true
  }

  // ─── 发送消息（委托 chatService） ──────────────

  function finalizeAssistantMessage(params: {
    content: string; sessionId: string; userText: string
    metadata?: Record<string, unknown>; toolCalls?: ChatMessage['tool_calls']; agentName?: string
  }): ChatMessage {
    const assistantMsg: ChatMessage = {
      id: nanoid(), role: 'assistant', content: params.content || '(空回复)',
      timestamp: new Date().toISOString(),
      metadata: params.metadata, tool_calls: params.toolCalls, agent_name: params.agentName,
    }
    messages.value.push(assistantMsg)
    persistMessage(assistantMsg, params.sessionId)
    if (messages.value.length <= 2 && !hasCustomTitle.value) {
      const title = params.userText.slice(0, 30) + (params.userText.length > 30 ? '...' : '')
      msgSvc.updateSessionTitle(params.sessionId, title).catch(() => {})
    }
    msgSvc.touchSession(params.sessionId).catch(() => {})
    extractArtifacts(params.content, assistantMsg.id)
    streaming.value = false
    streamingContent.value = ''
    loadSessions()
    return assistantMsg
  }

  function handleSendError(e: unknown) {
    logger.error('发送消息失败', e)
    const apiErr = fromNativeError(e)
    error.value = apiErr
    if (streaming.value) { stopStreaming() } else {
      streaming.value = false; streamingSessionId.value = null; streamingContent.value = ''
      chatSvc.clearWebSocketCallbacks()
    }
    messages.value.push({ id: nanoid(), role: 'assistant', content: apiErr.message || '发送失败，请检查 hexclaw 引擎是否运行', timestamp: new Date().toISOString() })
    loadSessions()
  }

  async function sendMessage(
    text: string, attachments?: ChatAttachment[], options?: { backendText?: string },
  ): Promise<ChatMessage | null> {
    if (streaming.value) stopStreaming()
    const backendText = options?.backendText ?? text
    const userMsg: ChatMessage = {
      id: nanoid(), role: 'user', content: text, timestamp: new Date().toISOString(),
      metadata: attachments?.length ? { attachments } : undefined,
    }
    messages.value.push(userMsg)
    const sessionId = await ensureSession()

    chatSvc.outboxInsert(userMsg.id, sessionId, text, attachments).catch((e) => logger.warn('outbox 写入失败', e))
    persistMessage(userMsg, sessionId)
    chatSvc.outboxMarkSending(userMsg.id).catch(() => {})

    streaming.value = true
    streamingSessionId.value = sessionId
    streamingContent.value = ''
    error.value = null

    const wsConnected = await chatSvc.ensureWebSocketConnected()

    if (!wsConnected) {
      try {
        const result = await chatSvc.sendViaBackend(backendText, sessionId, chatParams.value, agentRole.value, attachments)
        chatSvc.outboxMarkSent(userMsg.id).catch(() => {})
        return finalizeAssistantMessage({ content: result.reply, sessionId, userText: text, metadata: result.metadata, toolCalls: result.tool_calls, agentName: typeof result.metadata?.agent_name === 'string' ? result.metadata.agent_name : undefined })
      } catch (httpError) {
        chatSvc.outboxMarkFailed(userMsg.id, httpError instanceof Error ? httpError.message : 'HTTP 发送失败').catch(() => {})
        handleSendError(httpError)
        return null
      }
    }

    try {
      await chatSvc.sendViaWebSocket(backendText, sessionId, chatParams.value, agentRole.value, attachments, {
        onChunk: (content) => {
          if (streamingSessionId.value === sessionId) streamingContent.value += content
        },
        onDone: (content, metadata, toolCalls, agentName) => {
          finalizeAssistantMessage({
            content: content || streamingContent.value, sessionId, userText: text,
            metadata, toolCalls, agentName,
          })
        },
        onError: (err) => handleSendError(err),
      })
      chatSvc.outboxMarkSent(userMsg.id).catch(() => {})
      return messages.value[messages.value.length - 1] ?? null
    } catch (wsError) {
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        chatSvc.outboxMarkFailed(userMsg.id, (wsError as Error).message).catch(() => {})
        handleSendError(wsError)
        return null
      }
      logger.warn('WebSocket 发送失败，回退到 HTTP', wsError)
      try {
        const result = await chatSvc.sendViaBackend(backendText, sessionId, chatParams.value, agentRole.value, attachments)
        chatSvc.outboxMarkSent(userMsg.id).catch(() => {})
        return finalizeAssistantMessage({ content: result.reply, sessionId, userText: text, metadata: result.metadata, toolCalls: result.tool_calls, agentName: typeof result.metadata?.agent_name === 'string' ? result.metadata.agent_name : undefined })
      } catch (httpError) {
        chatSvc.outboxMarkFailed(userMsg.id, httpError instanceof Error ? httpError.message : 'HTTP 发送失败').catch(() => {})
        handleSendError(httpError)
        return null
      }
    }
  }

  function stopStreaming() {
    if (streamingContent.value.trim()) {
      const partialMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: streamingContent.value, timestamp: new Date().toISOString() }
      messages.value.push(partialMsg)
      if (currentSessionId.value) persistMessage(partialMsg, currentSessionId.value)
    }
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    chatSvc.clearWebSocketCallbacks()
  }

  async function deleteSession(sessionId: string) {
    try {
      await msgSvc.deleteSession(sessionId)
      sessions.value = sessions.value.filter((s) => s.id !== sessionId)
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null; messages.value = []; artifacts.value = []
        selectedArtifactId.value = null; showArtifacts.value = false
        if (streamingSessionId.value === sessionId) {
          streaming.value = false; streamingSessionId.value = null; streamingContent.value = ''
          chatSvc.clearWebSocketCallbacks()
        }
      }
      error.value = null
    } catch (e) {
      logger.error('删除会话失败', e)
      error.value = { code: 'SERVER_ERROR', status: 500, message: '删除会话失败' }
    }
  }

  // ─── 计算属性 ──────────────────────────────────

  const isCurrentStreaming = computed(() => streaming.value && streamingSessionId.value === currentSessionId.value)
  const isCurrentStreamingContent = computed(() => isCurrentStreaming.value ? streamingContent.value : '')

  return {
    sessions, currentSessionId, messages, streaming, streamingSessionId, streamingContent,
    isCurrentStreaming, isCurrentStreamingContent, error,
    chatMode, execMode, agentRole, chatParams,
    artifacts, selectedArtifactId, showArtifacts,
    loadSessions, selectSession, newSession, ensureSession,
    sendMessage, updateMessage, setMessageFeedback,
    stopStreaming, deleteSession,
    addArtifact, selectArtifact, extractArtifacts,
  }
})
