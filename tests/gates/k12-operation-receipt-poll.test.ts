import { describe, expect, it } from 'vitest'

import { classifyOperationReceiptPoll } from '../live/k12-operation-receipt-poll'

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
