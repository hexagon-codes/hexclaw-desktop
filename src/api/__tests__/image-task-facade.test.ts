import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_id: 'dispatch / 1',
    task_intent: 'artwork',
    status: 'routed',
    intent_evidence: ['drawing'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'creative_work_intake', id: 'intake-1' },
    target_projection: {
      kind: 'creative',
      intake_id: 'intake-1',
      work_type: 'art',
      status: 'promoted',
      work: { work_id: 'work-1', display_name: '美术作品' },
    },
    progress: { operation: 'promotion', state: 'promoted' },
    version: 1,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  }
}

const structuredFeedback = {
  feedback_id: 'feedback-1',
  version_id: 'version-1',
  feedback_type: 'art',
  evidence_refs: ['asset-ref:sha256:abc'],
  observations: [{ dimension: '构图', evidence: '主体位于画面中央。' }],
  source_snapshot: {
    source: 'ai',
    method_ref: 'art-feedback@1.0.0',
    capability: 'art_feedback',
  },
  limitations: '只依据当前照片中可见的画面。',
  suggestions: ['可以让主体和背景形成更清晰的层次。'],
  projection_markdown: '## 观察与依据\n\n- 主体位于画面中央。',
}

const recognizedQuestion = {
  problem_id: 'problem-1',
  problem_kind: 'standalone',
  page_asset_id: 'asset-1',
  attempt_id: 'attempt-1',
  question: '4.5×2=',
  raw_transcription: '4.5×2=',
  canonical_markdown: '4.5\\times 2=',
  canonical_valid: true,
  canonical_version: 1,
  knowledge_points: ['小数乘法'],
  student_answer: '8',
  answer_raw_transcription: '8',
  answer_canonical_markdown: '8',
  answer_canonical_valid: true,
  answer_state: 'present',
  subject: '数学',
  recognition_confidence: 0.99,
  confirmation_required: false,
  confirmed_version: 1,
  input_digest: 'sha256:input',
  bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
}

const parentGuide = {
  answer: '9',
  full_solution_steps: ['先算 45×2=90', '点回一位小数得到 9'],
  grade_level_method: '用五年级小数乘法方法。',
  likely_mistakes: ['整数乘法算错。'],
  parent_teaching_sequence: ['先让孩子复述题意。', '再定位第一处错步。'],
  follow_up_questions: ['积为什么只有一位小数？'],
  checking_method: '用 9÷2=4.5 反向验算。',
}

const wrongGrade = {
  solution: '9',
  verdict: 'disagree',
  evidence_type: 'numeric_exec',
  badge: 'disagree',
  wrong_step: '45×2 误算为 80',
  error_cause: '乘法事实错误',
  out_of_scope: false,
  record_created: true,
  record_id: 'mistake-1',
  curriculum_unmapped: [],
  solve_only: false,
}

function homeworkResult(
  intent: 'completed_homework' | 'blank_worksheet',
  item: Record<string, unknown>,
) {
  return {
    dispatch_id: 'dispatch-homework',
    task_intent: intent,
    status: 'routed',
    result: {
      kind: intent,
      payload: {
        mode: intent === 'completed_homework' ? 'grade' : 'solve',
        task_intent: intent,
        result_surface:
          intent === 'completed_homework' ? 'annotated_homework' : 'parent_teaching_guide',
        items: [item],
        markdown: '# 已完成',
        image_warning: '',
        ...(intent === 'completed_homework'
          ? {
              annotated_image: {
                mime: 'image/png',
                data_base64: 'QU5OT1RBVEVE',
                digest: 'sha256:annotated',
              },
            }
          : {}),
      },
    },
  }
}

function completedHomeworkDispatch() {
  const firstQuestion = {
    ...recognizedQuestion,
    problem_id: 'problem-1',
    source_number_path: [],
    display_label: '',
  }
  const secondQuestion = {
    ...recognizedQuestion,
    problem_id: 'problem-2',
    question: '57+38=',
    raw_transcription: '57+38=',
    canonical_markdown: '57+38=',
    source_number_path: [],
    display_label: '',
  }
  return {
    dispatch: dispatch({
      task_intent: 'completed_homework',
      target: { type: 'homework_submission', id: 'submission-public-1' },
      progress: { operation: 'homework', state: 'completed' },
      target_projection: {
        kind: 'homework',
        stage: 'completed',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        recognition: {
          subject: '数学',
          questions: [firstQuestion, secondQuestion],
        },
        progressive: {
          structure_version: 1,
          snapshot_revision: 1,
          problem_progress: [
            {
              problem_id: 'problem-1',
              status: 'correct',
              input_revision: 1,
              published_revision: 1,
              current_disposition: 'current',
            },
            {
              problem_id: 'problem-2',
              status: 'wrong',
              input_revision: 1,
              published_revision: 1,
              current_disposition: 'current',
            },
          ],
          coverage: {
            total: 2,
            published: 2,
            skipped: 0,
            awaiting: 0,
            failed: 0,
            status: 'complete',
            projection_revision: 1,
          },
        },
        final_artifact: {
          artifact_id: 'artifact-1',
          agent_name: 'tutor/小明',
          job_id: 'grading-job-1',
          structure_version: 1,
          coverage_status: 'complete',
          total_count: 2,
          published_count: 2,
          skipped_count: 0,
          ordered_current_digests_json: '["sha256:first","sha256:second"]',
          canonical_markdown: '# 批改结果',
          artifact_digest: '0123456789abcdef',
          summary_invocation_id: 'summary-invocation-1',
          created_at: 1_785_234_500,
          updated_at: 1_785_234_501,
        },
      },
    }),
  }
}

describe('K12 ImageTaskDispatch public facade', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
  })

  it('exports the exact six image-task operations and no GradingJob client', () => {
    const exports = k12Api as Record<string, unknown>

    for (const name of [
      'k12CreateImageTask',
      'k12GetImageTask',
      'k12ConfirmImageTask',
      'k12RetryImageTask',
      'k12CancelImageTask',
      'k12GetImageTaskResult',
    ]) {
      expect(exports[name], `${name} must be exported`).toBeTypeOf('function')
    }

    for (const retired of [
      'k12CreateGradingJob',
      'k12GetGradingJob',
      'k12ConfirmGradingJob',
      'k12RetryGradingJob',
      'k12CancelGradingJob',
      'k12GetGradingJobResult',
    ]) {
      expect(exports[retired], `${retired} must not remain public`).toBeUndefined()
    }
  })

  it('keeps the public photo result discriminators equal to the Go DTO enums', () => {
    const source = readFileSync(resolve(__dirname, '../k12.ts'), 'utf8')
    const unionValues = (name: string) => {
      const declaration = source.match(
        new RegExp(`export type ${name} =([\\s\\S]*?)(?=\\n(?:export|/\\*\\*))`),
      )?.[1]
      return [...(declaration || '').matchAll(/'([^']+)'/g)].map((match) => match[1])
    }
    const photoResult = source.match(/export interface PhotoJobResult \{([\s\S]*?)\n\}/)?.[1]
    const modeValues = [
      ...(photoResult?.match(/^\s*mode:\s*([^\n]+)/m)?.[1] || '').matchAll(/'([^']+)'/g),
    ].map((match) => match[1])

    expect(unionValues('PhotoJobTaskIntent')).toEqual(['completed_homework', 'blank_worksheet'])
    expect(unionValues('PhotoJobResultSurface')).toEqual([
      'annotated_homework',
      'parent_teaching_guide',
    ])
    expect(modeValues).toEqual(['grade', 'solve'])
  })

  it('[BUG-20260728-018] accepts and normalizes the current Sidecar queued progressive projection', async () => {
    client.apiGet.mockResolvedValueOnce({
      dispatch: {
        dispatch_id: 'EPtdYUWhUqQLvublgPSJR',
        task_intent: 'completed_homework',
        status: 'routed',
        provider_display_name: null,
        model_id: 'mock-model',
        retryable: false,
        intent_evidence: ['图片中可见两道数学题，第二题有手写答案 54'],
        intent_confidence: 0.99,
        confirmation_candidates: [],
        target: { type: 'homework_submission', id: 'u6LpZpp3lHz2vW0vSVii5' },
        progress: { operation: 'homework', state: 'queued' },
        target_projection: {
          kind: 'homework',
          stage: 'queued',
          confirmation_state: 'pending',
          anchor_state: 'pending',
          progressive: {
            structure_version: 0,
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
        version: 1,
        created_at: 1_785_234_467,
        updated_at: 1_785_234_467,
        automatic_budget_seconds: 300,
        automatic_started_at: 1_785_234_467,
        automatic_deadline_at: 1_785_234_767,
        automatic_remaining_seconds: 300,
      },
    })

    const response = await k12Api.k12GetImageTask(
      'tutor/小明',
      'EPtdYUWhUqQLvublgPSJR',
    )

    expect(response.dispatch.target_projection).toEqual({
      kind: 'homework',
      stage: 'queued',
      confirmation_state: 'pending',
      anchor_state: 'pending',
      structure_version: 0,
      problems: [],
      coverage: {
        state: 'incomplete',
        total: 0,
        processed: 0,
        skipped: 0,
      },
      projection_revision: 0,
    })
  })

  it('[K12-FACADE-PROGRESSIVE-STATUS-001] accepts the current Sidecar in_progress snapshot only at the shared boundary', async () => {
    const problemProgress = Array.from({ length: 16 }, (_, index) => ({
      problem_id: `problem-${index + 1}`,
      status: index < 5 ? 'correct' : 'processing',
      input_revision: 1,
      published_revision: index < 5 ? 1 : 0,
      current_disposition: 'current',
    }))
    const currentInProgressWire = {
      dispatch: {
        dispatch_id: 'dispatch-current-in-progress',
        task_intent: 'completed_homework',
        status: 'routed',
        provider_display_name: 'HexClaw-GPT',
        model_id: 'gpt-5.6-sol',
        retryable: false,
        intent_evidence: ['已作答作业'],
        intent_confidence: 0.99,
        confirmation_candidates: [],
        target: { type: 'homework_submission', id: 'submission-current-in-progress' },
        progress: { operation: 'homework', state: 'assessing' },
        target_projection: {
          kind: 'homework',
          stage: 'assessing',
          confirmation_state: 'confirmed',
          anchor_state: 'located',
          progressive: {
            structure_version: 1,
            snapshot_revision: 1,
            problem_progress: problemProgress,
            coverage: {
              total: 16,
              published: 5,
              skipped: 0,
              awaiting: 11,
              failed: 0,
              status: 'in_progress',
              projection_revision: 1,
            },
          },
        },
        version: 1,
        created_at: 1_785_234_467,
        updated_at: 1_785_234_467,
        automatic_budget_seconds: 300,
        automatic_started_at: 1_785_234_467,
        automatic_deadline_at: 1_785_234_767,
        automatic_remaining_seconds: 300,
      },
    }
    const unknownCoverageWire = structuredClone(currentInProgressWire)
    unknownCoverageWire.dispatch.target_projection.progressive.coverage.status = 'provider_private_state'
    client.apiGet.mockResolvedValueOnce(currentInProgressWire)

    await expect(
      k12Api.k12GetImageTask('tutor/小明', 'dispatch-current-in-progress'),
    ).resolves.toMatchObject({
      dispatch: {
        target_projection: {
          kind: 'homework',
          coverage: { state: 'incomplete', total: 16, processed: 5, skipped: 0 },
          projection_revision: 1,
        },
      },
    })

    client.apiGet.mockResolvedValueOnce(unknownCoverageWire)
    await expect(
      k12Api.k12GetImageTask('tutor/小明', 'dispatch-current-in-progress'),
    ).rejects.toThrow(/invalid image task dispatch response/i)
  })

  it('[BUG-20260728-018] accepts only a final artifact consistent with the current progressive projection', async () => {
    client.apiGet.mockResolvedValueOnce(completedHomeworkDispatch())

    const response = await k12Api.k12GetImageTask('tutor/小明', 'dispatch-homework')

    expect(response.dispatch.target_projection).toEqual({
      kind: 'homework',
      stage: 'completed',
      confirmation_state: 'confirmed',
      anchor_state: 'located',
      recognition: {
        subject: '数学',
        questions: [
          expect.objectContaining({
            problem_id: 'problem-1',
            source_number_path: [],
            display_label: '',
          }),
          expect.objectContaining({
            problem_id: 'problem-2',
            source_number_path: [],
            display_label: '',
          }),
        ],
      },
      structure_version: 1,
      problems: [
        expect.objectContaining({
          problem_id: 'problem-1',
          source_number_path: [],
          display_label: '',
          operation_state: 'correct',
          published_revision: 1,
        }),
        expect.objectContaining({
          problem_id: 'problem-2',
          source_number_path: [],
          display_label: '',
          operation_state: 'wrong',
          published_revision: 1,
        }),
      ],
      coverage: {
        state: 'full',
        total: 2,
        processed: 2,
        skipped: 0,
      },
      projection_revision: 1,
      final_artifact: {
        artifact_id: 'artifact-1',
        artifact_digest: '0123456789abcdef',
        canonical_markdown: '# 批改结果',
        coverage_status: 'complete',
        total_count: 2,
        published_count: 2,
        skipped_count: 0,
        created_at: 1_785_234_500,
        updated_at: 1_785_234_501,
      },
    })
  })

  it('[BUG-20260728-018] rejects a final artifact that contradicts the progressive projection', async () => {
    const response = completedHomeworkDispatch()
    const projection = response.dispatch.target_projection as Record<string, any>
    projection.progressive = {
      structure_version: 0,
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
    }
    client.apiGet.mockResolvedValueOnce(response)

    await expect(
      k12Api.k12GetImageTask('tutor/小明', 'dispatch-homework'),
    ).rejects.toThrow(/invalid image task dispatch response/i)
  })

  it('calls only the owner-scoped /image-tasks method+path exact-set', async () => {
    const publicDispatch = dispatch()
    client.apiPost
      .mockResolvedValueOnce({ created: true, dispatch: publicDispatch })
      .mockResolvedValueOnce({ dispatch: publicDispatch })
      .mockResolvedValueOnce({ dispatch: publicDispatch })
      .mockResolvedValueOnce({ dispatch: publicDispatch })
    client.apiGet.mockResolvedValueOnce({ dispatch: publicDispatch }).mockResolvedValueOnce({
      dispatch_id: 'dispatch / 1',
      task_intent: 'artwork',
      status: 'routed',
      result: {
        kind: 'artwork',
        payload: {
          intake: { intake_id: 'intake-1', status: 'promoted' },
          work: { work_id: 'work-1', display_name: '美术作品' },
        },
      },
    })
    const controller = new AbortController()
    const createRequest = {
      agent: 'tutor/小明',
      source_session: 'session-1',
      source_kind: 'desktop' as const,
      source_ref: 'message-1',
      source_asset_refs: ['asset://tutor/image.png'],
      message_intent: '请批改',
      attempt_generation: 1,
      route_request: {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        selection_source: 'explicit' as const,
      },
    }

    await k12Api.k12CreateImageTask(createRequest, controller.signal)
    await k12Api.k12GetImageTask('tutor/小明', 'dispatch / 1', controller.signal)
    await k12Api.k12ConfirmImageTask(
      'dispatch / 1',
      {
        agent: 'tutor/小明',
        version: 2,
        intent: 'writing',
      },
      controller.signal,
    )
    await k12Api.k12RetryImageTask(
      'dispatch / 1',
      { agent: 'tutor/小明', version: 3 },
      controller.signal,
    )
    await k12Api.k12CancelImageTask(
      'dispatch / 1',
      { agent: 'tutor/小明', version: 4 },
      controller.signal,
    )
    await k12Api.k12GetImageTaskResult('tutor/小明', 'dispatch / 1', controller.signal)

    expect(client.apiPost).toHaveBeenNthCalledWith(1, '/api/k12/image-tasks', createRequest, {
      timeout: 60_000,
      signal: controller.signal,
    })
    expect(client.apiGet).toHaveBeenNthCalledWith(
      1,
      '/api/k12/image-tasks/dispatch%20%2F%201',
      { agent: 'tutor/小明' },
      { signal: controller.signal },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      2,
      '/api/k12/image-tasks/dispatch%20%2F%201/confirm',
      { agent: 'tutor/小明', version: 2, intent: 'writing' },
      { timeout: 60_000, signal: controller.signal },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      3,
      '/api/k12/image-tasks/dispatch%20%2F%201/retry',
      { agent: 'tutor/小明', version: 3 },
      { timeout: 60_000, signal: controller.signal },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      4,
      '/api/k12/image-tasks/dispatch%20%2F%201/cancel',
      { agent: 'tutor/小明', version: 4 },
      { timeout: 60_000, signal: controller.signal },
    )
    expect(client.apiGet).toHaveBeenNthCalledWith(
      2,
      '/api/k12/image-tasks/dispatch%20%2F%201/result',
      { agent: 'tutor/小明' },
      { signal: controller.signal },
    )
  })

  it.each([
    [
      'string progress',
      {
        dispatch: dispatch({ progress: 'promoted' }),
      },
    ],
    [
      'legacy target discriminator',
      {
        dispatch: dispatch({ target: { kind: 'creative' } }),
      },
    ],
    [
      'internal route leak',
      {
        dispatch: dispatch({ model: 'gpt-5.6-sol' }),
      },
    ],
    [
      'progress state from a different operation',
      {
        dispatch: dispatch({ progress: { operation: 'homework', state: 'feedback_ready' } }),
      },
    ],
  ])('fails visibly on a non-approved dispatch shape: %s', async (_case, response) => {
    client.apiGet.mockResolvedValue(response)

    await expect(k12Api.k12GetImageTask('mingming', 'dispatch-1')).rejects.toThrow(
      /invalid image task dispatch response/i,
    )
  })

  it('fails visibly on the legacy result envelope instead of guessing its intent', async () => {
    client.apiGet.mockResolvedValue({
      kind: 'creative',
      payload: { intake_id: 'intake-1', work: { work_id: 'work-1' } },
    })

    await expect(k12Api.k12GetImageTaskResult('mingming', 'dispatch-1')).rejects.toThrow(
      /invalid image task result response/i,
    )
  })

  it('BUG-20260728-018 accepts the complete current result audit envelope', async () => {
    client.apiGet.mockResolvedValue({
      ...homeworkResult('completed_homework', {
        question: recognizedQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: wrongGrade,
        parent_guide: parentGuide,
      }),
      source_digest: 'sha256:source-image',
      source_attachments: [{ digest: 'sha256:source-image', size_bytes: 15777 }],
      operation_receipts: [
        {
          invocation_id: 'inv-assessing',
          operation: 'assessing',
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          status: 'succeeded',
          attempt: 1,
          result_digest: 'sha256:assessing-result',
        },
        {
          invocation_id: 'physical-recognizing-whole-page',
          parent_invocation_id: 'inv-recognizing',
          physical_unit: 'whole_page',
          operation: 'recognizing',
          provider: 'hexclaw-gpt',
          model: 'gpt-5.6-sol',
          status: 'succeeded',
          attempt: 1,
          result_digest: 'sha256:recognizing-result',
          request_policy_digest: 'sha256:recognizing-policy',
          request_policy: {
            policy_version: 'dd036-recognizing-v1',
            stage: 'recognizing',
            thinking: 'off',
            reasoning_effort: 'none',
          },
        },
      ],
    })

    await expect(
      k12Api.k12GetImageTaskResult('mingming', 'dispatch-homework'),
    ).resolves.toMatchObject({
      source_digest: 'sha256:source-image',
      operation_receipts: [
        { invocation_id: 'inv-assessing' },
        {
          invocation_id: 'physical-recognizing-whole-page',
          parent_invocation_id: 'inv-recognizing',
          request_policy: { reasoning_effort: 'none' },
        },
      ],
      result: { kind: 'completed_homework' },
    })
  })

  it.each([
    [
      'a partial audit envelope',
      {
        ...homeworkResult('completed_homework', {
          question: recognizedQuestion,
          status: 'wrong',
          result_kind: 'assessment',
          grade: wrongGrade,
          parent_guide: parentGuide,
        }),
        source_digest: 'sha256:source-image',
      },
    ],
    [
      'a receipt with a transport identifier',
      {
        ...homeworkResult('completed_homework', {
          question: recognizedQuestion,
          status: 'wrong',
          result_kind: 'assessment',
          grade: wrongGrade,
          parent_guide: parentGuide,
        }),
        source_digest: 'sha256:source-image',
        source_attachments: [{ digest: 'sha256:source-image', size_bytes: 15777 }],
        operation_receipts: [
          {
            invocation_id: 'inv-recognizing',
            operation: 'recognizing',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            status: 'succeeded',
            attempt: 1,
            result_digest: 'sha256:recognizing-result',
            external_request_id: 'must-not-cross-public-api',
          },
        ],
      },
    ],
  ])('rejects %s', async (_case, response) => {
    client.apiGet.mockResolvedValue(response)

    await expect(k12Api.k12GetImageTaskResult('mingming', 'dispatch-homework')).rejects.toThrow(
      /invalid image task result response/i,
    )
  })

  it('accepts the exact creative confirmation snapshot and durable feedback wire', async () => {
    client.apiGet
      .mockResolvedValueOnce({
        dispatch: dispatch({
          task_intent: 'writing',
          status: 'awaiting_confirmation',
          target_projection: {
            kind: 'creative',
            intake_id: 'intake-1',
            work_type: 'writing',
            status: 'awaiting_confirmation',
            canonical_version: 2,
            canonical_content: '我的好爸爸',
            conflicts: [
              {
                segment_id: 'line-1-word-3',
                raw_text: '〔字迹不清〕',
                canonical_text: '好',
                reason: 'illegible',
              },
            ],
          },
          progress: { operation: 'writing_ocr', state: 'awaiting_confirmation' },
          version: 2,
        }),
      })
      .mockResolvedValueOnce({
        dispatch_id: 'dispatch / 1',
        task_intent: 'artwork',
        status: 'routed',
        result: {
          kind: 'artwork',
          payload: {
            intake: { intake_id: 'intake-1', status: 'promoted' },
            work: { work_id: 'work-1', display_name: '美术作品' },
            feedback: {
              generation_id: 'generation-1',
              structured_feedback: structuredFeedback,
              projection_markdown: structuredFeedback.projection_markdown,
            },
          },
        },
      })

    await expect(k12Api.k12GetImageTask('mingming', 'dispatch / 1')).resolves.toMatchObject({
      dispatch: {
        target_projection: {
          canonical_version: 2,
          canonical_content: '我的好爸爸',
        },
      },
    })
    await expect(k12Api.k12GetImageTaskResult('mingming', 'dispatch / 1')).resolves.toMatchObject({
      result: {
        kind: 'artwork',
        payload: {
          feedback: {
            structured_feedback: structuredFeedback,
            projection_markdown: structuredFeedback.projection_markdown,
          },
        },
      },
    })
  })

  it('accepts the public creative recovering projection and rejects the internal receipt state', async () => {
    client.apiGet
      .mockResolvedValueOnce({
        dispatch: dispatch({
          progress: { operation: 'promotion', state: 'recovering' },
        }),
      })
      .mockResolvedValueOnce({
        dispatch: dispatch({
          progress: { operation: 'promotion', state: 'feedback_outcome_unknown' },
        }),
      })

    await expect(k12Api.k12GetImageTask('mingming', 'dispatch-recovering')).resolves.toMatchObject({
      dispatch: {
        progress: { operation: 'promotion', state: 'recovering' },
      },
    })
    await expect(k12Api.k12GetImageTask('mingming', 'dispatch-internal')).rejects.toThrow(
      /invalid image task dispatch response/i,
    )
  })

  it.each([
    [
      'creative projection leaks an unapproved field',
      {
        dispatch: dispatch({
          target_projection: {
            kind: 'creative',
            intake_id: 'intake-1',
            work_type: 'writing',
            status: 'awaiting_confirmation',
            canonical_version: 2,
            canonical_content: '我的好爸爸',
            ocr_job_id: 'internal-job',
          },
        }),
      },
      'dispatch',
    ],
    [
      'structured feedback leaks score',
      {
        dispatch_id: 'dispatch-1',
        task_intent: 'artwork',
        status: 'routed',
        result: {
          kind: 'artwork',
          payload: {
            intake: { intake_id: 'intake-1', status: 'promoted' },
            feedback: {
              structured_feedback: { ...structuredFeedback, score: 95 },
              projection_markdown: structuredFeedback.projection_markdown,
            },
          },
        },
      },
      'result',
    ],
    [
      'renderer projection differs from canonical feedback projection',
      {
        dispatch_id: 'dispatch-1',
        task_intent: 'artwork',
        status: 'routed',
        result: {
          kind: 'artwork',
          payload: {
            intake: { intake_id: 'intake-1', status: 'promoted' },
            feedback: {
              structured_feedback: structuredFeedback,
              projection_markdown: '被篡改的投影',
            },
          },
        },
      },
      'result',
    ],
  ])('rejects %s', async (_case, response, endpoint) => {
    client.apiGet.mockResolvedValue(response)

    const call =
      endpoint === 'dispatch'
        ? k12Api.k12GetImageTask('mingming', 'dispatch-1')
        : k12Api.k12GetImageTaskResult('mingming', 'dispatch-1')
    await expect(call).rejects.toThrow(/invalid image task (dispatch|result) response/i)
  })

  it('deep-validates the exact completed-homework result and seven-field wrong guide', async () => {
    client.apiGet.mockResolvedValue(
      homeworkResult('completed_homework', {
        question: recognizedQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: wrongGrade,
        parent_guide: parentGuide,
      }),
    )

    await expect(
      k12Api.k12GetImageTaskResult('mingming', 'dispatch-homework'),
    ).resolves.toMatchObject({
      result: {
        kind: 'completed_homework',
        payload: {
          items: [{ parent_guide: parentGuide }],
        },
      },
    })
  })

  it('accepts the Go public verbatim evidence and badge enum values', async () => {
    client.apiGet.mockResolvedValue(
      homeworkResult('completed_homework', {
        question: {
          ...recognizedQuestion,
          question: '默写“春眠不觉晓”',
          raw_transcription: '默写“春眠不觉晓”',
          canonical_markdown: '默写“春眠不觉晓”',
          student_answer: '春眠不觉晓',
          answer_raw_transcription: '春眠不觉晓',
          answer_canonical_markdown: '春眠不觉晓',
          subject: '语文',
        },
        status: 'correct',
        result_kind: 'assessment',
        grade: {
          ...wrongGrade,
          solution: '春眠不觉晓',
          verdict: 'agree',
          evidence_type: 'verbatim',
          badge: 'verbatim-recall',
          wrong_step: undefined,
          error_cause: undefined,
          record_created: false,
          record_id: undefined,
        },
      }),
    )

    await expect(
      k12Api.k12GetImageTaskResult('mingming', 'dispatch-homework'),
    ).resolves.toMatchObject({
      result: {
        kind: 'completed_homework',
        payload: {
          items: [
            {
              status: 'correct',
              grade: {
                evidence_type: 'verbatim',
                badge: 'verbatim-recall',
              },
            },
          ],
        },
      },
    })
  })

  it.each([
    [
      'an internal item identity',
      homeworkResult('completed_homework', {
        question: recognizedQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: wrongGrade,
        parent_guide: parentGuide,
        grading_job_id: 'internal-job',
      }),
    ],
    [
      'a wrong item without its complete parent guide',
      homeworkResult('completed_homework', {
        question: recognizedQuestion,
        status: 'wrong',
        result_kind: 'assessment',
        grade: wrongGrade,
      }),
    ],
    [
      'a correct item with an invented parent guide',
      homeworkResult('completed_homework', {
        question: { ...recognizedQuestion, student_answer: '9' },
        status: 'correct',
        result_kind: 'assessment',
        grade: { ...wrongGrade, verdict: 'agree', badge: 'verified-strong' },
        parent_guide: parentGuide,
      }),
    ],
    [
      'an incomplete blank-worksheet guide',
      homeworkResult('blank_worksheet', {
        question: {
          ...recognizedQuestion,
          student_answer: '',
          answer_raw_transcription: '',
          answer_canonical_markdown: '',
          answer_state: 'blank',
        },
        status: 'blank_solved',
        result_kind: 'parent_teaching_guide',
        parent_guide: {
          ...parentGuide,
          parent_teaching_sequence: undefined,
        },
      }),
    ],
    [
      'a blank-worksheet guide with an empty teaching step',
      homeworkResult('blank_worksheet', {
        question: {
          ...recognizedQuestion,
          student_answer: '',
          answer_raw_transcription: '',
          answer_canonical_markdown: '',
          answer_state: 'blank',
        },
        status: 'blank_solved',
        result_kind: 'parent_teaching_guide',
        parent_guide: {
          ...parentGuide,
          parent_teaching_sequence: ['先让孩子复述题意。', '  '],
        },
      }),
    ],
    [
      'an internal question field',
      homeworkResult('completed_homework', {
        question: { ...recognizedQuestion, invocation_id: 'internal-invocation' },
        status: 'wrong',
        result_kind: 'assessment',
        grade: wrongGrade,
        parent_guide: parentGuide,
      }),
    ],
  ])('rejects a photo result containing %s', async (_case, response) => {
    client.apiGet.mockResolvedValue(response)

    await expect(k12Api.k12GetImageTaskResult('mingming', 'dispatch-homework')).rejects.toThrow(
      /invalid image task result response/i,
    )
  })
})
