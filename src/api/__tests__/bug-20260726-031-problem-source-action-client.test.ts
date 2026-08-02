import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k12Api from '../k12'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

type SubmitProblemSourceAction = (
  dispatchId: string,
  problemId: string,
  request: {
    action: 'correct_text' | 'select_region' | 'retake' | 'skip' | 'resume'
    structure_version: number
    expected_input_revision: number
    payload: Record<string, unknown>
  },
  idempotencyKey: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>

function submitProblemSourceAction(): SubmitProblemSourceAction {
  const candidate = (k12Api as unknown as Record<string, unknown>)
    .k12SubmitImageTaskProblemSourceAction
  expect(
    candidate,
    'the progressive client must expose the one canonical source-action command',
  ).toBeTypeOf('function')
  return candidate as SubmitProblemSourceAction
}

function postCommitResponse() {
  return {
    command_receipt_id: 'source-action-receipt-1',
    dispatch_id: 'dispatch / 1',
    problem_id: 'problem/一.1',
    action: 'correct_text',
    structure_version: 4,
    input_revision: 3,
    progressive_snapshot: {
      structure_version: 4,
      snapshot_revision: 11,
      problem_progress: [
        {
          problem_id: 'problem/一.1',
          status: 'awaiting_source',
          input_revision: 3,
          published_revision: 0,
          current_disposition: 'current',
        },
      ],
      coverage: {
        total: 1,
        published: 0,
        skipped: 0,
        awaiting: 1,
        failed: 0,
        status: 'in_progress',
        projection_revision: 11,
      },
    },
  }
}

describe('BUG-20260726-031 · problem source-action Desktop client contract', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
  })

  it('PROG-026 posts the strict action union to the encoded problem route and keeps identity out of business JSON', async () => {
    const response = postCommitResponse()
    client.apiPost.mockResolvedValue(response)
    const signal = new AbortController().signal
    const submit = submitProblemSourceAction()

    const result = await submit(
      'dispatch / 1',
      'problem/一.1',
      {
        action: 'correct_text',
        structure_version: 4,
        expected_input_revision: 2,
        payload: {
          question_canonical_markdown: '8 的四分之一是多少？',
        },
      },
      'source-action-key-stable-1',
      signal,
    )

    expect(client.apiPost).toHaveBeenCalledTimes(1)
    expect(client.apiPost).toHaveBeenCalledWith(
      '/api/k12/image-tasks/dispatch%20%2F%201/problems/problem%2F%E4%B8%80.1/source-actions',
      {
        action: 'correct_text',
        structure_version: 4,
        expected_input_revision: 2,
        payload: {
          question_canonical_markdown: '8 的四分之一是多少？',
        },
      },
      expect.objectContaining({
        signal,
        headers: { 'Idempotency-Key': 'source-action-key-stable-1' },
      }),
    )
    const body = client.apiPost.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'action',
      'expected_input_revision',
      'payload',
      'structure_version',
    ])
    expect(body).not.toHaveProperty('owner')
    expect(body).not.toHaveProperty('agent')
    expect(body).not.toHaveProperty('dependency_group_id')
    expect(result).toEqual(response)
  })

  it.each([
    ['dispatch_id', 'another-dispatch'],
    ['problem_id', 'another-problem'],
    ['action', 'skip'],
  ] as const)(
    'rejects a source-action response whose %s is not bound to the request',
    async (field, mismatchedValue) => {
      client.apiPost.mockResolvedValue({
        ...postCommitResponse(),
        [field]: mismatchedValue,
      })

      await expect(
        submitProblemSourceAction()(
          'dispatch / 1',
          'problem/一.1',
          {
            action: 'correct_text',
            structure_version: 4,
            expected_input_revision: 2,
            payload: { question_canonical_markdown: '8 的四分之一是多少？' },
          },
          `source-action-mismatch-${field}`,
        ),
      ).rejects.toThrow(`$.${field}`)
    },
  )
})
