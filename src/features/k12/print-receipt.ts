import type { NativePrintCommitReq, PracticePrintJobStatus } from '@/api/k12'

interface PrintReceiptState {
  print_job: {
    status: PracticePrintJobStatus | string
    native_job_id?: string
    native_receipt_id?: string
    printer_snapshot?: Record<string, unknown>
  }
}

function isDialogOpen<T extends PrintReceiptState>(state: T): boolean {
  return state.print_job.status === 'dialog_open'
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    )
  }
  return value
}

function canonicalJson(value: unknown): string | undefined {
  try {
    // Round-trip first so comparison follows the JSON wire contract: object
    // key order is irrelevant while array order and scalar types remain exact.
    const wireValue = JSON.stringify(value)
    if (wireValue === undefined) return undefined
    return JSON.stringify(sortJsonValue(JSON.parse(wireValue)))
  } catch {
    return undefined
  }
}

function printerSnapshotsMatch(
  persisted: Record<string, unknown> | undefined,
  received: Record<string, unknown>,
): boolean {
  const persistedCanonical = canonicalJson(persisted)
  const receivedCanonical = canonicalJson(received)
  return persistedCanonical !== undefined && persistedCanonical === receivedCanonical
}

/**
 * Persist the pre-side-effect dialog_open boundary. A lost response is queried
 * before any replay, so native printing is never started from an unproven job
 * state and a landed event never strands the next attempt.
 */
export async function recordDialogOpenWithConvergence<T extends PrintReceiptState>(
  record: () => Promise<T>,
  query: () => Promise<T>,
): Promise<T> {
  try {
    const advanced = await record()
    if (!isDialogOpen(advanced)) throw new Error('PrintJob 未进入 dialog_open')
    return advanced
  } catch {
    // A response may have been lost after the server committed the event. Query
    // is mandatory before replay; if query itself fails, fail closed.
    const observed = await query()
    if (isDialogOpen(observed)) return observed
    if (observed.print_job.status !== 'preparing') {
      throw new Error(`PrintJob 状态冲突: ${observed.print_job.status}`)
    }
    try {
      const replayed = await record()
      if (!isDialogOpen(replayed)) throw new Error('PrintJob 未进入 dialog_open')
      return replayed
    } catch (replayError) {
      const reconciled = await query()
      if (isDialogOpen(reconciled)) return reconciled
      throw replayError
    }
  }
}

function receiptMatches(
  state: PrintReceiptState,
  receipt: NativePrintCommitReq,
): boolean {
  return (
    state.print_job.status === 'printed' &&
    state.print_job.native_job_id === receipt.native_job_id &&
    state.print_job.native_receipt_id === receipt.native_receipt_id &&
    printerSnapshotsMatch(state.print_job.printer_snapshot, receipt.printer_snapshot)
  )
}

function assertNoConflictingReceipt(
  state: PrintReceiptState,
  receipt: NativePrintCommitReq,
) {
  if (state.print_job.status === 'printed' && !receiptMatches(state, receipt)) {
    throw new Error('原生打印回执冲突，不能确认打印成功')
  }
}

/**
 * Commit the complete native receipt through one idempotent backend command.
 * If an HTTP response is lost, query first; replay only the exact same receipt
 * when the server proves the first command did not land.
 */
export async function commitPrintReceiptWithConvergence<T extends PrintReceiptState>(
  receipt: NativePrintCommitReq,
  commit: () => Promise<T>,
  query: () => Promise<T>,
): Promise<T> {
  try {
    const committed = await commit()
    assertNoConflictingReceipt(committed, receipt)
    if (!receiptMatches(committed, receipt)) {
      throw new Error('原生打印回执未完成持久化')
    }
    return committed
  } catch (firstError) {
    try {
      const observed = await query()
      assertNoConflictingReceipt(observed, receipt)
      if (receiptMatches(observed, receipt)) return observed
    } catch (queryError) {
      if (queryError instanceof Error && queryError.message.includes('回执冲突')) {
        throw queryError
      }
    }

    try {
      const replayed = await commit()
      assertNoConflictingReceipt(replayed, receipt)
      if (!receiptMatches(replayed, receipt)) {
        throw new Error('原生打印回执未完成持久化')
      }
      return replayed
    } catch (replayError) {
      try {
        const observed = await query()
        assertNoConflictingReceipt(observed, receipt)
        if (receiptMatches(observed, receipt)) return observed
      } catch (queryError) {
        if (queryError instanceof Error && queryError.message.includes('回执冲突')) {
          throw queryError
        }
      }
      throw replayError ?? firstError
    }
  }
}
