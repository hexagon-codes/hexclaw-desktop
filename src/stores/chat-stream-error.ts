import type { Ref } from 'vue'
import type { ChatMessage, ApiError } from '@/types'
import { fromNativeError } from '@/utils/errors'

type LoggerModule = typeof import('@/utils/logger').logger

export function createChatStreamErrorController(params: {
  error: Ref<ApiError | null>
  currentSessionId: Ref<string | null>
  streamingSessionId: Ref<string | null>
  logger: LoggerModule
  createId: () => string
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
  loadSessions: () => Promise<void>
}) {
  const {
    error,
    currentSessionId,
    streamingSessionId,
    logger,
    createId,
    appendMessageToSession,
    resetSessionStream,
    loadSessions,
  } = params

  function handleSendError(
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) {
    logger.error('发送消息失败', errorValue)
    const apiError = fromNativeError(errorValue)
    error.value = apiError
    const targetSessionId = sessionId ?? streamingSessionId.value ?? currentSessionId.value
    resetSessionStream(targetSessionId, sending, draftSending)
    const errorMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: apiError.message || '发送失败，请检查 hexclaw 引擎是否运行',
      timestamp: new Date().toISOString(),
    }
    if (targetSessionId) {
      appendMessageToSession(targetSessionId, errorMessage)
    }
    void loadSessions()
  }

  return {
    handleSendError,
  }
}
