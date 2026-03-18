import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { sendChatViaBackend } from '@/api/chat'
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
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, ChatAttachment, Artifact, ChatMode, ExecMode, ApiError } from '@/types'

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
  const chatParams = ref<{ model?: string; temperature?: number; maxTokens?: number }>({})

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
      messages.value = rows.map((r) => ({
        id: r.id,
        role: r.role as 'user' | 'assistant' | 'system',
        content: r.content,
        timestamp: r.timestamp,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      }))
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
      await dbSaveMessage(msg.id, sessionId, msg.role, msg.content, msg.timestamp, msg.metadata as Record<string, unknown> | undefined)
    } catch (e) {
      logger.warn('持久化消息失败', e)
    }
  }

  /** 从内容中提取 Artifact（代码块） */
  function extractArtifacts(content: string, messageId: string) {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'text'
      const code = match[2]!.trim()
      if (code.length < 20) continue

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
  function finalizeAssistantMessage(content: string, sessionId: string, userText: string) {
    const assistantMsg: ChatMessage = {
      id: nanoid(),
      role: 'assistant',
      content: content || '(空回复)',
      timestamp: new Date().toISOString(),
    }
    messages.value.push(assistantMsg)

    // 持久化助手消息
    persistMessage(assistantMsg, sessionId)

    // 用第一条消息更新会话标题（除非已有自定义标题，如从 Agent 页跳转）
    if (messages.value.length <= 2 && !hasCustomTitle.value) {
      const title = userText.slice(0, 30) + (userText.length > 30 ? '...' : '')
      dbUpdateSessionTitle(sessionId, title).catch(() => {})
    }
    dbTouchSession(sessionId).catch(() => {})

    // 提取代码 Artifact
    extractArtifacts(content, assistantMsg.id)

    streaming.value = false
    streamingContent.value = ''
    loadSessions()
  }

  /** 发送消息错误处理 */
  function handleSendError(e: unknown) {
    logger.error('发送消息失败', e)
    const errContent = e instanceof Error
      ? e.message
      : (typeof e === 'string' ? e : '发送失败，请检查 hexclaw 引擎是否运行')

    messages.value.push({
      id: nanoid(),
      role: 'assistant',
      content: errContent,
      timestamp: new Date().toISOString(),
    })
    streaming.value = false
    streamingContent.value = ''
    loadSessions()
  }

  /**
   * 通过 WebSocket 流式发送消息
   */
  async function sendMessageViaWebSocket(text: string, sessionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Clear previous callbacks to avoid duplicates
      hexclawWS.clearCallbacks()

      hexclawWS.onChunk((content: string, done: boolean) => {
        streamingContent.value += content
        if (done) {
          finalizeAssistantMessage(streamingContent.value, sessionId, text)
          resolve()
        }
      })

      hexclawWS.onReply((content: string) => {
        finalizeAssistantMessage(content, sessionId, text)
        resolve()
      })

      hexclawWS.onError((errMsg: string) => {
        reject(new Error(errMsg))
      })

      hexclawWS.sendMessage(text, sessionId, undefined, agentRole.value || undefined)
    })
  }

  /**
   * 通过 HTTP 后端发送消息（fallback）
   */
  async function sendMessageViaBackend(text: string, sessionId: string): Promise<void> {
    const result = await sendChatViaBackend(text, {
      sessionId,
      role: agentRole.value || 'assistant',
    })
    finalizeAssistantMessage(result.reply, sessionId, text)
  }

  /**
   * 发送消息 — 优先使用 WebSocket 流式，失败时回退到 HTTP
   *
   * WebSocket 流式: 前端 ↔ ws://localhost:16060/ws → Agent → 分块回复
   * HTTP 回退: 前端 → Rust backend_chat → hexclaw POST /api/v1/chat → 完整回复
   */
  async function sendMessage(text: string, attachments?: ChatAttachment[]) {
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
      // 尝试 WebSocket 流式
      if (!hexclawWS.isConnected()) {
        await hexclawWS.connect()
      }
      await sendMessageViaWebSocket(text, sessionId)
    } catch (wsError) {
      logger.warn('WebSocket 发送失败，回退到 HTTP', wsError)
      // 回退到 HTTP 同步模式
      try {
        await sendMessageViaBackend(text, sessionId)
      } catch (httpError) {
        handleSendError(httpError)
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
    stopStreaming,
    deleteSession,
    addArtifact,
    selectArtifact,
    extractArtifacts,
  }
})
