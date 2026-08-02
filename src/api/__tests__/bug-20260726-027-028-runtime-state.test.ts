import { beforeEach, describe, expect, it, vi } from 'vitest'
import { k12GetImageTask } from '../k12'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

describe('BUG-20260726-027/028 · persisted ImageTask execution facts', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
  })

  it('strictly decodes and preserves the V47 automatic window and active operation deadline', async () => {
    client.apiGet.mockResolvedValue({
      dispatch: {
        dispatch_id: 'dispatch-running',
        task_intent: 'completed_homework',
        status: 'routed',
        intent_evidence: ['answer_regions_present'],
        intent_confidence: 0.99,
        confirmation_candidates: [],
        target: { type: 'homework_submission', id: 'submission-running' },
        target_projection: {
          kind: 'homework',
          stage: 'locating',
          confirmation_state: 'confirmed',
          anchor_state: 'pending',
          progressive: {
            structure_version: 1,
            snapshot_revision: 0,
            problem_progress: [],
            coverage: {
              total: 0,
              published: 0,
              skipped: 0,
              awaiting: 0,
              failed: 0,
              status: 'incomplete',
              projection_revision: 0,
            },
          },
        },
        progress: { operation: 'homework', state: 'locating' },
        version: 7,
        created_at: 999_958,
        updated_at: 1_000_000,
        automatic_budget_seconds: 300,
        automatic_started_at: 999_958,
        automatic_deadline_at: 1_000_258,
        automatic_remaining_seconds: 258,
        operation_deadline_at: 1_000_018,
      },
    })

    const response = await k12GetImageTask('mingming', 'dispatch-running')

    expect(response.dispatch).toMatchObject({
      automatic_budget_seconds: 300,
      automatic_started_at: 999_958,
      automatic_deadline_at: 1_000_258,
      automatic_remaining_seconds: 258,
      operation_deadline_at: 1_000_018,
    })
  })
})
