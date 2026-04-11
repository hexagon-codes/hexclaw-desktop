import type { Ref } from 'vue'
import type { ToolApprovalRequest } from '@/api/websocket'
import type { PendingToolApproval } from './chat-stream-helpers'
import {
  clearPendingApproval as nextPendingApprovalsAfterClear,
  findPendingApprovalForSession,
  hasPendingApprovalForSession,
  storePendingApproval as nextPendingApprovals,
} from './chat-stream-helpers'

type WebSocketModule = typeof import('@/api/websocket').hexclawWS

export function createChatApprovalController(params: {
  pendingApprovals: Ref<Record<string, PendingToolApproval>>
  approvalCleanup: Ref<(() => void) | null>
  ws: WebSocketModule
}) {
  const { pendingApprovals, approvalCleanup, ws } = params

  function storePendingApproval(request: ToolApprovalRequest) {
    pendingApprovals.value = nextPendingApprovals(pendingApprovals.value, request)
  }

  function clearPendingApproval(requestId: string) {
    pendingApprovals.value = nextPendingApprovalsAfterClear(pendingApprovals.value, requestId)
  }

  function getPendingApprovalForSession(sessionId?: string | null): ToolApprovalRequest | null {
    return findPendingApprovalForSession(pendingApprovals.value, sessionId)
  }

  function hasSessionPendingApproval(sessionId: string) {
    return hasPendingApprovalForSession(pendingApprovals.value, sessionId)
  }

  function initApprovalListener() {
    if (approvalCleanup.value) return
    approvalCleanup.value = ws.onApprovalRequest((request) => {
      storePendingApproval(request)
    })
  }

  function respondApproval(requestId: string, approved: boolean, remember: boolean) {
    ws.sendApprovalResponse(requestId, approved, remember)
    clearPendingApproval(requestId)
  }

  return {
    initApprovalListener,
    respondApproval,
    storePendingApproval,
    clearPendingApproval,
    getPendingApprovalForSession,
    hasSessionPendingApproval,
  }
}

