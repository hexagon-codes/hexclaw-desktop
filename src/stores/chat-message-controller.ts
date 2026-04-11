import type { Ref } from 'vue'
import type { UserFeedback } from '@/api/chat'
import type { ChatMessage } from '@/types'
import { cloneMessage } from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')
type LoggerModule = typeof import('@/utils/logger').logger
type ChatApiModule = Pick<typeof import('@/api/chat'), 'updateMessageFeedback'>

export function createChatMessageController(params: {
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  msgSvc: Pick<MessageServiceModule, 'persistMessage' | 'touchSession'>
  chatApi: ChatApiModule
  logger: LoggerModule
}) {
  const {
    currentSessionId,
    messages,
    msgSvc,
    chatApi,
    logger,
  } = params

  async function persistMessage(message: ChatMessage, sessionId: string): Promise<boolean> {
    return msgSvc.persistMessage(message, sessionId)
  }

  async function updateMessage(
    messageId: string,
    updater: Partial<ChatMessage> | ((current: ChatMessage) => ChatMessage),
  ): Promise<ChatMessage | null> {
    const idx = messages.value.findIndex((message) => message.id === messageId)
    if (idx < 0) return null

    const current = messages.value[idx]!
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
    messages.value[idx] = next

    const sessionId = currentSessionId.value
    if (sessionId) {
      await persistMessage(next, sessionId)
      msgSvc.touchSession(sessionId).catch(() => {})
    }

    return next
  }

  async function setMessageFeedback(
    messageId: string,
    feedback: Exclude<UserFeedback, ''> | null,
  ): Promise<ChatMessage | null> {
    const current = messages.value.find((message) => message.id === messageId)
    if (!current || current.role !== 'assistant') return null

    const previous = cloneMessage(current)
    const next = await updateMessage(messageId, (message) => {
      const metadata = { ...message.metadata }
      if (feedback) metadata.user_feedback = feedback
      else delete metadata.user_feedback
      return { ...message, metadata: Object.keys(metadata).length > 0 ? metadata : undefined }
    })

    const backendMessageId = typeof previous.metadata?.backend_message_id === 'string'
      ? previous.metadata.backend_message_id
      : null
    if (!backendMessageId) {
      logger.warn('消息缺少 backend_message_id，反馈仅保存在本地', { messageId })
      return next
    }

    try {
      await chatApi.updateMessageFeedback(backendMessageId, feedback ?? '')
      return next
    } catch (syncError) {
      await updateMessage(messageId, previous)
      throw syncError
    }
  }

  return {
    persistMessage,
    updateMessage,
    setMessageFeedback,
  }
}
