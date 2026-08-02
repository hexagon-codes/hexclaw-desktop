import { describe, expect, it } from 'vitest'

import {
  classifyK12TaskTerminalPoll,
  classifyOperationReceiptPoll,
} from '../live/k12-operation-receipt-poll'

describe('K12-LIVE-BUDGET-006 operation receipt polling', () => {
  it.each([undefined, 'pending', 'running'])(
    'continues polling while the receipt status is %s',
    (status) => {
      expect(classifyOperationReceiptPoll(status)).toEqual({ kind: 'continue' })
    },
  )

  it('returns immediately when the receipt succeeds', () => {
    expect(classifyOperationReceiptPoll('succeeded')).toEqual({ kind: 'succeeded' })
  })

  it.each(['failed', 'outcome_unknown'] as const)(
    'stops in the current poll cycle when the receipt is terminal %s',
    (status) => {
      expect(classifyOperationReceiptPoll(status)).toEqual({
        kind: 'terminal_failure',
        status,
      })
    },
  )
})

describe('BUG-TEST-INFRA-K12-C02-20260802 post-confirm task terminal polling', () => {
  it.each([
    ['failed', 'assessing'],
    ['cancelled', 'assessing'],
    ['routed', 'recovering'],
    ['routed', 'failed_retryable'],
    ['routed', 'failed_terminal'],
  ] as const)(
    'fails in the current poll cycle for dispatch=%s projection=%s',
    (dispatchStatus, projectionStage) => {
      expect(
        classifyK12TaskTerminalPoll({
          receiptStatus: undefined,
          dispatchStatus,
          projectionStage,
        }),
      ).toEqual({ kind: 'terminal_failure', status: 'failed' })
    },
  )

  it('preserves a receipt-level outcome_unknown terminal classification', () => {
    expect(
      classifyK12TaskTerminalPoll({
        receiptStatus: 'outcome_unknown',
        dispatchStatus: 'routed',
        projectionStage: 'assessing',
      }),
    ).toEqual({ kind: 'terminal_failure', status: 'outcome_unknown' })
  })

  it('continues only while both receipt and public task projection remain non-terminal', () => {
    expect(
      classifyK12TaskTerminalPoll({
        receiptStatus: 'running',
        dispatchStatus: 'routed',
        projectionStage: 'assessing',
      }),
    ).toEqual({ kind: 'continue' })
  })
})
