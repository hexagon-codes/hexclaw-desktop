import type { Ref } from 'vue'

export interface SessionExecutionSnapshot {
  executionId: string
  state: string
  automaticBudgetSeconds?: number
  automaticStartedAt?: number
  automaticDeadlineAt?: number
  operationDeadlineAt?: number
}

export type SessionExecutionState = Record<
  string,
  Record<string, SessionExecutionSnapshot>
>

const TERMINAL_STATES = new Set([
  'completed',
  'feedback_ready',
  'promoted',
  'failed',
  'failed_retryable',
  'failed_terminal',
  'feedback_failed',
  'cancelled',
])

export function isTerminalSessionExecutionState(state: string): boolean {
  return TERMINAL_STATES.has(state.trim().toLowerCase())
}

export function createSessionExecutionRegistry(executions: Ref<SessionExecutionState>) {
  function clearSessionExecution(sessionId: string, executionId: string): void {
    const normalizedSessionId = sessionId.trim()
    const normalizedExecutionId = executionId.trim()
    const currentSessionExecutions = executions.value[normalizedSessionId]
    if (!currentSessionExecutions?.[normalizedExecutionId]) return

    const nextSessionExecutions = { ...currentSessionExecutions }
    delete nextSessionExecutions[normalizedExecutionId]
    const next = { ...executions.value }
    if (Object.keys(nextSessionExecutions).length > 0) {
      next[normalizedSessionId] = nextSessionExecutions
    } else {
      delete next[normalizedSessionId]
    }
    executions.value = next
  }

  function setSessionExecution(
    sessionId: string,
    snapshot: SessionExecutionSnapshot,
  ): void {
    const normalizedSessionId = sessionId.trim()
    const normalizedExecutionId = snapshot.executionId.trim()
    if (!normalizedSessionId || !normalizedExecutionId) return
    if (isTerminalSessionExecutionState(snapshot.state)) {
      clearSessionExecution(normalizedSessionId, normalizedExecutionId)
      return
    }
    executions.value = {
      ...executions.value,
      [normalizedSessionId]: {
        ...executions.value[normalizedSessionId],
        [normalizedExecutionId]: {
          ...snapshot,
          executionId: normalizedExecutionId,
        },
      },
    }
  }

  function isSessionExecuting(sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return false
    return Object.values(executions.value[normalizedSessionId] ?? {}).some(
      (snapshot) => !isTerminalSessionExecutionState(snapshot.state),
    )
  }

  return {
    setSessionExecution,
    clearSessionExecution,
    isSessionExecuting,
  }
}
