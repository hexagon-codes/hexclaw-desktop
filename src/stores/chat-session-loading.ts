import type { Ref } from 'vue'
import type { Artifact, ChatMessage, ChatSession } from '@/types'
import type { LoggerModule, MessageServiceModule } from './chat-session-types'
import { mergeMessagesById, upsertSession } from './chat-session-helpers'
import { pruneSessionModels } from './session-model-binding'
import { getSessionAgent, pruneSessionAgents } from './session-agent-binding'
import { getSessionDeepThinking, pruneSessionDeepThinking } from './session-thinking-preference'

export function createChatSessionLoadingController(params: {
  sessions: Ref<ChatSession[]>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  artifacts: Ref<Artifact[]>
  selectedArtifactId: Ref<string | null>
  showArtifacts: Ref<boolean>
  error: Ref<import('@/types').ApiError | null>
  chatMode: Ref<import('@/types').ChatMode>
  agentRole: Ref<string>
  thinkingEnabled: Ref<boolean>
  hasCustomTitle: Ref<boolean>
  pendingSessionIds: Ref<Record<string, boolean>>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  ensureSessionPromise: Ref<Promise<string> | null>
  sessionSelectionGen: Ref<number>
  msgSvc: MessageServiceModule
  logger: LoggerModule
  syncStreamingMirrors: () => void
  isSessionStreaming: (sessionId: string) => boolean
  extractArtifacts: (content: string, messageId: string) => void
}) {
  const {
    sessions,
    currentSessionId,
    messages,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    error,
    chatMode,
    agentRole,
    thinkingEnabled,
    hasCustomTitle,
    pendingSessionIds,
    pendingSuggestedTitleExpectation,
    ensureSessionPromise,
    sessionSelectionGen,
    msgSvc,
    logger,
    syncStreamingMirrors,
    isSessionStreaming,
    extractArtifacts,
  } = params

  // 按会话缓存内存中的消息快照（BUG-20260712 #F）：切走会话时存下其当前消息（含乐观/在途、
  // 后端尚未落库的），切回时与后端历史按 id 合并，避免盲目覆盖抹掉刚发的消息。
  const sessionMessageCache = new Map<string, ChatMessage[]>()

  async function selectSession(sessionId: string) {
    const selectionGen = ++sessionSelectionGen.value
    // 切走前先把「当前会话」的内存消息快照存入缓存（含尚未落库的乐观消息）。
    const prevId = currentSessionId.value
    if (prevId && prevId !== sessionId) {
      sessionMessageCache.set(prevId, messages.value.slice())
    }
    // 会话级 Agent 绑定恢复（BUG-20260708）：切走再切回不再丢失该会话的辅导老师人设 / 场景增强。
    // 无绑定（普通会话）→ agentRole 空、chat 模式，与旧行为一致；有绑定 → agent 模式 + 恢复收件人。
    const boundAgent = getSessionAgent(sessionId)
    const deepThinking = getSessionDeepThinking(sessionId)
    chatMode.value = deepThinking ? 'research' : boundAgent ? 'agent' : 'chat'
    agentRole.value = boundAgent
    // 深度思考是会话级偏好：有显式绑定则恢复；无绑定必须关闭，绝不沿用上一会话。
    thinkingEnabled.value = deepThinking
    hasCustomTitle.value = false

    currentSessionId.value = sessionId
    syncStreamingMirrors()
    msgSvc.setLastSessionId(sessionId)
    try {
      const nextMessages = await msgSvc.loadMessages(sessionId)
      if (selectionGen !== sessionSelectionGen.value) return
      // 后端历史 ∪ 本地快照（后端权威 + 保留后端尚无的乐观/在途消息），不盲目覆盖（#F）。
      messages.value = mergeMessagesById(nextMessages, sessionMessageCache.get(sessionId) ?? [])
    } catch (errorValue) {
      if (selectionGen !== sessionSelectionGen.value) return
      logger.warn('加载消息历史失败', errorValue)
      // 加载失败也不清空：回退到本地缓存快照，避免刚发的消息因一次网络抖动消失。
      messages.value = sessionMessageCache.get(sessionId) ?? []
    }
    try {
      const persisted = await msgSvc.loadArtifacts(sessionId)
      if (selectionGen !== sessionSelectionGen.value) return
      if (persisted.length > 0) {
        artifacts.value = persisted
      } else {
        artifacts.value = []
        for (const message of messages.value) {
          if (message.role === 'assistant' && message.content) {
            extractArtifacts(message.content, message.id)
          }
        }
      }
    } catch {
      if (selectionGen !== sessionSelectionGen.value) return
      artifacts.value = []
    }
    if (selectionGen !== sessionSelectionGen.value) return
    selectedArtifactId.value = null
    showArtifacts.value = false
    error.value = null
  }

  async function loadSessions(opts?: { suppressAutoSelect?: boolean }) {
    try {
      const loadedSessions = await msgSvc.loadAllSessions()
      let nextSessions = loadedSessions
      // Preserve local title for sessions with a pending auto-title sync
      // (backend may not have received the PATCH yet)
      const pendingTitles = pendingSuggestedTitleExpectation.value
      for (const s of nextSessions) {
        if (pendingTitles[s.id]) {
          const local = sessions.value.find((existing) => existing.id === s.id)
          if (local && local.title !== s.title) {
            s.title = local.title
          }
        }
      }
      for (const existing of sessions.value) {
        const shouldPreserve = existing.id === currentSessionId.value
          || !!pendingSessionIds.value[existing.id]
          || isSessionStreaming(existing.id)
        if (shouldPreserve && !loadedSessions.some((session) => session.id === existing.id)) {
          nextSessions = upsertSession(nextSessions, existing)
        }
      }
      sessions.value = nextSessions
      // 防累积：丢弃已不存在会话的模型 / Agent / 深度思考绑定，使 localStorage map 永远 ≤ 会话数
      pruneSessionModels(sessions.value.map((session) => session.id))
      pruneSessionAgents(sessions.value.map((session) => session.id))
      pruneSessionDeepThinking(sessions.value.map((session) => session.id))
      // Don't auto-select a session while a new session is being created (race condition fix).
      // U1：后台流收尾刷新列表时 suppressAutoSelect——否则用户主动新建的空白态(currentSessionId=null)
      // 会被自动 selectSession(lastId) 拽回旧会话，新建按钮等于没点。
      if (
        !opts?.suppressAutoSelect &&
        !currentSessionId.value &&
        !ensureSessionPromise.value &&
        sessions.value.length > 0
      ) {
        try {
          const lastId = await msgSvc.getLastSessionId()
          if (lastId && sessions.value.some((session) => session.id === lastId)) {
            await selectSession(lastId)
          }
        } catch {
          // ignore first-run persistence failures
        }
      }
    } catch (errorValue) {
      logger.warn('加载会话列表失败（可能非 Tauri 环境）', errorValue)
    }
  }

  return {
    loadSessions,
    selectSession,
  }
}
