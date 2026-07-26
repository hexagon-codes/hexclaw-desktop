export type SourceIssueAction =
  | 'correct_recognition'
  | 'reselect_region'
  | 'retake'
  | 'skip'
  | 'resume'

export interface SourceIssueIntent {
  action: SourceIssueAction
  problem_ids: string[]
  dependency_group_id?: string
  structure_version: number
  expected_input_revision: number
  payload?: {
    corrected_text?: string
  }
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
