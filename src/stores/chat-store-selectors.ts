import { computed, type Ref } from 'vue'
import type { ToolApprovalRequest } from '@/api/websocket'
import type { PendingToolApproval } from './chat-stream-helpers'
import { getStreamStateForSession, type SessionStreamState } from './chat-stream-helpers'

export function createChatStoreSelectors(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  currentSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  pendingApprovals: Ref<Record<string, PendingToolApproval>>
  hasLegacyCurrentStream: () => boolean
  getPendingApprovalForSession: (sessionId: string | null) => ToolApprovalRequest | PendingToolApproval | null
}) {
  const {
    activeStreams,
    currentSessionId,
    streamingContent,
    streamingReasoning,
    pendingApprovals,
    hasLegacyCurrentStream,
    getPendingApprovalForSession,
  } = params

  const isCurrentStreaming = computed(() => {
    return !!getStreamStateForSession(activeStreams.value, currentSessionId.value)
      || hasLegacyCurrentStream()
  })

  const isCurrentStreamingContent = computed(() => {
    return getStreamStateForSession(activeStreams.value, currentSessionId.value)?.content
      ?? (hasLegacyCurrentStream() ? streamingContent.value : '')
  })

  const isCurrentStreamingReasoning = computed(() => {
    return getStreamStateForSession(activeStreams.value, currentSessionId.value)?.reasoning
      ?? (hasLegacyCurrentStream() ? streamingReasoning.value : '')
  })

  const pendingApproval = computed(() => getPendingApprovalForSession(currentSessionId.value))
  const hasAnyPendingApproval = computed(() => Object.keys(pendingApprovals.value).length > 0)

  return {
    isCurrentStreaming,
    isCurrentStreamingContent,
    isCurrentStreamingReasoning,
    pendingApproval,
    hasAnyPendingApproval,
  }
}
