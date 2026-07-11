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
  loadSessions: (opts?: { suppressAutoSelect?: boolean }) => Promise<void>
  persistErrorReply: (sessionId: string, message: ChatMessage) => void | Promise<void>
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
    persistErrorReply,
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
      metadata: { is_error: true },
    }
    if (targetSessionId) {
      appendMessageToSession(targetSessionId, errorMessage)
      // 显式落库：后端不会自动持久化失败回复，否则切会话重载即丢失。
      void persistErrorReply(targetSessionId, errorMessage)
    }
    void loadSessions({ suppressAutoSelect: true })
  }

  return {
    handleSendError,
  }
}
