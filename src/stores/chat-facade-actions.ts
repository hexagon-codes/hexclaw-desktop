import type { Ref } from 'vue'
import type { ChatAttachment } from '@/types'
import type { createChatSendController } from './chat-send-controller'
import type { createChatSessionController } from './chat-session-controller'
import type { createBoundChatStreamController } from './chat-stream-bound-controller'
import type { createChatThinkingTimerController } from './chat-thinking-timer'

export function createChatFacadeActions(params: {
  error: Ref<unknown>
  sessionController: ReturnType<typeof createChatSessionController>
  sendController: ReturnType<typeof createChatSendController>
  boundStreamController: ReturnType<typeof createBoundChatStreamController>
  thinkingTimerController: ReturnType<typeof createChatThinkingTimerController>
}) {
  const {
    error,
    sessionController,
    sendController,
    boundStreamController,
    thinkingTimerController,
  } = params

  return {
    loadSessions: sessionController.loadSessions,
    async selectSession(sessionId: string) {
      thinkingTimerController.clearThinkingTimer()
      await sessionController.selectSession(sessionId)
    },
    newSession: sessionController.newSession,
    ensureSession: sessionController.ensureSession,
    async sendMessage(
      text: string,
      attachments?: ChatAttachment[],
      options?: { backendText?: string },
    ) {
      error.value = null
      return sendController.sendMessage(text, attachments, options)
    },
    stopStreaming: boundStreamController.stopStreaming,
    deleteSession: sessionController.deleteSession,
  }
}
