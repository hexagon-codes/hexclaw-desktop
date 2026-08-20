import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { MessageContent } from '@/contracts/message-content'
import {
  normalizeReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  normalizeThinkingDuration,
  normalizeThinkingMetadata,
  type ReasoningReceipt,
} from '@/types/chat'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'
import { getStreamThinkingDuration, type SessionStreamState } from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatStreamCompletionController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  pendingAutoTitleSync: Map<string, Promise<void>>
  currentSessionId: Ref<string | null>
  msgSvc: MessageServiceModule
  createId: () => string
  loadSessions: (opts?: { suppressAutoSelect?: boolean }) => Promise<void>
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  bumpLocalSession: (sessionId: string) => void
  extractArtifacts: (content: string, messageId: string) => void
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
}) {
  const {
    activeStreams,
    pendingSuggestedTitleExpectation,
    pendingAutoTitleSync,
    currentSessionId,
    msgSvc,
    createId,
    loadSessions,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    bumpLocalSession,
    extractArtifacts,
    appendMessageToSession,
    resetSessionStream,
  } = params

  function finalizeAssistantMessage(args: {
    content: string
    messageContent?: MessageContent
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    blocks?: ChatMessage['blocks']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
  }): ChatMessage {
    const parsed = extractThinkTags(args.content || '')
    const finalContent = parsed.content
    const rawReasoning = parsed.reasoning
      ? (args.reasoning ? args.reasoning + '\n' + parsed.reasoning : parsed.reasoning)
      : (args.reasoning || undefined)
    const streamState = activeStreams.value[args.sessionId]
    const fallbackReasoningRequest = streamState?.reasoningReceipt?.reasoning_request
      ?? (streamState?.thinkingEnabled ? 'on' : 'off')
    const incomingRuntimeMetadata = normalizeRuntimeSnapshotMetadata(
      args.metadata,
      undefined,
      undefined,
      fallbackReasoningRequest,
    )
    const streamReasoningReceipt = normalizeReasoningReceipt(
      streamState?.reasoningReceipt,
      fallbackReasoningRequest,
    )
    const incomingReasoningReceipt = normalizeReasoningReceipt(
      incomingRuntimeMetadata.reasoning_receipt,
      fallbackReasoningRequest,
    )
    let reasoningReceipt: ReasoningReceipt = incomingReasoningReceipt
    if (streamState) {
      if (streamReasoningReceipt.reasoning_execution !== 'unknown') {
        reasoningReceipt = streamReasoningReceipt
      } else if (incomingReasoningReceipt.reasoning_execution === 'unknown'
        && streamReasoningReceipt.reasoning_support !== 'unknown') {
        reasoningReceipt = streamReasoningReceipt
      }
    }
    const incomingDisclosure = incomingRuntimeMetadata.reasoning_disclosure
    const hasLiveRuntimeSnapshot = (streamState?.lastSequence ?? 0) > 0
    const streamOwnsDisclosure = streamState?.reasoningDisclosure?.visibility === streamState?.visibility
    const explicitVisibility = streamState && (hasLiveRuntimeSnapshot || streamOwnsDisclosure)
      ? streamState.visibility ?? 'not_exposed'
      : incomingDisclosure?.visibility
        ?? streamState?.visibility
        ?? incomingRuntimeMetadata.reasoning_visibility
    const finalReasoning = explicitVisibility === 'visible' && rawReasoning
      ? normalizeAssistantReasoning(rawReasoning) || undefined
      : undefined
    const thinkingDuration = getStreamThinkingDuration(streamState)
    const metadata = { ...incomingRuntimeMetadata } as Record<string, unknown>
    metadata.reasoning_receipt = reasoningReceipt
    if (streamState) {
      const canonicalAssistantMessageId = streamState.canonicalAssistantMessageId
        ?? incomingRuntimeMetadata.assistant_message_id
      const runtimeAssistantMessageId = canonicalAssistantMessageId
        ?? streamState.assistantMessageId
      metadata.assistant_message_id = runtimeAssistantMessageId
      metadata.message_id = runtimeAssistantMessageId
      if (
        canonicalAssistantMessageId
        && canonicalAssistantMessageId !== streamState.assistantMessageId
      ) {
        metadata.backend_message_id = canonicalAssistantMessageId
      }
      metadata.assistant_message_aliases = Array.from(new Set([
        ...streamState.assistantMessageAliases,
        ...(Array.isArray(incomingRuntimeMetadata.assistant_message_aliases)
          ? incomingRuntimeMetadata.assistant_message_aliases
          : []),
        ...(runtimeAssistantMessageId
        && streamState.assistantMessageId !== runtimeAssistantMessageId
          ? [streamState.assistantMessageId!]
          : []),
      ]))
      metadata.runtime_events = hasLiveRuntimeSnapshot
        ? streamState.runtimeEvents
        : incomingRuntimeMetadata.runtime_events
      metadata.last_sequence = hasLiveRuntimeSnapshot
        ? streamState.lastSequence
        : incomingRuntimeMetadata.last_sequence
      metadata.reasoning_disclosure = streamOwnsDisclosure
        ? streamState.reasoningDisclosure
        : hasLiveRuntimeSnapshot
          ? undefined
          : incomingDisclosure
    }
    if (reasoningReceipt.reasoning_execution === 'applied') {
      metadata.thinking_duration = thinkingDuration
        ?? normalizeThinkingDuration(incomingRuntimeMetadata.thinking_duration)
        ?? 0
    } else {
      delete metadata.thinking_duration
    }
    if (reasoningReceipt.reasoning_request === 'on') {
      metadata.reasoning_visibility = streamState?.visibility ?? 'not_exposed'
      if (streamState?.recipientDisplayName) {
        metadata.recipient_display_name = streamState.recipientDisplayName
      }
    }
    const hasDeliverableOutput = !!(
      finalContent.trim()
      || args.messageContent
      || args.toolCalls?.length
      || args.blocks?.length
    )
    const terminalState = reasoningReceipt.reasoning_request === 'on' && !hasDeliverableOutput
      ? 'failed'
      : 'completed'
    const normalizedRuntimeMetadata = normalizeRuntimeSnapshotMetadata(
      metadata,
      streamState?.canonicalAssistantMessageId ?? streamState?.assistantMessageId,
      undefined,
      reasoningReceipt.reasoning_request,
    )
    const finalMetadata = normalizeThinkingMetadata(normalizedRuntimeMetadata, finalReasoning, terminalState)

    const assistantMessage: ChatMessage = {
      id: streamState?.assistantMessageId
        || normalizedRuntimeMetadata.assistant_message_id
        || createId(),
      role: 'assistant',
      content: terminalState === 'failed' && !hasDeliverableOutput
        ? ''
        : getAssistantDisplayContent(finalContent, finalReasoning),
      message_content: args.messageContent,
      timestamp: new Date().toISOString(),
      reasoning: finalReasoning,
      metadata: finalMetadata,
      tool_calls: args.toolCalls,
      blocks: args.blocks,
      agent_name: streamState?.agentDisplayName || args.agentName,
    }

    appendMessageToSession(args.sessionId, assistantMessage)
    bumpLocalSession(args.sessionId)

    // 简化标题流程：直接调 suggest-title（不传 expectedTitle），后端无条件生成并写入
    const shouldSuggestTitle = !!pendingSuggestedTitleExpectation.value[args.sessionId]
    setPendingSuggestedTitleExpectation(args.sessionId, null)

    void (async () => {
      try {
        if (shouldSuggestTitle) {
          // 等待临时标题 PATCH 完成
          const titleSync = pendingAutoTitleSync.get(args.sessionId)
          if (titleSync) await titleSync

          // 调用后端生成标题（不传 expectedTitle，让后端直接覆盖）
          const result = await msgSvc.suggestSessionTitle?.(args.sessionId, '')
          if (result?.updated && result.title) {
            setLocalSessionTitle(args.sessionId, result.title)
          }
        }
      } catch {
        // best-effort，失败保留临时标题
      } finally {
        void loadSessions({ suppressAutoSelect: true })
      }
    })()

    msgSvc.touchSession(args.sessionId).catch(() => {})
    if (currentSessionId.value === args.sessionId) {
      extractArtifacts(finalContent, assistantMessage.id)
    }
    resetSessionStream(args.sessionId, args.sending, args.draftSending)
    return assistantMessage
  }

  return {
    finalizeAssistantMessage,
  }
}
