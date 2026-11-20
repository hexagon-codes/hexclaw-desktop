import { computed, shallowRef, type Ref } from 'vue'
import type { Artifact, ChatMessage, ChatSession } from '@/types'
import { backendScopeKey } from '@/services/backend-context'
import { backendDeletableMessageId } from '@/utils/chat-message-id'
import type { LoggerModule, MessageServiceModule } from './chat-session-types'
import { mergeMessagesById, upsertSession } from './chat-session-helpers'
import { pruneSessionModels } from './session-model-binding'
import { getSessionAgent, pruneSessionAgents } from './session-agent-binding'
import { getSessionDeepThinking, pruneSessionDeepThinking } from './session-thinking-preference'

export type SessionHistoryStatus = 'loading' | 'ready' | 'failed'

type SessionSelection = {
  sessionId: string
  generation: number
  scope: string
}

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

  const sessionMessageCache = new Map<string, ChatMessage[]>()
  const invalidatedHistory = new Map<string, Set<string>>()
  const history = shallowRef<(SessionSelection & { status: SessionHistoryStatus }) | null>(null)
  let cacheScope = backendScopeKey()

  function ownsSelection(selection: SessionSelection) {
    return selection.generation === sessionSelectionGen.value
      && selection.sessionId === currentSessionId.value && selection.scope === backendScopeKey()
  }

  const sessionHistory = computed(() => {
    const read = history.value
    return read && ownsSelection(read) ? read : null
  })

  function validCachedMessages(sessionId: string, rows: ChatMessage[]): ChatMessage[] {
    const invalidated = invalidatedHistory.get(sessionId)
    return invalidated ? rows.filter((row) => !invalidated.has(backendDeletableMessageId(row))) : rows
  }

  async function selectSession(sessionId: string) {
    const scope = backendScopeKey()
    const selection = { sessionId, generation: ++sessionSelectionGen.value, scope }
    const sameScope = cacheScope === scope
    const isCurrentSelection = () => ownsSelection(selection)
    const prevId = currentSessionId.value
    const changedSession = !sameScope || prevId !== sessionId
    if (!sameScope) {
      sessionMessageCache.clear()
      invalidatedHistory.clear()
      cacheScope = scope
    } else if (prevId && changedSession) {
      sessionMessageCache.set(prevId, validCachedMessages(prevId, messages.value).slice())
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

    history.value = { ...selection, status: 'loading' }
    currentSessionId.value = sessionId
    if (changedSession) {
      // 选择和消息快照同步交接，后续切换只能缓存目标会话自己的内容。
      messages.value = validCachedMessages(sessionId, sessionMessageCache.get(sessionId) ?? []).slice()
      artifacts.value = []
      selectedArtifactId.value = null
      showArtifacts.value = false
      error.value = null
    }
    syncStreamingMirrors()
    // 最近会话是恢复偏好，写入失败时仍要读取用户选中的历史。
    try {
      msgSvc.setLastSessionId(sessionId)
    } catch (errorValue) {
      logger.warn('保存最近会话失败', errorValue)
    }
    try {
      const nextMessages = await msgSvc.loadMessages(sessionId)
      if (!isCurrentSelection()) return
      // 读取过程中新增的同会话消息可能尚未落库，和权威历史按身份合并。
      messages.value = mergeMessagesById(nextMessages, validCachedMessages(sessionId, messages.value))
      invalidatedHistory.delete(sessionId)
      history.value = { ...selection, status: 'ready' }
    } catch (errorValue) {
      if (!isCurrentSelection()) return
      history.value = { ...selection, status: 'failed' }
      logger.warn('加载消息历史失败', errorValue)
    }
    try {
      const persisted = await msgSvc.loadArtifacts(sessionId)
      if (!isCurrentSelection()) return
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
      if (!isCurrentSelection()) return
      artifacts.value = []
    }
    if (!isCurrentSelection()) return
    selectedArtifactId.value = null
    showArtifacts.value = false
    error.value = null
  }

  async function refreshReplacedHistory(sessionId: string, requestId?: string) {
    if (cacheScope !== backendScopeKey()) return
    const visible = currentSessionId.value === sessionId
    const previous = visible ? messages.value : (sessionMessageCache.get(sessionId) ?? [])
    // 失效持续到该会话成功读回，避免切走时再次把待替换的历史写进缓存。
    const invalidated = invalidatedHistory.get(sessionId) ?? new Set<string>()
    for (const message of previous) invalidated.add(backendDeletableMessageId(message))
    invalidatedHistory.set(sessionId, invalidated)
    sessionMessageCache.delete(sessionId)
    if (!visible) return
    if (requestId) {
      const replaced = `${requestId}:assistant`
      messages.value = messages.value.filter((message) => backendDeletableMessageId(message) !== replaced)
    }
    await selectSession(sessionId)
  }

  async function loadSessions(opts?: { suppressAutoSelect?: boolean }) {
    const scope = backendScopeKey()
    try {
      // Vitest's module proxy throws when an omitted export is read directly.
      // Check ownership before reading the optional compatibility API so older
      // embedders/tests can still fall back to loadAllSessions().
      const hasResultLoader = 'loadAllSessionsResult' in msgSvc
      const loadResult = hasResultLoader && typeof msgSvc.loadAllSessionsResult === 'function'
        ? await msgSvc.loadAllSessionsResult()
        : { sessions: await msgSvc.loadAllSessions(), succeeded: true, complete: false }
      // 冷启动 sidecar 尚未就绪时，旧 loadAllSessions 会把请求失败压成 []。失败不是
      // “后端权威确认零会话”：此时既不能清空当前列表，也不能 prune 会话级模型/Agent/
      // 深度思考绑定，否则 sidecar-ready 后虽能补回会话，稳定身份（图标/固定置顶）已经丢失。
      if (!loadResult.succeeded || scope !== backendScopeKey()) return
      const loadedSessions = loadResult.sessions
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
        const shouldPreserve = !loadResult.complete || existing.id === currentSessionId.value
          || !!pendingSessionIds.value[existing.id]
          || isSessionStreaming(existing.id)
        if (shouldPreserve && !loadedSessions.some((session) => session.id === existing.id)) {
          nextSessions = upsertSession(nextSessions, existing)
        }
      }
      sessions.value = nextSessions
      // 只有完整后端集合才能证明会话已删除，部分分页必须保留页外偏好。
      if (loadResult.complete) {
        pruneSessionModels(sessions.value.map((session) => session.id))
        pruneSessionAgents(sessions.value.map((session) => session.id))
        pruneSessionDeepThinking(sessions.value.map((session) => session.id))
      }
      // Don't auto-select a session while a new session is being created (race condition fix).
      // U1：后台流收尾刷新列表时 suppressAutoSelect——否则用户主动新建的空白态(currentSessionId=null)
      // 会被自动 selectSession(lastId) 拽回旧会话，新建按钮等于没点。
      if (
        !opts?.suppressAutoSelect &&
        !currentSessionId.value &&
        !ensureSessionPromise.value &&
        sessions.value.length > 0
      ) {
        const selectionGen = sessionSelectionGen.value
        try {
          const lastId = await msgSvc.getLastSessionId()
          if (selectionGen === sessionSelectionGen.value && scope === backendScopeKey()
            && !currentSessionId.value && !ensureSessionPromise.value
            && lastId && sessions.value.some((session) => session.id === lastId)) {
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
