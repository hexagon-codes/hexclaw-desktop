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

function progressiveSnapshot() {
  return {
    dispatch: {
      dispatch_id: 'dispatch-progressive',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-progressive' },
      target_projection: {
        kind: 'homework',
        stage: 'assessing',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        structure_version: 4,
        recognition: { subject: '数学', questions: [] },
        problems: [
          {
            problem_id: 'problem-1',
            source_number_path: ['一', '1'],
            display_label: '一. 1',
            source_state: 'ready',
            anchor_state: 'located',
            operation_state: 'published',
            disposition_state: 'result',
            result_projection: null,
            published_revision: 9,
          },
          {
            problem_id: 'problem-2',
            source_number_path: ['一', '2'],
            display_label: '一. 2',
            source_state: 'ready',
            anchor_state: 'located',
            operation_state: 'assessing',
            disposition_state: 'pending',
            result_projection: null,
            published_revision: 0,
          },
        ],
        coverage: {
          state: 'incomplete',
          total: 2,
          processed: 1,
          skipped: 0,
        },
        projection_revision: 9,
        final_artifact: null,
      },
      progress: { operation: 'homework', state: 'assessing' },
      version: 7,
      created_at: 1,
      updated_at: 2,
    },
  }
}

describe('BUG-20260726-031 · ImageTask progressive snapshot public contract', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
  })

  it('BUG-20260726-031 accepts and preserves the approved problem-level projection fields', async () => {
    const snapshot = progressiveSnapshot()
    client.apiGet.mockResolvedValue(snapshot)

    const response = await k12GetImageTask('mingming', 'dispatch-progressive')
    const projection = response.dispatch.target_projection

    expect(projection).toMatchObject({
      structure_version: 4,
      problems: [
        {
          problem_id: 'problem-1',
          source_number_path: ['一', '1'],
          display_label: '一. 1',
          source_state: 'ready',
          anchor_state: 'located',
          operation_state: 'published',
          disposition_state: 'result',
          result_projection: null,
          published_revision: 9,
        },
        {
          problem_id: 'problem-2',
          source_number_path: ['一', '2'],
          display_label: '一. 2',
          source_state: 'ready',
          anchor_state: 'located',
          operation_state: 'assessing',
          disposition_state: 'pending',
          result_projection: null,
          published_revision: 0,
        },
      ],
      coverage: {
        state: 'incomplete',
        total: 2,
        processed: 1,
        skipped: 0,
      },
      projection_revision: 9,
      final_artifact: null,
    })
  })
})
