import type { ActiveStreamSnapshot } from '@/api/chat'
import type { ToolApprovalRequest } from '@/api/websocket'
import type {
  ChatMessage,
  ReasoningDisclosure,
  RuntimeEvent,
  RuntimeWireFrame,
  RuntimeWireSnapshot,
} from '@/types'
import {
  createRuntimeWireSnapshot,
  mergeRuntimeWireFrame,
  normalizeRuntimeSnapshotMetadata,
} from '@/types/chat'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'

export type SessionStreamState = {
  sessionId: string
  requestId: string
  /** Stable frontend identity for the assistant message across live terminal transitions. */
  assistantMessageId?: string
  /** Canonical backend identity. Stored as metadata/alias, never used as the Vue key. */
  canonicalAssistantMessageId?: string
  assistantMessageAliases: string[]
  lastSequence: number
  runtimeEvents: RuntimeEvent[]
  reasoningDisclosure?: ReasoningDisclosure
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

export function buildLiveAssistantMessageId(requestId: string): string {
  return `${requestId}:assistant`
}

export function buildSessionStreamState(args: {
  sessionId: string
  requestId: string
  thinkingEnabled: boolean
  startedAt?: number
  agentDisplayName?: string
  recipientDisplayName?: string
}): SessionStreamState {
  return {
    sessionId: args.sessionId,
    requestId: args.requestId,
    assistantMessageId: buildLiveAssistantMessageId(args.requestId),
    assistantMessageAliases: [],
    lastSequence: 0,
    runtimeEvents: [],
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
  const startTime = state?.thinkingEnabled && state.startedAt
    ? state.startedAt
    : state?.reasoningStartTime
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
    streamingReasoningStartTime: fallback.thinkingEnabled
      ? fallback.startedAt ?? fallback.reasoningStartTime
      : fallback.reasoningStartTime,
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
  let runtimeSnapshot: RuntimeWireSnapshot = {
    assistantMessageId: current.canonicalAssistantMessageId,
    aliases: current.assistantMessageAliases,
    lastSequence: current.lastSequence,
    runtimeEvents: current.runtimeEvents,
    reasoningDisclosure: current.reasoningDisclosure,
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
  let explicitReasoning = current.explicitReasoning
  let reasoningStartTime = current.reasoningStartTime

  if (publicReasoning) {
    if (!reasoningStartTime) reasoningStartTime = Date.now()
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

  const combinedReasoning = [explicitReasoning, extractedReasoning]
    .filter((value) => value && value.trim())
    .join(explicitReasoning && extractedReasoning ? '\n' : '')

  let reasoningEndTime = current.reasoningEndTime
  if (reasoningStartTime && !reasoningEndTime && content && !publicReasoning) {
    reasoningEndTime = Date.now()
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
    reasoningDisclosure: runtimeSnapshot.reasoningDisclosure,
    acceptedRuntimeFrames: runtimeSnapshot.acceptedFrames,
    rawContent,
    content: parsedContent,
    explicitReasoning,
    reasoning: normalizeAssistantReasoning(combinedReasoning, { trim: false }),
    reasoningStartTime,
    reasoningEndTime,
    visibility: runtimeSnapshot.reasoningDisclosure?.visibility ?? current.visibility,
  }
}

export function buildRecoveredStreamState(
  sessionId: string,
  snapshot: ActiveStreamSnapshot,
): SessionStreamState {
  const snapshotContent = snapshot.content || ''
  const snapshotReasoning = normalizeAssistantReasoning(snapshot.reasoning || '', { trim: false })
  const metadata = normalizeRuntimeSnapshotMetadata({
    ...(snapshot.metadata ?? {}),
    assistant_message_id: snapshot.assistant_message_id,
    message_id: snapshot.message_id,
    reasoning_disclosure: snapshot.reasoning_disclosure,
    runtime_events: snapshot.runtime_events,
    last_sequence: snapshot.last_sequence ?? snapshot.sequence,
  })
  const disclosure = metadata.reasoning_disclosure
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
  const rawThinkingEnabled = metadata.thinking_enabled
  const thinkingEnabled = rawThinkingEnabled === true
    || rawThinkingEnabled === 'true'
    || rawThinkingEnabled === '1'
      ? true
      : rawThinkingEnabled === false
        || rawThinkingEnabled === 'false'
        || rawThinkingEnabled === '0'
        ? false
        : !!snapshotReasoning || !!disclosure || (metadata.runtime_events?.length ?? 0) > 0
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
    reasoningStartTime: publicReasoning ? startedAt : 0,
    reasoningEndTime: 0,
  }
}
