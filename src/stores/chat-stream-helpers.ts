import type { ActiveStreamSnapshot } from '@/api/chat'
import type { ToolApprovalRequest } from '@/api/websocket'
import type {
  ChatMessage,
  ReasoningDisclosure,
  RuntimeEvent,
  RuntimeWireFrame,
  RuntimeWireSnapshot,
} from '@/types'
import type { ModelReasoningSupport } from '@/types/settings'
import {
  mergeRuntimeWireFrame,
  normalizeReasoningReceipt,
  normalizeRuntimeSnapshotMetadata,
  type ReasoningExecution,
  type ReasoningReceipt,
  type ReasoningRequest,
} from '@/types/chat'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'

export type SessionStreamState = {
  sessionId: string
  requestId: string
  /** 请求发出时的模型路由；只用于校验运行时 reasoning disclosure。 */
  requestRoute?: Readonly<{ provider?: string; model?: string }>
  /** Stable frontend identity for the assistant message across live terminal transitions. */
  assistantMessageId?: string
  /** Canonical backend identity. Stored as metadata/alias, never used as the Vue key. */
  canonicalAssistantMessageId?: string
  assistantMessageAliases: string[]
  lastSequence: number
  runtimeEvents: RuntimeEvent[]
  reasoningDisclosure?: ReasoningDisclosure
  /** 旧会话快照可能缺失；生产构建与归约路径始终写入 canonical 值。 */
  reasoningReceipt?: ReasoningReceipt
  reasoningSupport?: ModelReasoningSupport
  reasoningExecution?: ReasoningExecution
  acceptedRuntimeFrames: Record<number, string>
  /** Request-owned lifecycle snapshot. These fields never follow the currently selected session. */
  thinkingEnabled?: boolean
  startedAt?: number
  state?: 'running' | 'completed' | 'failed' | 'cancelled'
  visibility?: 'visible' | 'not_exposed'
  agentDisplayName?: string
  recipientDisplayName?: string
  rawContent: string
  content: string
  explicitReasoning: string
  reasoning: string
  reasoningStartTime: number
  reasoningEndTime: number
  /** 已检测到失控复读退化并熔断（内容已冻结，丢弃后续复读 chunk）。 */
  degenerated?: boolean
}

/** 发送链路使用的请求级错误投影契约。 */
export type ChatSendErrorHandler = (
  errorValue: unknown,
  sessionId: string | null | undefined,
  streamState?: SessionStreamState,
) => void

export function buildLiveAssistantMessageId(requestId: string): string {
  return `${requestId}:assistant`
}

export function buildSessionStreamState(args: {
  sessionId: string
  requestId: string
  thinkingEnabled: boolean
  reasoningSupport?: ModelReasoningSupport
  requestRoute?: { provider?: string; model?: string }
  startedAt?: number
  agentDisplayName?: string
  recipientDisplayName?: string
}): SessionStreamState {
  const reasoningRequest: ReasoningRequest = args.thinkingEnabled ? 'on' : 'off'
  const reasoningReceipt: ReasoningReceipt = {
    ...normalizeReasoningReceipt(undefined, reasoningRequest),
    reasoning_support: args.reasoningSupport ?? 'unknown',
  }
  const requestRoute = args.requestRoute
    ? Object.freeze({
        provider: args.requestRoute.provider,
        model: args.requestRoute.model,
      })
    : undefined
  return {
    sessionId: args.sessionId,
    requestId: args.requestId,
    ...(requestRoute ? { requestRoute } : {}),
    assistantMessageId: buildLiveAssistantMessageId(args.requestId),
    assistantMessageAliases: [],
    lastSequence: 0,
    runtimeEvents: [],
    reasoningReceipt,
    reasoningSupport: reasoningReceipt.reasoning_support,
    reasoningExecution: reasoningReceipt.reasoning_execution,
    acceptedRuntimeFrames: {},
    thinkingEnabled: args.thinkingEnabled,
    startedAt: args.startedAt ?? Date.now(),
    state: 'running',
    visibility: 'not_exposed',
    agentDisplayName: args.agentDisplayName,
    recipientDisplayName: args.recipientDisplayName,
    rawContent: '',
    content: '',
    explicitReasoning: '',
    reasoning: '',
    reasoningStartTime: 0,
    reasoningEndTime: 0,
  }
}

export function getStreamThinkingDuration(
  state: SessionStreamState | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!state) return undefined
  const usesCanonicalReceipt = state.reasoningExecution !== undefined
  if (usesCanonicalReceipt && state.reasoningExecution !== 'applied') return undefined
  const startTime = state.reasoningStartTime
    || (!usesCanonicalReceipt && state.thinkingEnabled ? state.startedAt : 0)
  if (!startTime) return undefined
  const endTime = state?.reasoningEndTime && state.reasoningEndTime >= startTime
    ? state.reasoningEndTime
    : now
  return Math.max(0, Math.round((endTime - startTime) / 1000))
}

export type PendingToolApproval = ToolApprovalRequest & {
  receivedAt: number
}

export function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message))
}

export function storePendingApproval(
  approvals: Record<string, PendingToolApproval>,
  request: ToolApprovalRequest,
): Record<string, PendingToolApproval> {
  return {
    ...approvals,
    [request.requestId]: {
      ...request,
      receivedAt: Date.now(),
    },
  }
}

export function clearPendingApproval(
  approvals: Record<string, PendingToolApproval>,
  requestId: string,
): Record<string, PendingToolApproval> {
  if (!approvals[requestId]) return approvals
  const next = { ...approvals }
  delete next[requestId]
  return next
}

export function findPendingApprovalForSession(
  approvals: Record<string, PendingToolApproval>,
  sessionId?: string | null,
): ToolApprovalRequest | null {
  if (!sessionId) return null
  const matched = Object.values(approvals)
    .filter((item) => item.sessionId === sessionId)
    .sort((a, b) => b.receivedAt - a.receivedAt)[0]
  return matched ?? null
}

export function hasPendingApprovalForSession(
  approvals: Record<string, PendingToolApproval>,
  sessionId: string,
): boolean {
  return Object.values(approvals).some((item) => item.sessionId === sessionId)
}

export function getStreamStateForSession(
  activeStreams: Record<string, SessionStreamState>,
  sessionId?: string | null,
): SessionStreamState | null {
  if (!sessionId) return null
  return activeStreams[sessionId] ?? null
}

export function getFallbackStreamState(
  activeStreams: Record<string, SessionStreamState>,
): SessionStreamState | null {
  const [first] = Object.values(activeStreams)
  return first ?? null
}

export function buildStreamingMirrorState(
  activeStreams: Record<string, SessionStreamState>,
  currentSessionId?: string | null,
) {
  const current = getStreamStateForSession(activeStreams, currentSessionId)
  const fallback = current ?? getFallbackStreamState(activeStreams)
  if (!fallback) {
    return {
      streaming: false,
      streamingSessionId: null,
      streamingContent: '',
      streamingReasoning: '',
      streamingReasoningStartTime: 0,
      streamingReasoningEndTime: 0,
    }
  }

  return {
    streaming: true,
    streamingSessionId: fallback.sessionId,
    streamingContent: fallback.content,
    streamingReasoning: fallback.reasoning,
    streamingReasoningStartTime: fallback.reasoningExecution === undefined
      ? (fallback.thinkingEnabled ? fallback.startedAt ?? fallback.reasoningStartTime : fallback.reasoningStartTime)
      : fallback.reasoningExecution === 'applied'
        ? fallback.reasoningStartTime
        : 0,
    streamingReasoningEndTime: fallback.reasoningEndTime,
  }
}

export function mergeStreamChunkState(
  current: SessionStreamState,
  content?: string,
  reasoning?: string,
  runtimeFrame?: RuntimeWireFrame | Record<string, unknown>,
  route?: { provider?: string; model?: string },
): SessionStreamState {
  const currentReasoningReceipt = normalizeReasoningReceipt(
    current.reasoningReceipt,
    current.thinkingEnabled ? 'on' : 'off',
  )
  let runtimeSnapshot: RuntimeWireSnapshot = {
    assistantMessageId: current.canonicalAssistantMessageId,
    aliases: current.assistantMessageAliases,
    lastSequence: current.lastSequence,
    runtimeEvents: current.runtimeEvents,
    reasoningDisclosure: current.reasoningDisclosure,
    reasoningReceipt: currentReasoningReceipt,
    acceptedFrames: current.acceptedRuntimeFrames,
  }
  let acceptedRuntimeFrame: RuntimeWireFrame | undefined
  if (runtimeFrame) {
    const raw = 'assistantMessageId' in runtimeFrame
      ? {
          assistant_message_id: runtimeFrame.assistantMessageId,
          message_id: runtimeFrame.messageId,
          sequence: runtimeFrame.sequence,
          reasoning_disclosure: runtimeFrame.reasoningDisclosure,
          reasoning_receipt: runtimeFrame.reasoningReceipt,
          runtime_event: runtimeFrame.runtimeEvent
            ? (() => {
                const event = { ...runtimeFrame.runtimeEvent } as Record<string, unknown>
                delete event.sequence
                return event
              })()
            : undefined,
        }
      : runtimeFrame
    const mergedRuntime = mergeRuntimeWireFrame(runtimeSnapshot, raw, route)
    if (!mergedRuntime.accepted || (Number(raw.sequence) > 0 && !mergedRuntime.frame)) return current
    runtimeSnapshot = mergedRuntime.snapshot
    acceptedRuntimeFrame = mergedRuntime.frame
  }
  const publicReasoning = acceptedRuntimeFrame?.reasoningDisclosure.visibility === 'visible'
    ? reasoning
    : undefined
  const hasUntrustedReasoning = !!reasoning?.trim() && publicReasoning === undefined
  const reasoningReceipt = runtimeSnapshot.reasoningReceipt
  const receivedAt = Date.now()
  let explicitReasoning = hasUntrustedReasoning ? '' : current.explicitReasoning
  let reasoningStartTime = current.reasoningStartTime

  if (reasoningReceipt.reasoning_execution === 'applied' && !reasoningStartTime) {
    reasoningStartTime = receivedAt
  }
  if (publicReasoning) {
    explicitReasoning = normalizeAssistantReasoning(explicitReasoning + publicReasoning, { trim: false })
  }

  let rawContent = current.rawContent
  let parsedContent = current.content
  let extractedReasoning = ''

  if (content) {
    rawContent += content
    const parsed = extractThinkTags(rawContent)
    parsedContent = parsed.content
    extractedReasoning = ''
  }

  const combinedReasoning = hasUntrustedReasoning ? '' : [explicitReasoning, extractedReasoning]
    .filter((value) => value && value.trim())
    .join(explicitReasoning && extractedReasoning ? '\n' : '')

  let reasoningEndTime = current.reasoningEndTime
  const hasVisibleContent = parsedContent.trim().length > 0
  if (
    reasoningReceipt.reasoning_execution === 'applied'
    && reasoningStartTime
    && !reasoningEndTime
    && hasVisibleContent
  ) {
    reasoningEndTime = receivedAt
  } else if (
    current.reasoningExecution === 'applied'
    && reasoningReceipt.reasoning_execution !== 'applied'
    && reasoningStartTime
    && !reasoningEndTime
  ) {
    reasoningEndTime = receivedAt
  }

  return {
    ...current,
    assistantMessageId: current.assistantMessageId,
    canonicalAssistantMessageId:
      runtimeSnapshot.assistantMessageId ?? current.canonicalAssistantMessageId,
    assistantMessageAliases: Array.from(new Set([
      ...current.assistantMessageAliases,
      ...(runtimeSnapshot.assistantMessageId
      && current.assistantMessageId !== runtimeSnapshot.assistantMessageId
        ? [runtimeSnapshot.assistantMessageId]
        : []),
      ...runtimeSnapshot.aliases.filter((id) => id !== current.assistantMessageId),
    ])),
    lastSequence: runtimeSnapshot.lastSequence,
    runtimeEvents: runtimeSnapshot.runtimeEvents,
    reasoningDisclosure: hasUntrustedReasoning ? undefined : runtimeSnapshot.reasoningDisclosure,
    reasoningReceipt,
    reasoningSupport: reasoningReceipt.reasoning_support,
    reasoningExecution: reasoningReceipt.reasoning_execution,
    acceptedRuntimeFrames: runtimeSnapshot.acceptedFrames,
    rawContent,
    content: parsedContent,
    explicitReasoning,
    reasoning: hasUntrustedReasoning ? '' : normalizeAssistantReasoning(combinedReasoning, { trim: false }),
    reasoningStartTime,
    reasoningEndTime,
    visibility: hasUntrustedReasoning
      ? 'not_exposed'
      : runtimeSnapshot.reasoningDisclosure?.visibility ?? current.visibility,
  }
}

export function buildRecoveredStreamState(
  sessionId: string,
  snapshot: ActiveStreamSnapshot,
): SessionStreamState {
  const snapshotContent = snapshot.content || ''
  const snapshotReasoning = normalizeAssistantReasoning(snapshot.reasoning || '', { trim: false })
  const rawThinkingEnabled = snapshot.metadata?.thinking_enabled
  const fallbackReasoningRequest: ReasoningRequest = rawThinkingEnabled === true
    || rawThinkingEnabled === 'true'
    || rawThinkingEnabled === '1'
    ? 'on'
    : 'off'
  const metadata = normalizeRuntimeSnapshotMetadata({
    ...snapshot.metadata,
    assistant_message_id: snapshot.assistant_message_id,
    message_id: snapshot.message_id,
    reasoning_disclosure: snapshot.reasoning_disclosure,
    reasoning_receipt: snapshot.metadata?.reasoning_receipt,
    runtime_events: snapshot.runtime_events,
    last_sequence: snapshot.last_sequence ?? snapshot.sequence,
  }, undefined, undefined, fallbackReasoningRequest)
  const disclosure = metadata.reasoning_disclosure
  const reasoningReceipt = normalizeReasoningReceipt(
    metadata.reasoning_receipt,
    fallbackReasoningRequest,
  )
  const publicReasoning = disclosure?.visibility === 'visible' ? snapshotReasoning : ''
  const frontendAssistantMessageId = buildLiveAssistantMessageId(snapshot.request_id)
  const canonicalAssistantMessageId = metadata.assistant_message_id
  const aliases = Array.from(new Set([
    ...(metadata.assistant_message_aliases ?? []),
    ...(canonicalAssistantMessageId && canonicalAssistantMessageId !== frontendAssistantMessageId
      ? [canonicalAssistantMessageId]
      : []),
  ])).filter((id) => id !== frontendAssistantMessageId)
  const parsedStartedAt = snapshot.started_at ? Date.parse(snapshot.started_at) : Number.NaN
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now()
  const normalizedThinkingEnabled = metadata.thinking_enabled
  const thinkingEnabled = normalizedThinkingEnabled === true
    || normalizedThinkingEnabled === 'true'
    || normalizedThinkingEnabled === '1'
      ? true
      : normalizedThinkingEnabled === false
        || normalizedThinkingEnabled === 'false'
        || normalizedThinkingEnabled === '0'
        ? false
        : reasoningReceipt.reasoning_request === 'on'
  const rawState = metadata.thinking_state
  const state = rawState === 'running'
    || rawState === 'completed'
    || rawState === 'failed'
    || rawState === 'cancelled'
    ? rawState
    : snapshot.status === 'completed'
      ? 'completed'
      : snapshot.status === 'errored'
        ? 'failed'
        : snapshot.status === 'cancelled'
          ? 'cancelled'
          : 'running'
  const metadataVisibility = metadata.reasoning_visibility === 'visible'
    || metadata.reasoning_visibility === 'not_exposed'
    ? metadata.reasoning_visibility
    : undefined
  const agentDisplayName = typeof metadata.agent_display_name === 'string'
    ? metadata.agent_display_name
    : typeof metadata.agent_name === 'string'
      ? metadata.agent_name
      : undefined
  const recipientDisplayName = typeof metadata.recipient_display_name === 'string'
    ? metadata.recipient_display_name
    : undefined
  return {
    sessionId,
    requestId: snapshot.request_id,
    assistantMessageId: frontendAssistantMessageId,
    canonicalAssistantMessageId: canonicalAssistantMessageId !== frontendAssistantMessageId
      ? canonicalAssistantMessageId
      : undefined,
    assistantMessageAliases: aliases,
    lastSequence: Number(metadata.last_sequence) || 0,
    runtimeEvents: metadata.runtime_events ?? [],
    reasoningDisclosure: disclosure,
    reasoningReceipt,
    reasoningSupport: reasoningReceipt.reasoning_support,
    reasoningExecution: reasoningReceipt.reasoning_execution,
    acceptedRuntimeFrames: {},
    thinkingEnabled,
    startedAt,
    state,
    visibility: disclosure?.visibility ?? metadataVisibility ?? 'not_exposed',
    agentDisplayName,
    recipientDisplayName,
    rawContent: snapshotContent,
    content: snapshotContent,
    explicitReasoning: publicReasoning,
    reasoning: publicReasoning,
    reasoningStartTime: reasoningReceipt.reasoning_execution === 'applied' ? startedAt : 0,
    reasoningEndTime: reasoningReceipt.reasoning_execution === 'applied' && snapshotContent.trim()
      ? Date.now()
      : 0,
  }
}
