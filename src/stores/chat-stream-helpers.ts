import type { ActiveStreamSnapshot } from '@/api/chat'
import type { ToolApprovalRequest } from '@/api/websocket'
import type { ChatMessage } from '@/types'
import { normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'

export type SessionStreamState = {
  sessionId: string
  requestId: string
  rawContent: string
  content: string
  explicitReasoning: string
  reasoning: string
  reasoningStartTime: number
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
    }
  }

  return {
    streaming: true,
    streamingSessionId: fallback.sessionId,
    streamingContent: fallback.content,
    streamingReasoning: fallback.reasoning,
    streamingReasoningStartTime: fallback.reasoningStartTime,
  }
}

export function mergeStreamChunkState(
  current: SessionStreamState,
  content?: string,
  reasoning?: string,
): SessionStreamState {
  let explicitReasoning = current.explicitReasoning
  let reasoningStartTime = current.reasoningStartTime

  if (reasoning) {
    if (!reasoningStartTime) reasoningStartTime = Date.now()
    explicitReasoning = normalizeAssistantReasoning(explicitReasoning + reasoning, { trim: false })
  }

  let rawContent = current.rawContent
  let parsedContent = current.content
  let extractedReasoning = ''

  if (content) {
    rawContent += content
    const parsed = extractThinkTags(rawContent)
    parsedContent = parsed.content
    extractedReasoning = parsed.reasoning
      ? normalizeAssistantReasoning(parsed.reasoning, { trim: false })
      : ''
    if (extractedReasoning && !reasoningStartTime) reasoningStartTime = Date.now()
  }

  const combinedReasoning = [explicitReasoning, extractedReasoning]
    .filter((value) => value && value.trim())
    .join(explicitReasoning && extractedReasoning ? '\n' : '')

  return {
    ...current,
    rawContent,
    content: parsedContent,
    explicitReasoning,
    reasoning: normalizeAssistantReasoning(combinedReasoning, { trim: false }),
    reasoningStartTime,
  }
}

export function buildRecoveredStreamState(
  sessionId: string,
  snapshot: ActiveStreamSnapshot,
): SessionStreamState {
  const snapshotContent = snapshot.content || ''
  const snapshotReasoning = normalizeAssistantReasoning(snapshot.reasoning || '', { trim: false })
  return {
    sessionId,
    requestId: snapshot.request_id,
    rawContent: snapshotContent,
    content: snapshotContent,
    explicitReasoning: snapshotReasoning,
    reasoning: snapshotReasoning,
    reasoningStartTime: snapshotReasoning ? Date.now() : 0,
  }
}
