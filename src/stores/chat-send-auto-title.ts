import { DEFAULT_SESSION_TITLE } from '@/constants'

type MessageServiceModule = Pick<typeof import('@/services/messageService'), 'updateSessionTitle'>

export function createChatSendAutoTitleController(params: {
  msgSvc: MessageServiceModule
  pendingAutoTitleSync: Map<string, Promise<void>>
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  defaultSessionTitle?: string
}) {
  const {
    msgSvc,
    pendingAutoTitleSync,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    defaultSessionTitle = DEFAULT_SESSION_TITLE,
  } = params

  function seedAutoTitle(sessionId: string, text: string) {
    const tempTitle = text.slice(0, 30) + (text.length > 30 ? '...' : '')
    setLocalSessionTitle(sessionId, tempTitle)
    setPendingSuggestedTitleExpectation(sessionId, tempTitle)
    const titleSync = msgSvc.updateSessionTitle(sessionId, tempTitle)
      .catch(() => {
        setPendingSuggestedTitleExpectation(sessionId, defaultSessionTitle)
      })
      .finally(() => {
        if (pendingAutoTitleSync.get(sessionId) === titleSync) {
          pendingAutoTitleSync.delete(sessionId)
        }
      })
    pendingAutoTitleSync.set(sessionId, titleSync)
  }

  return {
    seedAutoTitle,
  }
}
