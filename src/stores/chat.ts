/**
 * 聊天状态 Store（纯响应式状态 + 薄动作）
 *
 * 职责：管理响应式状态，委托 services 处理业务逻辑。
 * - 会话/消息状态 → 响应式 ref
 * - 持久化 → messageService
 * - 发送编排 → chatService
 */

import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { updateMessageFeedback as updateBackendMessageFeedback, type UserFeedback } from '@/api/chat'
import { fromNativeError } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, ChatAttachment, Artifact, ChatMode, ExecMode, ApiError } from '@/types'

import * as msgSvc from '@/services/messageService'
import * as chatSvc from '@/services/chatService'
import { hexclawWS, type ToolApprovalRequest } from '@/api/websocket'
import { extractThinkTags } from '@/utils/think-tags'

function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message))
}

export const useChatStore = defineStore('chat', () => {
  // ─── 响应式状态 ──────────────────────────────────

  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const streamingSessionId = ref<string | null>(null)
  const streamingContent = ref('')
  const streamingReasoning = ref('')
  const streamingReasoningStartTime = ref<number>(0)
  /** 原始流式内容缓冲（含可能的 <think> 标签），用于实时解析 */
  let _rawStreamBuf = ''
  const error = ref<ApiError | null>(null)

  const chatMode = ref<ChatMode>('chat')
  const execMode = ref<ExecMode>('craft')
  const agentRole = ref<string>('')

  const artifacts = ref<Artifact[]>([])
  const selectedArtifactId = ref<string | null>(null)
  const showArtifacts = ref(false)

  const chatParams = ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>({})
  const thinkingEnabled = ref(false)
  const sending = ref(false)

  // ─── 工具审批状态 ──────────────────────────────────
  const pendingApproval = ref<ToolApprovalRequest | null>(null)
  let sessionSelectionGen = 0

  // 初始化 WS 审批监听 (全局，只注册一次)
  let approvalCleanup: (() => void) | null = null
  function initApprovalListener() {
    if (approvalCleanup) return
    approvalCleanup = hexclawWS.onApprovalRequest((req) => {
      pendingApproval.value = req
    })
  }

  function respondApproval(requestId: string, approved: boolean, remember: boolean) {
    hexclawWS.sendApprovalResponse(requestId, approved, remember)
    pendingApproval.value = null
  }

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
    } catch (e) {
      logger.warn('加载会话列表失败（可能非 Tauri 环境）', e)
    }
  }

  async function selectSession(sessionId: string) {
    const selectionGen = ++sessionSelectionGen
    // Clean up state from previous session to prevent leaks
    if (streaming.value && streamingSessionId.value && streamingSessionId.value !== sessionId) {
      stopStreaming()
    }
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
    chatMode.value = 'chat'
    agentRole.value = ''
    hasCustomTitle.value = false

    currentSessionId.value = sessionId
    msgSvc.setLastSessionId(sessionId)
    try {
      const nextMessages = await msgSvc.loadMessages(sessionId)
      if (selectionGen !== sessionSelectionGen) return
      messages.value = nextMessages
    } catch (e) {
      if (selectionGen !== sessionSelectionGen) return
      logger.warn('加载消息历史失败', e)
      messages.value = []
    }
    try {
      const persisted = await msgSvc.loadArtifacts(sessionId)
      if (selectionGen !== sessionSelectionGen) return
      if (persisted.length > 0) {
        artifacts.value = persisted
      } else {
        // 持久化为空时从消息内容重建 artifacts
        artifacts.value = []
        for (const msg of messages.value) {
          if (msg.role === 'assistant' && msg.content) {
            extractArtifacts(msg.content, msg.id)
          }
        }
      }
    } catch {
      if (selectionGen !== sessionSelectionGen) return
      artifacts.value = []
    }
    if (selectionGen !== sessionSelectionGen) return
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
    // Clear existing artifacts for this message to avoid dedup collisions
    artifacts.value = artifacts.value.filter((a) => a.messageId !== messageId)
    let blockIndex = 0
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'text'
      const code = match[2]!.trim()
      if (code.length < 5) continue
      const artifact: Artifact = {
        id: nanoid(8),
        type: language === 'html' ? 'html' : 'code',
        title: `${language} snippet`,
        language,
        content: code,
        messageId,
        blockIndex,
        createdAt: new Date().toISOString(),
      }
      blockIndex++
      artifacts.value.push(artifact)
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
    reasoning?: string
  }): ChatMessage {
    // 兜底解析：从 content 中提取内嵌的 <think> 标签
    const parsed = extractThinkTags(params.content || '')
    const finalContent = parsed.content
    const finalReasoning = parsed.reasoning
      ? (params.reasoning ? params.reasoning + '\n' + parsed.reasoning : parsed.reasoning)
      : (params.reasoning || undefined)

    const thinkingDuration = streamingReasoningStartTime.value
      ? Math.round((Date.now() - streamingReasoningStartTime.value) / 1000)
      : 0
    const metadata = { ...params.metadata } as Record<string, unknown>
    if (thinkingDuration > 0) metadata.thinking_duration = thinkingDuration
    const assistantMsg: ChatMessage = {
      id: nanoid(), role: 'assistant', content: finalContent || (finalReasoning ? '' : '模型未生成有效回复，可能是内容安全策略过滤所致，请尝试换个方式提问。'),
      timestamp: new Date().toISOString(),
      reasoning: finalReasoning,
      metadata, tool_calls: params.toolCalls, agent_name: params.agentName,
    }
    messages.value.push(assistantMsg)
    persistMessage(assistantMsg, params.sessionId)
    if (messages.value.length <= 2 && !hasCustomTitle.value) {
      const title = params.userText.slice(0, 30) + (params.userText.length > 30 ? '...' : '')
      msgSvc.updateSessionTitle(params.sessionId, title).catch(() => {})
    }
    msgSvc.touchSession(params.sessionId).catch(() => {})
    extractArtifacts(finalContent, assistantMsg.id)
    streaming.value = false
    streamingContent.value = ''
    streamingReasoning.value = ''; streamingReasoningStartTime.value = 0
    _rawStreamBuf = ''
    loadSessions()
    return assistantMsg
  }

  function handleSendError(e: unknown) {
    logger.error('发送消息失败', e)
    const apiErr = fromNativeError(e)
    error.value = apiErr
    if (streaming.value) { stopStreaming() } else {
      streaming.value = false; streamingSessionId.value = null; streamingContent.value = ''; streamingReasoning.value = ''; _rawStreamBuf = ''
      chatSvc.clearWebSocketCallbacks()
    }
    messages.value.push({ id: nanoid(), role: 'assistant', content: apiErr.message || '发送失败，请检查 hexclaw 引擎是否运行', timestamp: new Date().toISOString() })
    loadSessions()
  }

  async function sendMessage(
    text: string, attachments?: ChatAttachment[], options?: { backendText?: string },
  ): Promise<ChatMessage | null> {
    if (sending.value) return null
    sending.value = true
    try {
    if (streaming.value) stopStreaming()
    const backendText = options?.backendText ?? text
    const userMsg: ChatMessage = {
      id: nanoid(), role: 'user', content: text, timestamp: new Date().toISOString(),
      metadata: attachments?.length ? { attachments } : undefined,
    }
    messages.value.push(userMsg)
    const sessionId = await ensureSession()

    persistMessage(userMsg, sessionId)

    streaming.value = true
    streamingSessionId.value = sessionId
    streamingContent.value = ''
    error.value = null

    const wsConnected = await chatSvc.ensureWebSocketConnected()

    if (!wsConnected) {
      try {
        const result = await chatSvc.sendViaBackend(backendText, sessionId, chatParams.value, agentRole.value, attachments)
        return finalizeAssistantMessage({ content: result.reply, sessionId, userText: text, metadata: result.metadata, toolCalls: result.tool_calls, agentName: typeof result.metadata?.agent_name === 'string' ? result.metadata.agent_name : undefined })
      } catch (httpError) {
        handleSendError(httpError)
        return null
      }
    }

    try {
      const wsMeta: Record<string, string> = {}
      if (thinkingEnabled.value) wsMeta.thinking = 'on'
      await chatSvc.sendViaWebSocket(backendText, sessionId, chatParams.value, agentRole.value, attachments, {
        onChunk: (content, reasoning) => {
          if (streamingSessionId.value !== sessionId) return
          if (reasoning) {
            if (!streamingReasoningStartTime.value) streamingReasoningStartTime.value = Date.now()
            streamingReasoning.value += reasoning
          }
          if (content) {
            // 累积原始内容，解析可能内嵌的 <think> 标签
            _rawStreamBuf += content
            const parsed = extractThinkTags(_rawStreamBuf)
            if (parsed.reasoning) {
              if (!streamingReasoningStartTime.value) streamingReasoningStartTime.value = Date.now()
              streamingReasoning.value = parsed.reasoning
            }
            streamingContent.value = parsed.content
          }
        },
        onDone: (content, metadata, toolCalls, agentName) => {
          finalizeAssistantMessage({
            content: content || streamingContent.value, sessionId, userText: text,
            metadata, toolCalls, agentName,
            reasoning: streamingReasoning.value || undefined,
          })
        },
      }, Object.keys(wsMeta).length > 0 ? wsMeta : undefined)
      return messages.value[messages.value.length - 1] ?? null
    } catch (wsError) {
      if (wsError instanceof chatSvc.ChatRequestError && wsError.noFallback) {
        handleSendError(wsError)
        return null
      }
      logger.warn('WebSocket 发送失败，回退到 HTTP', wsError)
      try {
        const result = await chatSvc.sendViaBackend(backendText, sessionId, chatParams.value, agentRole.value, attachments)
        return finalizeAssistantMessage({ content: result.reply, sessionId, userText: text, metadata: result.metadata, toolCalls: result.tool_calls, agentName: typeof result.metadata?.agent_name === 'string' ? result.metadata.agent_name : undefined })
      } catch (httpError) {
        handleSendError(httpError)
        return null
      }
    }
    } finally {
      sending.value = false
    }
  }

  function stopStreaming() {
    if (streamingContent.value.trim()) {
      const partialMsg: ChatMessage = {
        id: nanoid(), role: 'assistant', content: streamingContent.value, timestamp: new Date().toISOString(),
        reasoning: streamingReasoning.value || undefined,
      }
      messages.value.push(partialMsg)
      if (currentSessionId.value) persistMessage(partialMsg, currentSessionId.value)
    }
    // 通知后端取消当前流式生成
    hexclawWS.sendRaw({ type: 'cancel', session_id: streamingSessionId.value })
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    streamingReasoning.value = ''; streamingReasoningStartTime.value = 0
    _rawStreamBuf = ''
    // 先触发 error 回调来 settle 悬挂的 sendViaWebSocket promise，再清除回调
    hexclawWS.triggerError('用户取消')
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
          hexclawWS.sendRaw({ type: 'cancel', session_id: streamingSessionId.value })
          streaming.value = false; streamingSessionId.value = null; streamingContent.value = ''
          streamingReasoning.value = ''; streamingReasoningStartTime.value = 0
          hexclawWS.triggerError('用户取消')
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
  const isCurrentStreamingReasoning = computed(() => isCurrentStreaming.value ? streamingReasoning.value : '')
  const streamingThinkingElapsed = ref(0)
  let thinkingTimer: ReturnType<typeof setInterval> | null = null

  watch(() => streamingReasoningStartTime.value, (v) => {
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
    if (v) {
      streamingThinkingElapsed.value = 0
      thinkingTimer = setInterval(() => {
        streamingThinkingElapsed.value = Math.round((Date.now() - v) / 1000)
      }, 1000)
    } else {
      streamingThinkingElapsed.value = 0
    }
  })

  return {
    sessions, currentSessionId, messages, streaming, streamingSessionId, streamingContent, streamingReasoningStartTime,
    isCurrentStreaming, isCurrentStreamingContent, isCurrentStreamingReasoning, streamingThinkingElapsed, error,
    chatMode, execMode, agentRole, chatParams, thinkingEnabled, sending,
    artifacts, selectedArtifactId, showArtifacts,
    pendingApproval,
    hasCustomTitle,
    loadSessions, selectSession, newSession, ensureSession,
    sendMessage, updateMessage, setMessageFeedback,
    stopStreaming, deleteSession,
    addArtifact, selectArtifact, extractArtifacts,
    initApprovalListener, respondApproval,
  }
})
