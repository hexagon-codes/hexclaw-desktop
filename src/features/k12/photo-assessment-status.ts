import type { PhotoJobItemStatus } from '@/api/k12'

export type PhotoAssessmentTone =
  | 'correct'
  | 'process'
  | 'wrong'
  | 'unanswered'
  | 'unclear'
  | 'scope'
  | 'review'
  | 'neutral'

export interface PhotoAssessmentStatusProjection {
  symbol: '✓' | '⚠' | '✗' | '○' | '?' | '—'
  tone: PhotoAssessmentTone
  summaryBucket: 'correct' | 'process' | 'attention'
  defaultExpanded: boolean
  overlayVisible: boolean
}

export const PHOTO_PROCESS_ISSUE_COLOR = '#A56BD6'

const STATUS_PROJECTIONS: Record<PhotoJobItemStatus, PhotoAssessmentStatusProjection> = {
  correct: {
    symbol: '✓',
    tone: 'correct',
    summaryBucket: 'correct',
    defaultExpanded: false,
    overlayVisible: true,
  },
  correct_with_process_issue: {
    symbol: '⚠',
    tone: 'process',
    summaryBucket: 'process',
    defaultExpanded: true,
    overlayVisible: true,
  },
  wrong: {
    symbol: '✗',
    tone: 'wrong',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: true,
  },
  unanswered: {
    symbol: '○',
    tone: 'unanswered',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: true,
  },
  answer_unclear: {
    symbol: '?',
    tone: 'unclear',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: true,
  },
  blank_solved: {
    symbol: '—',
    tone: 'neutral',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: false,
  },
  out_of_scope: {
    symbol: '—',
    tone: 'scope',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: false,
  },
  untrusted: {
    symbol: '?',
    tone: 'review',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: true,
  },
  failed: {
    symbol: '?',
    tone: 'review',
    summaryBucket: 'attention',
    defaultExpanded: true,
    overlayVisible: false,
  },
}

export function isPhotoAssessmentStatus(value: unknown): value is PhotoJobItemStatus {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_PROJECTIONS, value)
  )
}

/**
 * 图片批改状态的唯一 UI 投影。调用方只能传 item.status，禁止传 verdict/badge/布尔值。
 */
export function projectPhotoAssessmentStatus(
  status: PhotoJobItemStatus,
): PhotoAssessmentStatusProjection {
  return STATUS_PROJECTIONS[status]
}
