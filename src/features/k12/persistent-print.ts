import {
  k12GetGenericPrintArtifact,
  k12GetGenericPrintJob,
  k12GetPrintArtifactContent,
  k12PrepareArtifactPrintJob,
  k12PrepareGenericPrintJob,
  k12RetryGenericPrintJob,
  type GenericPrintSourceKind,
} from '@/api/k12'
import { isTauri } from '@/utils/platform'
import { renderPracticePaperPdf, type NativePrintReceipt } from './export'

export interface PersistentPrintRequest {
  agent: string
  idempotencyKey?: string
  sourceKind: GenericPrintSourceKind
  sourceRef: string
  title: string
  canonicalMarkdown?: string
  artifactId?: string
  browserPrint: () => Promise<boolean>
}

export type PersistentPrintPreparation =
  | { status: 'completed'; printed: boolean }
  | { status: 'preview'; title: string; pdf: Blob; confirm: () => Promise<boolean> }

let printSequence = 0
const operationKeys = new Map<string, string>()
const inFlightPreparations = new Map<string, Promise<PersistentPrintPreparation>>()

function operationIdentity(req: PersistentPrintRequest): string {
  return `${req.agent}\u0000${req.sourceKind}\u0000${req.sourceRef}\u0000${req.title}\u0000${req.artifactId ?? req.canonicalMarkdown ?? ''}`
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

async function executeCoordinatedPrint(
  req: PersistentPrintRequest,
  printJobId: string,
): Promise<boolean> {
  const printed = await executeNativePrintJob({
    agent: req.agent,
    printJobId,
  })
  if (printed) clearOperationKey(req)
  return printed
}

export async function executeNativePrintJob(input: {
  agent: string
  printJobId: string
}): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<{ receipt: NativePrintReceipt }>('execute_print_job', {
    request: {
      agent: input.agent,
      printJobId: input.printJobId,
    },
  })
  if (result.receipt.status === 'printed') {
    return true
  }
  if (result.receipt.status === 'cancelled') return false
  throw new Error(
    result.receipt.failure_detail || result.receipt.failure_kind || '原生打印结果未能确认',
  )
}

async function prepare(req: PersistentPrintRequest): Promise<PersistentPrintPreparation> {
  const artifactId = req.artifactId?.trim()
  const canonicalMarkdown = req.canonicalMarkdown?.trim()
  if (Boolean(artifactId) === Boolean(canonicalMarkdown)) {
    throw new Error('打印请求必须且只能指定 artifactId 或 canonicalMarkdown')
  }
  if (!isTauri()) return { status: 'completed', printed: await req.browserPrint() }

  const prepared = artifactId
    ? await k12PrepareArtifactPrintJob({
        agent: req.agent,
        idempotency_key: operationKey(req),
        artifact_id: artifactId,
      })
    : await k12PrepareGenericPrintJob({
        agent: req.agent,
        idempotency_key: operationKey(req),
        source_kind: req.sourceKind,
        source_ref: req.sourceRef,
        title: req.title,
        canonical_markdown: canonicalMarkdown!,
      })
  let job = prepared.print_job
  if (job.status === 'printed') {
    clearOperationKey(req)
    return { status: 'completed', printed: true }
  }
  if (job.status === 'cancelled' || job.status === 'failed') {
    job = (await k12RetryGenericPrintJob(req.agent, job.print_job_id)).print_job
  } else if (['dialog_open', 'submitted', 'outcome_unknown'].includes(job.status)) {
    // Calling the coordinator with the same durable operation resumes commit
    // convergence and never opens another native dialog.
    await k12GetGenericPrintJob(req.agent, job.print_job_id)
  }

  const genericArtifact = artifactId
    ? null
    : await k12GetGenericPrintArtifact(req.agent, job.print_job_id)
  const pdf = artifactId
    ? await k12GetPrintArtifactContent(req.agent, artifactId)
    : await renderPracticePaperPdf(genericArtifact!.markdown, genericArtifact!.title)
  let confirmation: Promise<boolean> | null = null
  const confirm = () => {
    confirmation ??= executeCoordinatedPrint(req, job.print_job_id).catch((error) => {
      confirmation = null
      throw error
    })
    return confirmation
  }
  return { status: 'preview', title: genericArtifact?.title ?? req.title, pdf, confirm }
}

export function preparePersistentPrint(
  req: PersistentPrintRequest,
): Promise<PersistentPrintPreparation> {
  const identity = operationIdentity(req)
  const running = inFlightPreparations.get(identity)
  if (running) return running
  const started = prepare(req).finally(() => {
    if (inFlightPreparations.get(identity) === started) inFlightPreparations.delete(identity)
  })
  inFlightPreparations.set(identity, started)
  return started
}
