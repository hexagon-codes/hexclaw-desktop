import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import {
  normalizeReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  normalizeThinkingMetadata,
} from '@/types/chat'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { getStreamThinkingDuration, type SessionStreamState } from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatStreamCancelController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  streaming: Ref<boolean>
  streamingSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  streamingReasoningStartTime: Ref<number>
  streamingReasoningEndTime: Ref<number>
  streamHandles: Map<string, import('@/services/chatService').WebSocketStreamHandle>
  msgSvc: MessageServiceModule
  createId: () => string
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
  sendCancel: (sessionId: string | null) => void
  clearSocketCallbacks: () => void
  triggerSocketError: (message: string) => void
}) {
  const {
    activeStreams,
    currentSessionId,
    messages,
    streaming,
    streamingSessionId,
    streamingContent,
    streamingReasoning,
    streamingReasoningStartTime,
    streamingReasoningEndTime,
    streamHandles,
    msgSvc,
    createId,
    appendMessageToSession,
    resetSessionStream,
    sendCancel,
    clearSocketCallbacks,
    triggerSocketError,
  } = params

  function stopSessionStream(
    sessionId: string,
    preservePartial = true,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) {
    const current = activeStreams.value[sessionId]
    if (!current) return false

    if (
      preservePartial
      && (current.thinkingEnabled || current.content.trim() || current.reasoning.trim())
    ) {
      const normalizedReasoning = current.visibility === 'visible' && current.reasoning
        ? normalizeAssistantReasoning(current.reasoning) || undefined
        : undefined
      const fallbackReasoningRequest = current.reasoningReceipt?.reasoning_request
        ?? (current.thinkingEnabled ? 'on' : 'off')
      const reasoningReceipt = normalizeReasoningReceipt(
        current.reasoningReceipt,
        fallbackReasoningRequest,
      )
      const partialMessage: ChatMessage = {
        id: current.assistantMessageId || createId(),
        role: 'assistant',
        content: current.content.trim() || normalizedReasoning
          ? getAssistantDisplayContent(current.content, normalizedReasoning)
          : '',
        timestamp: new Date().toISOString(),
        reasoning: normalizedReasoning,
        metadata: normalizeThinkingMetadata(
          normalizeRuntimeSnapshotMetadata({
            reasoning_receipt: reasoningReceipt,
            thinking_duration: reasoningReceipt.reasoning_execution === 'applied'
              ? getStreamThinkingDuration(current) ?? 0
              : undefined,
            reasoning_visibility: current.thinkingEnabled
              ? current.visibility ?? 'not_exposed'
              : undefined,
            reasoning_disclosure: current.reasoningDisclosure?.visibility === current.visibility
              ? current.reasoningDisclosure
              : undefined,
            assistant_message_id: current.assistantMessageId,
            message_id: current.assistantMessageId,
            assistant_message_aliases: current.assistantMessageAliases,
            runtime_events: current.runtimeEvents,
            last_sequence: current.lastSequence,
            recipient_display_name: current.recipientDisplayName,
          }, current.assistantMessageId, undefined, fallbackReasoningRequest),
          normalizedReasoning,
          'cancelled',
        ),
        agent_name: current.agentDisplayName,
      }
      appendMessageToSession(sessionId, partialMessage)
      try {
        void msgSvc.persistCancelledReply(sessionId, partialMessage)
      } catch {
        // 部分测试 mock 或落库启动异常不阻塞本地取消。
      }
    }

    streamHandles.get(sessionId)?.cancel()
    resetSessionStream(sessionId, sending, draftSending)
    return true
  }

  function hasLegacyCurrentStream() {
    if (!streaming.value) return false
    if (currentSessionId.value) {
      return !streamingSessionId.value || streamingSessionId.value === currentSessionId.value
    }
    return !streamingSessionId.value
  }

  function stopStreaming(
    sessionId: string | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) {
    const targetSessionId = sessionId ?? currentSessionId.value ?? streamingSessionId.value
    if (targetSessionId && stopSessionStream(targetSessionId, true, sending, draftSending)) {
      return
    }

    // 目标会话无活跃流：若 target 明确指向「另一个会话」（≠ 正在流式的镜像会话），
    // 不得用镜像兜底取消，否则会停掉那个并发会话（F-01）。
    // 仅当 target 就是镜像流本身、或没有具体 target/镜像 时，才走下面的 legacy 镜像兜底。
    if (
      targetSessionId &&
      streamingSessionId.value &&
      targetSessionId !== streamingSessionId.value
    ) {
      resetSessionStream(targetSessionId, sending, draftSending)
      return
    }

    if (streamingContent.value.trim() || streamingReasoning.value.trim()) {
      const reasoning = undefined
      const partialMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: getAssistantDisplayContent(streamingContent.value, reasoning),
        timestamp: new Date().toISOString(),
        reasoning,
        metadata: normalizeThinkingMetadata(
          normalizeRuntimeSnapshotMetadata({
            reasoning_receipt: normalizeReasoningReceipt(undefined, 'off'),
            thinking_duration: streamingReasoningStartTime.value
              ? Math.max(
                  0,
                  Math.round(
                    ((streamingReasoningEndTime.value || Date.now())
                      - streamingReasoningStartTime.value) / 1000,
                  ),
                )
              : undefined,
          }),
          reasoning,
          'cancelled',
        ),
      }
      messages.value.push(partialMessage)
      if (currentSessionId.value) {
        try {
          void msgSvc.persistCancelledReply(currentSessionId.value, partialMessage)
        } catch {
          // 部分测试 mock 或落库启动异常不阻塞本地取消。
        }
      }
    }

    sendCancel(streamingSessionId.value)
    streaming.value = false
    streamingSessionId.value = null
    streamingContent.value = ''
    streamingReasoning.value = ''
    streamingReasoningStartTime.value = 0
    streamingReasoningEndTime.value = 0
    triggerSocketError('用户取消')
    clearSocketCallbacks()
  }

  return {
    stopSessionStream,
    hasLegacyCurrentStream,
    stopStreaming,
  }
}
