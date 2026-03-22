import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { sendChatViaBackend } from '@/api/chat'
import { updateMessageFeedback as updateBackendMessageFeedback, type UserFeedback } from '@/api/messages'
import { hexclawWS } from '@/api/websocket'
import {
  dbGetSessions,
  dbCreateSession,
  dbUpdateSessionTitle,
  dbTouchSession,
  dbDeleteSession,
  dbGetMessages,
  dbSaveMessage,
} from '@/db/chat'
import { fromNativeError } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, ChatAttachment, Artifact, ChatMode, ExecMode, ApiError } from '@/types'

const WS_FIRST_REPLY_TIMEOUT_MS = 45_000
const WS_INACTIVITY_TIMEOUT_MS = 90_000
const BACKEND_REPLY_TIMEOUT_MS = 120_000

class ChatRequestError extends Error {
  noFallback: boolean

  constructor(message: string, noFallback = false) {
    super(message)
    this.name = 'ChatRequestError'
    this.noFallback = noFallback
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function parseMessageMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function normalizeLoadedMessage(row: {
  id: string
  role: string
  content: string
  timestamp: string
  metadata: string | null
}): ChatMessage {
  const metadata = parseMessageMetadata(row.metadata)
  const toolCalls = Array.isArray(metadata?.tool_calls) ? metadata.tool_calls : undefined
  const agentName = typeof metadata?.agent_name === 'string' ? metadata.agent_name : undefined

  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    timestamp: row.timestamp,
    metadata,
    tool_calls: toolCalls as ChatMessage['tool_calls'],
    agent_name: agentName,
  }
}

function serializeMessageMetadata(msg: ChatMessage): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...(msg.metadata ?? {}) }
  if (msg.tool_calls?.length) metadata.tool_calls = msg.tool_calls
  if (msg.agent_name) metadata.agent_name = msg.agent_name
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
    tool_calls: message.tool_calls ? [...message.tool_calls] : undefined,
  }
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const streamingSessionId = ref<string | null>(null)
  const streamingContent = ref('')
  const error = ref<ApiError | null>(null)

  // 模式状态
  const chatMode = ref<ChatMode>('chat')
  const execMode = ref<ExecMode>('craft')

  // Agent 角色 (assistant/researcher/writer/coder/translator/analyst)
  const agentRole = ref<string>('assistant')

  // Artifacts 状态
  const artifacts = ref<Artifact[]>([])
  const selectedArtifactId = ref<string | null>(null)
  const showArtifacts = ref(false)

  // 聊天参数（保留兼容，后端模式下仅 role 生效）
  const chatParams = ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>({})

  /** 加载会话列表（从 SQLite） */
  async function loadSessions() {
    try {
      const rows = await dbGetSessions()
      sessions.value = rows.map((r) => ({
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        updated_at: r.updated_at,
        message_count: 0,
      }))
    } catch (e) {
      logger.warn('加载会话列表失败（可能非 Tauri 环境）', e)
    }
  }

  /** 选择会话（从 SQLite 加载消息） */
  async function selectSession(sessionId: string) {
    currentSessionId.value = sessionId
    try {
      const rows = await dbGetMessages(sessionId)
      messages.value = rows.map(normalizeLoadedMessage)
    } catch (e) {
      logger.warn('加载消息历史失败', e)
      messages.value = []
    }
    error.value = null
  }

  /** 新建会话，可选指定标题 */
  const pendingSessionTitle = ref<string | null>(null)
  /** 标记会话标题是否由用户/Agent 指定（不应被第一条消息覆盖） */
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
    hexclawWS.clearCallbacks()
    error.value = null
    pendingSessionTitle.value = title ?? null
    hasCustomTitle.value = !!title
  }

  /** 确保当前有会话 ID（没有则创建），加锁防止并发创建 */
  let _ensureSessionPromise: Promise<string> | null = null
  async function ensureSession(): Promise<string> {
    if (currentSessionId.value) return currentSessionId.value
    if (_ensureSessionPromise) return _ensureSessionPromise
    _ensureSessionPromise = (async () => {
      const id = nanoid(12)
      try {
        await dbCreateSession(id, pendingSessionTitle.value || '新对话')
        pendingSessionTitle.value = null
      } catch (e) {
        logger.warn('创建会话失败', e)
      }
      currentSessionId.value = id
      return id
    })()
    try {
      return await _ensureSessionPromise
    } finally {
      _ensureSessionPromise = null
    }
  }

  /** 持久化消息到 SQLite */
  async function persistMessage(msg: ChatMessage, sessionId: string) {
    try {
      await dbSaveMessage(msg.id, sessionId, msg.role, msg.content, msg.timestamp, serializeMessageMetadata(msg))
    } catch (e) {
      logger.warn('持久化消息失败', e)
    }
  }

  /** 更新消息并同步持久化 */
  async function updateMessage(
    messageId: string,
    updater: Partial<ChatMessage> | ((current: ChatMessage) => ChatMessage),
  ): Promise<ChatMessage | null> {
    const idx = messages.value.findIndex((msg) => msg.id === messageId)
    if (idx < 0) return null

    const current = messages.value[idx]!
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
    messages.value[idx] = next

    const sessionId = currentSessionId.value
    if (sessionId) {
      await persistMessage(next, sessionId)
      dbTouchSession(sessionId).catch(() => {})
    }

    return next
  }

  async function setMessageFeedback(
    messageId: string,
    feedback: Exclude<UserFeedback, ''> | null,
  ): Promise<ChatMessage | null> {
    const current = messages.value.find((message) => message.id === messageId)
    if (!current || current.role !== 'assistant') return null

    const previous = cloneMessage(current)
    const next = await updateMessage(messageId, (message) => {
      const metadata = { ...(message.metadata ?? {}) }
      if (feedback) metadata.user_feedback = feedback
      else delete metadata.user_feedback

      return {
        ...message,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    })

    const backendMessageId = typeof previous.metadata?.backend_message_id === 'string'
      ? previous.metadata.backend_message_id
      : null
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

  /** 从内容中提取 Artifact（代码块） */
  function extractArtifacts(content: string, messageId: string) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'text'
      const code = match[2]!.trim()
      if (code.length < 5) continue

      const existingIdx = artifacts.value.findIndex(
        (a) => a.messageId === messageId && a.language === language,
      )

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

      if (existingIdx >= 0) {
        artifacts.value[existingIdx] = artifact
      } else {
        artifacts.value.push(artifact)
      }
    }
  }

  /** 添加 Artifact */
  function addArtifact(artifact: Omit<Artifact, 'id' | 'createdAt'>) {
    artifacts.value.push({
      ...artifact,
      id: nanoid(8),
      createdAt: new Date().toISOString(),
    })
  }

  /** 选择 Artifact */
  function selectArtifact(id: string) {
    selectedArtifactId.value = id
    showArtifacts.value = true
  }

  /** 完成助手回复的通用处理 */
  function finalizeAssistantMessage(params: {
    content: string
    sessionId: string
    userText: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    agentName?: string
  }): ChatMessage {
    const assistantMsg: ChatMessage = {
      id: nanoid(),
      role: 'assistant',
      content: params.content || '(空回复)',
      timestamp: new Date().toISOString(),
      metadata: params.metadata,
      tool_calls: params.toolCalls,
      agent_name: params.agentName,
    }
    messages.value.push(assistantMsg)

    // 持久化助手消息
    persistMessage(assistantMsg, params.sessionId)

    // 用第一条消息更新会话标题（除非已有自定义标题，如从 Agent 页跳转）
    if (messages.value.length <= 2 && !hasCustomTitle.value) {
      const title = params.userText.slice(0, 30) + (params.userText.length > 30 ? '...' : '')
      dbUpdateSessionTitle(params.sessionId, title).catch(() => {})
    }
    dbTouchSession(params.sessionId).catch(() => {})

    // 提取代码 Artifact
    extractArtifacts(params.content, assistantMsg.id)

    streaming.value = false
    streamingContent.value = ''
    loadSessions()

    return assistantMsg
  }

  /** 发送消息错误处理 */
  function handleSendError(e: unknown) {
    logger.error('发送消息失败', e)
    const apiErr = fromNativeError(e)
    error.value = apiErr

    if (streaming.value) {
      stopStreaming()
    } else {
      streaming.value = false
      streamingSessionId.value = null
      streamingContent.value = ''
      hexclawWS.clearCallbacks()
    }

    messages.value.push({
      id: nanoid(),
      role: 'assistant',
      content: apiErr.message || '发送失败，请检查 hexclaw 引擎是否运行',
      timestamp: new Date().toISOString(),
    })
    loadSessions()
  }

  /**
   * 通过 WebSocket 流式发送消息
   *
   * 使用 requestId 防止竞态：回调中校验 requestId 匹配当前请求，
   * 避免旧请求的消息被新请求的回调错误消费。
   */
  async function sendMessageViaWebSocket(text: string, sessionId: string, attachments?: ChatAttachment[]): Promise<ChatMessage> {
    return new Promise<ChatMessage>((resolve, reject) => {
      hexclawWS.clearCallbacks()

      let settled = false
      let firstReplyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        fail(new ChatRequestError('助手长时间未开始回复，已超时并停止等待。', true))
      }, WS_FIRST_REPLY_TIMEOUT_MS)
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null

      function clearTimers() {
        if (firstReplyTimer) {
          clearTimeout(firstReplyTimer)
          firstReplyTimer = null
        }
        if (inactivityTimer) {
          clearTimeout(inactivityTimer)
          inactivityTimer = null
        }
      }

      function markActivity() {
        if (firstReplyTimer) {
          clearTimeout(firstReplyTimer)
          firstReplyTimer = null
        }
        if (inactivityTimer) {
          clearTimeout(inactivityTimer)
        }
        inactivityTimer = setTimeout(() => {
          fail(new ChatRequestError('助手回复长时间无新内容，已超时并停止等待。', true))
        }, WS_INACTIVITY_TIMEOUT_MS)
      }

      function fail(err: unknown) {
        if (settled) return
        settled = true
        clearTimers()
        hexclawWS.clearCallbacks()
        reject(err)
      }

      hexclawWS.onChunk((chunk) => {
        if (streamingSessionId.value !== sessionId) return
        markActivity()
        streamingContent.value += chunk.content
        if (chunk.done && !settled) {
          settled = true
          clearTimers()
          const assistantMsg = finalizeAssistantMessage({
            content: streamingContent.value,
            sessionId,
            userText: text,
            metadata: chunk.metadata,
            toolCalls: chunk.tool_calls,
            agentName: typeof chunk.metadata?.agent_name === 'string'
              ? chunk.metadata.agent_name
              : undefined,
          })
          resolve(assistantMsg)
        }
      })

      hexclawWS.onReply((reply) => {
        if (settled || streamingSessionId.value !== sessionId) return
        markActivity()
        settled = true
        clearTimers()
        const assistantMsg = finalizeAssistantMessage({
          content: reply.content,
          sessionId,
          userText: text,
          metadata: reply.metadata,
          toolCalls: reply.tool_calls,
          agentName: typeof reply.metadata?.agent_name === 'string'
            ? reply.metadata.agent_name
            : undefined,
        })
        resolve(assistantMsg)
      })

      hexclawWS.onError((errMsg: string) => {
        fail(new ChatRequestError(errMsg || 'WebSocket 请求失败', true))
      })

      const wsAttachments = attachments?.map(a => ({
        type: a.type,
        name: a.name,
        mime: a.mime,
        data: a.data,
      }))
      hexclawWS.sendMessage(
        text,
        sessionId,
        chatParams.value.model,
        agentRole.value || undefined,
        wsAttachments,
        chatParams.value.provider,
      )
    })
  }

  /**
   * 通过 HTTP 后端发送消息（fallback）
   */
  async function sendMessageViaBackend(text: string, sessionId: string, attachments?: ChatAttachment[]): Promise<ChatMessage> {
    const result = await withTimeout(
      sendChatViaBackend(text, {
        sessionId,
        role: agentRole.value || 'assistant',
        provider: chatParams.value.provider,
        model: chatParams.value.model,
        attachments: attachments?.map(a => ({ type: a.type, name: a.name, mime: a.mime, data: a.data })),
      }),
      BACKEND_REPLY_TIMEOUT_MS,
      '后端长时间未返回结果，已超时并停止等待。',
    )
    return finalizeAssistantMessage({
      content: result.reply,
      sessionId,
      userText: text,
      metadata: result.metadata,
      toolCalls: result.tool_calls,
      agentName: typeof result.metadata?.agent_name === 'string'
        ? result.metadata.agent_name
        : undefined,
    })
  }

  /**
   * 发送消息 — 优先使用 WebSocket 流式，失败时回退到 HTTP
   *
   * WebSocket 流式: 前端 ↔ ws://localhost:16060/ws → Agent → 分块回复
   * HTTP 回退: 前端 → Rust backend_chat → hexclaw POST /api/v1/chat → 完整回复
   */
  async function sendMessage(text: string, attachments?: ChatAttachment[]): Promise<ChatMessage | null> {
    // 如果正在流式输出，先停止上一次
    if (streaming.value) {
      stopStreaming()
    }

    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      metadata: attachments?.length ? { attachments } : undefined,
    }
    messages.value.push(userMsg)

    // 确保有会话 + 持久化用户消息
    const sessionId = await ensureSession()
    persistMessage(userMsg, sessionId)

    streaming.value = true
    streamingSessionId.value = sessionId
    streamingContent.value = ''
    error.value = null

    try {
      if (!hexclawWS.isConnected()) {
        await hexclawWS.connect()
      }
    } catch (connectError) {
      logger.warn('WebSocket 连接失败，回退到 HTTP', connectError)
      try {
        return await sendMessageViaBackend(text, sessionId, attachments)
      } catch (httpError) {
        handleSendError(httpError)
        return null
      }
    }

    try {
      return await sendMessageViaWebSocket(text, sessionId, attachments)
    } catch (wsError) {
      if (wsError instanceof ChatRequestError && wsError.noFallback) {
        handleSendError(wsError)
        return null
      }

      logger.warn('WebSocket 发送失败，回退到 HTTP', wsError)
      try {
        return await sendMessageViaBackend(text, sessionId, attachments)
      } catch (httpError) {
        handleSendError(httpError)
        return null
      }
    }
  }

  /** 停止流式输出 */
  function stopStreaming() {
    // 保存已接收的部分内容，避免用户可见内容丢失
    if (streamingContent.value.trim()) {
      const partialMsg: ChatMessage = {
        id: nanoid(),
        role: 'assistant',
        content: streamingContent.value,
        timestamp: new Date().toISOString(),
      }
      messages.value.push(partialMsg)
      if (currentSessionId.value) {
        persistMessage(partialMsg, currentSessionId.value)
      }
    }
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    hexclawWS.clearCallbacks()
  }

  /** 删除会话 */
  async function deleteSession(sessionId: string) {
    try {
      await dbDeleteSession(sessionId)
      sessions.value = sessions.value.filter((s) => s.id !== sessionId)
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
        messages.value = []
        artifacts.value = []
        selectedArtifactId.value = null
        showArtifacts.value = false
        if (streamingSessionId.value === sessionId) {
          streaming.value = false
          streamingSessionId.value = null
          streamingContent.value = ''
          hexclawWS.clearCallbacks()
        }
      }
      error.value = null
    } catch (e) {
      logger.error('删除会话失败', e)
      error.value = { code: 'SERVER_ERROR', status: 500, message: '删除会话失败' }
    }
  }

  /** 当前会话是否正在流式输出 */
  const isCurrentStreaming = computed(() =>
    streaming.value && streamingSessionId.value === currentSessionId.value,
  )

  /** 当前流式输出的内容（仅当前会话活跃时返回） */
  const isCurrentStreamingContent = computed(() =>
    isCurrentStreaming.value ? streamingContent.value : '',
  )

  return {
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    isCurrentStreaming,
    isCurrentStreamingContent,
    error,
    chatMode,
    execMode,
    agentRole,
    chatParams,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    loadSessions,
    selectSession,
    newSession,
    ensureSession,
    sendMessage,
    updateMessage,
    setMessageFeedback,
    stopStreaming,
    deleteSession,
    addArtifact,
    selectArtifact,
    extractArtifacts,
  }
})
