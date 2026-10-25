import {
  k12GetPrintArtifactContent,
  k12PrepareGradingFinalArtifactOutput,
  k12SendGradingFinalArtifact,
  type PrintableArtifactDTO,
  type GradingFinalArtifactDTO,
} from '@/api/k12'
import { savePdfArtifact } from './export'
import type { PersistentPrintRequest } from './persistent-print'

/** 只组合冻结标题和冻结日期；不使用界面状态标题或当前时间。 */
export function finalArtifactPdfTitle(artifact: GradingFinalArtifactDTO): string {
  const metadata = artifact.teaching_report?.metadata
  if (metadata) return `${metadata.title} · ${metadata.report_date}`
  let heading = artifact.canonical_markdown.trim().split('\n', 1)[0] || ''
  if (heading.startsWith('# ')) heading = heading.slice(2).trim()
  const date = new Date((artifact.created_at + 8 * 60 * 60) * 1000).toISOString().slice(0, 10)
  return `${heading || '家长辅导指南'} · ${date}`
}

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

// 图片产物在终稿身份后附加图片摘要和渲染版本，仍须逐项验证身份与后缀合同。
export function matchesFinalArtifactSourceRef(
  sourceRef: string,
  intent: FinalArtifactActionIntent,
): boolean {
  const base = finalArtifactSourceRef(intent)
  if (sourceRef === base) return true
  if (!sourceRef.startsWith(`${base}:`)) return false
  const suffix = sourceRef.slice(base.length + 1).split(':')
  // 教学报告以冻结模板包摘要标识渲染源，终稿身份仍由上方完整前缀核对。
  if (suffix.length === 2 && suffix[0] === 'teaching-report') {
    return /^[a-f0-9]{64}$/.test(suffix[1] ?? '')
  }
  if (suffix.length !== 2 && suffix.length !== 3) return false
  if (!/^[a-f0-9]{64}$/.test(suffix[0] ?? '')) return false
  if (suffix.length === 3 && !/^(grading-pdf|blank-worksheet-pdf)-v[1-9]\d*$/.test(suffix[1] ?? '')) {
    return false
  }
  return /^k12-image-pdf-v[1-9]\d*$/.test(suffix[suffix.length - 1] ?? '')
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

/** 预览、打印及保存使用同一终稿身份和服务端冻结输出。 */
export async function prepareFinalArtifactOutput(
  agent: string,
  intent: FinalArtifactActionIntent,
  signal?: AbortSignal,
): Promise<PrintableArtifactDTO> {
  assertFinalArtifactIntent(intent)
  const { artifact } = await k12PrepareGradingFinalArtifactOutput({
    agent,
    final_artifact_id: intent.artifact_id,
    final_artifact_digest: intent.artifact_digest,
    title: intent.artifact_title,
  }, signal)
  if (artifact.source_kind !== 'grading_final_artifact'
    || !matchesFinalArtifactSourceRef(artifact.source_ref, intent)) {
    throw new Error('Final report identity does not match the frozen source')
  }
  return artifact
}

/** 打印和导出复用同一冻结PDF，IM沿原终稿身份投递。 */
export function createFinalArtifactActionHandler(host: FinalArtifactActionHost) {
  const prepared = new Map<string, Promise<PrintableArtifactDTO>>()
  const running = new Map<string, Promise<void>>()

  function prepare(intent: FinalArtifactActionIntent): Promise<PrintableArtifactDTO> {
    const agent = host.agent().trim()
    const sourceRef = finalArtifactSourceRef(intent)
    const key = `${agent}\u0000${sourceRef}\u0000${intent.artifact_title}`
    const existing = prepared.get(key)
    if (existing) return existing
    const request = prepareFinalArtifactOutput(agent, intent)
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
      idempotencyKey: `grading-final:${artifact.artifact_id}`,
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
