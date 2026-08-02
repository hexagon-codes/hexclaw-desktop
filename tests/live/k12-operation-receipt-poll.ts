export type OperationReceiptPollDecision =
  | { kind: 'continue' }
  | { kind: 'succeeded' }
  | { kind: 'terminal_failure'; status: 'failed' | 'outcome_unknown' }

export function classifyOperationReceiptPoll(status: unknown): OperationReceiptPollDecision {
  if (status === 'succeeded') return { kind: 'succeeded' }
  if (status === 'failed' || status === 'outcome_unknown') {
    return { kind: 'terminal_failure', status }
  }
  return { kind: 'continue' }
}

export function classifyK12TaskTerminalPoll(input: {
  receiptStatus: unknown
  dispatchStatus: unknown
  projectionStage: unknown
}): OperationReceiptPollDecision {
  const dispatchTerminal = ['failed', 'cancelled'].includes(String(input.dispatchStatus))
  const projectionTerminal = [
    'recovering',
    'failed_retryable',
    'failed_terminal',
    'cancelled',
  ].includes(String(input.projectionStage))
  if (dispatchTerminal || projectionTerminal) {
    return { kind: 'terminal_failure', status: 'failed' }
  }
  return classifyOperationReceiptPoll(input.receiptStatus)
}
