import { describe, expect, it, vi } from 'vitest'
import {
  commitPrintReceiptWithConvergence,
  recordDialogOpenWithConvergence,
} from '../print-receipt'

const receipt = {
  native_job_id: 'native-1',
  native_receipt_id: 'receipt-1',
  printer_snapshot: { adapter: 'appkit', printer: 'Office', paper: 'A4' },
}

function state(
  status: string,
  nativeJobID = '',
  nativeReceiptID = '',
  printerSnapshot: Record<string, unknown> | undefined =
    status === 'printed' ? receipt.printer_snapshot : undefined,
) {
  return {
    print_job: {
      status,
      native_job_id: nativeJobID || undefined,
      native_receipt_id: nativeReceiptID || undefined,
      printer_snapshot: printerSnapshot,
    },
  }
}

describe('atomic native print receipt convergence', () => {
  it('accepts a normal atomic commit without a submitted intermediate write', async () => {
    const commit = vi.fn().mockResolvedValue(state('printed', 'native-1', 'receipt-1'))
    const query = vi.fn()

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).resolves.toEqual(
      state('printed', 'native-1', 'receipt-1'),
    )
    expect(commit).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })

  it('treats a lost response as success only when query proves the exact receipt was committed', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockResolvedValue(state('printed', 'native-1', 'receipt-1'))

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).resolves.toEqual(
      state('printed', 'native-1', 'receipt-1'),
    )
    expect(commit).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('replays the same idempotent receipt when query proves the first commit did not land', async () => {
    const committed = state('printed', 'native-1', 'receipt-1')
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error('request interrupted'))
      .mockResolvedValueOnce(committed)
    const query = vi.fn().mockResolvedValueOnce(state('dialog_open'))

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).resolves.toEqual(committed)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit.mock.calls[0]).toEqual(commit.mock.calls[1])
  })

  it('rejects a conflicting receipt instead of accepting or replaying it', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockResolvedValue(state('printed', 'native-other', 'receipt-other'))

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).rejects.toThrow('冲突')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('accepts the same printer snapshot when object keys arrive in a different order', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockResolvedValue(state(
      'printed',
      'native-1',
      'receipt-1',
      { paper: 'A4', printer: 'Office', adapter: 'appkit' },
    ))

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).resolves.toEqual(
      state('printed', 'native-1', 'receipt-1', {
        paper: 'A4',
        printer: 'Office',
        adapter: 'appkit',
      }),
    )
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('rejects matching receipt IDs when the persisted printer snapshot differs', async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockResolvedValue(state(
      'printed',
      'native-1',
      'receipt-1',
      { adapter: 'appkit', printer: 'Office', paper: 'Letter' },
    ))

    await expect(commitPrintReceiptWithConvergence(receipt, commit, query)).rejects.toThrow('冲突')
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('dialog_open event convergence before native side effects', () => {
  it('continues after a lost response only when GET proves dialog_open landed', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockResolvedValueOnce(state('dialog_open'))

    await expect(recordDialogOpenWithConvergence(record, query)).resolves.toEqual(
      state('dialog_open'),
    )
    expect(record).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('replays the idempotent event only after GET proves the job is still preparing', async () => {
    const record = vi.fn()
      .mockRejectedValueOnce(new Error('request interrupted'))
      .mockResolvedValueOnce(state('dialog_open'))
    const query = vi.fn().mockResolvedValueOnce(state('preparing'))

    await expect(recordDialogOpenWithConvergence(record, query)).resolves.toEqual(
      state('dialog_open'),
    )
    expect(record).toHaveBeenCalledTimes(2)
  })

  it.each(['submitted', 'printed', 'cancelled', 'failed', 'outcome_unknown'])(
    'fails closed when GET observes conflicting %s state',
    async (status) => {
      const record = vi.fn().mockRejectedValueOnce(new Error('response lost'))
      const query = vi.fn().mockResolvedValueOnce(state(status))
      await expect(recordDialogOpenWithConvergence(record, query)).rejects.toThrow()
      expect(record).toHaveBeenCalledTimes(1)
    },
  )

  it('fails closed when GET cannot establish whether dialog_open landed', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    const query = vi.fn().mockRejectedValueOnce(new Error('query unavailable'))
    await expect(recordDialogOpenWithConvergence(record, query)).rejects.toThrow('query unavailable')
    expect(record).toHaveBeenCalledTimes(1)
  })
})
