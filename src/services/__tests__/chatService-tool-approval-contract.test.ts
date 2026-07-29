import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openWebSocketStream,
} from '../chatService'
import { hexclawWS } from '@/api/websocket'

type CanonicalToolApprovalDecision = {
  request_id: string
  decision_id: string
  invocation_id?: string
  arguments_digest?: string
  security_scope_digest?: string
  decision: 'approved_once' | 'approved_remember' | 'denied'
  idempotency_key: string
  reason?: string
}

class ContractWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: ContractWebSocket[] = []

  readyState = ContractWebSocket.CONNECTING
  sent: Record<string, unknown>[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(_url: string) {
    ContractWebSocket.instances.push(this)
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close() {
    this.readyState = ContractWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  open() {
    this.readyState = ContractWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
}

afterEach(() => {
  ContractWebSocket.instances = []
  vi.unstubAllGlobals()
})

describe('backend/Desktop tool approval wire contract', () => {
  it('preserves request identity and resolves the owning-socket decision from the correlated ACK', async () => {
    vi.stubGlobal('WebSocket', ContractWebSocket)
    let approvalRequest: Record<string, unknown> | undefined
    const handle = openWebSocketStream(
      'edit the file',
      'session-contract-1',
      {},
      '',
      undefined,
      {
        onApprovalRequest(request) {
          approvalRequest = request as unknown as Record<string, unknown>
        },
      },
      undefined,
      'chat-contract-1',
    )
    const socket = ContractWebSocket.instances[0]
    if (!socket) throw new Error('request WebSocket was not created')
    socket.open()
    socket.receive({
      type: 'tool_approval_request',
      request_id: 'approval-contract-1',
      session_id: 'session-contract-1',
      owner_id: 'desktop-user',
      invocation_id: 'invocation-contract-1',
      tool_name: 'file_edit',
      arguments: { path: '/workspace/report.md' },
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      deadline_at: '2026-07-29T05:00:00.000Z',
      content: 'edit one approved file scope',
      metadata: {
        request_id: 'approval-contract-1',
        tool_name: 'file_edit',
        risk: 'sensitive',
      },
    })

    expect(approvalRequest).toMatchObject({
      requestId: 'approval-contract-1',
      sessionId: 'session-contract-1',
      ownerId: 'desktop-user',
      invocationId: 'invocation-contract-1',
      toolName: 'file_edit',
      arguments: { path: '/workspace/report.md' },
      argumentsDigest: 'a'.repeat(64),
      securityScopeDigest: 'b'.repeat(64),
      deadlineAt: '2026-07-29T05:00:00.000Z',
    })

    const respond = approvalRequest?.respondApproval as
      | ((decision: CanonicalToolApprovalDecision) => Promise<unknown>)
      | undefined
    expect(respond).toEqual(expect.any(Function))
    const decision = {
      request_id: 'approval-contract-1',
      decision_id: 'decision-contract-1',
      invocation_id: 'invocation-contract-1',
      arguments_digest: 'a'.repeat(64),
      security_scope_digest: 'b'.repeat(64),
      decision: 'approved_remember' as const,
      idempotency_key: 'idempotency-contract-1',
    }
    const acknowledgement = respond!(decision)
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({
      type: 'tool_approval_response',
      content: 'approved_remember',
      request_id: 'approval-contract-1',
      decision_id: 'decision-contract-1',
      metadata: {
        request_id: 'approval-contract-1',
        decision_id: 'decision-contract-1',
        invocation_id: 'invocation-contract-1',
        decision: 'approved_remember',
        idempotency_key: 'idempotency-contract-1',
        arguments_digest: 'a'.repeat(64),
        security_scope_digest: 'b'.repeat(64),
      },
    })

    socket.receive({
      type: 'tool_approval_ack',
      request_id: 'approval-contract-1',
      decision_id: 'decision-contract-1',
      status: 'accepted',
    })
    await expect(acknowledgement).resolves.toMatchObject({
      request_id: 'approval-contract-1',
      decision_id: 'decision-contract-1',
      status: 'accepted',
    })

    handle.cancel()
    await expect(handle.done).resolves.toBeNull()
  })

  it('does not expose the legacy global approval sender', () => {
    expect('sendApprovalResponse' in hexclawWS).toBe(false)
  })
})
