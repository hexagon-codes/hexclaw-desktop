import type { Ref } from 'vue'
import type { ToolApprovalRequest } from '@/api/websocket'
import type {
  ToolApprovalAckWire,
  ToolApprovalDecisionWire,
} from '@/services/chatService'

type PendingApproval = ToolApprovalRequest & { receivedAt: number }
type ApprovalResponder = (decision: ToolApprovalDecisionWire) => Promise<ToolApprovalAckWire>
type ApprovalRequestWithResponder = ToolApprovalRequest & {
  respondApproval?: ApprovalResponder
}
type ApprovalTransport = {
  sendApprovalResponse: ApprovalResponder
}

function createDecisionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sameApprovalRequest(current: PendingApproval, incoming: ToolApprovalRequest): boolean {
  return current.requestId === incoming.requestId
    && current.sessionId === incoming.sessionId
    && current.toolName === incoming.toolName
    && current.ownerId === incoming.ownerId
    && current.invocationId === incoming.invocationId
    && current.argumentsDigest === incoming.argumentsDigest
    && current.securityScopeDigest === incoming.securityScopeDigest
    && current.risk === incoming.risk
    && current.reason === incoming.reason
    && current.deadlineAt === incoming.deadlineAt
}

export function createChatApprovalController(params: {
  pendingApprovals: Ref<Record<string, PendingApproval>>
  approvalCleanup?: Ref<(() => void) | null>
  ws: {
    onApprovalRequest?: (callback: (request: ToolApprovalRequest) => void) => () => void
  }
  approvalTransport?: ApprovalTransport
}) {
  const {
    pendingApprovals,
    approvalCleanup,
    ws,
    approvalTransport,
  } = params
  const decisions = new Map<string, ToolApprovalDecisionWire>()
  const inFlight = new Map<string, Promise<ToolApprovalAckWire>>()
  const responders = new Map<string, ApprovalResponder>()

  function removePendingApproval(requestId: string) {
    if (!pendingApprovals.value[requestId]) return
    const next = { ...pendingApprovals.value }
    delete next[requestId]
    pendingApprovals.value = next
  }

  function clearPendingApproval(requestId: string) {
    removePendingApproval(requestId)
    decisions.delete(requestId)
    inFlight.delete(requestId)
    responders.delete(requestId)
  }

  async function submitDecision(requestId: string): Promise<ToolApprovalAckWire> {
    const decision = decisions.get(requestId)
    if (!decision) throw new Error(`No approval decision exists for ${requestId}`)
    const active = inFlight.get(requestId)
    if (active) return active
    const responder = responders.get(requestId) ?? approvalTransport?.sendApprovalResponse
    if (!responder) throw new Error(`No owning approval transport exists for ${requestId}`)

    const submission = responder(decision)
      .then((ack) => {
        if (ack.request_id !== decision.request_id || ack.decision_id !== decision.decision_id) {
          throw new Error('Tool approval acknowledgement correlation mismatch')
        }
        if (
          ack.status === 'accepted'
          || ack.status === 'already_accepted'
          || ack.status === 'expired'
          || ack.status === 'rejected'
        ) {
          clearPendingApproval(requestId)
          return ack
        }
        throw new Error(`Unsupported tool approval acknowledgement status: ${String(ack.status)}`)
      })
      .finally(() => {
        if (inFlight.get(requestId) === submission) inFlight.delete(requestId)
      })

    inFlight.set(requestId, submission)
    return submission
  }

  function storePendingApproval(rawRequest: ToolApprovalRequest) {
    const {
      respondApproval,
      ...request
    } = rawRequest as ApprovalRequestWithResponder
    const current = pendingApprovals.value[request.requestId]
    if (current) {
      if (!sameApprovalRequest(current, request)) return
      if (respondApproval) responders.set(request.requestId, respondApproval)
      if (decisions.has(request.requestId) && !inFlight.has(request.requestId)) {
        void submitDecision(request.requestId).catch(() => undefined)
      }
      return
    }

    if (respondApproval) responders.set(request.requestId, respondApproval)
    pendingApprovals.value = {
      ...pendingApprovals.value,
      [request.requestId]: {
        ...request,
        receivedAt: Date.now(),
      },
    }
  }

  function getPendingApprovalForSession(sessionId: string | null): PendingApproval | null {
    if (!sessionId) return null
    return Object.values(pendingApprovals.value)
      .filter((request) => request.sessionId === sessionId)
      .sort((left, right) => right.receivedAt - left.receivedAt)[0] ?? null
  }

  function hasSessionPendingApproval(sessionId: string | null): boolean {
    return getPendingApprovalForSession(sessionId) !== null
  }

  function respondApproval(
    requestId: string,
    approved: boolean,
    remember: boolean,
    reason?: string,
  ): Promise<ToolApprovalAckWire> | undefined {
    if (!pendingApprovals.value[requestId]) return undefined
    if (!decisions.has(requestId)) {
      const pending = pendingApprovals.value[requestId]
      const decisionId = createDecisionId()
      decisions.set(requestId, {
        request_id: requestId,
        decision_id: decisionId,
        invocation_id: pending.invocationId,
        arguments_digest: pending.argumentsDigest,
        security_scope_digest: pending.securityScopeDigest,
        decision: approved
          ? (remember ? 'approved_remember' : 'approved_once')
          : 'denied',
        idempotency_key: decisionId,
        reason,
      })
    }
    return submitDecision(requestId)
  }

  function initApprovalListener() {
    if (!approvalCleanup || !ws.onApprovalRequest) return
    approvalCleanup.value?.()
    approvalCleanup.value = ws.onApprovalRequest(storePendingApproval)
  }

  return {
    initApprovalListener,
    storePendingApproval,
    getPendingApprovalForSession,
    hasSessionPendingApproval,
    respondApproval,
    clearPendingApproval,
  }
}
