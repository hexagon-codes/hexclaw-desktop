import type { BBox, GradeResp } from '../../src/api/k12'
import { gradeToVerify } from '../../src/features/k12/mappers'
import { isValidGradingBBox } from '../../src/features/k12/graded-photo'

type Json = Record<string, unknown>

export interface PhotoAnnotationCoverage {
  /** Number of final result items that the overlay is required to account for. */
  evaluated: number
  /** Whether the same artifact is safe for the production WebView to render. */
  immutableArtifact: boolean
  /**
   * Items with a trusted, in-scope coordinate.  With an immutable artifact
   * they are baked into that artifact; otherwise PhotoGradeOverlay renders
   * one DOM mark for each item.
   */
  artifactCoverage: number
  /** Items that must be represented by one DOM degraded row, never a mark. */
  degradedCoverage: number
}

const OVERLAY_ITEM_STATUSES = new Set(['correct', 'wrong', 'out_of_scope', 'untrusted'])
const SAFE_ANNOTATED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function asRecord(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Json
}

function renderableImmutableArtifact(value: unknown): boolean {
  if (value === undefined) return false
  const image = asRecord(value, 'annotated_image')
  const mime = typeof image.mime === 'string' ? image.mime.trim().toLowerCase() : ''
  const payload = typeof image.data_base64 === 'string' ? image.data_base64.replace(/\s/g, '') : ''
  if (
    !SAFE_ANNOTATED_IMAGE_MIMES.has(mime) ||
    !payload ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    throw new Error('annotated_image is not renderable by the production WebView')
  }
  return true
}

function gradeVerdict(value: unknown, label: string): GradeResp['verdict'] {
  switch (value) {
    case 'agree':
    case 'disagree':
    case 'unverifiable':
    case 'out_of_scope':
    case 'verbatim':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp verdict`)
  }
}

function gradeEvidenceType(value: unknown, label: string): GradeResp['evidence_type'] {
  switch (value) {
    case 'numeric_exec':
    case 'symbolic_exec':
    case 'heterogeneous_model':
    case 'heuristic':
    case 'verbatim':
    case 'none':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp evidence_type`)
  }
}

function gradeBadge(value: unknown, label: string): GradeResp['badge'] {
  switch (value) {
    case 'verified-strong':
    case 'verified-weak':
    case 'disagree':
    case 'out-of-scope':
    case 'unverifiable':
    case 'verbatim-recall':
      return value
    default:
      throw new Error(`${label} must be a valid GradeResp badge`)
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string when present`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean when present`)
  return value
}

function optionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array when present`)
  }
  return [...value]
}

function completeGrade(value: unknown, index: number): GradeResp {
  const label = `items[${index}].grade`
  const grade = asRecord(value, label)
  if (typeof grade.solution !== 'string' || typeof grade.out_of_scope !== 'boolean') {
    throw new Error(`${label} must be a complete GradeResp`)
  }
  if (typeof grade.record_created !== 'boolean') {
    throw new Error(`${label} must be a complete GradeResp`)
  }

  const wrongStep = optionalString(grade.wrong_step, `${label}.wrong_step`)
  const errorCause = optionalString(grade.error_cause, `${label}.error_cause`)
  const outOfScopeKnowledgePoint = optionalString(grade.out_of_scope_kp, `${label}.out_of_scope_kp`)
  const recordID = optionalString(grade.record_id, `${label}.record_id`)
  const curriculumUnmapped = optionalStringList(
    grade.curriculum_unmapped,
    `${label}.curriculum_unmapped`,
  )
  const solveOnly = optionalBoolean(grade.solve_only, `${label}.solve_only`)

  return {
    solution: grade.solution,
    verdict: gradeVerdict(grade.verdict, `${label}.verdict`),
    evidence_type: gradeEvidenceType(grade.evidence_type, `${label}.evidence_type`),
    badge: gradeBadge(grade.badge, `${label}.badge`),
    out_of_scope: grade.out_of_scope,
    record_created: grade.record_created,
    ...(wrongStep === undefined ? {} : { wrong_step: wrongStep }),
    ...(errorCause === undefined ? {} : { error_cause: errorCause }),
    ...(outOfScopeKnowledgePoint === undefined
      ? {}
      : { out_of_scope_kp: outOfScopeKnowledgePoint }),
    ...(recordID === undefined ? {} : { record_id: recordID }),
    ...(curriculumUnmapped === undefined ? {} : { curriculum_unmapped: curriculumUnmapped }),
    ...(solveOnly === undefined ? {} : { solve_only: solveOnly }),
  }
}

function overlayOutOfScope(value: unknown, index: number): boolean {
  return gradeToVerify(completeGrade(value, index)).verdict === 'out_of_scope'
}

/**
 * Mirrors the two production overlay branches without reading image pixels or
 * model text. The live caller separately verifies item identities and the
 * immutable artifact's wire digest before it uses this coverage summary.
 */
export function summarizePhotoAnnotationCoverage(value: unknown): PhotoAnnotationCoverage {
  const payload = asRecord(value, 'homework payload')
  if (!Array.isArray(payload.items)) throw new Error('homework payload.items must be an array')

  let artifactCoverage = 0
  let degradedCoverage = 0
  for (const [index, value] of payload.items.entries()) {
    const item = asRecord(value, `items[${index}]`)
    if (typeof item.status !== 'string' || !OVERLAY_ITEM_STATUSES.has(item.status)) {
      throw new Error(`items[${index}] does not map to a completed-photo overlay mark`)
    }
    if (item.grade === undefined) throw new Error(`items[${index}] has no grade for its overlay mark`)

    const outOfScope = overlayOutOfScope(item.grade, index)
    if ((item.status === 'out_of_scope') !== outOfScope) {
      throw new Error(`items[${index}] status and grade disagree about out_of_scope`)
    }
    const question = asRecord(item.question, `items[${index}].question`)
    const positioned = !outOfScope && isValidGradingBBox(question.bbox as BBox | null | undefined)
    if (positioned) artifactCoverage += 1
    else degradedCoverage += 1
  }

  return {
    evaluated: payload.items.length,
    immutableArtifact: renderableImmutableArtifact(payload.annotated_image),
    artifactCoverage,
    degradedCoverage,
  }
}
