import type { K12SourceRegion } from '@/contracts/k12-source-region'

export type SourceIssueAction =
  | 'correct_recognition'
  | 'reselect_region'
  | 'retake'
  | 'skip'
  | 'resume'

export type SourceRegion = K12SourceRegion

interface SourceIssueIntentBase {
  problem_ids: string[]
  dependency_group_id?: string
  structure_version: number
  expected_input_revision: number
}

export type SourceIssueIntent =
  | (SourceIssueIntentBase & {
      action: 'correct_recognition'
      payload: { corrected_text: string }
    })
  | (SourceIssueIntentBase & {
      action: 'reselect_region'
      payload: { page_asset_id: string; region: SourceRegion }
    })
  | (SourceIssueIntentBase & {
      action: 'retake'
      payload: { page_asset_id: string }
    })
  | (SourceIssueIntentBase & {
      action: 'skip' | 'resume'
    })

export type SourceIssueRetakeFileIntent = SourceIssueIntentBase & {
  action: 'retake'
  file: File
}

const LOCKED_OPERATION_STATES = new Set([
  'sent',
  'processing',
  'assessing',
  'outcome_unknown',
])

export function sourceIssueOperationLocked(operationState: string): boolean {
  return LOCKED_OPERATION_STATES.has(operationState)
}
