import type { Artifact } from '@/types'
import type { UnitSummaryResponse } from '@/api/k12'
export type { UnitSummaryContentV1, UnitSummaryReference, UnitSummaryResponse } from '@/api/k12'

export const UNIT_SUBJECT_LABELS: Record<string, string> = {
  math: '数学',
  chinese: '语文',
  english: '英语',
  science: '科学',
  information_technology: '信息科技',
  art: '美术',
}

/** 已发布版本才能进入产物列表；保存状态与冻结 PDF 引用必须同时存在。 */
export function materialArtifact(view: UnitSummaryResponse, messageId = ''): Artifact | null {
  const material = view.material
  const documentId = view.document?.document_id || view.document?.id || material?.document_id
  if (!view.delivery?.complete || !material?.artifact?.artifact_id || !documentId) return null
  return {
    id: `unit-summary:${documentId}:${material.revision_id}`,
    type: 'learning-material',
    title: material.title || material.content.title,
    content: '',
    messageId,
    createdAt: new Date(material.generated_at * 1000).toISOString(),
    reference: {
      documentId,
      revisionId: material.revision_id,
      artifactId: material.artifact.artifact_id,
      contentDigest: material.content_digest,
      byteDigest: material.artifact.byte_digest,
      filename: material.filename,
      version: material.version,
      subject: material.subject,
      generatedDate: material.generated_date,
      gradeTerm: material.grade_term,
      edition: material.textbook_edition,
      unitNumber: material.unit_number,
      unitTitle: material.unit_title,
    },
  }
}
