import {
  k12GetPrintArtifactContent,
  k12PrepareGradingFinalArtifactOutput,
  k12SendGradingFinalArtifact,
  type PrintableArtifactDTO,
} from '@/api/k12'
import { savePdfArtifact } from './export'
import type { PersistentPrintRequest } from './persistent-print'

export type FinalArtifactAction = 'print' | 'export_pdf' | 'send_im'

export interface FinalArtifactActionIntent {
  action: FinalArtifactAction
  artifact_id: string
  artifact_digest: string
  artifact_title: string
}

interface FinalArtifactActionHost {
  agent: () => string
  openPrint: (request: PersistentPrintRequest) => Promise<void>
  browserPrint: () => Promise<boolean>
}

function finalArtifactSourceRef(intent: FinalArtifactActionIntent): string {
  return `final_artifact:${intent.artifact_id}:${intent.artifact_digest}`
}

function assertFinalArtifactIntent(intent: FinalArtifactActionIntent) {
  if (
    !intent.artifact_id.trim() ||
    !intent.artifact_digest.trim() ||
    !intent.artifact_title.trim()
  ) {
    throw new Error('批改最终产物身份不完整')
  }
}

/**
 * One host controller for all final-artifact actions. Print and export reuse
 * one server-frozen PrintableArtifact; IM sends the exact same final identity.
 */
export function createFinalArtifactActionHandler(host: FinalArtifactActionHost) {
  const prepared = new Map<string, Promise<PrintableArtifactDTO>>()
  const running = new Map<string, Promise<void>>()

  function prepare(intent: FinalArtifactActionIntent): Promise<PrintableArtifactDTO> {
    const agent = host.agent().trim()
    const sourceRef = finalArtifactSourceRef(intent)
    const key = `${agent}\u0000${sourceRef}\u0000${intent.artifact_title}`
    const existing = prepared.get(key)
    if (existing) return existing
    const request = k12PrepareGradingFinalArtifactOutput({
      agent,
      final_artifact_id: intent.artifact_id,
      final_artifact_digest: intent.artifact_digest,
      title: intent.artifact_title,
    })
      .then(({ artifact }) => {
        if (
          artifact.source_kind !== 'grading_final_artifact' ||
          artifact.source_ref !== sourceRef
        ) {
          throw new Error('批改最终产物身份校验失败')
        }
        return artifact
      })
      .catch((cause) => {
        prepared.delete(key)
        throw cause
      })
    prepared.set(key, request)
    return request
  }

  async function execute(intent: FinalArtifactActionIntent) {
    assertFinalArtifactIntent(intent)
    const agent = host.agent().trim()
    if (!agent) throw new Error('辅导助手实例不能为空')
    if (intent.action === 'send_im') {
      await k12SendGradingFinalArtifact(
        agent,
        intent.artifact_id,
        intent.artifact_digest,
      )
      return
    }
    const artifact = await prepare(intent)
    if (intent.action === 'export_pdf') {
      const pdf = await k12GetPrintArtifactContent(agent, artifact.artifact_id)
      await savePdfArtifact(pdf, artifact.title)
      return
    }
    await host.openPrint({
      agent,
      idempotencyKey: `grading-final:${intent.artifact_id}:${intent.artifact_digest}`,
      sourceKind: 'grading_final_artifact',
      sourceRef: artifact.source_ref,
      title: artifact.title,
      artifactId: artifact.artifact_id,
      browserPrint: host.browserPrint,
    })
  }

  function run(intent: FinalArtifactActionIntent): Promise<void> {
    const key = `${intent.action}\u0000${intent.artifact_id}\u0000${intent.artifact_digest}`
    const existing = running.get(key)
    if (existing) return existing
    const request = execute(intent).finally(() => {
      if (running.get(key) === request) running.delete(key)
    })
    running.set(key, request)
    return request
  }

  return { run }
}
