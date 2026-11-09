import type { Ref } from 'vue'
import type { ChatMessage, ApiError } from '@/types'
import {
  normalizeReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  normalizeThinkingMetadata,
} from '@/types/chat'
import { fromNativeError } from '@/utils/errors'
import { getStreamThinkingDuration, type SessionStreamState } from './chat-stream-helpers'
import type { WebSocketStreamResult } from '@/services/chatService'
import type { createChatStreamCompletionController } from './chat-stream-completion'
import { hasPersistedAssistantReply } from './chat-stream-completion'

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
  finalizeAssistantMessage?: ReturnType<typeof createChatStreamCompletionController>['finalizeAssistantMessage']
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
    finalizeAssistantMessage,
  } = params

  function handleSendError(
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
    streamState?: SessionStreamState,
  ) {
    const apiError = fromNativeError(errorValue)
    logger.error('发送消息失败', { code: apiError.code, message: apiError.message, status: apiError.status })
    error.value = apiError
    const projection = (errorValue as { result?: WebSocketStreamResult } | null)?.result
    const projectionSessionId = typeof projection?.metadata?.session_id === 'string'
      && projection.metadata.session_id.trim() ? projection.metadata.session_id : undefined
    const targetSessionId = (sessionId === '' && projectionSessionId ? projectionSessionId : sessionId)
      ?? (streamState?.sessionId || projectionSessionId)
      ?? streamingSessionId.value ?? currentSessionId.value
    if (projection && targetSessionId && finalizeAssistantMessage) {
      const message = finalizeAssistantMessage({
        content: projection.messageContent?.markdown
          ?? (projection.content || streamState?.content || apiError.message || ''),
        messageContent: projection.messageContent,
        renderManifest: projection.renderManifest,
        sessionId: targetSessionId,
        metadata: { ...projection.metadata, is_error: true },
        toolCalls: projection.toolCalls,
        blocks: projection.blocks,
        agentName: projection.agentName,
        reasoning: streamState?.reasoning,
        sending,
        draftSending,
        terminalState: 'failed',
      })
      // 仅服务端明确的落盘回执可替代追加，计划消息ID不证明已保存。
      if (!hasPersistedAssistantReply(projection.metadata)) {
        void persistErrorReply(targetSessionId, message)
      }
      return
    }
    resetSessionStream(targetSessionId, sending, draftSending)
    const fallbackReasoningRequest = streamState?.reasoningReceipt?.reasoning_request
      ?? (streamState?.thinkingEnabled ? 'on' : 'off')
    const reasoningReceipt = normalizeReasoningReceipt(
      streamState?.reasoningReceipt,
      fallbackReasoningRequest,
    )
    const errorMessage: ChatMessage = {
      id: streamState?.assistantMessageId || createId(),
      role: 'assistant',
      content: apiError.message || '发送失败，请检查 hexclaw 引擎是否运行',
      timestamp: new Date().toISOString(),
      reasoning: streamState?.visibility === 'visible' ? streamState.reasoning || undefined : undefined,
      metadata: normalizeThinkingMetadata(
        normalizeRuntimeSnapshotMetadata({
          is_error: true,
          request_id: streamState?.requestId,
          reasoning_receipt: reasoningReceipt,
          thinking_duration: reasoningReceipt.reasoning_execution === 'applied'
            ? getStreamThinkingDuration(streamState) ?? 0
            : undefined,
          reasoning_visibility: streamState?.thinkingEnabled
            ? streamState.visibility ?? 'not_exposed'
            : undefined,
          reasoning_disclosure: streamState?.reasoningDisclosure?.visibility === streamState?.visibility
            ? streamState?.reasoningDisclosure
            : undefined,
          assistant_message_id: streamState?.assistantMessageId,
          message_id: streamState?.assistantMessageId,
          assistant_message_aliases: streamState?.assistantMessageAliases,
          runtime_events: streamState?.runtimeEvents,
          last_sequence: streamState?.lastSequence,
          recipient_display_name: streamState?.recipientDisplayName,
        }, streamState?.assistantMessageId, undefined, fallbackReasoningRequest),
        streamState?.visibility === 'visible' ? streamState.reasoning : undefined,
        'failed',
      ),
      agent_name: streamState?.agentDisplayName,
      tool_calls: streamState?.toolCalls,
      blocks: streamState?.blocks,
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
