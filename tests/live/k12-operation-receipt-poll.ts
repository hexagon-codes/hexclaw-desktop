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
