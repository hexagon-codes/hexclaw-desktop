import type { ChatSession } from '@/types'
import { backendScopeKey } from '@/services/backend-context'
import { createChatSessionLifecycleController } from './chat-session-lifecycle'
import { createChatSessionLoadingController } from './chat-session-loading'
import type { ChatSessionControllerParams } from './chat-session-types'
import { bumpSession, setSessionTitle, upsertSession } from './chat-session-helpers'
export function createChatSessionController(params: ChatSessionControllerParams) {
  const { sessions, pendingSuggestedTitleExpectation } = params

  function upsertLocalSession(session: ChatSession, prepend = false) {
    sessions.value = upsertSession(sessions.value, session, prepend)
  }

  async function updateSessionPersona(sessionId: string, name: string) {
    const backend = backendScopeKey()
    const session = await params.msgSvc.updateSessionPersona(sessionId, name)
    if (backend === backendScopeKey()) upsertLocalSession(session)
    return session
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

  async function deleteSession(sessionId: string): Promise<boolean> {
    const removed = await lifecycleController.deleteSession(sessionId)
    if (!removed) return false
    sessions.value = sessions.value.filter((session) => session.id !== sessionId)
    return true
  }

  return {
    upsertLocalSession,
    bumpLocalSession,
    updateSessionPersona,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    loadSessions: loadingController.loadSessions,
    selectSession: loadingController.selectSession,
    newSession: lifecycleController.newSession,
    ensureSession: lifecycleController.ensureSession,
    deleteSession,
  }
}
