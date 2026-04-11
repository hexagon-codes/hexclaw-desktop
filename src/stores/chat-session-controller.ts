import type { ChatSession } from '@/types'
import { createChatSessionLifecycleController } from './chat-session-lifecycle'
import { createChatSessionLoadingController } from './chat-session-loading'
import type { ChatSessionControllerParams } from './chat-session-types'
import { bumpSession, setSessionTitle, upsertSession } from './chat-session-helpers'
export function createChatSessionController(params: ChatSessionControllerParams) {
  const {
    sessions,
    pendingSuggestedTitleExpectation,
  } = params

  function upsertLocalSession(session: ChatSession, prepend = false) {
    sessions.value = upsertSession(sessions.value, session, prepend)
  }

  function bumpLocalSession(sessionId: string) {
    sessions.value = bumpSession(sessions.value, sessionId)
  }

  function setLocalSessionTitle(sessionId: string, title: string) {
    sessions.value = setSessionTitle(sessions.value, sessionId, title)
  }

  function setPendingSuggestedTitleExpectation(sessionId: string, expectedTitle: string | null) {
    const next = { ...pendingSuggestedTitleExpectation.value }
    if (expectedTitle) next[sessionId] = expectedTitle
    else delete next[sessionId]
    pendingSuggestedTitleExpectation.value = next
  }

  const loadingController = createChatSessionLoadingController(params)
  const lifecycleController = createChatSessionLifecycleController({
    ...params,
    upsertLocalSession,
  })

  async function deleteSession(sessionId: string) {
    const removed = await lifecycleController.deleteSession(sessionId)
    if (!removed) return
    sessions.value = sessions.value.filter((session) => session.id !== sessionId)
  }

  return {
    upsertLocalSession,
    bumpLocalSession,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    loadSessions: loadingController.loadSessions,
    selectSession: loadingController.selectSession,
    newSession: lifecycleController.newSession,
    ensureSession: lifecycleController.ensureSession,
    deleteSession,
  }
}
