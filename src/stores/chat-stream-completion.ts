import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { MessageContent, RenderManifest } from '@/contracts/message-content'
import {
  normalizeReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  normalizeThinkingDuration,
  normalizeThinkingMetadata,
  type ReasoningReceipt,
} from '@/types/chat'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'
import { freezeProcessAnswer } from '@/utils/assistant-process'
import { getStreamThinkingDuration, type SessionStreamState } from './chat-stream-helpers'
import { backendScopeKey } from '@/services/backend-context'

type MessageServiceModule = typeof import('@/services/messageService')

/** 只有服务端元数据中的明确落盘身份且无保存错误，才能省略追加。 */
export function hasPersistedAssistantReply(metadata: Record<string, unknown> | undefined): boolean {
  return typeof metadata?.backend_message_id === 'string'
    && !!metadata.backend_message_id.trim()
    && !metadata.persist_error
}

export function createChatStreamCompletionController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  pendingAutoTitleSync: Map<string, Promise<string>>
  currentSessionId: Ref<string | null>
  msgSvc: MessageServiceModule
  createId: () => string
  loadSessions: (opts?: { suppressAutoSelect?: boolean }) => Promise<void>
  setLocalSessionTitle: (sessionId: string, title: string, expectedTitle?: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  bumpLocalSession: (sessionId: string) => void
  extractArtifacts: (content: string, messageId: string) => void
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  projectObservedMessage?: (sessionId: string, message: ChatMessage, regenerateFromMessageId?: string) => void
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
    projectObservedMessage,
    resetSessionStream,
  } = params

  function finalizeAssistantMessage(args: {
    content: string
    messageContent?: MessageContent
    renderManifest?: RenderManifest
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    blocks?: ChatMessage['blocks']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
    terminalState?: 'completed' | 'failed' | 'cancelled'
    outcomeUnconfirmed?: true
    regenerateFromMessageId?: string
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
    // 明确的请求终态覆盖中间模型轮次的状态，不用旧思考状态改写取消结果。
    if (args.terminalState) metadata.thinking_state = args.terminalState
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
    const terminalState = args.outcomeUnconfirmed ? undefined : args.terminalState ?? (
      reasoningReceipt.reasoning_request === 'on' && !hasDeliverableOutput ? 'failed' : 'completed'
    )
    const normalizedRuntimeMetadata = normalizeRuntimeSnapshotMetadata(
      metadata,
      streamState?.canonicalAssistantMessageId ?? streamState?.assistantMessageId,
      undefined,
      reasoningReceipt.reasoning_request,
    )
    const finalMetadata = normalizeThinkingMetadata(normalizedRuntimeMetadata, finalReasoning, terminalState)
    if (args.outcomeUnconfirmed && finalMetadata) {
      delete finalMetadata.backend_message_id
      delete finalMetadata.thinking_state
      finalMetadata.request_id = streamState?.requestId
      if (args.regenerateFromMessageId) finalMetadata.regenerate_from_message_id = args.regenerateFromMessageId
      finalMetadata.outcome_unconfirmed = true
    }

    const assistantMessage: ChatMessage = {
      id: streamState?.assistantMessageId
        || normalizedRuntimeMetadata.assistant_message_id
        || createId(),
      role: 'assistant',
      content: args.outcomeUnconfirmed ? finalContent : (args.messageContent && !finalContent.trim())
        || ((terminalState === 'failed' || terminalState === 'cancelled') && !hasDeliverableOutput)
        ? ''
        : getAssistantDisplayContent(finalContent, finalReasoning),
      message_content: args.messageContent,
      render_manifest: args.renderManifest,
      timestamp: new Date().toISOString(),
      reasoning: finalReasoning,
      metadata: finalMetadata,
      tool_calls: args.toolCalls ?? streamState?.toolCalls,
      blocks: args.outcomeUnconfirmed && streamState?.degenerated
        ? freezeProcessAnswer(streamState.blocks, finalContent)
        : args.blocks ?? streamState?.blocks,
      agent_name: streamState?.agentDisplayName || args.agentName,
    }

    if (args.outcomeUnconfirmed) {
      // 只保留部分预览，不追加历史、生成标题或执行回复后的自动动作。
      projectObservedMessage?.(args.sessionId, assistantMessage)
      resetSessionStream(args.sessionId, args.sending, args.draftSending)
      return assistantMessage
    }
    if (args.regenerateFromMessageId) projectObservedMessage?.(args.sessionId, assistantMessage, args.regenerateFromMessageId)
    else appendMessageToSession(args.sessionId, assistantMessage)
    if (args.terminalState === 'cancelled' && hasDeliverableOutput
      && !hasPersistedAssistantReply(args.metadata)) {
      // 真实取消没有正常助手轮次落库，沿原身份保存已观察的部分结果。
      void msgSvc.persistCancelledReply(args.sessionId, assistantMessage)
    }
    bumpLocalSession(args.sessionId)

    const expectedTitle = terminalState === 'completed' ? pendingSuggestedTitleExpectation.value[args.sessionId] : undefined
    const titleSync = pendingAutoTitleSync.get(args.sessionId)
    const titleBackend = backendScopeKey()
    pendingAutoTitleSync.delete(args.sessionId)
    setPendingSuggestedTitleExpectation(args.sessionId, null)

    void (async () => {
      try {
        if (expectedTitle) {
          // 服务端以实际暂存标题提交，页面也只替换仍属于本次建议的标题。
          const storedTitle = titleSync ? await titleSync : expectedTitle
          if (titleBackend !== backendScopeKey()) return
          const result = await msgSvc.suggestSessionTitle?.(args.sessionId, storedTitle)
          if (titleBackend === backendScopeKey() && result?.updated && result.title) {
            setLocalSessionTitle(args.sessionId, result.title, expectedTitle)
          }
        }
      } catch {
        // best-effort，失败保留临时标题
      } finally {
        if (titleBackend === backendScopeKey()) void loadSessions({ suppressAutoSelect: true })
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
