import type { Ref } from 'vue'
import type { ToolApprovalRequest, ToolApprovalWireMessage } from '@/api/websocket'
import {
  onToolApprovalTerminal,
  parseToolApprovalReconciliationAck,
  parseToolApprovalTerminal,
  type ToolApprovalAckWire,
  type ToolApprovalDecisionWire,
  type ToolApprovalReconciliationAckWire,
  type ToolApprovalTerminalWire,
} from '@/services/chatService'

type PendingApproval = ToolApprovalRequest & { receivedAt: number }
type CompletePendingApprovalIdentity = PendingApproval & {
  requestId: string
  sessionId: string
  ownerId: string
  invocationId: string
  argumentsDigest: string
  securityScopeDigest: string
  scopeSchemaVersion: number
}
type ReconcileablePendingApproval = CompletePendingApprovalIdentity & { deadlineAt: string }
type ApprovalResponder = (decision: ToolApprovalDecisionWire) => Promise<ToolApprovalAckWire>
type ApprovalRequestWithResponder = ToolApprovalRequest & {
  respondApproval?: ApprovalResponder
}
type ApprovalTransport = {
  sendApprovalResponse: ApprovalResponder
}
type ToolApprovalReconciliationRequest = {
  type: 'tool_approval_reconcile'
  request_id: string
  session_id: string
  owner_id: string
  invocation_id: string
  arguments_digest: string
  security_scope_digest: string
  scope_schema_version: number
  deadline_at: string
}

function createDecisionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasCompletePendingApprovalIdentity(
  request: PendingApproval,
): request is CompletePendingApprovalIdentity {
  return isNonEmptyString(request.requestId)
    && isNonEmptyString(request.sessionId)
    && isNonEmptyString(request.ownerId)
    && isNonEmptyString(request.invocationId)
    && isNonEmptyString(request.argumentsDigest)
    && isNonEmptyString(request.securityScopeDigest)
    && Number.isSafeInteger(request.scopeSchemaVersion)
    && Number(request.scopeSchemaVersion) > 0
}

function hasCompleteApprovalTerminalIdentity(terminal: ToolApprovalTerminalWire): boolean {
  return isNonEmptyString(terminal.request_id)
    && isNonEmptyString(terminal.session_id)
    && isNonEmptyString(terminal.owner_id)
    && isNonEmptyString(terminal.invocation_id)
    && isNonEmptyString(terminal.arguments_digest)
    && isNonEmptyString(terminal.security_scope_digest)
    && Number.isSafeInteger(terminal.scope_schema_version)
    && Number(terminal.scope_schema_version) > 0
}

function hasCompleteReconciliationRequest(
  request: PendingApproval,
): request is ReconcileablePendingApproval {
  return hasCompletePendingApprovalIdentity(request) && isNonEmptyString(request.deadlineAt)
}

function sameApprovalRequest(current: PendingApproval, incoming: ToolApprovalRequest): boolean {
  return current.requestId === incoming.requestId
    && current.sessionId === incoming.sessionId
    && current.toolName === incoming.toolName
    && current.ownerId === incoming.ownerId
    && current.invocationId === incoming.invocationId
    && current.argumentsDigest === incoming.argumentsDigest
    && current.securityScopeDigest === incoming.securityScopeDigest
    && current.scopeSchemaVersion === incoming.scopeSchemaVersion
    && current.risk === incoming.risk
    && current.reason === incoming.reason
    && current.deadlineAt === incoming.deadlineAt
}

function sameApprovalTerminal(current: PendingApproval, terminal: ToolApprovalTerminalWire): boolean {
  if (!hasCompletePendingApprovalIdentity(current) || !hasCompleteApprovalTerminalIdentity(terminal)) {
    return false
  }
  return current.requestId === terminal.request_id
    && current.sessionId === terminal.session_id
    && current.ownerId === terminal.owner_id
    && current.invocationId === terminal.invocation_id
    && current.argumentsDigest === terminal.arguments_digest
    && current.securityScopeDigest === terminal.security_scope_digest
    && current.scopeSchemaVersion === terminal.scope_schema_version
}

function sameApprovalReconciliationAck(
  current: PendingApproval,
  acknowledgement: ToolApprovalReconciliationAckWire,
): boolean {
  if (!hasCompletePendingApprovalIdentity(current)) return false
  return current.requestId === acknowledgement.request_id
    && current.sessionId === acknowledgement.session_id
    && current.ownerId === acknowledgement.owner_id
    && current.invocationId === acknowledgement.invocation_id
    && current.argumentsDigest === acknowledgement.arguments_digest
    && current.securityScopeDigest === acknowledgement.security_scope_digest
    && current.scopeSchemaVersion === acknowledgement.scope_schema_version
}

export function createChatApprovalController(params: {
  pendingApprovals: Ref<Record<string, PendingApproval>>
  approvalCleanup?: Ref<(() => void) | null>
  ws: {
    onApprovalRequest?: (callback: (request: ToolApprovalRequest) => void) => () => void
    onApprovalWire?: (callback: (wire: ToolApprovalWireMessage) => void) => () => void
    onReconnect?: (callback: () => void) => () => void
    sendRaw?: (wire: Record<string, unknown>) => void
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
  const inFlight = new Map<string, Promise<ToolApprovalAckWire | undefined>>()
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

  async function submitDecision(requestId: string): Promise<ToolApprovalAckWire | undefined> {
    const decision = decisions.get(requestId)
    if (!decision) throw new Error(`No approval decision exists for ${requestId}`)
    const active = inFlight.get(requestId)
    if (active) return active
    const responder = responders.get(requestId) ?? approvalTransport?.sendApprovalResponse
    if (!responder) throw new Error(`No owning approval transport exists for ${requestId}`)

    const transport = Promise.resolve()
      .then(() => responder(decision))
      .catch(() => undefined)
    const submission = transport
      .then((ack) => {
        if (!ack) return undefined
        const current = pendingApprovals.value[requestId]
        if (
          !current
          || !sameApprovalReconciliationAck(current, ack)
          || ack.decision_id !== decision.decision_id
          || ack.decision !== decision.decision
          || ack.idempotency_key !== decision.idempotency_key
        ) {
          throw new Error('Tool approval acknowledgement correlation mismatch')
        }
        if (ack.status === 'accepted' || ack.status === 'already_accepted') {
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

  function storeApprovalTerminal(terminal: ToolApprovalTerminalWire) {
    if (terminal.terminal_result !== 'expired' && terminal.terminal_result !== 'fenced') return
    const current = pendingApprovals.value[terminal.request_id]
    if (!current || !sameApprovalTerminal(current, terminal)) return
    clearPendingApproval(terminal.request_id)
  }

  function storeApprovalReconciliationAck(acknowledgement: ToolApprovalReconciliationAckWire) {
    const current = pendingApprovals.value[acknowledgement.request_id]
    if (!current || !sameApprovalReconciliationAck(current, acknowledgement)) return
    const submitted = decisions.get(acknowledgement.request_id)
    if (
      submitted && (
        submitted.decision_id !== acknowledgement.decision_id
        || submitted.decision !== acknowledgement.decision
        || submitted.idempotency_key !== acknowledgement.idempotency_key
      )
    ) {
      return
    }
    clearPendingApproval(acknowledgement.request_id)
  }

  function storeApprovalReconciliationWire(wire: ToolApprovalWireMessage) {
    const data = wire as unknown as Record<string, unknown>
    if (wire.type === 'tool_approval_terminal') {
      const terminal = parseToolApprovalTerminal(data)
      if (terminal) storeApprovalTerminal(terminal)
      return
    }
    if (wire.type === 'tool_approval_ack') {
      const acknowledgement = parseToolApprovalReconciliationAck(data)
      if (acknowledgement) storeApprovalReconciliationAck(acknowledgement)
    }
  }

  function reconcilePendingApprovals() {
    if (!ws.sendRaw) return
    for (const request of Object.values(pendingApprovals.value)) {
      if (!hasCompleteReconciliationRequest(request)) continue
      const wire: ToolApprovalReconciliationRequest = {
        type: 'tool_approval_reconcile',
        request_id: request.requestId,
        session_id: request.sessionId,
        owner_id: request.ownerId,
        invocation_id: request.invocationId,
        arguments_digest: request.argumentsDigest,
        security_scope_digest: request.securityScopeDigest,
        scope_schema_version: request.scopeSchemaVersion,
        deadline_at: request.deadlineAt,
      }
      try {
        ws.sendRaw(wire)
      } catch {
        // 发送失败时保留本地 pending，后续重连会再次向后端权威状态查询。
      }
    }
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

  function clearPendingApprovalsForSession(sessionId: string) {
    if (!isNonEmptyString(sessionId)) return
    for (const request of Object.values(pendingApprovals.value)) {
      if (request.sessionId === sessionId) clearPendingApproval(request.requestId)
    }
  }

  function respondApproval(
    requestId: string,
    approved: boolean,
    remember: boolean,
    reason?: string,
  ): Promise<ToolApprovalAckWire | undefined> | undefined {
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
    return submitDecision(requestId).catch(() => undefined)
  }

  function initApprovalListener() {
    if (!approvalCleanup) return
    approvalCleanup.value?.()
    const stopRequest = ws.onApprovalRequest?.(storePendingApproval)
    const stopTerminal = onToolApprovalTerminal(storeApprovalTerminal)
    const stopWire = ws.onApprovalWire?.(storeApprovalReconciliationWire)
    const stopReconnect = ws.onReconnect?.(reconcilePendingApprovals)
    approvalCleanup.value = () => {
      stopRequest?.()
      stopTerminal()
      stopWire?.()
      stopReconnect?.()
    }
  }

  return {
    initApprovalListener,
    storePendingApproval,
    storeApprovalTerminal,
    storeApprovalReconciliationAck,
    reconcilePendingApprovals,
    getPendingApprovalForSession,
    hasSessionPendingApproval,
    respondApproval,
    clearPendingApproval,
    clearPendingApprovalsForSession,
  }
}
