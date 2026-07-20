import {
  k12GetGenericPrintArtifact,
  k12PrepareGenericPrintJob,
  k12RecordGenericPrintEvent,
  k12RetryGenericPrintJob,
  type GenericPrintSourceKind,
} from '@/api/k12'
import { isTauri } from '@/utils/platform'
import { printPracticePaperWithReceipt } from './export'

export interface PersistentPrintRequest {
  agent: string
  idempotencyKey?: string
  sourceKind: GenericPrintSourceKind
  sourceRef: string
  title: string
  canonicalMarkdown: string
  /** Browser/prototype only. Formal Tauri builds never invoke this callback. */
  browserPrint: () => Promise<boolean>
}

let printSequence = 0
const operationKeys = new Map<string, string>()
const inFlightPrints = new Map<string, Promise<boolean>>()

function operationIdentity(req: PersistentPrintRequest): string {
  return `${req.agent}\u0000${req.sourceKind}\u0000${req.sourceRef}\u0000${req.title}\u0000${req.canonicalMarkdown}`
}

function operationKey(req: PersistentPrintRequest): string {
  if (req.idempotencyKey?.trim()) return req.idempotencyKey.trim()
  const identity = operationIdentity(req)
  const cached = operationKeys.get(identity)
  if (cached) return cached
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++printSequence}`
  const created = `desktop-print:${req.agent}:${req.sourceKind}:${nonce}`
  operationKeys.set(identity, created)
  return created
}

function clearOperationKey(req: PersistentPrintRequest) {
  if (!req.idempotencyKey) operationKeys.delete(operationIdentity(req))
}

/**
 * Executes the shared DD-023 state machine. The backend-frozen Artifact—not
 * mutable component state—is the only payload handed to the native adapter.
 */
async function executePersistentPrint(req: PersistentPrintRequest): Promise<boolean> {
  if (!isTauri()) return req.browserPrint()

  const prepared = await k12PrepareGenericPrintJob({
    agent: req.agent,
    idempotency_key: operationKey(req),
    source_kind: req.sourceKind,
    source_ref: req.sourceRef,
    title: req.title,
    canonical_markdown: req.canonicalMarkdown,
  })
  let job = prepared.print_job
  if (job.status === 'printed') {
    clearOperationKey(req)
    return true
  }
  if (job.status === 'cancelled' || job.status === 'failed') {
    job = (await k12RetryGenericPrintJob(req.agent, job.print_job_id)).print_job
  } else if (['dialog_open', 'submitted', 'outcome_unknown'].includes(job.status)) {
    throw new Error('发现未决打印任务，请先核对系统打印队列，不能盲目重复打印')
  }

  const artifact = await k12GetGenericPrintArtifact(req.agent, job.print_job_id)
  await k12RecordGenericPrintEvent(req.agent, job.print_job_id, { status: 'dialog_open' })

  let receipt
  try {
    receipt = await printPracticePaperWithReceipt(artifact.markdown, artifact.title)
  } catch (error) {
    await k12RecordGenericPrintEvent(req.agent, job.print_job_id, {
      status: 'outcome_unknown',
      failure_kind: 'native_receipt_unavailable',
      failure_detail: '原生打印结果未能确认',
    })
    throw error
  }
  if (receipt.status === 'cancelled') {
    await k12RecordGenericPrintEvent(req.agent, job.print_job_id, {
      status: 'cancelled',
      native_job_id: receipt.native_job_id,
    })
    return false
  }

  await k12RecordGenericPrintEvent(req.agent, job.print_job_id, {
    status: 'submitted',
    native_job_id: receipt.native_job_id,
  })
  await k12RecordGenericPrintEvent(req.agent, job.print_job_id, {
    status: 'printed',
    native_job_id: receipt.native_job_id,
    native_receipt_id: receipt.native_receipt_id,
    printer_snapshot: receipt.printer_snapshot,
  })
  clearOperationKey(req)
  return true
}

export function printPersistentArtifact(req: PersistentPrintRequest): Promise<boolean> {
  const identity = operationIdentity(req)
  const running = inFlightPrints.get(identity)
  if (running) return running
  const started = executePersistentPrint(req).finally(() => {
    if (inFlightPrints.get(identity) === started) inFlightPrints.delete(identity)
  })
  inFlightPrints.set(identity, started)
  return started
}
