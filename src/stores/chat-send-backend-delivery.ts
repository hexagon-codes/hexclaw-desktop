import type { Ref } from 'vue'
import { getAssistantReasoningFromMetadata } from '@/utils/assistant-reply'
import type { ChatAttachment, ChatMessage } from '@/types'

type ChatServiceModule = typeof import('@/services/chatService')

export function createChatSendBackendDeliveryController(params: {
  chatParams: Ref<{ provider?: string; model?: string; temperature?: number; maxTokens?: number }>
  agentRole: Ref<string>
  chatSvc: ChatServiceModule
  isSessionCancelled: (sessionId: string) => boolean
  resetSessionStream: (sessionId?: string | null, sending?: Ref<boolean>, draftSending?: Ref<boolean>) => void
  finalizeAssistantMessage: (params: {
    content: string
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
  }) => ChatMessage
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) => void
}) {
  const {
    chatParams,
    agentRole,
    chatSvc,
    isSessionCancelled,
    resetSessionStream,
    finalizeAssistantMessage,
    handleSendError,
  } = params

  async function deliverViaBackend(args: {
    backendText: string
    sessionId: string
    attachments?: ChatAttachment[]
    requestId: string
    requestMetadata?: Record<string, string>
    sending: Ref<boolean>
    draftSending: Ref<boolean>
  }): Promise<ChatMessage | null> {
    const {
      backendText,
      sessionId,
      attachments,
      requestId,
      requestMetadata,
      sending,
      draftSending,
    } = args

    try {
      const result = await chatSvc.sendViaBackend(
        backendText,
        sessionId,
        chatParams.value,
        agentRole.value,
        attachments,
        requestMetadata,
        requestId,
      )
      if (isSessionCancelled(sessionId)) {
        resetSessionStream(sessionId, sending, draftSending)
        return null
      }
      return finalizeAssistantMessage({
        content: result.reply,
        sessionId,
        metadata: result.metadata,
        toolCalls: result.tool_calls,
        agentName: typeof result.metadata?.agent_name === 'string' ? result.metadata.agent_name : undefined,
        reasoning: getAssistantReasoningFromMetadata(result.metadata),
        sending,
        draftSending,
      })
    } catch (httpError) {
      handleSendError(httpError, sessionId, sending, draftSending)
      return null
    }
  }

  return {
    deliverViaBackend,
  }
}
