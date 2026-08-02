import type {
  ImageTaskCoverageDTO,
  ImageTaskProblemProgressDTO,
  ImageTaskProblemSourceActionResp,
} from '@/api/k12'
import { normalizeImageTaskProblemSourceActionSnapshot } from '@/contracts/k12-image-task-semantics'

export interface ImageTaskProblemSourceActionViewSnapshot {
  structure_version: number
  snapshot_revision: number
  problem_progress: ImageTaskProblemProgressDTO[]
  coverage: ImageTaskCoverageDTO
}

/**
 * Adapts the validated compact receipt to the feature's existing renderer DTO.
 * The shared semantic mapper retains only stable display/anchor metadata from
 * the current view and fails closed on identity or coverage drift.
 */
export function projectImageTaskProblemSourceActionSnapshot(
  response: ImageTaskProblemSourceActionResp,
  currentProblems: readonly ImageTaskProblemProgressDTO[],
): ImageTaskProblemSourceActionViewSnapshot {
  return normalizeImageTaskProblemSourceActionSnapshot(
    response,
    currentProblems,
  ) as unknown as ImageTaskProblemSourceActionViewSnapshot
}
