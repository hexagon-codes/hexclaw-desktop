import { DEFAULT_SESSION_TITLE } from '@/constants'
import type { Ref } from 'vue'
import type { Artifact, ChatMessage } from '@/types'
import type { LoggerModule, MessageServiceModule } from './chat-session-types'

export function createChatSessionLifecycleController(params: {
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  artifacts: Ref<Artifact[]>
  selectedArtifactId: Ref<string | null>
  showArtifacts: Ref<boolean>
  error: Ref<import('@/types').ApiError | null>
  pendingSessionTitle: Ref<string | null>
  hasCustomTitle: Ref<boolean>
  pendingSessionIds: Ref<Record<string, boolean>>
  ensureSessionPromise: Ref<Promise<string> | null>
  cancelledSessions: Set<string>
  msgSvc: MessageServiceModule
  logger: LoggerModule
  createId: () => string
  syncStreamingMirrors: () => void
  isSessionStreaming: (sessionId: string) => boolean
  stopSessionStream: (sessionId: string, preservePartial?: boolean) => boolean
  resetSessionStream: (sessionId?: string | null) => void
  clearSessionCancelled: (sessionId: string) => void
  markSessionCancelled: (sessionId: string) => void
  upsertLocalSession: (session: import('@/types').ChatSession, prepend?: boolean) => void
}) {
  const {
    currentSessionId,
    messages,
    artifacts,
    selectedArtifactId,
    showArtifacts,
    error,
    pendingSessionTitle,
    hasCustomTitle,
    pendingSessionIds,
    ensureSessionPromise,
    cancelledSessions,
    msgSvc,
    logger,
    createId,
    syncStreamingMirrors,
    isSessionStreaming,
    stopSessionStream,
    resetSessionStream,
    clearSessionCancelled,
    markSessionCancelled,
    upsertLocalSession,
  } = params

  function newSession(title?: string) {
    currentSessionId.value = null
    messages.value = []
    artifacts.value = []
    selectedArtifactId.value = null
    showArtifacts.value = false
    error.value = null
    pendingSessionTitle.value = title ?? null
    hasCustomTitle.value = !!title
    syncStreamingMirrors()
  }

  async function ensureSession(): Promise<string> {
    if (currentSessionId.value) return currentSessionId.value
    if (ensureSessionPromise.value) return ensureSessionPromise.value
    ensureSessionPromise.value = (async () => {
      const id = createId()
      const now = new Date().toISOString()
      const initialTitle = pendingSessionTitle.value || DEFAULT_SESSION_TITLE
      try {
        await msgSvc.createSession(id, initialTitle)
        pendingSessionTitle.value = null
      } catch (errorValue) {
        logger.warn('创建会话失败', errorValue)
      }
      currentSessionId.value = id
      syncStreamingMirrors()
      upsertLocalSession({
        id,
        title: initialTitle,
        created_at: now,
        updated_at: now,
        message_count: 0,
      }, true)
      return id
    })()
    try {
      return await ensureSessionPromise.value
    } finally {
      ensureSessionPromise.value = null
    }
  }

  async function deleteSession(sessionId: string) {
    let cancelMarkerSet = false
    try {
      if (pendingSessionIds.value[sessionId] || isSessionStreaming(sessionId)) {
        markSessionCancelled(sessionId)
        cancelMarkerSet = true
      }
      if (isSessionStreaming(sessionId)) {
        stopSessionStream(sessionId, false)
      } else if (pendingSessionIds.value[sessionId]) {
        resetSessionStream(sessionId)
      }
      await msgSvc.deleteSession(sessionId)
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
        messages.value = []
        artifacts.value = []
        selectedArtifactId.value = null
        showArtifacts.value = false
      }
      error.value = null
      syncStreamingMirrors()
      return true
    } catch (errorValue) {
      if (cancelMarkerSet) {
        clearSessionCancelled(sessionId)
      }
      logger.error('删除会话失败', errorValue)
      error.value = { code: 'SERVER_ERROR', status: 500, message: '删除会话失败' }
      return false
    } finally {
      cancelledSessions.delete(sessionId)
    }
  }

  return {
    newSession,
    ensureSession,
    deleteSession,
  }
}
